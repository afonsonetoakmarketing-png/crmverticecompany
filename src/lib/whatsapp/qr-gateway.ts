import QRCode from 'qrcode'
import { isIP } from 'node:net'
import { normalizePhone } from './phone-utils'

// ============================================================
// WhatsApp Web (QR Code) Gateway Adapter
//
// Bridges this serverless Next.js CRM with a WhatsApp Web session
// hosted on Evolution API v2, WAHA (WhatsApp HTTP API), or a
// custom Baileys/webhook gateway. All outbound requests validate
// the gateway URL against SSRF rules before touching the network.
// ============================================================

export type QrGatewayProvider = 'evolution' | 'waha' | 'custom_webhook'
export type QrConnectionStatus = 'disconnected' | 'qr_ready' | 'connected'

export interface QrGatewayConfig {
  provider: QrGatewayProvider
  apiUrl: string
  instanceName: string
  apiKey: string
}

export interface QrConnectResult {
  status: QrConnectionStatus
  qrCodeDataUrl: string | null
  pairingCode: string | null
  phoneNumber: string | null
  message?: string
}

export interface QrStatusResult {
  status: QrConnectionStatus
  phoneNumber: string | null
  qrCodeDataUrl: string | null
  rawState?: string
}

export interface QrInboundMessageEvent {
  kind: 'message'
  fromPhone: string
  contactName: string | null
  messageId: string
  contentType: 'text' | 'image' | 'video' | 'document' | 'audio'
  contentText: string | null
  mediaUrl: string | null
  timestamp: string
}

export interface QrConnectionUpdateEvent {
  kind: 'connection'
  status: QrConnectionStatus
  phoneNumber: string | null
}

export type ParsedQrWebhookEvent =
  | QrInboundMessageEvent
  | QrConnectionUpdateEvent
  | { kind: 'ignored'; reason: string }

const GATEWAY_TIMEOUT_MS = 15_000

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true
  }
  const [a, b] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast / reserved
  return false
}

function isPrivateIpv6(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, '').toLowerCase()
  if (clean === '::1' || clean === '::' || clean === '0:0:0:0:0:0:0:1') return true
  if (clean.startsWith('fc') || clean.startsWith('fd')) return true // unique local
  if (clean.startsWith('fe8') || clean.startsWith('fe9') || clean.startsWith('fea') || clean.startsWith('feb')) {
    return true // link-local
  }
  if (clean.startsWith('::ffff:')) {
    const mapped = clean.slice('::ffff:'.length)
    if (isIP(mapped) === 4) return isPrivateIpv4(mapped)
  }
  return false
}

/**
 * Validate a user-supplied QR gateway base URL.
 * Enforces HTTPS and blocks loopback, private network ranges, and cloud
 * metadata addresses to prevent SSRF.
 */
export function validateQrGatewayUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    throw new Error('A URL do gateway WhatsApp Web é obrigatória.')
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('URL do gateway inválida. Use um endereço completo como https://sua-api.seudominio.com.')
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('A URL do gateway deve usar HTTPS (https://...).')
  }

  if (parsed.username || parsed.password) {
    throw new Error('A URL do gateway não deve conter usuário ou senha embutidos.')
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host || BLOCKED_HOSTNAMES.has(host)) {
    throw new Error('Endereços locais ou internos não são permitidos como URL do gateway.')
  }

  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    throw new Error('Endereços de rede interna (.local / .internal) não são permitidos.')
  }

  const ipVersion = isIP(host)
  if (ipVersion === 4 && isPrivateIpv4(host)) {
    throw new Error('Endereços IP privados ou de loopback não são permitidos como URL do gateway.')
  }
  if (ipVersion === 6 && isPrivateIpv6(host)) {
    throw new Error('Endereços IPv6 privados ou de loopback não são permitidos como URL do gateway.')
  }

  // Strip trailing slashes so endpoint joins stay predictable.
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * Normalize a QR payload returned by a gateway into a renderable PNG data URL.
 * Accepts already-formatted `data:image/...`, raw base64 PNG strings, or raw
 * WhatsApp pairing QR text (converted via `qrcode`).
 */
