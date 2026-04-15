// @ts-nocheck
// lib/middleware/rate-limit.ts
//
// RATE LIMITING â€” prevents any single user from hammering the API.
//
// Implementation: In-memory sliding window, stored in a Map.
// No Redis needed â€” Vercel functions are stateless but this works fine
// for single-instance usage. For high-volume production use, swap the
// storage backend for Upstash Redis (one line change â€” see bottom of file).
//
// How it works (sliding window):
//   - We keep a list of timestamps for each user's recent requests.
//   - On each request we remove timestamps older than the window (1 minute).
//   - If the remaining count >= limit, we block the request.
//   - Otherwise we add the current timestamp and allow through.
//
// Usage in an API route:
//   import { rateLimit } from '@/lib/middleware/rate-limit'
//
//   const limit = await rateLimit(request, auth)
//   if (!limit.ok) return limit.response   // 429 Too Many Requests

import { type OrgContext } from '@/lib/auth/get-org'

// â”€â”€ Limits per plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// These are *per user* (not per org) per minute.
// Generous enough not to irritate real users, tight enough to block abuse.

const LIMITS: Record<string, {
  requests_per_minute: number    // general API calls
  ai_per_minute:       number    // AI / chat calls (expensive)
  upload_per_minute:   number    // file uploads
}> = {
  trial:      { requests_per_minute: 30,  ai_per_minute: 5,  upload_per_minute: 3  },
  starter:    { requests_per_minute: 120, ai_per_minute: 20, upload_per_minute: 10 },
  pro:        { requests_per_minute: 300, ai_per_minute: 60, upload_per_minute: 30 },
  enterprise: { requests_per_minute: 600, ai_per_minute: 120,upload_per_minute: 60 },
  past_due:   { requests_per_minute: 20,  ai_per_minute: 0,  upload_per_minute: 0  },
}

// Request type â€” determines which sub-limit to apply
export type RequestType = 'general' | 'ai' | 'upload'

// â”€â”€ In-memory store â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Key: `{userId}:{requestType}` â†’ list of timestamps in last 60 seconds
// This Map lives in the Vercel function's memory for the duration of its warm state.
const store = new Map<string, number[]>()

// Clean up old entries every 5 minutes to prevent memory leak
setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [key, timestamps] of store.entries()) {
    const recent = timestamps.filter(t => t > cutoff)
    if (recent.length === 0) {
      store.delete(key)
    } else {
      store.set(key, recent)
    }
  }
}, 5 * 60_000)

// â”€â”€ Main function â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface RateLimitResult {
  ok:          boolean
  remaining:   number    // requests remaining in current window
  resetInMs:   number    // milliseconds until window resets
  response?:   Response  // populated when ok = false
}

export async function rateLimit(
  request:     Request,
  auth:        OrgContext | null,
  type:        RequestType = 'general'
): Promise<RateLimitResult> {
  // If no auth â€” apply very tight anonymous limits
  const userId  = auth?.userId ?? getAnonymousId(request)
  const plan    = auth?.plan   ?? 'trial'
  const planLimits = LIMITS[plan] ?? LIMITS.trial

  // Pick the right sub-limit for this request type
  const limit = type === 'ai'
    ? planLimits.ai_per_minute
    : type === 'upload'
    ? planLimits.upload_per_minute
    : planLimits.requests_per_minute

  // AI is blocked for past_due accounts
  if (type === 'ai' && plan === 'past_due') {
    return {
      ok:        false,
      remaining: 0,
      resetInMs: 0,
      response:  Response.json({
        error:       'AI access is suspended due to a payment issue.',
        code:        'PAYMENT_REQUIRED',
        upgrade_url: '/upgrade',
      }, {
        status: 402,
        headers: retryHeaders(0),
      }),
    }
  }

  const key     = `${userId}:${type}`
  const now     = Date.now()
  const cutoff  = now - 60_000   // 60-second sliding window

  // Get recent requests in the last 60 seconds
  const timestamps = (store.get(key) ?? []).filter(t => t > cutoff)

  const remaining  = Math.max(0, limit - timestamps.length)
  const resetInMs  = timestamps.length > 0 ? (timestamps[0] + 60_000) - now : 0

  if (timestamps.length >= limit) {
    // Over limit â€” return 429 with Retry-After header
    return {
      ok:        false,
      remaining: 0,
      resetInMs,
      response:  Response.json({
        error:        `Too many requests. Limit: ${limit} per minute.`,
        code:         'RATE_LIMITED',
        retry_after:  Math.ceil(resetInMs / 1000),
        upgrade_hint: plan === 'trial' || plan === 'starter'
          ? 'Upgrade to Pro for higher rate limits.'
          : undefined,
      }, {
        status: 429,
        headers: retryHeaders(Math.ceil(resetInMs / 1000)),
      }),
    }
  }

  // Under limit â€” record this request and allow through
  timestamps.push(now)
  store.set(key, timestamps)

  return { ok: true, remaining, resetInMs }
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Identify anonymous callers by IP address
function getAnonymousId(request: Request): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'anonymous'
  )
}

function retryHeaders(retryAfterSeconds: number): HeadersInit {
  return {
    'Retry-After':          String(retryAfterSeconds),
    'X-RateLimit-Limit':    '0',
    'X-RateLimit-Remaining':'0',
    'X-RateLimit-Reset':    String(Math.floor(Date.now() / 1000) + retryAfterSeconds),
  }
}

// â”€â”€ Upstash Redis upgrade path â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// When you need distributed rate limiting (multiple Vercel regions),
// replace the in-memory store with Upstash Redis:
//
// npm install @upstash/ratelimit @upstash/redis
//
// import { Ratelimit } from '@upstash/ratelimit'
// import { Redis }     from '@upstash/redis'
//
// const ratelimit = new Ratelimit({
//   redis:     Redis.fromEnv(),
//   limiter:   Ratelimit.slidingWindow(30, '1 m'),
//   analytics: true,
// })
//
// const { success, remaining, reset } = await ratelimit.limit(userId)
// The rest of the logic is the same.
