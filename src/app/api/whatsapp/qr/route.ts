import crypto from 'node:crypto'
import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import {
  connectQrInstance,
  disconnectQrInstance,
  fetchQrInstanceStatus,
  validateQrGatewayUrl,
  type QrGatewayConfig,
  type QrGatewayProvider,
} from '@/lib/whatsapp/qr-gateway'

const VALID_PROVIDERS = new Set<QrGatewayProvider>([
  'evolution',
  'waha',
  'custom_webhook',
])

function resolveOrigin(request: Request): string {
  const envOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (envOrigin) {
    return envOrigin.replace(/\/+$/, '')
  }
  const url = new URL(request.url)
  const forwardedHost = request.headers.get('x-forwarded-host')
  const forwardedProto = request.headers.get('x-forwarded-proto') || 'https'
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, '')
  }
  return url.origin.replace(/\/+$/, '')
}

function buildWebhookUrl(origin: string, accountId: string): string {
  return `${origin}/api/whatsapp/qr/webhook?account=${encodeURIComponent(accountId)}`
}

function safeDecrypt(ciphertext: string | null | undefined): string {
  if (!ciphertext) return ''
  try {
    return decrypt(ciphertext)
  } catch {
    return ''
  }
}

/**
 * GET /api/whatsapp/qr
 *
 * Returns the account's WhatsApp Web (QR Code) settings and status without
 * exposing raw API keys. Pass `?poll=1` to check live status against the
 * configured QR gateway.
 */
