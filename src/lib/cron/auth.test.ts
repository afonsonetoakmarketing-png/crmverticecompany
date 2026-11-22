import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyCronRequest } from './auth'

describe('verifyCronRequest', () => {
  const origCron = process.env.CRON_SECRET
  const origAuto = process.env.AUTOMATION_CRON_SECRET

  beforeEach(() => {
    delete process.env.CRON_SECRET
    delete process.env.AUTOMATION_CRON_SECRET
  })

  afterEach(() => {
    if (origCron !== undefined) process.env.CRON_SECRET = origCron
    else delete process.env.CRON_SECRET
    if (origAuto !== undefined) process.env.AUTOMATION_CRON_SECRET = origAuto
    else delete process.env.AUTOMATION_CRON_SECRET
  })

  it('returns 503 when neither CRON_SECRET nor AUTOMATION_CRON_SECRET is set', () => {
    const req = new Request('https://example.com/api/automations/cron')
    expect(verifyCronRequest(req)).toEqual({
      ok: false,
      status: 503,
      error: 'cron not configured',
    })
  })

  it('accepts Vercel Cron native Authorization Bearer CRON_SECRET', () => {
    process.env.CRON_SECRET = 'vercel-secret-123'
    const req = new Request('https://example.com/api/automations/cron', {
      headers: { Authorization: 'Bearer vercel-secret-123' },
    })
    expect(verifyCronRequest(req)).toEqual({ ok: true })
  })

  it('accepts legacy x-cron-secret AUTOMATION_CRON_SECRET', () => {
    process.env.AUTOMATION_CRON_SECRET = 'legacy-secret-456'
    const req = new Request('https://example.com/api/flows/cron', {
      headers: { 'x-cron-secret': 'legacy-secret-456' },
    })
    expect(verifyCronRequest(req)).toEqual({ ok: true })
  })

  it('rejects wrong or missing tokens with 401', () => {
    process.env.CRON_SECRET = 'correct-secret'
    const missing = new Request('https://example.com/api/automations/cron')
    expect(verifyCronRequest(missing)).toEqual({
      ok: false,
      status: 401,
      error: 'Unauthorized',
    })

    const wrong = new Request('https://example.com/api/automations/cron', {
      headers: { Authorization: 'Bearer wrong-secret' },
    })
    expect(verifyCronRequest(wrong)).toEqual({
      ok: false,
      status: 401,
      error: 'Unauthorized',
    })
  })
})
