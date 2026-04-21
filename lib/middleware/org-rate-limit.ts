// lib/middleware/org-rate-limit.ts
//
// Persistent per-org rate limit backed by the org_rate_limits Supabase
// table. Survives cold starts (unlike lib/middleware/rate-limit.ts
// which is in-memory only).
//
// Use for buckets that trigger paid external APIs (Stripe checkout,
// big Anthropic calls) where a burst can cost real money and the
// in-memory limiter would be bypassed by Vercel spawning a new
// instance between calls.
//
// Contract:
//   const r = await orgRateLimit({ orgId, bucket: 'stripe_checkout', windowMs: 3600_000, max: 5 })
//   if (!r.ok) return 429 with r.retryAfterMs

import { createAdminClient } from '@/lib/supabase/server'

export interface OrgRateLimitArgs {
  orgId:     string
  bucket:    string   // short identifier: 'stripe_checkout', 'ai_expensive', ...
  windowMs:  number
  max:       number
}

export interface OrgRateLimitResult {
  ok:            boolean
  count:         number   // current count inside the active window
  retryAfterMs?: number
}

export async function orgRateLimit(args: OrgRateLimitArgs): Promise<OrgRateLimitResult> {
  const db         = createAdminClient()
  // Floor the window start to the nearest windowMs boundary so all
  // requests within the same window share a single row (upsertable).
  const nowMs      = Date.now()
  const windowMs   = args.windowMs
  const startMs    = nowMs - (nowMs % windowMs)
  const startIso   = new Date(startMs).toISOString()

  // Upsert the counter row. The composite PK (org_id, bucket, window_start)
  // means concurrent requests land on the same row.
  const { data: existing, error: selErr } = await db
    .from('org_rate_limits')
    .select('count')
    .eq('org_id', args.orgId)
    .eq('bucket', args.bucket)
    .eq('window_start', startIso)
    .maybeSingle()

  if (selErr && selErr.code !== 'PGRST116') {
    // Table missing or other infra issue — fail open (don't block the user
    // on a plumbing problem), but log it so Sentry picks it up.
    console.error('[orgRateLimit] select failed:', selErr.message)
    return { ok: true, count: 0 }
  }

  const nextCount = (existing?.count ?? 0) + 1

  if (nextCount > args.max) {
    const retryAfterMs = (startMs + windowMs) - nowMs
    return { ok: false, count: nextCount - 1, retryAfterMs }
  }

  // Increment (upsert). Small race window between the SELECT and the
  // UPSERT, but acceptable: at worst we let 1-2 extra requests through
  // under heavy concurrency. For hard limits we'd use a Postgres RPC
  // with SELECT FOR UPDATE.
  const { error: upErr } = await db.from('org_rate_limits').upsert({
    org_id:       args.orgId,
    bucket:       args.bucket,
    window_start: startIso,
    count:        nextCount,
  }, { onConflict: 'org_id,bucket,window_start' })

  if (upErr) {
    console.error('[orgRateLimit] upsert failed:', upErr.message)
    return { ok: true, count: nextCount }   // fail open on write errors
  }

  return { ok: true, count: nextCount }
}
