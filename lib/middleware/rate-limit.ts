// lib/middleware/rate-limit.ts
//
// Sliding window rate limiter for AI endpoints.
//
// Uses a module-level Map so the store persists across requests
// within the same Vercel function instance. On cold starts the
// window resets — acceptable because cold starts are rare and
// the window is short (60 seconds).
//
// For production hardening, swap the store for Upstash Redis:
//   npm install @upstash/ratelimit @upstash/redis
//   https://upstash.com/docs/redis/sdks/ratelimit

interface Window {
  count:     number
  resetAt:   number
}

// Module-level store — persists within a single Vercel instance
const store = new Map<string, Window>()

// Clean up expired windows every 5 minutes to prevent memory leaks
setInterval(() => {
  const now = Date.now()
  for (const [key, win] of store.entries()) {
    if (win.resetAt < now) store.delete(key)
  }
}, 5 * 60 * 1000)

export interface RateLimitOptions {
  windowMs: number   // time window in milliseconds
  max:      number   // max requests per window
}

export interface RateLimitResult {
  allowed:    boolean
  remaining:  number
  resetAt:    number   // unix ms when window resets
}

export function rateLimit(
  identifier: string,  // usually userId or IP
  options:    RateLimitOptions,
): RateLimitResult {
  const now = Date.now()
  const key = `rl:${identifier}`

  let win = store.get(key)

  // If no window exists or it has expired, start a fresh one
  if (!win || win.resetAt < now) {
    win = { count: 0, resetAt: now + options.windowMs }
    store.set(key, win)
  }

  win.count++

  const allowed   = win.count <= options.max
  const remaining = Math.max(0, options.max - win.count)

  return { allowed, remaining, resetAt: win.resetAt }
}

// Convenience: rate limit for AI chat (10 requests per minute per user)
export function rateLimitChat(userId: string): RateLimitResult {
  return rateLimit(userId, { windowMs: 60_000, max: 10 })
}

// Convenience: rate limit for document upload (5 per minute per user)
export function rateLimitUpload(userId: string): RateLimitResult {
  return rateLimit(userId, { windowMs: 60_000, max: 5 })
}