export async function normalizeQrToDataUrl(raw: string | null | undefined): Promise<string | null> {
  if (!raw || typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (trimmed.startsWith('data:image/')) {
    return trimmed
  }

  // Evolution API sometimes returns raw base64 PNG without the data URI prefix.
  if (trimmed.startsWith('iVBORw0KGgo')) {
    return `data:image/png;base64,${trimmed}`
  }

  return QRCode.toDataURL(trimmed, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: 'M',
  })
}

async function gatewayFetch(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null; rawText: string }> {
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
    redirect: 'error',
  })
  const rawText = await res.text().catch(() => '')
  let data: Record<string, unknown> | null = null
  try {
    const parsed = JSON.parse(rawText)
    if (parsed && typeof parsed === 'object') {
      data = parsed as Record<string, unknown>
    }
  } catch {
    // Non-JSON payload (e.g. PNG binary or plain text)
  }
  return { ok: res.ok, status: res.status, data, rawText }
}

function evolutionHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers.apikey = apiKey
  return headers
}

function wahaHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (apiKey) headers['X-Api-Key'] = apiKey
  return headers
}

function extractPhoneFromJid(jid: unknown): string | null {
  if (typeof jid !== 'string') return null
  const clean = jid.split('@')[0]?.split(':')[0] ?? ''
  const digits = normalizePhone(clean)
  return digits.length >= 8 ? digits : null
}

function mapConnectionState(raw: unknown): QrConnectionStatus {
  const value = typeof raw === 'string' ? raw.toLowerCase().trim() : ''
  if (value === 'open' || value === 'working' || value === 'connected') {
    return 'connected'
  }
  if (
    value === 'connecting' ||
    value === 'scan_qr_code' ||
    value === 'qr' ||
    value === 'qr_ready' ||
    value === 'starting'
  ) {
    return 'qr_ready'
  }
  return 'disconnected'
}

/**
 * Connect / initialize a WhatsApp Web session on the configured gateway
 * and retrieve a scannable QR code when not yet authenticated.
 */
