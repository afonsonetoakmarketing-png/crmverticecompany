import { describe, expect, it } from 'vitest'
import { buildN8nTemplates } from './templates'

describe('buildN8nTemplates', () => {
  it('returns 4 valid n8n workflow templates pre-filled with normalized CRM origin', () => {
    const templates = buildN8nTemplates('https://meu-crm.vercel.app///')
    expect(templates).toHaveLength(4)

    for (const tpl of templates) {
      expect(tpl.id).toBeTruthy()
      expect(tpl.filename.endsWith('.json')).toBe(true)
      const wf = tpl.workflow as {
        name: string
        nodes: unknown[]
        connections: Record<string, unknown>
        settings: { executionOrder: string }
      }
      expect(wf.name).toBeTruthy()
      expect(Array.isArray(wf.nodes)).toBe(true)
      expect(wf.nodes.length).toBeGreaterThanOrEqual(3)
      expect(wf.connections).toBeTypeOf('object')
      expect(wf.settings.executionOrder).toBe('v1')
    }

    const serialized = JSON.stringify(templates)
    expect(serialized).toContain('https://meu-crm.vercel.app/api/integrations/n8n/webhook')
    expect(serialized).toContain('https://meu-crm.vercel.app/api/automations/cron')
    expect(serialized).toContain('https://meu-crm.vercel.app/api/flows/cron')
  })

  it('falls back to placeholder origin when omitted', () => {
    const templates = buildN8nTemplates()
    expect(JSON.stringify(templates)).toContain('https://seu-crm.vercel.app/api/integrations/n8n/webhook')
  })
})
