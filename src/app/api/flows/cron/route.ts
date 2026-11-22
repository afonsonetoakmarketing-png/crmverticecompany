import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRunTimeout, markRunTimedOut } from '@/lib/flows/timeout'
import { verifyCronRequest } from '@/lib/cron/auth'

const TIMEOUT_SWEEP_PAGE_SIZE = 500
const TIMEOUT_SWEEP_MAX_PAGES = 20

interface TimedOutRunRow {
  id: string
  last_advanced_at: string
  fallback_policy: unknown
}

/**
 * Sweep abandoned active flow runs.
 *
 * Reads each active run's parent-flow `fallback_policy.on_timeout_hours`
 * to compute the staleness cutoff (default 24h), then marks any run
 * past its cutoff as `timed_out`. Writes a matching `flow_run_events`
 * row for the audit trail.
 *
 * Auth: accepts Vercel Cron's `Authorization: Bearer <CRON_SECRET>`
 * as well as the legacy `x-cron-secret: <AUTOMATION_CRON_SECRET>`.
 */
export async function GET(request: Request) {
  const auth = verifyCronRequest(request)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const admin = supabaseAdmin()
  const now = new Date()

  let swept = 0
  for (let page = 0; page < TIMEOUT_SWEEP_MAX_PAGES; page += 1) {
    const { data: runs, error } = await admin.rpc('list_timed_out_flow_runs', {
      p_now: now.toISOString(),
      p_limit: TIMEOUT_SWEEP_PAGE_SIZE,
    })
    if (error) {
      console.error('[flows-cron] timed-out run scan failed:', error.message)
      return NextResponse.json({ error: error.message, swept }, { status: 500 })
    }

    const rows = (runs ?? []) as TimedOutRunRow[]
    let sweptThisPage = 0
    for (const r of rows) {
      const check = checkRunTimeout(r.last_advanced_at, r.fallback_policy, now)
      if (!check.timedOut) continue
      if (await markRunTimedOut(admin, r.id, check, 'stale_sweep', now)) {
        sweptThisPage += 1
      }
    }
    swept += sweptThisPage

    if (rows.length < TIMEOUT_SWEEP_PAGE_SIZE || sweptThisPage === 0) break
  }

  return NextResponse.json({ swept })
}