export async function connectQrInstance(
  cfg: QrGatewayConfig,
  webhookUrl?: string,
  webhookSecret?: string,
): Promise<QrConnectResult> {
  const baseUrl = validateQrGatewayUrl(cfg.apiUrl)
  const instance = encodeURIComponent(cfg.instanceName.trim() || 'wacrm')

  if (cfg.provider === 'evolution') {
    const headers = evolutionHeaders(cfg.apiKey)

    // Best-effort create instance (idempotent if it already exists).
    const createBody: Record<string, unknown> = {
      instanceName: cfg.instanceName.trim() || 'wacrm',
      qrcode: true,
      integration: 'WHATSAPP-BAILEYS',
    }
    if (webhookUrl) {
      createBody.webhook = {
        url: webhookUrl,
        byEvents: false,
        base64: false,
        headers: webhookSecret ? { 'x-webhook-secret': webhookSecret } : undefined,
        events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
      }
    }

    const createRes = await gatewayFetch(`${baseUrl}/instance/create`, {
      method: 'POST',
      headers,
      body: JSON.stringify(createBody),
    }).catch(() => null)

    const createQr =
      (createRes?.data?.qrcode as Record<string, unknown> | undefined)?.base64 ??
      (createRes?.data?.qrcode as Record<string, unknown> | undefined)?.code
    if (typeof createQr === 'string' && createQr.trim()) {
      return {
        status: 'qr_ready',
        qrCodeDataUrl: await normalizeQrToDataUrl(createQr),
        pairingCode:
          typeof (createRes?.data?.qrcode as Record<string, unknown> | undefined)?.pairingCode === 'string'
            ? ((createRes?.data?.qrcode as Record<string, unknown>).pairingCode as string)
            : null,
        phoneNumber: null,
      }
    }

    // Best-effort sync webhook URL onto existing instance.
    if (webhookUrl) {
      await gatewayFetch(`${baseUrl}/webhook/set/${instance}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          enabled: true,
          url: webhookUrl,
          webhookByEvents: false,
          webhookBase64: false,
          headers: webhookSecret ? { 'x-webhook-secret': webhookSecret } : undefined,
          events: ['MESSAGES_UPSERT', 'CONNECTION_UPDATE', 'QRCODE_UPDATED'],
        }),
      }).catch(() => null)
    }

    // Request live QR code / connection info.
    const connectRes = await gatewayFetch(`${baseUrl}/instance/connect/${instance}`, {
      method: 'GET',
      headers,
    })

    if (!connectRes.ok) {
      const detail =
        (connectRes.data?.message as string) ||
        (connectRes.data?.error as string) ||
        `HTTP ${connectRes.status}`
      throw new Error(`Evolution API recusou a conexão: ${detail}`)
    }

    const d = connectRes.data ?? {}
    const nestedInstance = d.instance as Record<string, unknown> | undefined
    const state = mapConnectionState(nestedInstance?.state ?? d.state)
    const rawQr =
      (typeof d.base64 === 'string' && d.base64) ||
      (typeof d.code === 'string' && d.code) ||
      (typeof (d.qrcode as Record<string, unknown> | undefined)?.base64 === 'string'
        ? ((d.qrcode as Record<string, unknown>).base64 as string)
        : null)

    if (state === 'connected') {
      return {
        status: 'connected',
        qrCodeDataUrl: null,
        pairingCode: null,
        phoneNumber: extractPhoneFromJid(nestedInstance?.owner ?? d.owner),
      }
    }

    return {
      status: rawQr ? 'qr_ready' : state,
      qrCodeDataUrl: await normalizeQrToDataUrl(rawQr),
      pairingCode: typeof d.pairingCode === 'string' ? d.pairingCode : null,
      phoneNumber: extractPhoneFromJid(nestedInstance?.owner ?? d.owner),
    }
  }

  if (cfg.provider === 'waha') {
    const headers = wahaHeaders(cfg.apiKey)
    const session = cfg.instanceName.trim() || 'default'

    // Ensure session exists & starts with CRM webhook configured.
    await gatewayFetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: session,
        start: true,
        config: webhookUrl
          ? {
              webhooks: [
                {
                  url: webhookUrl,
                  events: ['message', 'session.status'],
                  customHeaders: webhookSecret
                    ? [{ name: 'x-webhook-secret', value: webhookSecret }]
                    : [],
                },
              ],
            }
          : undefined,
      }),
    }).catch(() => null)

    await gatewayFetch(`${baseUrl}/api/sessions/${encodeURIComponent(session)}/start`, {
      method: 'POST',
      headers,
    }).catch(() => null)

    const qrRes = await gatewayFetch(
      `${baseUrl}/api/${encodeURIComponent(session)}/auth/qr?format=raw`,
      {
        method: 'GET',
        headers: { ...headers, Accept: 'application/json' },
      },
    )

    if (qrRes.ok && qrRes.data) {
      const value =
        (typeof qrRes.data.value === 'string' && qrRes.data.value) ||
        (typeof qrRes.data.data === 'string' && qrRes.data.data) ||
        null
      if (value) {
        return {
          status: 'qr_ready',
          qrCodeDataUrl: await normalizeQrToDataUrl(value),
          pairingCode: null,
          phoneNumber: null,
        }
      }
    }

    // Check if already connected
    const status = await fetchQrInstanceStatus(cfg)
    return {
      status: status.status,
      qrCodeDataUrl: status.qrCodeDataUrl,
      pairingCode: null,
      phoneNumber: status.phoneNumber,
    }
  }

  // Custom Webhook / Baileys HTTP Bridge
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`
    headers['x-api-key'] = cfg.apiKey
  }
  const res = await gatewayFetch(`${baseUrl}/connect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      instance: cfg.instanceName.trim() || 'wacrm',
      webhookUrl,
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Gateway personalizado retornou HTTP ${res.status}. Verifique se o endpoint /connect está ativo.`,
    )
  }
  const d = res.data ?? {}
  const rawQr =
    (typeof d.qrCodeDataUrl === 'string' && d.qrCodeDataUrl) ||
    (typeof d.qr === 'string' && d.qr) ||
    (typeof d.base64 === 'string' && d.base64) ||
    (typeof d.code === 'string' && d.code) ||
    null
  const status = mapConnectionState(d.status ?? (rawQr ? 'qr_ready' : 'disconnected'))
  return {
    status,
    qrCodeDataUrl: await normalizeQrToDataUrl(rawQr),
    pairingCode: typeof d.pairingCode === 'string' ? d.pairingCode : null,
    phoneNumber: extractPhoneFromJid(d.phoneNumber ?? d.phone),
  }
}

export async function fetchQrInstanceStatus(cfg: QrGatewayConfig): Promise<QrStatusResult> {
  const baseUrl = validateQrGatewayUrl(cfg.apiUrl)
  const instance = encodeURIComponent(cfg.instanceName.trim() || 'wacrm')

  if (cfg.provider === 'evolution') {
    const res = await gatewayFetch(`${baseUrl}/instance/connectionState/${instance}`, {
      method: 'GET',
      headers: evolutionHeaders(cfg.apiKey),
    })
    if (!res.ok) {
      return { status: 'disconnected', phoneNumber: null, qrCodeDataUrl: null }
    }
    const inst = (res.data?.instance as Record<string, unknown> | undefined) ?? res.data ?? {}
    const rawState = String(inst.state ?? '')
    return {
      status: mapConnectionState(rawState),
      phoneNumber: extractPhoneFromJid(inst.owner ?? res.data?.owner),
      qrCodeDataUrl: null,
      rawState,
    }
  }

  if (cfg.provider === 'waha') {
    const res = await gatewayFetch(`${baseUrl}/api/sessions/${instance}`, {
      method: 'GET',
      headers: wahaHeaders(cfg.apiKey),
    })
    if (!res.ok) {
      return { status: 'disconnected', phoneNumber: null, qrCodeDataUrl: null }
    }
    const rawState = String(res.data?.status ?? '')
    const me = res.data?.me as Record<string, unknown> | undefined
    return {
      status: mapConnectionState(rawState),
      phoneNumber: extractPhoneFromJid(me?.id),
      qrCodeDataUrl: null,
      rawState,
    }
  }

  const headers: Record<string, string> = {}
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`
    headers['x-api-key'] = cfg.apiKey
  }
  const res = await gatewayFetch(`${baseUrl}/status?instance=${instance}`, {
    method: 'GET',
    headers,
  })
  if (!res.ok) {
    return { status: 'disconnected', phoneNumber: null, qrCodeDataUrl: null }
  }
  const d = res.data ?? {}
  return {
    status: mapConnectionState(d.status),
    phoneNumber: extractPhoneFromJid(d.phoneNumber ?? d.phone),
    qrCodeDataUrl: null,
    rawState: typeof d.status === 'string' ? d.status : undefined,
  }
}

export async function disconnectQrInstance(cfg: QrGatewayConfig): Promise<void> {
  const baseUrl = validateQrGatewayUrl(cfg.apiUrl)
  const instance = encodeURIComponent(cfg.instanceName.trim() || 'wacrm')

  if (cfg.provider === 'evolution') {
    await gatewayFetch(`${baseUrl}/instance/logout/${instance}`, {
      method: 'DELETE',
      headers: evolutionHeaders(cfg.apiKey),
    })
    return
  }

  if (cfg.provider === 'waha') {
    await gatewayFetch(`${baseUrl}/api/sessions/${instance}/logout`, {
      method: 'POST',
      headers: wahaHeaders(cfg.apiKey),
    })
    return
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`
    headers['x-api-key'] = cfg.apiKey
  }
  await gatewayFetch(`${baseUrl}/disconnect`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ instance: cfg.instanceName.trim() || 'wacrm' }),
  })
}

