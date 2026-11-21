import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateContentMock = vi.fn()
const constructorCalls: unknown[] = []

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models = {
      generateContent: generateContentMock,
    }
    constructor(opts: unknown) {
      constructorCalls.push(opts)
    }
  }
  return { GoogleGenAI: MockGoogleGenAI }
})

const { generateGemini } = await import('./gemini')
const { AiError } = await import('../types')

describe('generateGemini provider adapter', () => {
  beforeEach(() => {
    generateContentMock.mockReset()
    constructorCalls.length = 0
  })

  it('calls @google/genai with User-Agent header, mapped roles, and normalizes usage', async () => {
    generateContentMock.mockResolvedValueOnce({
      text: 'Olá! Como posso ajudar hoje?',
      usageMetadata: {
        promptTokenCount: 24,
        candidatesTokenCount: 12,
        totalTokenCount: 36,
      },
    })

    const res = await generateGemini({
      apiKey: 'AIza-test-key',
      model: 'gemini-4-hydrogen',
      systemPrompt: 'Seja cordial e conciso.',
      messages: [
        { role: 'user', content: 'Oi' },
        { role: 'assistant', content: 'Olá!' },
        { role: 'user', content: 'Qual o horário?' },
      ],
      timeoutMs: 5000,
    })

    expect(constructorCalls[0]).toEqual({
      apiKey: 'AIza-test-key',
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    })
    expect(generateContentMock).toHaveBeenCalledWith({
      model: 'gemini-4-hydrogen',
      contents: [
        { role: 'user', parts: [{ text: 'Oi' }] },
        { role: 'model', parts: [{ text: 'Olá!' }] },
        { role: 'user', parts: [{ text: 'Qual o horário?' }] },
      ],
      config: { systemInstruction: 'Seja cordial e conciso.' },
    })
    expect(res).toEqual({
      text: 'Olá! Como posso ajudar hoje?',
      usage: { promptTokens: 24, completionTokens: 12, totalTokens: 36 },
    })
  })

  it('maps invalid key errors to AiError(invalid_key, 401)', async () => {
    const err = Object.assign(new Error('API_KEY_INVALID'), { status: 403 })
    generateContentMock.mockRejectedValueOnce(err)

    await expect(
      generateGemini({
        apiKey: 'AIza-bad',
        model: 'gemini-4-hydrogen',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'ping' }],
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      name: AiError.name,
      code: 'invalid_key',
      status: 401,
    })
  })

  it('maps quota exhaustion to AiError(rate_limited, 502)', async () => {
    const err = Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 })
    generateContentMock.mockRejectedValueOnce(err)

    await expect(
      generateGemini({
        apiKey: 'AIza-valid',
        model: 'gemini-4-hydrogen',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'ping' }],
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      code: 'rate_limited',
      status: 502,
    })
  })

  it('throws empty_response when Gemini returns blank text', async () => {
    generateContentMock.mockResolvedValueOnce({ text: '   ' })

    await expect(
      generateGemini({
        apiKey: 'AIza-valid',
        model: 'gemini-4-hydrogen',
        systemPrompt: '',
        messages: [{ role: 'user', content: 'ping' }],
        timeoutMs: 5000,
      }),
    ).rejects.toMatchObject({
      code: 'empty_response',
      status: 502,
    })
  })
})
