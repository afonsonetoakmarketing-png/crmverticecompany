import { GoogleGenAI, type Content } from '@google/genai'
import { AiError, type ProviderResult } from '../types'
import { mergeConsecutive, normalizeUsage, type ProviderArgs } from './shared'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

// ============================================================
// Google Gemini adapter using the official @google/genai SDK.
//
// Server-side only. Supports both bring-your-own Gemini API keys
// (stored encrypted per account) and optional server-level
// GEMINI_API_KEY fallback. Never sends deprecated sampling params
// (temperature/topP/topK/thinkingBudget) so Gemini 4 and Gemini 3
// models work cleanly out of the box.
// ============================================================

function extractErrorStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null
  const record = err as Record<string, unknown>
  if (typeof record.status === 'number') return record.status
  if (typeof record.statusCode === 'number') return record.statusCode
  if (record.error && typeof record.error === 'object') {
    const nested = record.error as Record<string, unknown>
    if (typeof nested.code === 'number') return nested.code
  }
  return null
}

function mapGeminiError(err: unknown): AiError {
  if (err instanceof AiError) return err

  const msg = err instanceof Error ? err.message : String(err)
  const lower = msg.toLowerCase()
  const status = extractErrorStatus(err)

  if (
    lower.includes('timeout') ||
    lower.includes('aborted') ||
    (err instanceof DOMException && err.name === 'TimeoutError')
  ) {
    return new AiError(t('ai.timeout'), {
      code: 'timeout',
      status: 504,
    })
  }

  if (
    status === 401 ||
    status === 403 ||
    lower.includes('api_key_invalid') ||
    lower.includes('api key not valid') ||
    lower.includes('permission_denied') ||
    lower.includes('unauthenticated')
  ) {
    const base = t('ai.invalidKey', { provider: 'Google Gemini' })
    return new AiError(msg ? `${base}: ${msg}` : base, {
      code: 'invalid_key',
      status: 401,
    })
  }

  if (
    status === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    const base = t('ai.rateLimited', { provider: 'Google Gemini' })
    return new AiError(msg ? `${base}: ${msg}` : base, {
      code: 'rate_limited',
      status: 502,
    })
  }

  if (status === 404 || lower.includes('not_found') || lower.includes('not found')) {
    const base = t('ai.apiError', { provider: 'Google Gemini', status: '404' })
    return new AiError(msg ? `${base}: ${msg}` : base, {
      code: 'provider_error',
      status: 502,
    })
  }

  if (status !== null && status >= 400) {
    const base = t('ai.apiError', {
      provider: 'Google Gemini',
      status: String(status),
    })
    return new AiError(msg ? `${base}: ${msg}` : base, {
      code: 'provider_error',
      status: 502,
    })
  }

  return new AiError(t('ai.unreachable', { message: msg }), {
    code: 'network_error',
    status: 502,
  })
}

function buildGeminiContents(args: ProviderArgs): Content[] {
  const merged = mergeConsecutive(args.messages)
  const contents: Content[] = merged.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: 'Hello' }] })
  }
  return contents
}

export async function generateGemini(
  args: ProviderArgs,
): Promise<ProviderResult> {
  const apiKey = args.apiKey.trim() || process.env.GEMINI_API_KEY?.trim() || ''
  if (!apiKey) {
    throw new AiError(t('ai.invalidKey', { provider: 'Google Gemini' }), {
      code: 'invalid_key',
      status: 401,
    })
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  })

  const contents = buildGeminiContents(args)

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new AiError(t('ai.timeout'), {
            code: 'timeout',
            status: 504,
          }),
        )
      }, args.timeoutMs)
    })

    const response = await Promise.race([
      ai.models.generateContent({
        model: args.model,
        contents,
        config: args.systemPrompt
          ? { systemInstruction: args.systemPrompt }
          : undefined,
      }),
      timeoutPromise,
    ])

    const text = (response.text ?? '').trim()
    if (!text) {
      throw new AiError(t('ai.emptyResponse', { provider: 'Google Gemini' }), {
        code: 'empty_response',
        status: 502,
      })
    }

    const usage = normalizeUsage({
      prompt: response.usageMetadata?.promptTokenCount,
      completion: response.usageMetadata?.candidatesTokenCount,
      total: response.usageMetadata?.totalTokenCount,
    })

    return { text, usage }
  } catch (err) {
    throw mapGeminiError(err)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}
