// app/api/cron/cost-intelligence/route.ts
//
// Monthly cron that re-runs the cost-intel agent for every business with
// at least 2 months of other_cost line items.  Catches drift the
// on-apply trigger misses — e.g. a subscription quietly creeping up
// without a new PDF upload in that month.
//
// Called by Vercel cron on the 2nd of each month (give the applied PDFs
// from month-end a day to land).  Requires Authorization: Bearer
// CRON_SECRET.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { runCostIntel } from '@/lib/agents/cost-intelligence'
import { checkCronSecret } from '@/lib/admin/check-secret'
import { log }             from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const started = Date.now()
  const db = createAdminClient()

  // Find businesses with at least some other_cost lines.  Cheap query —
  // just checks for any row and groups by (org, business).
  const { data: targets } = await db
    .from('tracker_line_items')
    .select('org_id, business_id')
    .eq('category', 'other_cost')
    .limit(2000)

  // De-dupe
  const seen = new Set<string>()
  const unique: Array<{ org_id: string; business_id: string }> = []
  for (const t of (targets ?? [])) {
    const k = `${t.org_id}:${t.business_id}`
    if (!seen.has(k)) {
      seen.add(k)
      unique.push(t as any)
    }
  }

  const results: any[] = []
  for (const t of unique) {
    try {
      const res = await runCostIntel({ orgId: t.org_id, businessId: t.business_id, db })
      results.push({ ...t, ok: true, reason: res.reason, count: res.insights.length })
    } catch (e: any) {
      results.push({ ...t, ok: false, error: e?.message })
    }
  }

  const failed = results.filter(r => !r.ok).length
  log.info('cost-intelligence complete', {
    route:       'cron/cost-intelligence',
    duration_ms: Date.now() - started,
    businesses:  unique.length,
    failed,
    status:      failed === 0 ? 'success' : 'partial',
  })

  return NextResponse.json({ ran: unique.length, results })
}

export async function GET(req: NextRequest) {
  // Vercel cron sends GET; accept both.
  return POST(req)
}