export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount()
    const { searchParams } = new URL(request.url)
    const shouldPoll = searchParams.get('poll') === '1'

    const { data: row, error } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[whatsapp/qr GET] DB error:', error)
      return NextResponse.json(
        { error: 'Falha ao carregar configuração do WhatsApp QR Code.' },
        { status: 500 },
      )
    }

    const origin = resolveOrigin(request)
    const webhookUrl = buildWebhookUrl(origin, accountId)

    if (!row) {
      return NextResponse.json({
        configured: false,
        connection_mode: 'official_api',
        qr_provider: 'evolution',
        qr_api_url: '',
        qr_instance_name: 'wacrm',
        has_qr_api_key: false,
        has_webhook_secret: false,
        qr_status: 'disconnected',
        qr_phone_number: null,
        qr_connected_at: null,
        webhook_url: webhookUrl,
        webhook_secret: null,
      })
    }

    let qrStatus = (row.qr_status as string | null) || 'disconnected'
    let qrPhone = (row.qr_phone_number as string | null) || null
    let qrConnectedAt = (row.qr_connected_at as string | null) || null

    if (
      shouldPoll &&
      row.qr_api_url &&
      row.qr_provider &&
      VALID_PROVIDERS.has(row.qr_provider as QrGatewayProvider)
    ) {
      try {
        const live = await fetchQrInstanceStatus({
          provider: row.qr_provider as QrGatewayProvider,
          apiUrl: row.qr_api_url,
          instanceName: row.qr_instance_name || 'wacrm',
          apiKey: safeDecrypt(row.qr_api_key),
        })
        qrStatus = live.status
        if (live.phoneNumber) qrPhone = live.phoneNumber
        if (live.status === 'connected' && !qrConnectedAt) {
          qrConnectedAt = new Date().toISOString()
        }
        await supabase
          .from('whatsapp_config')
          .update({
            qr_status: qrStatus,
            qr_phone_number: qrPhone,
            qr_connected_at: qrConnectedAt,
            ...(row.connection_mode === 'qr_code'
              ? { status: qrStatus === 'connected' ? 'connected' : 'disconnected' }
              : {}),
          })
          .eq('account_id', accountId)
      } catch (err) {
        console.warn(
          '[whatsapp/qr GET] poll failed:',
          err instanceof Error ? err.message : err,
        )
      }
    }

    const decryptedSecret = safeDecrypt(row.qr_webhook_secret)

    return NextResponse.json({
      configured: Boolean(row.qr_api_url || row.qr_webhook_secret),
      connection_mode: row.connection_mode || 'official_api',
      qr_provider: row.qr_provider || 'evolution',
      qr_api_url: row.qr_api_url || '',
      qr_instance_name: row.qr_instance_name || 'wacrm',
      has_qr_api_key: Boolean(row.qr_api_key),
      has_webhook_secret: Boolean(decryptedSecret),
      qr_status: qrStatus,
      qr_phone_number: qrPhone,
      qr_connected_at: qrConnectedAt,
      webhook_url: webhookUrl,
      // Returned to authenticated members so admins can configure the
      // gateway webhook without rotating it on every visit.
      webhook_secret: decryptedSecret || null,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/whatsapp/qr  (admin+)
 *
 * Actions:
 *  - `save`: persists gateway config + activates `qr_code` mode
 *  - `connect`: saves config + requests a live QR Code from the gateway
 *  - `status`: polls live status from the gateway
 *  - `disconnect`: logs out the WhatsApp Web session on the gateway
 *  - `activate_mode`: toggles active mode between `official_api` and `qr_code`
 *  - `rotate_secret`: generates a fresh webhook secret for inbound messages
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`whatsapp-qr:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Corpo da requisição inválido.' }, { status: 400 })
    }

    const action = typeof body.action === 'string' ? body.action : 'save'
    const origin = resolveOrigin(request)
    const webhookUrl = buildWebhookUrl(origin, accountId)

    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (action === 'activate_mode') {
      const nextMode = body.connection_mode === 'qr_code' ? 'qr_code' : 'official_api'
      if (existing) {
        const { error } = await supabase
          .from('whatsapp_config')
          .update({ connection_mode: nextMode })
          .eq('account_id', accountId)
        if (error) {
          return NextResponse.json({ error: 'Falha ao alternar modo de conexão.' }, { status: 500 })
        }
      }
      return NextResponse.json({ ok: true, connection_mode: nextMode })
    }

    if (action === 'rotate_secret') {
      const freshSecret = `wacrm_qr_${crypto.randomBytes(24).toString('hex')}`
      const encryptedSecret = encrypt(freshSecret)
      if (existing) {
        await supabase
          .from('whatsapp_config')
          .update({ qr_webhook_secret: encryptedSecret })
          .eq('account_id', accountId)
      } else {
        await supabase.from('whatsapp_config').insert({
          account_id: accountId,
          user_id: userId,
          phone_number_id: `qr:${accountId}`,
          access_token: encrypt('qr-mode-placeholder'),
          status: 'disconnected',
          connection_mode: 'qr_code',
          qr_provider: 'evolution',
          qr_instance_name: 'wacrm',
          qr_webhook_secret: encryptedSecret,
          qr_status: 'disconnected',
        })
      }
      return NextResponse.json({
        ok: true,
        webhook_url: webhookUrl,
        webhook_secret: freshSecret,
      })
    }

    if (action === 'disconnect') {
      if (existing?.qr_api_url && existing?.qr_provider) {
        try {
          await disconnectQrInstance({
            provider: existing.qr_provider as QrGatewayProvider,
            apiUrl: existing.qr_api_url,
            instanceName: existing.qr_instance_name || 'wacrm',
            apiKey: safeDecrypt(existing.qr_api_key),
          })
        } catch (err) {
          console.warn(
            '[whatsapp/qr disconnect] gateway logout error:',
            err instanceof Error ? err.message : err,
          )
        }
      }
      if (existing) {
        await supabase
          .from('whatsapp_config')
          .update({
            qr_status: 'disconnected',
            qr_phone_number: null,
            ...(existing.connection_mode === 'qr_code' ? { status: 'disconnected' } : {}),
          })
          .eq('account_id', accountId)
      }
      return NextResponse.json({ ok: true, qr_status: 'disconnected' })
    }

    if (action === 'status') {
      if (!existing?.qr_api_url || !existing?.qr_provider) {
        return NextResponse.json(
          { error: 'Salve a URL do gateway antes de verificar o status.' },
          { status: 400 },
        )
      }
      const live = await fetchQrInstanceStatus({
        provider: existing.qr_provider as QrGatewayProvider,
        apiUrl: existing.qr_api_url,
        instanceName: existing.qr_instance_name || 'wacrm',
        apiKey: safeDecrypt(existing.qr_api_key),
      })
      const connectedAt =
        live.status === 'connected'
          ? existing.qr_connected_at || new Date().toISOString()
          : existing.qr_connected_at || null

      await supabase
        .from('whatsapp_config')
        .update({
          qr_status: live.status,
          qr_phone_number: live.phoneNumber ?? existing.qr_phone_number ?? null,
          qr_connected_at: connectedAt,
          ...(existing.connection_mode === 'qr_code'
            ? { status: live.status === 'connected' ? 'connected' : 'disconnected' }
            : {}),
        })
        .eq('account_id', accountId)

      return NextResponse.json({
        ok: true,
        qr_status: live.status,
        qr_phone_number: live.phoneNumber ?? existing.qr_phone_number ?? null,
        qr_connected_at: connectedAt,
      })
    }

    // `save` or `connect`
    const providerRaw =
      typeof body.qr_provider === 'string'
        ? body.qr_provider
        : existing?.qr_provider || 'evolution'
    if (!VALID_PROVIDERS.has(providerRaw as QrGatewayProvider)) {
      return NextResponse.json({ error: 'Provedor QR inválido.' }, { status: 400 })
    }
    const provider = providerRaw as QrGatewayProvider

    const rawUrl =
      typeof body.qr_api_url === 'string'
        ? body.qr_api_url.trim()
        : existing?.qr_api_url || ''
    let validatedUrl = ''
    if (rawUrl) {
      try {
        validatedUrl = validateQrGatewayUrl(rawUrl)
      } catch (err) {
        return NextResponse.json(
          { error: err instanceof Error ? err.message : 'URL do gateway inválida.' },
          { status: 400 },
        )
      }
    } else if (action === 'connect') {
      return NextResponse.json(
        {
          error:
            'Informe a URL HTTPS do seu gateway WhatsApp Web (Evolution API ou WAHA) para gerar o QR Code.',
        },
        { status: 400 },
      )
    }

    const instanceName =
      typeof body.qr_instance_name === 'string' && body.qr_instance_name.trim()
        ? body.qr_instance_name.trim().slice(0, 80)
        : existing?.qr_instance_name || 'wacrm'

    const rawApiKey =
      typeof body.qr_api_key === 'string' ? body.qr_api_key.trim() : ''
    const plainApiKey = rawApiKey || safeDecrypt(existing?.qr_api_key)
    const encryptedApiKey = rawApiKey
      ? encrypt(rawApiKey)
      : existing?.qr_api_key || null

    let plainWebhookSecret = safeDecrypt(existing?.qr_webhook_secret)
    if (!plainWebhookSecret) {
      plainWebhookSecret = `wacrm_qr_${crypto.randomBytes(24).toString('hex')}`
    }
    const encryptedWebhookSecret = existing?.qr_webhook_secret
      ? existing.qr_webhook_secret
      : encrypt(plainWebhookSecret)

    const qrFields: Record<string, unknown> = {
      connection_mode: 'qr_code',
      qr_provider: provider,
      qr_api_url: validatedUrl || null,
      qr_instance_name: instanceName,
      qr_api_key: encryptedApiKey,
      qr_webhook_secret: encryptedWebhookSecret,
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('whatsapp_config')
        .update(qrFields)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[whatsapp/qr POST] update failed:', upErr)
        return NextResponse.json(
          { error: 'Falha ao salvar configuração QR Code.' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('whatsapp_config').insert({
        account_id: accountId,
        user_id: userId,
        phone_number_id: `qr:${accountId}`,
        access_token: encrypt('qr-mode-placeholder'),
        status: 'disconnected',
        qr_status: 'disconnected',
        ...qrFields,
      })
      if (insErr) {
        console.error('[whatsapp/qr POST] insert failed:', insErr)
        return NextResponse.json(
          { error: 'Falha ao criar configuração QR Code.' },
          { status: 500 },
        )
      }
    }

    if (action === 'save') {
      return NextResponse.json({
        ok: true,
        connection_mode: 'qr_code',
        qr_provider: provider,
        qr_api_url: validatedUrl,
        qr_instance_name: instanceName,
        qr_status: existing?.qr_status || 'disconnected',
        webhook_url: webhookUrl,
        webhook_secret: plainWebhookSecret,
      })
    }

    // action === 'connect': contact gateway and return scannable QR Code
    const gatewayCfg: QrGatewayConfig = {
      provider,
      apiUrl: validatedUrl,
      instanceName,
      apiKey: plainApiKey,
    }

    let connectResult
    try {
      connectResult = await connectQrInstance(
        gatewayCfg,
        webhookUrl,
        plainWebhookSecret,
      )
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Não foi possível gerar o QR Code no gateway informado.',
        },
        { status: 502 },
      )
    }

    const connectedAt =
      connectResult.status === 'connected' ? new Date().toISOString() : null

    await supabase
      .from('whatsapp_config')
      .update({
        qr_status: connectResult.status,
        qr_phone_number: connectResult.phoneNumber,
        qr_connected_at: connectedAt,
        status: connectResult.status === 'connected' ? 'connected' : 'disconnected',
      })
      .eq('account_id', accountId)

    return NextResponse.json({
      ok: true,
      connection_mode: 'qr_code',
      qr_status: connectResult.status,
      qr_code_data_url: connectResult.qrCodeDataUrl,
      pairing_code: connectResult.pairingCode,
      qr_phone_number: connectResult.phoneNumber,
      webhook_url: webhookUrl,
      webhook_secret: plainWebhookSecret,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/whatsapp/qr (admin+)
 * Clears WhatsApp Web QR Code fields and switches back to official_api mode.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { data: existing } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json({ ok: true })
    }

    if (existing.qr_api_url && existing.qr_provider) {
      await disconnectQrInstance({
        provider: existing.qr_provider as QrGatewayProvider,
        apiUrl: existing.qr_api_url,
        instanceName: existing.qr_instance_name || 'wacrm',
        apiKey: safeDecrypt(existing.qr_api_key),
      }).catch(() => null)
    }

    const isQrOnlyRow =
      typeof existing.phone_number_id === 'string' &&
      existing.phone_number_id.startsWith('qr:')

    if (isQrOnlyRow) {
      await supabase
        .from('whatsapp_config')
        .delete()
        .eq('account_id', accountId)
    } else {
      await supabase
        .from('whatsapp_config')
        .update({
          connection_mode: 'official_api',
          qr_provider: null,
          qr_api_url: null,
          qr_instance_name: null,
          qr_api_key: null,
          qr_webhook_secret: null,
          qr_status: 'disconnected',
          qr_phone_number: null,
          qr_connected_at: null,
        })
        .eq('account_id', accountId)
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
