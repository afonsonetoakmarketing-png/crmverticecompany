import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { N8N_ACTIONS, hashN8nToken, type N8nActionType } from '@/lib/n8n/events'
import {
  N8nActionError,
  executeN8nAction,
  type N8nActionPayload,
} from '@/lib/n8n/actions'
import { SendMessageError } from '@/lib/whatsapp/send-message'

function extractToken(request: Request): string {
  const custom = request.headers.get('x-n8n-token')?.trim()
  if (custom) return custom
  const auth = request.headers.get('authorization')?.trim()
  if (auth && /^Bearer\s+/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, '').trim()
  }
  return ''
}

function safeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Inbound n8n action webhook.
 *
 * Allows any workflow running in `n8n.akm` (VPS / Railway / Cloud) to trigger
 * authenticated CRM operations with a single HTTP Request node.
 */
export async function POST(request: Request) {
  const token = extractToken(request)
  if (!token) {
    return NextResponse.json(
      { error: 'Token ausente. Envie Authorization: Bearer <token> ou x-n8n-token.' },
      { status: 401 },
    )
  }

  const tokenHash = hashN8nToken(token)
  const db = supabaseAdmin()
  const { data: integration, error } = await db
    .from('n8n_integrations')
    .select('id, account_id, inbound_token_hash')
    .eq('inbound_token_hash', tokenHash)
    .maybeSingle()

  if (
    error ||
    !integration?.inbound_token_hash ||
    !safeHexEqual(String(integration.inbound_token_hash), tokenHash)
  ) {
    return NextResponse.json({ error: 'Token n8n inválido.' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Corpo JSON inválido.' }, { status: 400 })
  }

  const rawAction = (body as Record<string, unknown>).action
  if (
    typeof rawAction !== 'string' ||
    !(N8N_ACTIONS as readonly string[]).includes(rawAction)
  ) {
    return NextResponse.json(
      {
        error: `Ação inválida. Use uma de: ${N8N_ACTIONS.join(', ')}`,
      },
      { status: 400 },
    )
  }

  try {
    const result = await executeN8nAction(
      db,
      String(integration.account_id),
      { ...(body as Record<string, unknown>), action: rawAction as N8nActionType } as N8nActionPayload,
    )

    // Record last inbound timestamp (best-effort)
    try {
      await db
        .from('n8n_integrations')
        .update({ last_inbound_at: new Date().toISOString() })
        .eq('id', integration.id)
    } catch {
      // non-fatal
    }

    return NextResponse.json(result)
  } catch (err) {
    if (err instanceof N8nActionError) {
      return NextResponse.json({ error: err.message }, { status: err.status })
    }
    if (err instanceof SendMessageError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    }
    console.error('[n8n/webhook] action failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Erro interno ao executar ação.' },
      { status: 500 },
    )
  }
}
