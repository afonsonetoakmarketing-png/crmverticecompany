import crypto from 'node:crypto'
import { NextResponse, after } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isLocalHybridMode } from '@/lib/local-backend/mode'
import { createLocalAdminClient } from '@/lib/local-backend/server-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { parseQrWebhookPayload } from '@/lib/whatsapp/qr-gateway'
import { readCappedBody } from '@/lib/whatsapp/webhook-body'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { reopenClosedConversation } from '@/lib/conversations/reopen'
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply'
import { runAutomationsForTrigger } from '@/lib/automations/engine'

export const maxDuration = 60

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function supabaseAdmin(): any {
  return isLocalHybridMode()
    ? createLocalAdminClient()
    : createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
      )
}

function timingSafeSecretEquals(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function extractRequestSecret(request: Request): string {
  const url = new URL(request.url)
  const fromQuery = url.searchParams.get('token')?.trim()
  if (fromQuery) return fromQuery

  const headerSecret =
    request.headers.get('x-webhook-secret')?.trim() ||
    request.headers.get('x-api-key')?.trim() ||
    request.headers.get('apikey')?.trim()
  if (headerSecret) return headerSecret

  const auth = request.headers.get('authorization')?.trim() || ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  return ''
}

/**
 * POST /api/whatsapp/qr/webhook?account=<accountId>
 *
 * Receives inbound WhatsApp Web events from Evolution API v2, WAHA,
 * or custom Baileys/webhook bridges. Authenticated with the account's
 * per-workspace `qr_webhook_secret` via constant-time comparison.
 */
export async function POST(request: Request) {
  const rawBody = await readCappedBody(request)
  if (rawBody === null) {
    return NextResponse.json({ error: 'Payload muito grande.' }, { status: 413 })
  }

  const { searchParams } = new URL(request.url)
  const accountId = searchParams.get('account')?.trim() || ''
  if (!accountId) {
    return NextResponse.json(
      { error: 'Parâmetro account é obrigatório.' },
      { status: 400 },
    )
  }

  const providedSecret = extractRequestSecret(request)
  if (!providedSecret) {
    return NextResponse.json(
      { error: 'Token de segurança do webhook ausente.' },
      { status: 401 },
    )
  }

  const db = supabaseAdmin()
  const { data: config, error: cfgErr } = await db
    .from('whatsapp_config')
    .select('id, account_id, user_id, qr_webhook_secret, connection_mode')
    .eq('account_id', accountId)
    .maybeSingle()

  if (cfgErr || !config?.qr_webhook_secret) {
    return NextResponse.json(
      { error: 'Webhook QR não configurado para esta conta.' },
      { status: 401 },
    )
  }

  let expectedSecret = ''
  try {
    expectedSecret = decrypt(config.qr_webhook_secret)
  } catch {
    return NextResponse.json(
      { error: 'Segredo do webhook corrompido. Regenere o token nas configurações.' },
      { status: 500 },
    )
  }

  if (!timingSafeSecretEquals(expectedSecret, providedSecret)) {
    return NextResponse.json(
      { error: 'Token de segurança do webhook inválido.' },
      { status: 401 },
    )
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
  }

  const event = parseQrWebhookPayload(body)

  if (event.kind === 'ignored') {
    return NextResponse.json({ ok: true, ignored: event.reason })
  }

  if (event.kind === 'connection') {
    const patch: Record<string, unknown> = {
      qr_status: event.status,
    }
    if (event.phoneNumber) patch.qr_phone_number = event.phoneNumber
    if (event.status === 'connected') {
      patch.qr_connected_at = new Date().toISOString()
    }
    if (config.connection_mode === 'qr_code') {
      patch.status = event.status === 'connected' ? 'connected' : 'disconnected'
    }
    await db
      .from('whatsapp_config')
      .update(patch)
      .eq('account_id', accountId)

    return NextResponse.json({ ok: true, status: event.status })
  }

  // Inbound message: find or create contact -> conversation -> message
  const normalized = normalizePhone(event.fromPhone)
  let contact = await findExistingContact(db, accountId, normalized)

  if (!contact) {
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert({
        account_id: accountId,
        user_id: config.user_id,
        phone: normalized,
        phone_normalized: normalized,
        name: event.contactName || normalized,
      })
      .select()
      .single()

    if (createErr) {
      if (isUniqueViolation(createErr)) {
        contact = await findExistingContact(db, accountId, normalized)
      } else {
        console.error('[whatsapp/qr/webhook] contact insert failed:', createErr)
        return NextResponse.json(
          { error: 'Erro ao criar contato.' },
          { status: 500 },
        )
      }
    } else {
      contact = created
    }
  } else if (event.contactName && (!contact.name || contact.name === contact.phone)) {
    await db
      .from('contacts')
      .update({ name: event.contactName })
      .eq('id', contact.id)
  }

  if (!contact) {
    return NextResponse.json({ error: 'Contato não encontrado.' }, { status: 500 })
  }

  // Find or create conversation for this contact
  const { data: existingConvs } = await db
    .from('conversations')
    .select('id, status, unread_count')
    .eq('account_id', accountId)
    .eq('contact_id', contact.id)
    .order('created_at', { ascending: false })
    .limit(1)

  let conversation = existingConvs?.[0] ?? null
  if (!conversation) {
    const { data: createdConv, error: convErr } = await db
      .from('conversations')
      .insert({
        account_id: accountId,
        user_id: config.user_id,
        contact_id: contact.id,
        status: 'open',
        unread_count: 0,
      })
      .select('id, status, unread_count')
      .single()
    if (convErr || !createdConv) {
      console.error('[whatsapp/qr/webhook] conversation insert failed:', convErr)
      return NextResponse.json(
        { error: 'Erro ao criar conversa.' },
        { status: 500 },
      )
    }
    conversation = createdConv
  } else if (conversation.status === 'closed') {
    await reopenClosedConversation(db, conversation)
  }

  // Deduplicate by message_id
  const { data: existingMsg } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversation.id)
    .eq('message_id', event.messageId)
    .maybeSingle()

  if (existingMsg) {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  const previewText = event.contentText || `[${event.contentType}]`
  const { data: insertedMsg, error: msgErr } = await db
    .from('messages')
    .insert({
      conversation_id: conversation.id,
      sender_type: 'customer',
      content_type: event.contentType,
      content_text: event.contentText,
      media_url: event.mediaUrl,
      message_id: event.messageId,
      status: 'delivered',
    })
    .select('id')
    .single()

  if (msgErr) {
    console.error('[whatsapp/qr/webhook] message insert failed:', msgErr)
    return NextResponse.json(
      { error: 'Erro ao salvar mensagem recebida.' },
      { status: 500 },
    )
  }

  await db
    .from('conversations')
    .update({
      status: 'open',
      last_message_text: previewText,
      last_message_at: event.timestamp,
      unread_count: (Number(conversation.unread_count) || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // Trigger automations & AI auto-reply asynchronously (same pipeline as Meta webhook)
  const convId = conversation.id as string
  const contactId = contact.id as string
  const ownerId = config.user_id as string
  const textBody = event.contentText ?? ''

  after(async () => {
    try {
      await runAutomationsForTrigger({
        accountId,
        triggerType: 'new_message_received',
        contactId,
        context: {
          conversation_id: convId,
          message_text: textBody,
        },
      })
      if (textBody) {
        await runAutomationsForTrigger({
          accountId,
          triggerType: 'keyword_match',
          contactId,
          context: {
            conversation_id: convId,
            message_text: textBody,
          },
        })
      }
      await dispatchInboundToAiReply({
        accountId,
        conversationId: convId,
        contactId,
        configOwnerUserId: ownerId,
        inboundMessageId: event.messageId,
      })
    } catch (err) {
      console.error('[whatsapp/qr/webhook] async dispatch error:', err)
    }
  })

  return NextResponse.json({
    ok: true,
    conversation_id: convId,
    message_id: insertedMsg?.id ?? null,
  })
}
