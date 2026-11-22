import crypto from 'node:crypto'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

export const N8N_EVENTS = [
  'message.received',
  'contact.created',
  'deal.created',
  'deal.stage_changed',
  'tag.added',
  'ai.handoff',
] as const

export type N8nEventType = (typeof N8N_EVENTS)[number]

export const N8N_ACTIONS = [
  'send_whatsapp',
  'upsert_contact',
  'add_tag',
  'create_deal',
  'move_deal_stage',
  'run_ai_reply',
] as const

export type N8nActionType = (typeof N8N_ACTIONS)[number]

export interface N8nIntegrationRow {
  id: string
  account_id: string
  is_active: boolean
  instance_url: string | null
  webhook_url: string | null
  auth_header_name: string
  auth_header_value_encrypted: string | null
  subscribed_events: string[]
  inbound_token_hash: string | null
  inbound_token_prefix: string | null
  inbound_token_encrypted: string | null
  last_outbound_at: string | null
  last_outbound_status: number | null
  last_outbound_error: string | null
  last_inbound_at: string | null
  created_at: string
  updated_at: string
}

export function isN8nEvent(value: unknown): value is N8nEventType {
  return typeof value === 'string' && (N8N_EVENTS as readonly string[]).includes(value)
}

export function normalizeN8nEvents(input: unknown): N8nEventType[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<N8nEventType>()
  for (const item of input) {
    if (isN8nEvent(item)) seen.add(item)
  }
  return Array.from(seen)
}

export function hashN8nToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function generateN8nInboundToken(): {
  token: string
  hash: string
  prefix: string
} {
  const token = `n8n_${crypto.randomBytes(24).toString('hex')}`
  return {
    token,
    hash: hashN8nToken(token),
    prefix: `${token.slice(0, 12)}...`,
  }
}

export function isValidHeaderName(name: string): boolean {
  return /^[a-zA-Z0-9_-]{1,64}$/.test(name.trim())
}

export interface DispatchN8nResult {
  sent: boolean
  status?: number
  error?: string
  latencyMs?: number
}

/**
 * Push a standardized CRM event payload to the account's configured n8n
 * webhook URL. Never throws when called from event hooks — returns a
 * structured result and persists the latest delivery status.
 */
export async function dispatchN8nEvent(args: {
  accountId: string
  event: N8nEventType | 'test.ping'
  payload: Record<string, unknown>
  /** When true (manual Test button), dispatches even if `is_active` is false or event isn't subscribed. */
  force?: boolean
}): Promise<DispatchN8nResult> {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('n8n_integrations')
    .select('*')
    .eq('account_id', args.accountId)
    .maybeSingle()

  if (error || !data) {
    return { sent: false, error: 'Integração n8n não configurada para esta conta.' }
  }

  const cfg = data as unknown as N8nIntegrationRow
  if (!args.force && !cfg.is_active) {
    return { sent: false, error: 'Integração n8n desativada.' }
  }
  if (!cfg.webhook_url) {
    return { sent: false, error: 'URL do webhook do n8n não preenchida.' }
  }
  if (
    !args.force &&
    args.event !== 'test.ping' &&
    Array.isArray(cfg.subscribed_events) &&
    !cfg.subscribed_events.includes(args.event)
  ) {
    return { sent: false, error: `Evento ${args.event} não assinado.` }
  }

  const allowed = await isDeliverableUrl(cfg.webhook_url)
  if (!allowed) {
    const errMsg = 'URL de destino bloqueada por política de segurança (use endereço público HTTPS).'
    await recordOutboundResult(db, cfg.id, null, errMsg)
    return { sent: false, error: errMsg }
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'user-agent': 'WhatsApp-CRM-n8n-Hub/1.0',
    'x-crm-event': args.event,
  }

  if (cfg.auth_header_value_encrypted) {
    try {
      const secretVal = decrypt(cfg.auth_header_value_encrypted)
      const headerName = isValidHeaderName(cfg.auth_header_name || '')
        ? cfg.auth_header_name.trim()
        : 'x-n8n-secret'
      if (secretVal) {
        headers[headerName] = secretVal
      }
    } catch {
      const errMsg = 'Não foi possível descriptografar o segredo de autenticação do n8n.'
      await recordOutboundResult(db, cfg.id, null, errMsg)
      return { sent: false, error: errMsg }
    }
  }

  const body = JSON.stringify({
    event: args.event,
    account_id: args.accountId,
    timestamp: new Date().toISOString(),
    source: 'whatsapp-crm',
    data: args.payload,
  })

  const startedAt = Date.now()
  try {
    const res = await fetch(cfg.webhook_url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
    const latencyMs = Date.now() - startedAt
    const ok = res.status >= 200 && res.status < 300
    const errMsg = ok ? null : `HTTP ${res.status}`
    await recordOutboundResult(db, cfg.id, res.status, errMsg)
    return {
      sent: ok,
      status: res.status,
      latencyMs,
      ...(errMsg ? { error: errMsg } : {}),
    }
  } catch (err) {
    const latencyMs = Date.now() - startedAt
    const errMsg = err instanceof Error ? err.message : 'Falha de conexão com o n8n'
    await recordOutboundResult(db, cfg.id, null, errMsg)
    return { sent: false, error: errMsg, latencyMs }
  }
}

async function recordOutboundResult(
  db: ReturnType<typeof supabaseAdmin>,
  id: string,
  status: number | null,
  errorMsg: string | null,
) {
  try {
    await db
      .from('n8n_integrations')
      .update({
        last_outbound_at: new Date().toISOString(),
        last_outbound_status: status,
        last_outbound_error: errorMsg,
      })
      .eq('id', id)
  } catch {
    // Non-fatal telemetry update
  }
}
