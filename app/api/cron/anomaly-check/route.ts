// app/api/cron/anomaly-check/route.ts
// Runs daily at 06:00 UTC — detects anomalies and creates alerts
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { runAnomalyDetection }       from '@/lib/alerts/detector'
import { runLineItemAnomalies }      from '@/lib/alerts/line-item-anomalies'
import { createAdminClient }          from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { log }                       from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  try {
    const orgId = req.nextUrl.searchParams.get('org_id') ?? undefined
    const alerts = await runAnomalyDetection(orgId)

    // ── Line-item anomalies: runs alongside and writes to the same
    //    anomaly_alerts table.  Iterates every (org, business) with
    //    Fortnox data in the last 6 months — O(N businesses) Supabase
    //    queries, no AI, so it's cheap to run daily.
    const db = createAdminClient()
    const { data: activeBizs } = await db
      .from('tracker_line_items')
      .select('org_id, business_id')
      .eq('category', 'other_cost')
      .gte('period_year', new Date().getFullYear() - 1)
      .limit(500)
    const seen = new Set<string>()
    const lineItemResults: any[] = []
    for (const r of (activeBizs ?? [])) {
      const key = `${r.org_id}:${r.business_id}`
      if (seen.has(key)) continue
      seen.add(key)
      if (orgId && r.org_id !== orgId) continue
      try {
        const res = await runLineItemAnomalies({ orgId: r.org_id, businessId: r.business_id, db })
        lineItemResults.push({ ...r, inserted: res.inserted, reason: res.reason })
      } catch (e: any) {
        lineItemResults.push({ ...r, error: e?.message })
      }
    }

    const lineItemInserted = lineItemResults.reduce((s: number, r: any) => s + (r.inserted ?? 0), 0)
    log.info('anomaly-check complete', {
      route:              'cron/anomaly-check',
      duration_ms:        Date.now() - started,
      alerts_created:     alerts.length,
      line_item_scans:    lineItemResults.length,
      line_item_inserted: lineItemInserted,
      status:             'success',
    })

    return NextResponse.json({
      ok:                true,
      alerts_created:    alerts.length,
      alerts,
      line_item_scans:   lineItemResults.length,
      line_item_inserted: lineItemInserted,
      timestamp:         new Date().toISOString(),
    })
  } catch (error: any) {
    log.error('anomaly-check failed', {
      route:       'cron/anomaly-check',
      duration_ms: Date.now() - started,
      error:       error?.message ?? String(error),
      status:      'error',
    })
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}

// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
