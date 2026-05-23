// app/api/cron/voucher-cache-refresh/route.ts
//
// Daily refresh for the Fortnox voucher cache (M080). Walks every
// business with a 'connected' Fortnox integration and force-refreshes
// the cache for CURRENT month + PREVIOUS month — those are the two
// windows where vouchers may still be edited (current = in flight;
// previous = late-arriving entries during the bokslut window).
//
// Closed older months stay in cache untouched — they don't change.
//
// Schedule: 06:15 UTC daily (vercel.json). Sits after fortnox-backfill-
// worker (06:00) so any new tracker_data writes that fed voucher edits
// land first.
//
// Per-business work is parallelised in chunks of 5 to balance Vercel
// function-resource limits against wall-clock time. Each customer's
// Fortnox token is independent so they don't compete for rate-limit
// budget. Worst case for 50 customers: ~5 chunks × ~3 min = ~15 min
// total inside the 800 s function cap — fits comfortably.
//
// Telemetry: structured JSON log per business + a summary at the end.

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { getCachedVouchersForRange } from '@/lib/fortnox/voucher-cache'
import { warmFiscalYearMissing }     from '@/lib/fortnox/voucher-cache-fy-warm'

const PARALLEL_CHUNK = 5

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }

async function handle(req: NextRequest) {
  noStore()

  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const startedAt = Date.now()

  // 1. Enumerate eligible businesses — has a connected Fortnox row.
  // We accept status IN ('connected', 'warning') so a transient
  // warning state doesn't skip the daily refresh (same shape as the
  // existing eligibility helper).
  const { data: integrations, error } = await db
    .from('integrations')
    .select('org_id, business_id, status')
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'warning'])
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const targets = (integrations ?? []).filter((r: any) => r.business_id != null) as Array<{
    org_id:      string
    business_id: string
    status:      string
  }>

  // 2. Build current + previous month windows. Stockholm is UTC+1/+2 —
  // we use UTC for consistency (the date math affects which "current
  // month" we refresh; UTC midnight tick is fine for daily cadence).
  const now = new Date()
  const cur  = { y: now.getUTCFullYear(),                                  m: now.getUTCMonth() + 1                    }
  const prev = cur.m === 1
    ? { y: cur.y - 1, m: 12 }
    : { y: cur.y, m: cur.m - 1 }

  // 3. Process businesses in parallel chunks.
  const summaries: Array<{
    business_id:     string
    current_status:  'ok' | 'failed'
    current_count?:  number
    current_duration?: number
    previous_status: 'ok' | 'failed'
    previous_count?: number
    previous_duration?: number
    fy_warm_status?:  'ok' | 'failed'
    fy_warm_months_warmed?:  number
    fy_warm_skipped_budget?: number
    fiscal_year_from?: string
    fiscal_year_to?:   string
    error?:          string
  }> = []

  for (let i = 0; i < targets.length; i += PARALLEL_CHUNK) {
    const slice = targets.slice(i, i + PARALLEL_CHUNK)
    const chunkResults = await Promise.all(slice.map(async biz => {
      const out: any = { business_id: biz.business_id }
      try {
        const r1 = await getCachedVouchersForRange({
          db,
          orgId:           biz.org_id,
          businessId:      biz.business_id,
          fromDate:        isoFirstOfMonth(cur),
          toDate:          isoLastOfMonth(cur),
          refreshCurrent:  true,
        })
        out.current_status   = 'ok'
        out.current_count    = r1.vouchers.length
        out.current_duration = r1.duration_ms
      } catch (e: any) {
        out.current_status = 'failed'
        out.error          = `current: ${e?.message ?? e}`
      }
      try {
        const r2 = await getCachedVouchersForRange({
          db,
          orgId:           biz.org_id,
          businessId:      biz.business_id,
          fromDate:        isoFirstOfMonth(prev),
          toDate:          isoLastOfMonth(prev),
          refreshCurrent:  true,
        })
        out.previous_status   = 'ok'
        out.previous_count    = r2.vouchers.length
        out.previous_duration = r2.duration_ms
      } catch (e: any) {
        out.previous_status = 'failed'
        out.error           = (out.error ? `${out.error}; ` : '') + `previous: ${e?.message ?? e}`
      }

      // FY catch-up: opportunistically warm any missing months in the
      // customer's current fiscal year. Idempotent — no-op once full.
      // Bounded to 180 s per business so a single broken-FY customer
      // with empty cache can't starve the rest of the cron run.
      try {
        const r3 = await warmFiscalYearMissing({
          db,
          orgId:      biz.org_id,
          businessId: biz.business_id,
          budgetMs:   180_000,
          log:        (msg, fields) => console.log(JSON.stringify({ at: msg, ...fields })),
        })
        out.fy_warm_status         = r3.ok ? 'ok' : 'failed'
        out.fy_warm_months_warmed  = r3.months_warmed
        out.fy_warm_skipped_budget = r3.months_skipped_budget
        out.fiscal_year_from       = r3.fiscal_year_from
        out.fiscal_year_to         = r3.fiscal_year_to
      } catch (e: any) {
        out.fy_warm_status = 'failed'
        out.error          = (out.error ? `${out.error}; ` : '') + `fy_warm: ${e?.message ?? e}`
      }

      return out
    }))
    summaries.push(...chunkResults)
  }

  // 4. Roll up.
  const okCurrent  = summaries.filter(s => s.current_status  === 'ok').length
  const okPrev     = summaries.filter(s => s.previous_status === 'ok').length
  const failed     = summaries.filter(s => s.current_status === 'failed' || s.previous_status === 'failed')

  // Structured log line for observability — Vercel runtime logs.
  console.log(JSON.stringify({
    at:                'cron.voucher-cache-refresh',
    eligible:          targets.length,
    current_ok:        okCurrent,
    previous_ok:       okPrev,
    failed_count:      failed.length,
    duration_ms:       Date.now() - startedAt,
    current_period:    `${cur.y}-${String(cur.m).padStart(2, '0')}`,
    previous_period:   `${prev.y}-${String(prev.m).padStart(2, '0')}`,
  }))

  return NextResponse.json({
    ok:                  true,
    eligible:            targets.length,
    current_period:      `${cur.y}-${String(cur.m).padStart(2, '0')}`,
    previous_period:     `${prev.y}-${String(prev.m).padStart(2, '0')}`,
    current_refreshed:   okCurrent,
    previous_refreshed:  okPrev,
    failed_count:        failed.length,
    failed_samples:      failed.slice(0, 5),
    duration_ms:         Date.now() - startedAt,
    summaries,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

// ─── helpers ──────────────────────────────────────────────────────

function isoFirstOfMonth({ y, m }: { y: number; m: number }): string {
  return `${y}-${String(m).padStart(2, '0')}-01`
}
function isoLastOfMonth({ y, m }: { y: number; m: number }): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}
