// lib/admin/check-secret.ts
//
// Shared timing-safe comparison for admin and cron secrets. Prevents the
// byte-by-byte timing attack that `===` / `!==` on strings allows.
//
// Usage:
//   if (!checkAdminSecret(req)) return 401
//   if (!checkCronSecret(req))  return 401

import { timingSafeEqual } from 'crypto'
import type { NextRequest } from 'next/server'

function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const aBuf = Buffer.from(a, 'utf8')
  const bBuf = Buffer.from(b, 'utf8')
  // Length leak is unavoidable; compare lengths first to skip the timingSafeEqual
  // call (which requires equal-length buffers anyway).
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

/**
 * Validates x-admin-secret header or admin_secret cookie against ADMIN_SECRET.
 * Returns true iff the secret matches in constant time.
 */
export function checkAdminSecret(req: NextRequest): boolean {
  const got = req.headers.get('x-admin-secret') ?? req.cookies.get('admin_secret')?.value ?? null
  return safeEqual(got, process.env.ADMIN_SECRET ?? null)
}

/**
 * Validates CRON_SECRET supplied via Authorization: Bearer header,
 * x-cron-secret header, or `?secret=` query param, OR the presence of
 * the Vercel-internal x-vercel-cron=1 header that Vercel sets on
 * scheduled cron invocations (impossible to forge from outside the
 * platform network).
 *
 * Prefer the bearer-header path in new code. The query-param path is
 * retained for backwards compatibility but should be removed once all
 * callers are migrated — query strings leak into CDN and proxy logs.
 */
export function checkCronSecret(req: NextRequest): boolean {
  // Vercel scheduler always sets this on its cron invocations. Treating
  // it as trusted means the scheduler doesn't need to know CRON_SECRET
  // to fire a cron — matches Vercel's documented pattern.
  if (req.headers.get('x-vercel-cron') === '1') return true

  const want = process.env.CRON_SECRET ?? null
  if (!want) return false

  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  if (safeEqual(bearer, want)) return true

  const header = req.headers.get('x-cron-secret') ?? null
  if (safeEqual(header, want)) return true

  const query = new URL(req.url).searchParams.get('secret')
  if (safeEqual(query, want)) return true

  return false
}
