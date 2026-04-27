// lib/auth/session-cookie.ts
//
// Shared reader for the Supabase session cookie. @supabase/ssr v0.3+
// stores large JWTs across multiple cookies named sb-<ref>-auth-token.0,
// .1, ... so any consumer (middleware, API route, server component)
// has to know how to reassemble.
//
// Used by:
//   - middleware.ts (structural validation only — Edge-safe, no DB)
//   - lib/supabase/server.ts::getRequestAuth (full validation, server-only)
//
// Three exports: readSessionCookie, extractAccessToken, isJwtStructurallyValid.
// Each is a pure function with no side effects, safe to call from the Edge
// runtime (no Node-only APIs, no Supabase network calls).

const PROJECT_REF_FALLBACK = 'llzmixkrysduztsvmfzi'

interface CookieGetter {
  get(name: string): { value: string } | undefined
}

/**
 * Read the Supabase session cookie value, joining chunks if present.
 * Returns the raw cookie content (which may be a JSON-stringified session
 * object, an array, or a bare JWT depending on @supabase/ssr version).
 * Caller decides what to do with it.
 */
export function readSessionCookie(cookies: CookieGetter): string | null {
  // Derive project ref from NEXT_PUBLIC_SUPABASE_URL when possible;
  // fall back to the hardcoded value for resilience. Edge runtime
  // does have process.env access for NEXT_PUBLIC_* vars.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const ref = url.match(/https?:\/\/([^.]+)\./)?.[1] ?? PROJECT_REF_FALLBACK
  const BASE = `sb-${ref}-auth-token`

  let raw: string | null = cookies.get(BASE)?.value ?? null

  if (!raw) {
    // Base cookie absent — collect indexed chunks
    const chunks: string[] = []
    for (let i = 0; ; i++) {
      const c = cookies.get(`${BASE}.${i}`)?.value
      if (!c) break
      chunks.push(c)
    }
    if (chunks.length) raw = chunks.join('')
  } else if (/^\d+$/.test(raw.trim())) {
    // Base cookie holds only the chunk count
    const n = parseInt(raw, 10)
    const chunks: string[] = []
    for (let i = 0; i < n; i++) {
      const c = cookies.get(`${BASE}.${i}`)?.value
      if (c) chunks.push(c)
    }
    if (chunks.length) raw = chunks.join('')
  }

  return raw
}

/**
 * Extract the JWT access_token from a stored Supabase session value.
 * Handles three shapes @supabase/ssr has used over time:
 *   1. JSON-stringified session object: { access_token, refresh_token, ... }
 *   2. JSON array: [access_token, refresh_token, ...]
 *   3. Bare JWT string (rare, fallback)
 */
export function extractAccessToken(raw: string): string | null {
  let value = raw
  try {
    const decoded = decodeURIComponent(raw)
    const parsed  = JSON.parse(decoded)
    if (Array.isArray(parsed))     value = parsed[0]
    else if (parsed?.access_token) value = parsed.access_token
  } catch {
    // raw is already a plain JWT — use as-is
  }
  return typeof value === 'string' && value.length > 20 ? value : null
}

/**
 * Cheap structural validation of a JWT. Edge-safe (no crypto, no fetch).
 * Returns true iff:
 *   - The token has 3 base64url segments
 *   - The payload parses as JSON
 *   - The exp claim exists and is in the future (with 60s clock skew)
 *
 * This is NOT a security check — anyone can mint a JWT with a future exp.
 * Use this only to filter out obviously-not-logged-in users at the edge.
 * The cryptographic check happens server-side via supabase.auth.getUser.
 */
export function isJwtStructurallyValid(token: string): boolean {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  try {
    // Edge runtime supports atob; pad base64url manually
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded     = payloadB64 + '='.repeat((4 - payloadB64.length % 4) % 4)
    const json       = atob(padded)
    const payload    = JSON.parse(json)
    const exp        = Number(payload?.exp)
    if (!Number.isFinite(exp)) return false
    const nowSec     = Math.floor(Date.now() / 1000)
    return exp > nowSec - 60   // 60s clock skew tolerance
  } catch {
    return false
  }
}
