import type { HttpRequestStepConfig } from '@/types'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
const FORBIDDEN_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Safely extract a nested value from a parsed JSON response using dot notation
 * (e.g. `data.order.status` or `items.0.id`). Blocks prototype traversal keys.
 */
export function extractJsonPath(data: unknown, rawPath: string): unknown {
  const path = rawPath.trim()
  if (!path) return undefined
  const segments = path.split('.').filter(Boolean)
  let current: unknown = data

  for (const seg of segments) {
    if (FORBIDDEN_PATH_SEGMENTS.has(seg)) return undefined
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    if (Array.isArray(current)) {
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= current.length) return undefined
      current = current[idx]
    } else {
      const record = current as Record<string, unknown>
      if (!Object.prototype.hasOwnProperty.call(record, seg)) return undefined
      current = record[seg]
    }
  }

  return current
}

export interface HttpRequestExecutionResult {
  status: number
  extractedVars: Record<string, string>
  summary: string
}

/**
 * Execute an n8n-style `http_request` automation step with SSRF validation,
 * auth injection, variable interpolation, and JSON response mapping.
 */
export async function executeHttpRequestStep(args: {
  config: HttpRequestStepConfig
  interpolate: (template: string) => string
}): Promise<HttpRequestExecutionResult> {
  const { config, interpolate } = args
  const method = (config.method || 'POST').toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`http_request: método HTTP inválido (${method})`)
  }

  const resolvedUrl = interpolate(config.url || '').trim()
  if (!resolvedUrl) {
    throw new Error('http_request: URL obrigatória')
  }

  const allowed = await isDeliverableUrl(resolvedUrl)
  if (!allowed) {
    throw new Error('http_request: destino bloqueado por segurança (endereço privado ou esquema inválido)')
  }

  const headers: Record<string, string> = {}
  if (config.headers && typeof config.headers === 'object') {
    for (const [k, v] of Object.entries(config.headers)) {
      const cleanKey = k.trim()
      if (!cleanKey) continue
      headers[cleanKey] = interpolate(String(v ?? ''))
    }
  }

  if (config.auth_type === 'bearer' && config.auth_token?.trim()) {
    headers['Authorization'] = `Bearer ${interpolate(config.auth_token.trim())}`
  } else if (config.auth_type === 'api_key' && config.auth_token?.trim()) {
    const headerName = (config.auth_header_name || 'x-api-key').trim()
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(headerName)) {
      headers[headerName] = interpolate(config.auth_token.trim())
    }
  }

  let body: string | undefined
  if (method !== 'GET' && config.body_template && config.body_template.trim()) {
    body = interpolate(config.body_template)
    const hasContentType = Object.keys(headers).some(
      (h) => h.toLowerCase() === 'content-type',
    )
    if (!hasContentType) {
      headers['Content-Type'] = 'application/json'
    }
  }

  const res = await fetch(resolvedUrl, {
    method,
    headers,
    ...(body !== undefined ? { body } : {}),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    throw new Error(`http_request: resposta HTTP ${res.status}`)
  }

  const extractedVars: Record<string, string> = {}
  const mappings = Array.isArray(config.response_mappings)
    ? config.response_mappings.filter((m) => m.json_path?.trim() && m.var_name?.trim())
    : []

  if (mappings.length > 0) {
    const rawText = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(rawText)
    } catch {
      parsed = null
    }
    if (parsed !== null) {
      for (const mapping of mappings) {
        const val = extractJsonPath(parsed, mapping.json_path)
        if (val !== undefined && val !== null) {
          extractedVars[mapping.var_name.trim()] =
            typeof val === 'string' ? val : JSON.stringify(val)
        }
      }
    }
  }

  const mappedKeys = Object.keys(extractedVars)
  const summary =
    mappedKeys.length > 0
      ? `${method} ${res.status} (salvou ${mappedKeys.map((k) => `vars.${k}`).join(', ')})`
      : `${method} ${res.status}`

  return { status: res.status, extractedVars, summary }
}
