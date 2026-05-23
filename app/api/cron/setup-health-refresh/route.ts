// app/api/cron/setup-health-refresh/route.ts
//
// Phase 3 — Daily setup-health refresh. Walks every Fortnox-connected
// business and re-runs the readiness validator. The validator itself
// persists a compact summary to businesses.setup_health_summary, so
// this cron's job is just to TRIGGER the eval for everyone.
//
// Schedule: daily 07:00 UTC (after voucher-cache-refresh at 06:15 +
// fortnox-backfill-worker at 06:00 so the underlying caches are fresh
// before readiness reads them).
//
// Why daily: customer's books drift between connect-time and now —
// new accounts get added, FY rolls over, the bookkeeper falls behind,
// 26xx accounts they newly start using need mapping. Without a regular
// re-evaluation the dashboard widget would silently keep reporting the
// connect-time picture forever. Daily is the right cadence: low cost,
// catches drift the same day it appears.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { evaluateFortnoxReadiness } from '@/lib/integrations/fortnox-readiness'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

const PARALLEL_CHUNK = 3   // each readiness eval can take 3-30 s; chunk modestly

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
  const t0 = Date.now()

  // Enumerate every Fortnox-connected business (incl. warning state so
  // the readiness check itself can surface the warning detail).
  const { data: integrations, error } = await db
    .from('integrations')
    .select('org_id, business_id, status')
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'warning'])
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const targets = (integrations ?? [])
    .filter((r: any) => r.business_id != null)
    .map((r: any) => ({ org_id: r.org_id as string, business_id: r.business_id as string }))

  const summaries: Array<{
    business_id: string
    status:      'ok' | 'failed'
    overall?:    'ok' | 'warn' | 'fail' | 'pending'
    counts?:     Record<string, number>
    duration_ms?: number
    error?:      string
  }> = []

  for (let i = 0; i < targets.length; i += PARALLEL_CHUNK) {
    const slice = targets.slice(i, i + PARALLEL_CHUNK)
    const chunkResults = await Promise.all(slice.map(async biz => {
      const out: any = { business_id: biz.business_id }
      try {
        const r = await evaluateFortnoxReadiness(db, biz.org_id, biz.business_id)
        const counts = { ok: 0, warn: 0, fail: 0, pending: 0 } as Record<string, number>
        for (const c of r.checks) counts[c.status]++
        out.status      = 'ok'
        out.overall     = r.overall
        out.counts      = counts
        out.duration_ms = r.duration_ms
      } catch (e: any) {
        out.status = 'failed'
        out.error  = String(e?.message ?? e).slice(0, 200)
      }
      return out
    }))
    summaries.push(...chunkResults)
  }

  // Aggregate summary for the cron log + JSON response
  const failCount   = summaries.filter(s => s.status === 'failed').length
  const okOverall   = summaries.filter(s => s.overall === 'ok').length
  const warnOverall = summaries.filter(s => s.overall === 'warn').length
  const failOverall = summaries.filter(s => s.overall === 'fail').length
  const pendOverall = summaries.filter(s => s.overall === 'pending').length

  console.log(JSON.stringify({
    at:           'cron.setup-health-refresh',
    eligible:     targets.length,
    eval_failed:  failCount,
    overall_ok:   okOverall,
    overall_warn: warnOverall,
    overall_fail: failOverall,
    overall_pend: pendOverall,
    duration_ms:  Date.now() - t0,
  }))

  return NextResponse.json({
    ok:           true,
    eligible:     targets.length,
    eval_failed:  failCount,
    overall: {
      ok:      okOverall,
      warn:    warnOverall,
      fail:    failOverall,
      pending: pendOverall,
    },
    duration_ms:  Date.now() - t0,
    summaries,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
