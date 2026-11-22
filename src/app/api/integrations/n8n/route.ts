import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import {
  N8N_EVENTS,
  generateN8nInboundToken,
  isValidHeaderName,
  normalizeN8nEvents,
  type N8nIntegrationRow,
} from '@/lib/n8n/events'

function serializeIntegration(row: N8nIntegrationRow | null, revealInboundToken = false) {
  if (!row) {
    return {
      configured: false,
      is_active: false,
      instance_url: '',
      webhook_url: '',
      auth_header_name: 'x-n8n-secret',
      has_auth_header_value: false,
      subscribed_events: [...N8N_EVENTS],
      has_inbound_token: false,
      inbound_token_prefix: null,
      inbound_token: null,
      last_outbound_at: null,
      last_outbound_status: null,
      last_outbound_error: null,
      last_inbound_at: null,
    }
  }

  let inboundToken: string | null = null
  if (revealInboundToken && row.inbound_token_encrypted) {
    try {
      inboundToken = decrypt(row.inbound_token_encrypted)
    } catch {
      inboundToken = null
    }
  }

  return {
    configured: true,
    is_active: Boolean(row.is_active),
    instance_url: row.instance_url ?? '',
    webhook_url: row.webhook_url ?? '',
    auth_header_name: row.auth_header_name || 'x-n8n-secret',
    has_auth_header_value: Boolean(row.auth_header_value_encrypted),
    subscribed_events: Array.isArray(row.subscribed_events) ? row.subscribed_events : [],
    has_inbound_token: Boolean(row.inbound_token_hash),
    inbound_token_prefix: row.inbound_token_prefix ?? null,
    inbound_token: inboundToken,
    last_outbound_at: row.last_outbound_at ?? null,
    last_outbound_status: row.last_outbound_status ?? null,
    last_outbound_error: row.last_outbound_error ?? null,
    last_inbound_at: row.last_inbound_at ?? null,
  }
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('n8n_integrations')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const canReveal = ctx.role === 'owner' || ctx.role === 'admin'
    return NextResponse.json({
      integration: serializeIntegration((data as N8nIntegrationRow | null) ?? null, canReveal),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 })
    }

    const db = supabaseAdmin()
    const { data: existing } = await db
      .from('n8n_integrations')
      .select('*')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    const current = (existing as N8nIntegrationRow | null) ?? null

    const instanceUrl =
      typeof body.instance_url === 'string' ? body.instance_url.trim() : current?.instance_url ?? ''
    const webhookUrl =
      typeof body.webhook_url === 'string' ? body.webhook_url.trim() : current?.webhook_url ?? ''

    if (instanceUrl) {
      try {
        const u = new URL(instanceUrl)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return NextResponse.json(
            { error: 'A URL da instância n8n deve começar com https:// ou http://.' },
            { status: 400 },
          )
        }
      } catch {
        return NextResponse.json({ error: 'URL da instância n8n inválida.' }, { status: 400 })
      }
    }

    if (webhookUrl) {
      const deliverable = await isDeliverableUrl(webhookUrl)
      if (!deliverable) {
        return NextResponse.json(
          {
            error:
              'A URL do webhook do n8n precisa ser um endereço público válido (https://).',
          },
          { status: 400 },
        )
      }
    }

    const rawHeaderName =
      typeof body.auth_header_name === 'string' && body.auth_header_name.trim()
        ? body.auth_header_name.trim()
        : current?.auth_header_name || 'x-n8n-secret'

    if (!isValidHeaderName(rawHeaderName)) {
      return NextResponse.json(
        { error: 'Nome de cabeçalho HTTP inválido (use letras, números, - ou _).' },
        { status: 400 },
      )
    }

    let encryptedHeaderValue = current?.auth_header_value_encrypted ?? null
    if (body.clear_auth_header_value === true) {
      encryptedHeaderValue = null
    } else if (typeof body.auth_header_value === 'string' && body.auth_header_value.trim()) {
      encryptedHeaderValue = encrypt(body.auth_header_value.trim())
    }

    const subscribedEvents = Array.isArray(body.subscribed_events)
      ? normalizeN8nEvents(body.subscribed_events)
      : current?.subscribed_events ?? [...N8N_EVENTS]

    const isActive =
      typeof body.is_active === 'boolean' ? body.is_active : current?.is_active ?? false

    // Auto-create an inbound token on first save if none exists yet
    let inboundHash = current?.inbound_token_hash ?? null
    let inboundPrefix = current?.inbound_token_prefix ?? null
    let inboundEncrypted = current?.inbound_token_encrypted ?? null
    if (!inboundHash) {
      const generated = generateN8nInboundToken()
      inboundHash = generated.hash
      inboundPrefix = generated.prefix
      inboundEncrypted = encrypt(generated.token)
    }

    const payload = {
      account_id: ctx.accountId,
      is_active: isActive,
      instance_url: instanceUrl || null,
      webhook_url: webhookUrl || null,
      auth_header_name: rawHeaderName,
      auth_header_value_encrypted: encryptedHeaderValue,
      subscribed_events: subscribedEvents,
      inbound_token_hash: inboundHash,
      inbound_token_prefix: inboundPrefix,
      inbound_token_encrypted: inboundEncrypted,
      updated_at: new Date().toISOString(),
    }

    let saved: N8nIntegrationRow | null = null
    if (current) {
      const { data, error } = await db
        .from('n8n_integrations')
        .update(payload)
        .eq('id', current.id)
        .select('*')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      saved = data as N8nIntegrationRow
    } else {
      const { data, error } = await db
        .from('n8n_integrations')
        .insert(payload)
        .select('*')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      saved = data as N8nIntegrationRow
    }

    return NextResponse.json({ integration: serializeIntegration(saved, true) })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** POST rotates or initializes the per-account inbound n8n token. */
export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()
    const generated = generateN8nInboundToken()
    const encryptedToken = encrypt(generated.token)

    const { data: existing } = await db
      .from('n8n_integrations')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    let saved: N8nIntegrationRow | null = null
    if (existing?.id) {
      const { data, error } = await db
        .from('n8n_integrations')
        .update({
          inbound_token_hash: generated.hash,
          inbound_token_prefix: generated.prefix,
          inbound_token_encrypted: encryptedToken,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      saved = data as N8nIntegrationRow
    } else {
      const { data, error } = await db
        .from('n8n_integrations')
        .insert({
          account_id: ctx.accountId,
          is_active: false,
          auth_header_name: 'x-n8n-secret',
          subscribed_events: [...N8N_EVENTS],
          inbound_token_hash: generated.hash,
          inbound_token_prefix: generated.prefix,
          inbound_token_encrypted: encryptedToken,
        })
        .select('*')
        .single()
      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      saved = data as N8nIntegrationRow
    }

    return NextResponse.json({
      token: generated.token,
      integration: serializeIntegration(saved, true),
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
