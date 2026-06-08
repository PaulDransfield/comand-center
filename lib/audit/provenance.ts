// lib/audit/provenance.ts
//
// A1.10 — provenance lookup for owner-facing values. Given a business +
// metric + period, return everything we know about where that number
// came from:
//   - last_updated_at  — when the value was last touched
//   - sources[]        — providers that contributed (PK, Fortnox, manual)
//   - raw_value        — the unrounded number actually stored
//   - decision_code    — when the aggregator picked one source over
//                        another (cost_source, rev_source codes)
//   - disagreements[]  — any "_disagrees" / "_partial" markers
//   - notes[]          — owner-readable strings derived from the above
//
// The engine pulls from THREE canonical tables (no recompute):
//   - monthly_metrics    — aggregated revenue/staff_cost/food_cost per month
//                          with cost_source / rev_source decision codes
//   - daily_metrics      — same shape per day
//   - tracker_data       — Fortnox-driven P&L (created_via tag)
//
// Reads only — pure-compute (no writes). Cheap to call from any UI
// surface (the dashboard KPI tile click handler).

import type { SupabaseClient } from '@supabase/supabase-js'

// Five metrics owners actually scrutinise. Each maps to a column on
// one of the canonical tables; the engine knows which.
export type Metric =
  | 'revenue'
  | 'staff_cost'
  | 'food_cost'
  | 'net_profit'
  | 'covers'

export interface Provenance {
  business_id:     string
  metric:          Metric
  from:            string                   // ISO date
  to:              string                   // ISO date
  last_updated_at: string | null
  sources:         string[]                 // ['fortnox', 'personalkollen'] etc.
  raw_value:       number | null
  decision_code:   string | null            // cost_source / rev_source value
  disagreements:   string[]                 // human-readable strings
  notes:           string[]                 // additional context
  table:           string                   // which table the value came from
}

// ── Helpers ─────────────────────────────────────────────────────────
function periodToYM(from: string, to: string): { year: number; month: number } | null {
  // Only single-month windows resolve to a monthly_metrics row.
  if (!from || !to) return null
  if (from.slice(0, 7) !== to.slice(0, 7)) return null
  const [y, m] = from.split('-').map(Number)
  if (!Number.isFinite(y) || !Number.isFinite(m)) return null
  return { year: y, month: m }
}

const COST_SOURCE_LABELS: Record<string, string> = {
  pk:                  'Personalkollen',
  pk_canonical:        'Personalkollen (canonical)',
  pk_partial:          'Personalkollen (partial coverage)',
  fortnox:             'Fortnox',
  fortnox_pk_disagrees:'Fortnox (PK disagreed — fell back)',
  none:                'No data',
}
const REV_SOURCE_LABELS: Record<string, string> = {
  personalkollen: 'Personalkollen',
  pk_bella:       'Personalkollen (Bella)',
  pk_carne:       'Personalkollen (Carne)',
  onslip:         'Onslip',
  ancon:          'Ancon',
  swess:          'Swess',
  fortnox:        'Fortnox (P&L)',
  manual:         'Manual entry',
}

const FORTNOX_CREATED_VIA_LABELS: Record<string, string> = {
  fortnox_apply:    'Fortnox PDF (validator-passed)',
  fortnox_pdf:      'Fortnox PDF (legacy)',
  fortnox_api:      'Fortnox API backfill',
  fortnox_backfill: 'Fortnox API backfill',
  owner_form:       'Manual owner entry',
  admin_backfill:   'Admin backfill',
  migration:        'Schema migration',
}

