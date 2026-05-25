// lib/ai/anthropic-fetch.ts
//
// Shared retry-with-backoff wrapper around the Anthropic Messages API.
// Centralises what every AI-calling endpoint needs to get right:
//   - Honour Retry-After when Anthropic sends it
//   - Exponential backoff 2/4/8/16s on 429 + 5xx
//   - Don't retry 4xx other than 429 (those are auth/payload bugs)
//   - Cap at 4 retries (~30s worst case) so cron budgets stay sane
//
// Use this everywhere we POST to api.anthropic.com/v1/messages. Mirrors
// the proven pattern in lib/inventory/pdf-extractor.ts which has held up
// under bulk-extraction load. Before this helper, ai-recommend +
// ai-suggest + draft-reply each had no retry — a single Anthropic blip
// turned an AI feature into a 502 to the user.

export interface AnthropicFetchOptions {
  apiKey?: string                            // defaults to process.env.ANTHROPIC_API_KEY
  body:    Record<string, unknown>           // model, max_tokens, system, messages, tools, etc.
  extraHeaders?: Record<string, string>      // e.g. anthropic-beta for extended-cache-ttl
  maxRetries?:    number                     // default 4
  backoffMsSchedule?: number[]               // default [2000, 4000, 8000, 16000]
}

export interface AnthropicFetchResult<T = any> {
  ok:          true
  json:        T
  tokensIn:    number
  tokensOut:   number
  cacheRead:   number
  cacheCreate: number
  status:      number
  attempts:    number
  durationMs:  number
}

export interface AnthropicFetchError {
  ok:        false
  status:    number
  errorText: string
  attempts:  number
  durationMs: number
}

const DEFAULT_BACKOFF_MS = [2000, 4000, 8000, 16000]
const DEFAULT_MAX_RETRIES = 4
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * POST to the Anthropic Messages API with retry-on-429 + retry-on-5xx.
 *
 * Throws on missing API key (configuration error — not a runtime situation
 * worth retrying around). Returns a discriminated union for HTTP outcomes
 * so callers can branch on `.ok` without try/catch noise.
 */
export async function anthropicFetch<T = any>(
  opts: AnthropicFetchOptions,
): Promise<AnthropicFetchResult<T> | AnthropicFetchError> {
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const backoff    = opts.backoffMsSchedule ?? DEFAULT_BACKOFF_MS
  const maxRetries = opts.maxRetries        ?? DEFAULT_MAX_RETRIES
  const t0 = Date.now()

  let res: Response | null = null
  let attempts = 0
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    attempts = attempt + 1
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        ...(opts.extraHeaders ?? {}),
      },
      body: JSON.stringify(opts.body),
    })

    const isRetriable = res.status === 429 || (res.status >= 500 && res.status < 600)
    if (!isRetriable || attempt === maxRetries) break

    let waitMs = backoff[attempt] ?? backoff[backoff.length - 1] ?? 16000
    const retryAfterRaw = res.headers.get('retry-after')
    if (retryAfterRaw) {
      const asSeconds = Number(retryAfterRaw)
      if (Number.isFinite(asSeconds)) {
        waitMs = Math.max(waitMs, asSeconds * 1000)
      }
    }
    await sleep(waitMs)
  }

  if (!res) {
    return { ok: false, status: 0, errorText: 'No response from Anthropic', attempts, durationMs: Date.now() - t0 }
  }
  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    return { ok: false, status: res.status, errorText: errorText.slice(0, 600), attempts, durationMs: Date.now() - t0 }
  }

  const json: any = await res.json()
  return {
    ok:          true,
    json:        json as T,
    tokensIn:    Number(json?.usage?.input_tokens             ?? 0),
    tokensOut:   Number(json?.usage?.output_tokens            ?? 0),
    cacheRead:   Number(json?.usage?.cache_read_input_tokens  ?? 0),
    cacheCreate: Number(json?.usage?.cache_creation_input_tokens ?? 0),
    status:      res.status,
    attempts,
    durationMs:  Date.now() - t0,
  }
}
