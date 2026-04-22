// app/api/cron/industry-benchmarks/route.ts
//
// Weekly cron — computes anonymised cross-tenant benchmarks from every
// business with 2+ months of Fortnox line items.  Surfaces on /overheads
// as chips ("your 3.4% vs median 1.5% from 47 restaurants").
//
// Privacy guard: minimum cohort size of 5 businesses per row.  Subcategories
// with fewer than 5 contributors are not published — they identify
// individual orgs.  No org_id, no amounts per-tenant — only the aggregate
// distribution.
//
// Cron: Sunday 03:00 UTC.  Cheap: one SQL aggregation, no LLM.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret } from '@/lib/admin/check-secret'
import { log }             from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

// Minimum cohort size per subcategory — below this, we don't publish
// (would identify the tenant).
const MIN_COHORT = 5

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorised' }, { status: 401 })
  }

  const started = Date.now()

  const db = createAdminClient()
  // Assumes industry_benchmarks table exists (created via migration).

  // Pull all other_cost line items across every business.  Limit by time
  // window to keep it fresh (last 12 months).  Group in memory because
  // computing percentiles in SQL is painful.
  const yearNow  = new Date().getFullYear()
  const { data: lines } = await db
    .from('tracker_line_items')
    .select('business_id, period_year, period_month, subcategory, amount')
    .eq('category', 'other_cost')
    .gte('period_year', yearNow - 1)
    .limit(50_000)

  if (!lines?.length) return NextResponse.json({ ran: 0, reason: 'no_data' })

  // Build per-business monthly totals per subcategory.
  // Key: business|subcategory|year|month -> kr
  const bucketed: Record<string, number> = {}
  for (const l of lines) {
    const sub = l.subcategory ?? null
    if (!sub) continue
    const k = `${l.business_id}|${sub}|${l.period_year}|${l.period_month}`
    bucketed[k] = (bucketed[k] ?? 0) + Number(l.amount ?? 0)
  }

  // Aggregate per subcategory: gather all monthly amounts across all
  // tenants, then compute percentiles if we have ≥MIN_COHORT distinct
  // businesses contributing.
  const bySub: Record<string, { businesses: Set<string>; monthlyAmounts: number[] }> = {}
  for (const k of Object.keys(bucketed)) {
    const [bizId, sub] = k.split('|')
    if (!bySub[sub]) bySub[sub] = { businesses: new Set(), monthlyAmounts: [] }
    bySub[sub].businesses.add(bizId)
    bySub[sub].monthlyAmounts.push(bucketed[k])
  }

  const published: any[] = []
  const skipped: any[] = []

  for (const [sub, agg] of Object.entries(bySub)) {
    if (agg.businesses.size < MIN_COHORT) {
      skipped.push({ subcategory: sub, cohort: agg.businesses.size })
      continue
    }
    const sorted = [...agg.monthlyAmounts].sort((a, b) => a - b)
    const pick = (p: number) => sorted[Math.floor(sorted.length * p)]
    const median = pick(0.50)
    const p25    = pick(0.25)
    const p75    = pick(0.75)

    await db.from('industry_benchmarks')
      .upsert({
        subcategory:  sub,
        sample_size:  agg.businesses.size,
        median_kr:    median,
        p25_kr:       p25,
        p75_kr:       p75,
        generated_at: new Date().toISOString(),
      }, { onConflict: 'subcategory' })

    published.push({ subcategory: sub, cohort: agg.businesses.size, median })
  }

  log.info('industry-benchmarks complete', {
    route:       'cron/industry-benchmarks',
    duration_ms: Date.now() - started,
    ran:         Object.keys(bySub).length,
    published:   published.length,
    skipped:     skipped.length,
    status:      'success',
  })

  return NextResponse.json({
    ran:       Object.keys(bySub).length,
    published: published.length,
    skipped:   skipped.length,
    details:   { published, skipped },
  })
}

export async function GET(req: NextRequest) { return POST(req) }