export async function sendQrTextMessage(args: {
  config: QrGatewayConfig
  to: string
  text: string
}): Promise<{ messageId: string }> {
  const baseUrl = validateQrGatewayUrl(args.config.apiUrl)
  const instance = encodeURIComponent(args.config.instanceName.trim() || 'wacrm')
  const phone = normalizePhone(args.to)
  if (!phone) {
    throw new Error('Número de destino inválido para envio via WhatsApp Web.')
  }

  if (args.config.provider === 'evolution') {
    const res = await gatewayFetch(`${baseUrl}/message/sendText/${instance}`, {
      method: 'POST',
      headers: evolutionHeaders(args.config.apiKey),
      body: JSON.stringify({
        number: phone,
        text: args.text,
      }),
    })
    if (!res.ok) {
      const detail =
        (res.data?.message as string) ||
        (res.data?.error as string) ||
        `HTTP ${res.status}`
      throw new Error(`Evolution API erro ao enviar mensagem: ${detail}`)
    }
    const key = res.data?.key as Record<string, unknown> | undefined
    const id =
      (typeof key?.id === 'string' && key.id) ||
      (typeof res.data?.id === 'string' && res.data.id) ||
      `qr_${Date.now()}`
    return { messageId: id }
  }

  if (args.config.provider === 'waha') {
    const res = await gatewayFetch(`${baseUrl}/api/sendText`, {
      method: 'POST',
      headers: wahaHeaders(args.config.apiKey),
      body: JSON.stringify({
        session: args.config.instanceName.trim() || 'default',
        chatId: `${phone}@c.us`,
        text: args.text,
      }),
    })
    if (!res.ok) {
      const detail =
        (res.data?.message as string) ||
        (res.data?.error as string) ||
        `HTTP ${res.status}`
      throw new Error(`WAHA erro ao enviar mensagem: ${detail}`)
    }
    const id =
      (typeof res.data?.id === 'string' && res.data.id) ||
      (typeof (res.data?.id as Record<string, unknown> | undefined)?._serialized === 'string'
        ? ((res.data?.id as Record<string, unknown>)._serialized as string)
        : `qr_${Date.now()}`)
    return { messageId: id }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (args.config.apiKey) {
    headers.Authorization = `Bearer ${args.config.apiKey}`
    headers['x-api-key'] = args.config.apiKey
  }
  const res = await gatewayFetch(`${baseUrl}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      instance: args.config.instanceName.trim() || 'wacrm',
      to: phone,
      type: 'text',
      text: args.text,
    }),
  })
  if (!res.ok) {
    throw new Error(`Gateway QR retornou HTTP ${res.status} ao enviar texto.`)
  }
  const id =
    (typeof res.data?.messageId === 'string' && res.data.messageId) ||
    (typeof res.data?.id === 'string' && res.data.id) ||
    `qr_${Date.now()}`
  return { messageId: id }
}

export async function sendQrMediaMessage(args: {
  config: QrGatewayConfig
  to: string
  kind: 'image' | 'video' | 'document' | 'audio'
  mediaUrl: string
  caption?: string
  filename?: string
}): Promise<{ messageId: string }> {
  const baseUrl = validateQrGatewayUrl(args.config.apiUrl)
  const instance = encodeURIComponent(args.config.instanceName.trim() || 'wacrm')
  const phone = normalizePhone(args.to)
  if (!phone) {
    throw new Error('Número de destino inválido para envio de mídia via WhatsApp Web.')
  }

  if (args.config.provider === 'evolution') {
    const endpoint =
      args.kind === 'audio'
        ? `${baseUrl}/message/sendWhatsAppAudio/${instance}`
        : `${baseUrl}/message/sendMedia/${instance}`
    const payload =
      args.kind === 'audio'
        ? { number: phone, audio: args.mediaUrl }
        : {
            number: phone,
            mediatype: args.kind,
            media: args.mediaUrl,
            caption: args.caption || undefined,
            fileName: args.filename || undefined,
          }

    const res = await gatewayFetch(endpoint, {
      method: 'POST',
      headers: evolutionHeaders(args.config.apiKey),
      body: JSON.stringify(payload),
    })
    if (!res.ok) {
      throw new Error(`Evolution API erro ao enviar mídia: HTTP ${res.status}`)
    }
    const key = res.data?.key as Record<string, unknown> | undefined
    return {
      messageId: (typeof key?.id === 'string' && key.id) || `qr_${Date.now()}`,
    }
  }

  if (args.config.provider === 'waha') {
    const endpoint =
      args.kind === 'image'
        ? `${baseUrl}/api/sendImage`
        : args.kind === 'audio'
          ? `${baseUrl}/api/sendVoice`
          : `${baseUrl}/api/sendFile`

    const res = await gatewayFetch(endpoint, {
      method: 'POST',
      headers: wahaHeaders(args.config.apiKey),
      body: JSON.stringify({
        session: args.config.instanceName.trim() || 'default',
        chatId: `${phone}@c.us`,
        file: {
          url: args.mediaUrl,
          filename: args.filename || undefined,
        },
        caption: args.caption || undefined,
      }),
    })
    if (!res.ok) {
      throw new Error(`WAHA erro ao enviar mídia: HTTP ${res.status}`)
    }
    return {
      messageId:
        (typeof res.data?.id === 'string' && res.data.id) || `qr_${Date.now()}`,
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (args.config.apiKey) {
    headers.Authorization = `Bearer ${args.config.apiKey}`
    headers['x-api-key'] = args.config.apiKey
  }
  const res = await gatewayFetch(`${baseUrl}/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      instance: args.config.instanceName.trim() || 'wacrm',
      to: phone,
      type: args.kind,
      mediaUrl: args.mediaUrl,
      caption: args.caption || undefined,
      filename: args.filename || undefined,
    }),
  })
  if (!res.ok) {
    throw new Error(`Gateway QR retornou HTTP ${res.status} ao enviar mídia.`)
  }
  return {
    messageId:
      (typeof res.data?.messageId === 'string' && res.data.messageId) ||
      `qr_${Date.now()}`,
  }
}

