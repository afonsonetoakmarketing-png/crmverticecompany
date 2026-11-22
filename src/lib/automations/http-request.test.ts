import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractJsonPath, executeHttpRequestStep } from './http-request'

vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async (url: string) => url.startsWith('https://api.public.test')),
}))

describe('extractJsonPath', () => {
  it('extracts nested object and array fields safely', () => {
    const sample = {
      data: {
        order: { status: 'enviado', code: 42 },
        items: [{ sku: 'SKU-1' }, { sku: 'SKU-2' }],
      },
    }
    expect(extractJsonPath(sample, 'data.order.status')).toBe('enviado')
    expect(extractJsonPath(sample, 'data.order.code')).toBe(42)
    expect(extractJsonPath(sample, 'data.items.1.sku')).toBe('SKU-2')
    expect(extractJsonPath(sample, 'data.missing.path')).toBeUndefined()
  })

  it('blocks prototype traversal segments', () => {
    const sample = { ok: true }
    expect(extractJsonPath(sample, '__proto__.polluted')).toBeUndefined()
    expect(extractJsonPath(sample, 'constructor.prototype')).toBeUndefined()
  })
})

describe('executeHttpRequestStep', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('blocks private or disallowed destinations before calling fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(
      executeHttpRequestStep({
        config: { method: 'GET', url: 'http://127.0.0.1:8080/internal' },
        interpolate: (s) => s,
      }),
    ).rejects.toThrow(/bloqueado/i)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('sends authenticated JSON request and extracts response mappings into vars', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { status: 'aprovado', eta: '2 dias' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await executeHttpRequestStep({
      config: {
        method: 'POST',
        url: 'https://api.public.test/orders?tel={{contact.phone}}',
        auth_type: 'bearer',
        auth_token: 'tok_live_abc',
        body_template: '{"nome":"{{contact.name}}"}',
        response_mappings: [
          { json_path: 'data.status', var_name: 'pedido_status' },
          { json_path: 'data.eta', var_name: 'prazo' },
        ],
      },
      interpolate: (s) =>
        s.replace('{{contact.phone}}', '5511999999999').replace('{{contact.name}}', 'Ana'),
    })

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.public.test/orders?tel=5511999999999')
    expect(init?.method).toBe('POST')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe('Bearer tok_live_abc')
    expect(init?.body).toBe('{"nome":"Ana"}')
    expect(result.status).toBe(200)
    expect(result.extractedVars).toEqual({
      pedido_status: 'aprovado',
      prazo: '2 dias',
    })
  })
})
