// lib/monitoring/sentry-scrub.ts
//
// beforeSend hook shared by the three Sentry runtimes (server/edge/client).
// Two jobs:
//   1. Redact obvious secrets from error payloads before they reach Sentry
//      (GDPR: Sentry is a US processor; never want auth cookies or API keys
//      escaping our boundary accidentally).
//   2. Drop the request.cookies blob so the Supabase auth cookie never lands
//      in a Sentry event.
//
// Kept deliberately simple — regex-based. Do NOT attempt to scrub "all PII" —
// we rely on Sentry only seeing stack traces + our own messages, not customer
// data. If an issue arises where it does, add the specific pattern here.

import type { ErrorEvent, EventHint } from '@sentry/core'

// Match obvious secret-shaped strings. Order matters — more specific first.
// Character class `[\w-]` = `[A-Za-z0-9_-]` — Stripe, Resend, Anthropic
// tokens sometimes include underscores/dashes inside the payload, not only
// after the prefix. Verified against a mis-scrubbed test event 2026-04-19
// where `sk_live_fake_stripe_key_123` only partially redacted because the
// regex stopped at the first underscore.
const SECRET_PATTERNS: RegExp[] = [
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,  // JWTs
  /\bBearer\s+[A-Za-z0-9._\-~+/=]+/gi,                    // Bearer <token>
  /sb-[a-z0-9]+-auth-token/gi,                            // Supabase cookie name
  /sk_live_[\w-]+/g,                                      // Stripe live secret
  /sk_test_[\w-]+/g,                                      // Stripe test secret
  /whsec_[\w-]+/g,                                        // Stripe webhook secret
  /\bre_[\w-]{10,}/g,                                     // Resend API key (≥10 chars post-prefix)
  /sk-ant-api[0-9]+-[\w-]+/g,                             // Anthropic API key
]

const MAX_STRING = 2000  // truncate any single string field above this length

function redact(s: string): string {
  if (typeof s !== 'string') return s as any
  let out = s
  for (const p of SECRET_PATTERNS) out = out.replace(p, '[REDACTED]')
  if (out.length > MAX_STRING) out = out.slice(0, MAX_STRING) + '…[truncated]'
  return out
}

function walk(obj: any, depth = 0): any {
  if (depth > 6) return obj
  if (obj == null) return obj
  if (typeof obj === 'string') return redact(obj)
  if (Array.isArray(obj)) return obj.map(v => walk(v, depth + 1))
  if (typeof obj === 'object') {
    const out: any = Array.isArray(obj) ? [] : {}
    for (const k of Object.keys(obj)) out[k] = walk(obj[k], depth + 1)
    return out
  }
  return obj
}

export function scrubSentryEvent(event: ErrorEvent, _hint?: EventHint): ErrorEvent | null {
  try {
    // Drop cookies entirely — the Supabase auth cookie would otherwise reach Sentry.
    if (event.request) {
      if ('cookies' in event.request) delete (event.request as any).cookies
      if ('headers' in event.request && event.request.headers) {
        const h = event.request.headers as Record<string, any>
        if (h.cookie)        h.cookie        = '[REDACTED]'
        if (h.Cookie)        h.Cookie        = '[REDACTED]'
        if (h.authorization) h.authorization = '[REDACTED]'
        if (h.Authorization) h.Authorization = '[REDACTED]'
      }
    }

    // Recursive secret redaction on the rest of the payload.
    if (event.message)    event.message = redact(event.message) as any
    if (event.breadcrumbs) event.breadcrumbs = event.breadcrumbs.map(b => walk(b))
    if (event.extra)       event.extra = walk(event.extra)
    if (event.contexts)    event.contexts = walk(event.contexts)
    if (event.tags)        event.tags = walk(event.tags)

    if (event.exception?.values) {
      for (const v of event.exception.values) {
        if (v.value) v.value = redact(v.value)
      }
    }
  } catch {
    // Never let a scrubber bug prevent error delivery — better an unredacted
    // event than no event. If this trips, fix the scrubber.
  }
  return event
}
