import { timingSafeEqual } from 'node:crypto'

export type CronAuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string }

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Verify a scheduled cron invocation.
 *
 * Accepts BOTH:
 * - Vercel Cron native header: `Authorization: Bearer <CRON_SECRET>`
 * - Legacy / external pinger / n8n Schedule Trigger header: `x-cron-secret: <AUTOMATION_CRON_SECRET>`
 *
 * Either `CRON_SECRET` or `AUTOMATION_CRON_SECRET` may be configured on the
 * server; if both are set, either secret is accepted so zero-downtime rotation
 * and mixed Vercel Cron + n8n pinger setups work seamlessly.
 */
export function verifyCronRequest(request: Request): CronAuthResult {
  const configuredSecrets = [
    process.env.CRON_SECRET?.trim(),
    process.env.AUTOMATION_CRON_SECRET?.trim(),
  ].filter((v): v is string => Boolean(v && v.length > 0))

  if (configuredSecrets.length === 0) {
    return { ok: false, status: 503, error: 'cron not configured' }
  }

  const candidates: string[] = []
  const legacyHeader = request.headers.get('x-cron-secret')?.trim()
  if (legacyHeader) candidates.push(legacyHeader)

  const authHeader = request.headers.get('authorization')?.trim()
  if (authHeader && /^Bearer\s+/i.test(authHeader)) {
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim()
    if (bearer) candidates.push(bearer)
  }

  if (candidates.length === 0) {
    return { ok: false, status: 401, error: 'Unauthorized' }
  }

  for (const supplied of candidates) {
    for (const expected of configuredSecrets) {
      if (constantTimeEquals(supplied, expected)) {
        return { ok: true }
      }
    }
  }

  return { ok: false, status: 401, error: 'Unauthorized' }
}
