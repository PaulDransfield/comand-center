// app/api/overheads/projection/route.ts
//
// What-if projection for the dashboard overhead-savings card + the
// /overheads page projection card.
//
// Returns the current-month overhead total, the projected savings if all
// pending + already-dismissed flagged suppliers are cancelled, and the
// resulting net-profit + margin numbers. Pure arithmetic — no AI.
//
// Sign convention follows lib/finance/conventions.ts (every cost positive,
// net_profit signed). Uses the persisted tracker_data row as the source of
// truth for the current period (per CLAUDE.md Session 13 invariant —
// "trusted reads, never recompute").
//
// PR 1 of the overhead-review feature: schema-only, so this endpoint
// returns zeros for the savings side until the worker (PR 2) starts
// writing flags. Shape is final — UI built on this in PR 3 won't refit.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { computeNetProfit, computeMarginPct } from '@/lib/finance/conventions'
import { expireDeferredFlags } from '@/lib/overheads/expire-deferred'

export const dynamic = 'force-dynamic'

const isMissingTable = (err: any): boolean => {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
}

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u          = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  const yearStr    = u.searchParams.get('year')
  const monthStr   = u.searchParams.get('month')

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // PR 5: expire any deferred flags whose 30-day snooze has elapsed BEFORE
  // we sum, so the projection numbers reflect current pending state.
  await expireDeferredFlags(db, auth.orgId, businessId)

  // ── Resolve "the period to project against" ──────────────────────────────
  // Caller can pin a specific year+month via query params; otherwise use the
  // latest tracker_data row for this business. Naively defaulting to the
  // current calendar month means a business that uploaded Dec 2025 data in
  // April 2026 has no projection — wrong, since their LATEST applied period
  // is Dec 2025 and that's what the dashboard card should reflect.
  let year:  number
  let month: number
  if (yearStr && monthStr) {
    year  = Number(yearStr)
    month = Number(monthStr)
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return NextResponse.json({ error: 'invalid year/month' }, { status: 400 })
    }
  } else {
    const { data: latest, error: lErr } = await db
      .from('tracker_data')
      .select('period_year, period_month')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .order('period_year',  { ascending: false })
      .order('period_month', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
    if (latest) {
      year  = Number(latest.period_year)
      month = Number(latest.period_month)
    } else {
      // No data at all — fall back to current calendar month so the
      // empty-state numbers (zeros) still render in a sensible period.
      const now = new Date()
      year  = now.getFullYear()
      month = now.getMonth() + 1
    }
  }

  // ── Source-of-truth rollup for the resolved period ───────────────────────
  const { data: rollup, error: rErr } = await db
    .from('tracker_data')
    .select('revenue, food_cost, staff_cost, other_cost, depreciation, financial, net_profit, margin_pct')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('period_year', year)
    .eq('period_month', month)
    .maybeSingle()

  if (rErr) return NextResponse.json({ error: rErr.message }, { status: 500 })

  const current = {
    revenue:      Number(rollup?.revenue ?? 0),
    food_cost:    Number(rollup?.food_cost ?? 0),
    staff_cost:   Number(rollup?.staff_cost ?? 0),
    other_cost:   Number(rollup?.other_cost ?? 0),
    depreciation: Number(rollup?.depreciation ?? 0),
    financial:    Number(rollup?.financial ?? 0),
  }

  // ── Pending flag totals (per-category split) ─────────────────────────────
  // Decisions are supplier-wide. Sum the LATEST amount per (supplier,
  // category) across all pending periods. Per-category split keeps the
  // net_profit math correct: food savings reduce food_cost, overhead
  // savings reduce other_cost.
  let pendingFlagsTotal = 0
  let pendingCount      = 0
  let pendingOther      = 0
  let pendingFood       = 0
  let flagsTableMissing = false
  {
    const { data: flags, error } = await db
      .from('overhead_flags')
      .select('supplier_name_normalised, category, amount_sek, period_year, period_month')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('resolution_status', 'pending')
    if (error) {
      if (isMissingTable(error)) flagsTableMissing = true
      else return NextResponse.json({ error: error.message }, { status: 500 })
    } else if (flags) {
      const latestPerSupplier = new Map<string, { key: number; amount: number; category: string }>()
      for (const f of flags as any[]) {
        const cat = f.category ?? 'other_cost'
        const compositeKey = `${f.supplier_name_normalised}::${cat}`
        const periodKey = Number(f.period_year) * 100 + Number(f.period_month)
        const cur = latestPerSupplier.get(compositeKey)
        if (!cur || periodKey > cur.key) {
          latestPerSupplier.set(compositeKey, { key: periodKey, amount: Number(f.amount_sek ?? 0), category: cat })
        }
      }
      pendingCount      = latestPerSupplier.size
      for (const v of latestPerSupplier.values()) {
        pendingFlagsTotal += v.amount
        if (v.category === 'food_cost') pendingFood  += v.amount
        else                            pendingOther += v.amount
      }
    }
  }

  // ── Already-dismissed suppliers still appearing in the books ──────────────
  // For each classification.status='dismissed', sum the supplier's tracker_line_items
  // for the requested period. The supplier is "planned to cancel" but has not
  // yet been cancelled — those amounts are real future savings on top of any
  // pending flags. PR 1 returns 0 for both parts when M039 hasn't applied.
  let dismissedStillBilling = 0
  let classificationsTableMissing = false
  {
    const { data: classifs, error: cErr } = await db
      .from('overhead_classifications')
      .select('supplier_name_normalised')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('status', 'dismissed')
    if (cErr) {
      if (isMissingTable(cErr)) classificationsTableMissing = true
      else return NextResponse.json({ error: cErr.message }, { status: 500 })
    } else if (classifs && classifs.length > 0) {
      const dismissedSuppliers = classifs.map((c: any) => c.supplier_name_normalised)
      // Match against the un-normalised supplier_name on tracker_line_items
      // by lowercasing in JS — the line-items table doesn't carry a
      // normalised column. Sufficient for PR 1; PR 2 adds the column.
      const { data: lines, error: lErr } = await db
        .from('tracker_line_items')
        .select('amount, label_sv, label_en, fortnox_account')
        .eq('org_id', auth.orgId)
        .eq('business_id', businessId)
        .eq('period_year',  year)
        .eq('period_month', month)
        .eq('category', 'other_cost')
      if (lErr) return NextResponse.json({ error: lErr.message }, { status: 500 })
      for (const ln of (lines ?? []) as any[]) {
        const key = String(ln.label_sv ?? ln.label_en ?? '').toLowerCase().trim()
        if (dismissedSuppliers.some((s: string) => key.includes(s) || s.includes(key))) {
          dismissedStillBilling += Number(ln.amount ?? 0)
        }
      }
    }
  }

  // dismissedStillBilling currently scopes to category='other_cost' line
  // items only — keep that for backwards compat (food-cost dismissed
  // tracking is a polish item; baseline cost is the pending flag savings).
  const otherSavings  = pendingOther + dismissedStillBilling
  const foodSavings   = pendingFood   // no dismissed-still-billing for food yet
  const projectedOther    = Math.max(0, current.other_cost - otherSavings)
  const projectedFood     = Math.max(0, current.food_cost  - foodSavings)
  const projectedSavings  = otherSavings + foodSavings

  const currentNetProfit  = rollup
    ? Number(rollup.net_profit)
    : computeNetProfit(current)
  const currentMarginPct  = rollup
    ? Number(rollup.margin_pct)
    : computeMarginPct(currentNetProfit, current.revenue)

  // Recompute net_profit with BOTH categories' reductions applied.
  const projectedNetProfit = computeNetProfit({
    ...current,
    other_cost: projectedOther,
    food_cost:  projectedFood,
  })
  const projectedMarginPct = computeMarginPct(projectedNetProfit, current.revenue)

  return NextResponse.json({
    period: { year, month },
    current: {
      overheads_sek:  Math.round(current.other_cost),
      food_cost_sek:  Math.round(current.food_cost),
      revenue_sek:    Math.round(current.revenue),
      net_profit_sek: Math.round(currentNetProfit),
      margin_pct:     currentMarginPct,
    },
    projected: {
      overheads_sek:  Math.round(projectedOther),
      food_cost_sek:  Math.round(projectedFood),
      net_profit_sek: Math.round(projectedNetProfit),
      margin_pct:     projectedMarginPct,
    },
    savings: {
      total_sek:           Math.round(projectedSavings),
      from_pending_flags:  Math.round(pendingFlagsTotal),
      from_dismissed_still_billing: Math.round(dismissedStillBilling),
      // Per-category split for UIs that need to show distinct buckets.
      by_category: {
        other_cost: Math.round(otherSavings),
        food_cost:  Math.round(foodSavings),
      },
    },
    pending_count:               pendingCount,
    flags_table_missing:         flagsTableMissing,
    classifications_table_missing: classificationsTableMissing,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
