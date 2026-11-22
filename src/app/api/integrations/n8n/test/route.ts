import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { dispatchN8nEvent } from '@/lib/n8n/events'

export async function POST() {
  try {
    const ctx = await requireRole('admin')
    const result = await dispatchN8nEvent({
      accountId: ctx.accountId,
      event: 'test.ping',
      force: true,
      payload: {
        message: 'Ping de teste enviado pelo WhatsApp CRM Hub n8n',
        account_name: ctx.account.name,
        tested_by: ctx.userId,
      },
    })

    if (!result.sent) {
      return NextResponse.json(
        {
          ok: false,
          status: result.status ?? null,
          latencyMs: result.latencyMs ?? null,
          error: result.error ?? 'Falha ao enviar teste para o n8n.',
        },
        { status: 400 },
      )
    }

    return NextResponse.json({
      ok: true,
      status: result.status ?? 200,
      latencyMs: result.latencyMs ?? 0,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