/**
 * Parse inbound webhook payloads from Evolution API v2, WAHA, or
 * custom Baileys/n8n JSON webhooks into a single normalized event.
 */
export function parseQrWebhookPayload(body: unknown): ParsedQrWebhookEvent {
  if (!body || typeof body !== 'object') {
    return { kind: 'ignored', reason: 'invalid_payload' }
  }
  const payload = body as Record<string, unknown>
  const event = typeof payload.event === 'string' ? payload.event.toLowerCase() : ''

  // 1. Evolution API v2 connection updates
  if (event === 'connection.update' || event === 'connection_update') {
    const data = (payload.data as Record<string, unknown> | undefined) ?? {}
    return {
      kind: 'connection',
      status: mapConnectionState(data.state ?? data.status),
      phoneNumber: extractPhoneFromJid(data.wuid ?? data.owner ?? payload.sender),
    }
  }

  // 2. WAHA session status updates
  if (event === 'session.status') {
    const data = (payload.payload as Record<string, unknown> | undefined) ?? {}
    const me = payload.me as Record<string, unknown> | undefined
    return {
      kind: 'connection',
      status: mapConnectionState(data.status),
      phoneNumber: extractPhoneFromJid(me?.id),
    }
  }

  // 3. Evolution API v2 inbound messages (`messages.upsert`)
  if (event === 'messages.upsert' || event === 'messages_upsert') {
    const data = (payload.data as Record<string, unknown> | undefined) ?? {}
    const key = (data.key as Record<string, unknown> | undefined) ?? {}
    if (key.fromMe === true) {
      return { kind: 'ignored', reason: 'from_me' }
    }
    const remoteJid = typeof key.remoteJid === 'string' ? key.remoteJid : ''
    if (!remoteJid || remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') {
      return { kind: 'ignored', reason: 'group_or_status' }
    }
    const fromPhone = extractPhoneFromJid(remoteJid)
    if (!fromPhone) {
      return { kind: 'ignored', reason: 'invalid_sender' }
    }

    const msg = (data.message as Record<string, unknown> | undefined) ?? {}
    let contentType: QrInboundMessageEvent['contentType'] = 'text'
    let contentText: string | null = null
    let mediaUrl: string | null = null

    if (typeof msg.conversation === 'string') {
      contentText = msg.conversation
    } else if (
      msg.extendedTextMessage &&
      typeof (msg.extendedTextMessage as Record<string, unknown>).text === 'string'
    ) {
      contentText = (msg.extendedTextMessage as Record<string, unknown>).text as string
    } else if (msg.imageMessage && typeof msg.imageMessage === 'object') {
      contentType = 'image'
      const img = msg.imageMessage as Record<string, unknown>
      contentText = typeof img.caption === 'string' ? img.caption : null
      mediaUrl = typeof img.url === 'string' ? img.url : null
    } else if (msg.videoMessage && typeof msg.videoMessage === 'object') {
      contentType = 'video'
      const vid = msg.videoMessage as Record<string, unknown>
      contentText = typeof vid.caption === 'string' ? vid.caption : null
      mediaUrl = typeof vid.url === 'string' ? vid.url : null
    } else if (msg.audioMessage && typeof msg.audioMessage === 'object') {
      contentType = 'audio'
      const aud = msg.audioMessage as Record<string, unknown>
      mediaUrl = typeof aud.url === 'string' ? aud.url : null
    } else if (msg.documentMessage && typeof msg.documentMessage === 'object') {
      contentType = 'document'
      const doc = msg.documentMessage as Record<string, unknown>
      contentText = typeof doc.caption === 'string' ? doc.caption : (typeof doc.fileName === 'string' ? doc.fileName : null)
      mediaUrl = typeof doc.url === 'string' ? doc.url : null
    }

    if (!contentText && !mediaUrl) {
      return { kind: 'ignored', reason: 'empty_message' }
    }

    return {
      kind: 'message',
      fromPhone,
      contactName: typeof data.pushName === 'string' && data.pushName.trim() ? data.pushName.trim() : null,
      messageId: typeof key.id === 'string' && key.id ? key.id : `qr_evo_${Date.now()}`,
      contentType,
      contentText,
      mediaUrl,
      timestamp: new Date().toISOString(),
    }
  }

  // 4. WAHA inbound messages (`message` / `message.any`)
  if (event === 'message' || event === 'message.any') {
    const data = (payload.payload as Record<string, unknown> | undefined) ?? {}
    if (data.fromMe === true) {
      return { kind: 'ignored', reason: 'from_me' }
    }
    const rawFrom = typeof data.from === 'string' ? data.from : ''
    if (!rawFrom || rawFrom.endsWith('@g.us') || rawFrom === 'status@broadcast') {
      return { kind: 'ignored', reason: 'group_or_status' }
    }
    const fromPhone = extractPhoneFromJid(rawFrom)
    if (!fromPhone) {
      return { kind: 'ignored', reason: 'invalid_sender' }
    }

    const media = data.media as Record<string, unknown> | undefined
    const mediaUrl = typeof media?.url === 'string' ? media.url : null
    const mime = typeof media?.mimetype === 'string' ? media.mimetype : ''
    let contentType: QrInboundMessageEvent['contentType'] = 'text'
    if (mediaUrl) {
      if (mime.startsWith('image/')) contentType = 'image'
      else if (mime.startsWith('video/')) contentType = 'video'
      else if (mime.startsWith('audio/')) contentType = 'audio'
      else contentType = 'document'
    }
    const contentText = typeof data.body === 'string' && data.body.trim() ? data.body.trim() : null
    if (!contentText && !mediaUrl) {
      return { kind: 'ignored', reason: 'empty_message' }
    }

    const notifyName =
      (data._data as Record<string, unknown> | undefined)?.notifyName ?? data.pushName
    return {
      kind: 'message',
      fromPhone,
      contactName: typeof notifyName === 'string' && notifyName.trim() ? notifyName.trim() : null,
      messageId: typeof data.id === 'string' && data.id ? data.id : `qr_waha_${Date.now()}`,
      contentType,
      contentText,
      mediaUrl,
      timestamp: new Date().toISOString(),
    }
  }

  // 5. Generic / Custom Webhook format: { from, name?, text?, messageId?, mediaUrl?, mediaType? }
  if (typeof payload.from === 'string') {
    if (payload.fromMe === true) {
      return { kind: 'ignored', reason: 'from_me' }
    }
    const fromPhone = extractPhoneFromJid(payload.from)
    if (!fromPhone) {
      return { kind: 'ignored', reason: 'invalid_sender' }
    }
    const text =
      typeof payload.text === 'string' && payload.text.trim()
        ? payload.text.trim()
        : typeof payload.body === 'string' && payload.body.trim()
          ? payload.body.trim()
          : null
    const mediaUrl = typeof payload.mediaUrl === 'string' && payload.mediaUrl.trim() ? payload.mediaUrl.trim() : null
    const rawType = typeof payload.mediaType === 'string' ? payload.mediaType : 'text'
    const contentType: QrInboundMessageEvent['contentType'] =
      rawType === 'image' || rawType === 'video' || rawType === 'document' || rawType === 'audio'
        ? rawType
        : 'text'
    if (!text && !mediaUrl) {
      return { kind: 'ignored', reason: 'empty_message' }
    }
    return {
      kind: 'message',
      fromPhone,
      contactName:
        typeof payload.name === 'string' && payload.name.trim()
          ? payload.name.trim()
          : null,
      messageId:
        typeof payload.messageId === 'string' && payload.messageId
          ? payload.messageId
          : `qr_custom_${Date.now()}`,
      contentType,
      contentText: text,
      mediaUrl,
      timestamp: new Date().toISOString(),
    }
  }

  return { kind: 'ignored', reason: 'unrecognized_event' }
}