// ── Engine ──────────────────────────────────────────────────────────
export async function getMetricProvenance(
  db:         SupabaseClient,
  businessId: string,
  metric:     Metric,
  from:       string,
  to:         string,
): Promise<Provenance> {
  const base: Provenance = {
    business_id:    businessId,
    metric,
    from, to,
    last_updated_at: null,
    sources:        [],
    raw_value:      null,
    decision_code:  null,
    disagreements:  [],
    notes:          [],
    table:          'unknown',
  }

  const ym = periodToYM(from, to)

  // Prefer monthly_metrics when the window is a single calendar month —
  // that's where the aggregator wrote the decision codes (M026 / Session
  // 16). Otherwise sum daily_metrics in the window and derive provenance
  // from the most recent day.
  if (ym) {
    const { data: mm } = await db
      .from('monthly_metrics')
      .select('revenue, staff_cost, food_cost, dine_in_revenue, takeaway_revenue, alcohol_revenue, cost_source, rev_source, updated_at, year, month')
      .eq('business_id', businessId)
      .eq('year', ym.year)
      .eq('month', ym.month)
      .maybeSingle()

    if (mm) {
      base.table = 'monthly_metrics'
      base.last_updated_at = (mm as any).updated_at ?? null
      const cost_source = String((mm as any).cost_source ?? '')
      const rev_source  = String((mm as any).rev_source  ?? '')

      switch (metric) {
        case 'revenue':
          base.raw_value     = Number((mm as any).revenue ?? 0)
          base.decision_code = rev_source || null
          if (rev_source) base.sources.push(REV_SOURCE_LABELS[rev_source] ?? rev_source)
          if (Number((mm as any).dine_in_revenue ?? 0) > 0)  base.notes.push(`Dine-in: ${fmtNum((mm as any).dine_in_revenue)} kr`)
          if (Number((mm as any).takeaway_revenue ?? 0) > 0) base.notes.push(`Takeaway: ${fmtNum((mm as any).takeaway_revenue)} kr`)
          if (Number((mm as any).alcohol_revenue ?? 0) > 0)  base.notes.push(`Alcohol: ${fmtNum((mm as any).alcohol_revenue)} kr`)
          break
        case 'staff_cost':
          base.raw_value     = Number((mm as any).staff_cost ?? 0)
          base.decision_code = cost_source || null
          if (cost_source) base.sources.push(COST_SOURCE_LABELS[cost_source] ?? cost_source)
          if (/_disagrees$/.test(cost_source)) base.disagreements.push('Personalkollen and Fortnox disagreed by more than 30% — used Fortnox.')
          if (/_partial$/.test(cost_source))   base.disagreements.push('Personalkollen coverage starts after the period began — value may underrepresent earlier days.')
          break
        case 'food_cost':
          base.raw_value = Number((mm as any).food_cost ?? 0)
          base.sources.push('Fortnox')
          base.table     = 'monthly_metrics'
          base.notes.push('Sourced from Fortnox P&L when month is closed; null until then.')
          break
        case 'net_profit': {
          // Net profit lives on tracker_data — pull that row too.
          const { data: td } = await db
            .from('tracker_data')
            .select('net_profit, margin_pct, revenue, food_cost, staff_cost, other_cost, source, created_via, updated_at, is_provisional')
            .eq('business_id', businessId)
            .eq('period_year', ym.year)
            .eq('period_month', ym.month)
            .or('is_provisional.is.null,is_provisional.eq.false')
            .maybeSingle()
          if (td) {
            base.table = 'tracker_data'
            base.raw_value = Number((td as any).net_profit ?? 0)
            base.last_updated_at = (td as any).updated_at ?? base.last_updated_at
            const via = (td as any).created_via ?? (td as any).source
            if (via) {
              base.decision_code = String(via)
              base.sources.push(FORTNOX_CREATED_VIA_LABELS[String(via)] ?? String(via))
            }
            base.notes.push(`Margin: ${Number((td as any).margin_pct ?? 0).toFixed(1)}%`)
          } else {
            base.notes.push('No tracker_data row for this month — net profit not yet computed.')
          }
          break
        }
        case 'covers':
          // Covers not on monthly_metrics; fall through to daily_metrics
          break
      }

      // Done unless covers (falls through) or revenue without a rev_source set.
      if (metric !== 'covers' && base.raw_value != null) return base
    }
  }

  // Daily-metrics path — sum the window.
  const { data: daily } = await db
    .from('daily_metrics')
    .select('date, revenue, staff_cost, covers, providers, updated_at')
    .eq('business_id', businessId)
    .gte('date', from)
    .lte('date', to)
    .order('date', { ascending: false })
    .limit(120)

  if (daily && daily.length > 0) {
    base.table = 'daily_metrics'
    base.last_updated_at = (daily[0] as any).updated_at ?? base.last_updated_at
    const providerSet = new Set<string>()
    let sum = 0
    for (const d of daily) {
      const arr = (d as any).providers ?? []
      if (Array.isArray(arr)) for (const p of arr) providerSet.add(String(p))
      switch (metric) {
        case 'revenue':    sum += Number((d as any).revenue    ?? 0); break
        case 'staff_cost': sum += Number((d as any).staff_cost ?? 0); break
        case 'covers':     sum += Number((d as any).covers     ?? 0); break
      }
    }
    base.raw_value = sum > 0 ? sum : 0
    for (const p of providerSet) {
      base.sources.push(REV_SOURCE_LABELS[p] ?? p)
    }
    if (daily.length < windowDays(from, to)) {
      const missing = windowDays(from, to) - daily.length
      base.notes.push(`${missing} day${missing === 1 ? '' : 's'} in the window have no data yet.`)
    }
  } else {
    base.notes.push('No daily_metrics rows in this window.')
  }

  return base
}

function windowDays(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00Z').getTime()
  const b = new Date(to   + 'T00:00:00Z').getTime()
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 1
  return Math.round((b - a) / 86_400_000) + 1
}

function fmtNum(n: any): string {
  const v = Number(n)
  if (!Number.isFinite(v)) return '0'
  return Math.round(v).toLocaleString('sv-SE')
}
