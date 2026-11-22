import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { isLocalHybridMode } from '@/lib/local-backend/mode'
import { supabaseAdmin } from '@/lib/automations/admin-client'

export interface EnvCheckItem {
  key: string
  category: 'core' | 'ai' | 'whatsapp' | 'cron'
  requiredForVercel: boolean
  configured: boolean
  hint: string
}

/**
 * Admin-only readiness inspector for GitHub + Vercel deployment.
 * Returns ONLY boolean presence flags — never exposes any secret values.
 */
export async function GET() {
  try {
    const ctx = await requireRole('admin')
    const db = supabaseAdmin()

    const [aiRow, waRow, n8nRow] = await Promise.all([
      db
        .from('ai_configs')
        .select('provider, is_active')
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      db
        .from('whatsapp_config')
        .select('connection_mode, phone_number_id, qr_status')
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      db
        .from('n8n_integrations')
        .select('is_active, webhook_url, inbound_token_hash')
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
    ])

    const checks: EnvCheckItem[] = [
      {
        key: 'NEXT_PUBLIC_SUPABASE_URL',
        category: 'core',
        requiredForVercel: true,
        configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim()),
        hint: 'URL do projeto Supabase para produção na Vercel',
      },
      {
        key: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        category: 'core',
        requiredForVercel: true,
        configured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()),
        hint: 'Chave pública (anon) do Supabase',
      },
      {
        key: 'SUPABASE_SERVICE_ROLE_KEY',
        category: 'core',
        requiredForVercel: true,
        configured: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()),
        hint: 'Chave service_role (servidor) para webhooks, automações e cron',
      },
      {
        key: 'ENCRYPTION_KEY',
        category: 'core',
        requiredForVercel: true,
        configured: Boolean(process.env.ENCRYPTION_KEY?.trim()),
        hint: 'Chave de 32 bytes (64 hex) para criptografia AES-256-GCM de credenciais',
      },
      {
        key: 'NEXT_PUBLIC_SITE_URL',
        category: 'core',
        requiredForVercel: true,
        configured: Boolean(process.env.NEXT_PUBLIC_SITE_URL?.trim()),
        hint: 'URL pública da Vercel (ex.: https://seu-crm.vercel.app)',
      },
      {
        key: 'CRON_SECRET',
        category: 'cron',
        requiredForVercel: true,
        configured: Boolean(
          process.env.CRON_SECRET?.trim() || process.env.AUTOMATION_CRON_SECRET?.trim(),
        ),
        hint: 'Segredo enviado automaticamente pelo Vercel Cron (Authorization: Bearer)',
      },
      {
        key: 'GEMINI_API_KEY',
        category: 'ai',
        requiredForVercel: false,
        configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
        hint: 'Chave opcional do Google Gemini no servidor (ou configure na aba Agente de IA)',
      },
      {
        key: 'META_APP_SECRET',
        category: 'whatsapp',
        requiredForVercel: false,
        configured: Boolean(process.env.META_APP_SECRET?.trim()),
        hint: 'Assinatura de webhooks da API Oficial da Meta (opcional se usar apenas QR Code)',
      },
    ]

    return NextResponse.json({
      runtime: {
        mode: isLocalHybridMode() ? 'local-hybrid' : 'supabase',
        isVercel: Boolean(process.env.VERCEL),
        siteUrl: process.env.NEXT_PUBLIC_SITE_URL?.trim() || null,
      },
      workspaceStatus: {
        aiConfigured: Boolean(aiRow.data),
        aiProvider: (aiRow.data?.provider as string | undefined) ?? null,
        whatsappMode: (waRow.data?.connection_mode as string | undefined) ?? null,
        whatsappConfigured: Boolean(
          waRow.data?.phone_number_id || waRow.data?.qr_status === 'connected',
        ),
        n8nConfigured: Boolean(n8nRow.data?.webhook_url || n8nRow.data?.inbound_token_hash),
        n8nActive: Boolean(n8nRow.data?.is_active),
      },
      checks,
      cronEndpoints: [
        { path: '/api/automations/cron', schedule: '0 9 * * *', authHeader: 'Authorization: Bearer <CRON_SECRET>' },
        { path: '/api/flows/cron', schedule: '0 9 * * *', authHeader: 'Authorization: Bearer <CRON_SECRET>' },
      ],
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
