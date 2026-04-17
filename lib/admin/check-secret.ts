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
 * x-cron-secret header, or `?secret=` query param.
 */
export function checkCronSecret(req: NextRequest): boolean {
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
