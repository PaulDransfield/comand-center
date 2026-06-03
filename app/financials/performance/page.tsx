'use client'
// @ts-nocheck
// app/financials/performance/page.tsx
//
// Unified business performance view — rolls up revenue, food cost, labour,
// overheads and margin into one page with period + comparison controls.
// Spec: PERFORMANCE-PROMPT.md. Style contract: DESIGN.md (inline SVG,
// inline styles, existing shared components, no new npm deps).
//
// Data sources (all existing — no API changes):
//   GET /api/businesses                    — business list + selection
//   GET /api/tracker?year=Y                — monthly revenue/food/staff/margin
//   GET /api/overheads/line-items?year     — tracker_line_items per period
//   GET /api/metrics/daily?from&to         — week-granularity revenue + labour
//
// Week granularity can't show food/overheads (Fortnox is monthly); those
// rows render `—` with an attention-panel bullet explaining why.

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import { labourTier, DEFAULT_TIER_CONFIG } from '@/lib/utils/labourTier'
import { PageContainer } from '@/components/ui/Layout'
import { Popover } from '@/components/ui/Popover'

// Local AttentionItem type — the legacy import is gone but the
// buildTunableItems helper below still returns this shape.
interface AttentionItem {
  tone:    'good' | 'warning' | 'bad'
  entity:  string
  message: string
}

// ─── Types ─────────────────────────────────────────────────────────────────
type Granularity = 'week' | 'month' | 'quarter' | 'ytd'

interface PeriodKey {
  granularity: Granularity
  year:    number
  month?:  number   // 1-12 (month granularity)
  week?:   number   // 1-53 (ISO week)
  quarter?: number  // 1-4
}

interface PeriodData {
  revenue:      number
  // Revenue split by Swedish VAT rate (M029). Each is a SUBSET of `revenue`,
  // never additive. Sum may be slightly less than total revenue if some
  // revenue is uncategorised ("övriga intäkter"). Read straight from
  // tracker_data — no longer derived from line items at render time.
  revenue_dine_in:  number   // 12% moms — sit-down food
  revenue_takeaway: number   // 6% moms — Wolt/Foodora etc
  revenue_alcohol:  number   // 25% moms — alcohol & non-food drinks
  revenue_food:     number   // dine-in + takeaway (back-compat for callers)
  has_revenue_split: boolean
  food_cost:    number      // total cost of goods (food + alcohol combined)
  alcohol_cost: number      // subset of food_cost tagged as beverages/alcohol
  food_only_cost: number    // food_cost minus alcohol_cost
  staff_cost:   number
  overheads:    number
  net_margin:   number
  margin_pct:   number | null
  food_pct:     number | null
  alcohol_pct:  number | null
  takeaway_pct: number | null
  staff_pct:    number | null
  overheads_pct: number | null
  // Breakdown of overheads by subcategory for the donut + table
  overhead_split: { rent: number; utilities: number; other: number }
  // Data completeness flags — used to show `—` and explain honestly.
  has_food:      boolean
  has_alcohol:   boolean
  has_takeaway:  boolean
  has_overheads: boolean
}

interface SparkRow { label: string; value: number }

// ─── Helpers ───────────────────────────────────────────────────────────────
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const QUARTERS     = ['Q1', 'Q2', 'Q3', 'Q4']

function fmtShortKr(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${Math.round(n / 1_000) / 1_000}m`.replace('.', ',')
  if (Math.abs(n) >= 10_000)    return `${Math.round(n / 1_000)}k`
  if (Math.abs(n) >= 1_000)     return `${Math.round(n / 100) / 10}k`
  return String(Math.round(n))
}
function fmtPp(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}pp`
}
function fmtPct(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return '—'
  return `${n.toFixed(digits)}%`
}

// ISO week number for a date (Mon-first week).
function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return Math.ceil(((t.getTime() - y0.getTime()) / 86400000 + 1) / 7)
}
function monthOfQuarter(q: number): number { return (q - 1) * 3 + 1 } // 1,4,7,10
function quarterOfMonth(m: number): number { return Math.floor((m - 1) / 3) + 1 }

// Convert a PeriodKey into the absolute date range (ISO YYYY-MM-DD).
function periodBounds(k: PeriodKey): { from: string; to: string } {
  const y = k.year
  if (k.granularity === 'year' as any || k.granularity === 'ytd') {
    const today = new Date()
    const endY  = y < today.getFullYear() ? new Date(y, 11, 31) : today
    return { from: `${y}-01-01`, to: endY.toISOString().slice(0, 10) }
  }
  if (k.granularity === 'month') {
    const m = k.month!
    const last = new Date(y, m, 0).getDate()
    return { from: `${y}-${String(m).padStart(2,'0')}-01`, to: `${y}-${String(m).padStart(2,'0')}-${String(last).padStart(2,'0')}` }
  }
  if (k.granularity === 'quarter') {
    const qStartM = monthOfQuarter(k.quarter!)
    const qEndM   = qStartM + 2
    const last    = new Date(y, qEndM, 0).getDate()
    return { from: `${y}-${String(qStartM).padStart(2,'0')}-01`, to: `${y}-${String(qEndM).padStart(2,'0')}-${String(last).padStart(2,'0')}` }
  }
  // week — ISO week: Monday → Sunday. Approximate by taking Jan 4 of year
  // (always in week 1) and stepping weeks.
  const jan4 = new Date(Date.UTC(y, 0, 4))
  const jan4Day = jan4.getUTCDay() || 7
  const mon1 = new Date(jan4); mon1.setUTCDate(jan4.getUTCDate() - (jan4Day - 1))
  const mon  = new Date(mon1);  mon.setUTCDate(mon1.getUTCDate() + (k.week! - 1) * 7)
  const sun  = new Date(mon);   sun.setUTCDate(mon.getUTCDate() + 6)
  return { from: mon.toISOString().slice(0, 10), to: sun.toISOString().slice(0, 10) }
}

// Label for the period picker button.
function periodLabel(k: PeriodKey): string {
  if (k.granularity === 'ytd')     return `YTD ${k.year}`
  if (k.granularity === 'quarter') return `${QUARTERS[k.quarter! - 1]} ${k.year}`
  if (k.granularity === 'month')   return `${MONTHS_SHORT[k.month! - 1]} ${k.year}`
  // week
  const { from, to } = periodBounds(k)
  const d1 = new Date(from + 'T00:00:00Z')
  const d2 = new Date(to   + 'T00:00:00Z')
  const m1 = MONTHS_SHORT[d1.getUTCMonth()]
  const m2 = MONTHS_SHORT[d2.getUTCMonth()]
  const rng = m1 === m2 ? `${d1.getUTCDate()}–${d2.getUTCDate()} ${m1}` : `${d1.getUTCDate()} ${m1} – ${d2.getUTCDate()} ${m2}`
  return `Week ${k.week} · ${rng}`
}
function periodLabelCaps(k: PeriodKey): string {
  return periodLabel(k).toUpperCase()
}

// "current" period for a granularity (today's week / month / etc.).
function currentPeriod(g: Granularity): PeriodKey {
  const now = new Date()
  const y = now.getFullYear()
  if (g === 'ytd')     return { granularity: 'ytd',     year: y }
  if (g === 'quarter') return { granularity: 'quarter', year: y, quarter: quarterOfMonth(now.getMonth() + 1) }
  if (g === 'month')   return { granularity: 'month',   year: y, month: now.getMonth() + 1 }
  return                         { granularity: 'week',    year: y, week: isoWeek(now) }
}

function isFuturePeriod(k: PeriodKey): boolean {
  const now = new Date()
  const cur = currentPeriod(k.granularity)
  if (k.year > cur.year) return true
  if (k.year < cur.year) return false
  if (k.granularity === 'ytd')     return false
  if (k.granularity === 'month')   return (k.month ?? 0)   > (cur.month ?? 0)
  if (k.granularity === 'quarter') return (k.quarter ?? 0) > (cur.quarter ?? 0)
  return (k.week ?? 0) > (cur.week ?? 0)
}

// Step one period.
function stepPeriod(k: PeriodKey, delta: -1 | 1): PeriodKey {
  const step = <T extends PeriodKey>(nk: T) => nk
  if (k.granularity === 'month') {
    let m = (k.month ?? 1) + delta
    let y = k.year
    if (m < 1)  { m = 12; y-- }
    if (m > 12) { m = 1;  y++ }
    return step({ ...k, month: m, year: y })
  }
  if (k.granularity === 'quarter') {
    let q = (k.quarter ?? 1) + delta
    let y = k.year
    if (q < 1) { q = 4; y-- }
    if (q > 4) { q = 1; y++ }
    return step({ ...k, quarter: q, year: y })
  }
  if (k.granularity === 'ytd') {
    return step({ ...k, year: k.year + delta })
  }
  // week — need to roll over year boundary via actual dates.
  const { from } = periodBounds(k)
  const d = new Date(from + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + delta * 7)
  return step({ granularity: 'week', year: d.getUTCFullYear(), week: isoWeek(d) })
}

// Previous period: equivalent shift back.
function previousPeriod(k: PeriodKey): PeriodKey { return stepPeriod(k, -1) }
function samePeriodLastYear(k: PeriodKey): PeriodKey {
  if (k.granularity === 'week') {
    // Approximate — use the same ISO week number in previous year.
    return { ...k, year: k.year - 1 }
  }
  return { ...k, year: k.year - 1 }
}

// Aggregation: reduce a set of month-rows into a PeriodData.
//
// Totals come from `tracker_data` (Fortnox rollup — authoritative). Line
// items are used ONLY for the overhead subcategory split. We deliberately
// don't sum `tracker_line_items.other_cost` as the overhead total: food
// lines that the AI mis-classified as other_cost would double-count
// against tracker_data.food_cost (see FIXES.md §0k).
// alcohol_cost now lives on tracker_data (M028) — the regex/label-based
// fallback that used to live here was removed when the rollup column was
// promoted. Cost-side alcohol comes from the rollup; revenue-side split
// still derives from line-item subcategory (no rollup column for that).

function aggregateMonths(
  trackerRows: any[],
  lineItems:   any[],
  includeMonths: (yr: number, mo: number) => boolean,
): PeriodData {
  let revenue = 0, food = 0, alcoholCost = 0, staff = 0, overheads = 0, depreciation = 0, financial = 0
  let revenueDineIn = 0, revenueTakeaway = 0, revenueAlcohol = 0
  let netSum = 0
  let anyFood = false, anyOverheads = false
  for (const r of trackerRows) {
    if (!includeMonths(r.period_year, r.period_month)) continue
    revenue          += Number(r.revenue           ?? 0)
    food             += Number(r.food_cost         ?? 0)
    // VAT-rate revenue subsets read STRAIGHT FROM tracker_data (M029
    // columns). Pre-M029 rows are backfilled from line items by the
    // migration. The Performance page used to re-derive this from line
    // items every render — fragile when items were missing or
    // misclassified. See FIXES.md §0o.
    alcoholCost      += Number(r.alcohol_cost      ?? 0)
    revenueDineIn    += Number(r.dine_in_revenue   ?? 0)
    revenueTakeaway  += Number(r.takeaway_revenue  ?? 0)
    revenueAlcohol   += Number(r.alcohol_revenue   ?? 0)
    staff            += Number(r.staff_cost        ?? 0)
    overheads        += Number(r.other_cost        ?? 0)
    depreciation     += Number(r.depreciation      ?? 0)
    financial        += Number(r.financial         ?? 0)
    // Trust the persisted net_profit — projectRollup applied the canonical
    // formula at write time. Summing across months gives the period total.
    netSum           += Number(r.net_profit        ?? 0)
    if (Number(r.food_cost  ?? 0) > 0) anyFood      = true
    if (Number(r.other_cost ?? 0) > 0) anyOverheads = true
  }
  // food revenue (dine-in + takeaway) — kept as a back-compat alias for
  // any caller that wants "all food revenue regardless of channel".
  const revenueFood = revenueDineIn + revenueTakeaway
  // Defensive clamp — projectRollup also clamps on write, but doubling up
  // here costs nothing and protects against legacy rows that might violate.
  alcoholCost = Math.min(alcoholCost, food)
  // Only show the food/alcohol COST split when both sides are meaningful.
  // If 95%+ of COGS is tagged as alcohol (happens when the Fortnox PDF
  // lumps all purchases under drink accounts, or the AI mislabels them),
  // collapse back into a single "Food cost" line rather than showing
  // "Food cost: 0, Alcohol: 594k" which looks like COGS is missing.
  if (food > 0 && alcoholCost >= food * 0.95) {
    alcoholCost = 0
  }
  const foodOnly = food - alcoholCost
  // Revenue split is only meaningful if at least one bucket has data AND
  // the sum is within a sensible band of the authoritative revenue (±15% —
  // anything beyond that suggests incomplete extraction). The three subsets
  // are dine-in (12%) + takeaway (6%) + alcohol (25%); remainder is
  // "övriga intäkter" (other income).
  const splitSum = revenueDineIn + revenueTakeaway + revenueAlcohol
  const hasRevenueSplit = splitSum > 0 && revenue > 0 && Math.abs(splitSum - revenue) / revenue < 0.15
  // Subcategory split for the donut + breakdown table — only use line items
  // whose Fortnox account is in the 5000-6999 "Övriga externa kostnader"
  // range. Account 4000-4999 is cost-of-goods (food), which we intentionally
  // exclude even if it's been mis-classified as category='other_cost'.
  // Falls back to category+subcategory label matching when the account is
  // missing (older extractions pre-account-capture).
  const split = { rent: 0, utilities: 0, other: 0 }
  for (const li of lineItems) {
    if (!includeMonths(li.period_year, li.period_month)) continue
    const acct = Number(li.fortnox_account ?? 0)
    const isOverheadByAccount = acct >= 5000 && acct <= 6999
    const isOverheadByCategory = li.category === 'other_cost' && (!acct || acct === 0)
    // Exclude food lines that may have been mis-classified as other_cost
    // in older extractions — if the account sits in the 4000-series, it's
    // cost-of-goods, not overheads.
    if (acct >= 4000 && acct <= 4999) continue
    if (!isOverheadByAccount && !isOverheadByCategory) continue
    const amt = Number(li.amount ?? 0)
    const sub = (li.subcategory ?? '').toLowerCase()
    if (sub === 'rent')                                                           split.rent      += amt
    else if (sub === 'utilities' || sub === 'electricity' || sub === 'telecom')   split.utilities += amt
    else                                                                          split.other     += amt
  }
  // If the subcategory split is much smaller than the authoritative total,
  // the line items are incomplete — fall back to showing everything under
  // "other" so the donut matches the waterfall.
  const splitTotal = split.rent + split.utilities + split.other
  if (splitTotal > 0 && splitTotal < overheads * 0.6) {
    split.other += overheads - splitTotal
  } else if (splitTotal === 0 && overheads > 0) {
    split.other = overheads
  }
  // Use the summed persisted net_profit values from /api/tracker (which
  // already applied the canonical formula via projectRollup). Falls back to
  // the components-formula only if no rows had a persisted net_profit
  // (e.g. a pure manual-entry month from before tracker_data.net_profit
  // was reliable). Sign convention matches lib/finance/conventions.ts:
  // financial is signed, ADDED (not subtracted).
  const netMargin = netSum !== 0
    ? netSum
    : (revenue - food - staff - overheads - depreciation + financial)
  const marginPct = revenue > 0 ? (netMargin / revenue) * 100 : null
  return {
    revenue,
    revenue_dine_in:   revenueDineIn,
    revenue_takeaway:  revenueTakeaway,
    revenue_alcohol:   revenueAlcohol,
    revenue_food:      revenueFood,   // dine-in + takeaway, back-compat
    has_revenue_split: hasRevenueSplit,
    food_cost:      food,
    alcohol_cost:   alcoholCost,
    food_only_cost: foodOnly,
    staff_cost:     staff,
    overheads,
    net_margin:     netMargin,
    margin_pct:     marginPct,
    // food_pct is the COMBINED COGS ratio (food + alcohol) — industry
    // benchmarks (28-32%) apply to total cost-of-goods, not just food.
    // alcohol_pct breaks out the beverage portion for display.
    food_pct:       revenue > 0 ? (food / revenue)            * 100 : null,
    alcohol_pct:    revenue > 0 ? (alcoholCost / revenue)     * 100 : null,
    takeaway_pct:   revenue > 0 ? (revenueTakeaway / revenue) * 100 : null,
    staff_pct:      revenue > 0 ? (staff / revenue)           * 100 : null,
    overheads_pct:  revenue > 0 ? (overheads / revenue)       * 100 : null,
    overhead_split: split,
    has_food:       anyFood,
    has_alcohol:    alcoholCost > 0,
    has_takeaway:   revenueTakeaway > 0,
    has_overheads:  anyOverheads,
  }
}

// Aggregation for week granularity using daily rows (revenue + staff_cost
// only — food/overheads are N/A weekly).
function aggregateDaily(dailyRows: any[]): PeriodData {
  let revenue = 0, staff = 0, revFood = 0, revBev = 0
  for (const r of dailyRows) {
    revenue += Number(r.revenue ?? 0)
    staff   += Number(r.staff_cost ?? 0)
    // daily_metrics writes food_revenue / bev_revenue via the aggregator —
    // VAT-based PK split (12% = food, 25% = drink). Surface when non-zero.
    revFood += Number(r.food_revenue ?? 0)
    revBev  += Number(r.bev_revenue  ?? 0)
  }
  const splitSum = revFood + revBev
  const hasSplit = splitSum > 0 && revenue > 0 && Math.abs(splitSum - revenue) / revenue < 0.15
  const net = revenue - staff
  // daily_metrics doesn't carry a takeaway split (PK groups food + takeaway
  // both as 'food'-side revenue), so the weekly view shows the dine-in /
  // alcohol pair only; takeaway stays at 0 for now.
  return {
    revenue,
    revenue_dine_in:   revFood,
    revenue_takeaway:  0,
    revenue_alcohol:   revBev,
    revenue_food:      revFood,
    has_revenue_split: hasSplit,
    food_cost:      0,
    alcohol_cost:   0,
    food_only_cost: 0,
    staff_cost:     staff,
    overheads:      0,
    net_margin:     net,
    margin_pct:     revenue > 0 ? (net / revenue) * 100 : null,
    food_pct:       null,
    alcohol_pct:    null,
    takeaway_pct:   null,
    staff_pct:      revenue > 0 ? (staff / revenue) * 100 : null,
    overheads_pct:  null,
    overhead_split: { rent: 0, utilities: 0, other: 0 },
    has_food:       false,
    has_alcohol:    false,
    has_takeaway:   false,
    has_overheads:  false,
  }
}

// Select which months roll up into a PeriodKey.
function monthIncluder(k: PeriodKey): (yr: number, mo: number) => boolean {
  if (k.granularity === 'month')   return (yr, mo) => yr === k.year && mo === k.month
  if (k.granularity === 'quarter') return (yr, mo) => yr === k.year && quarterOfMonth(mo) === k.quarter
  if (k.granularity === 'ytd') {
    const now = new Date()
    const maxMo = k.year === now.getFullYear() ? now.getMonth() + 1 : 12
    return (yr, mo) => yr === k.year && mo <= maxMo
  }
  return () => false
}

// ─── Main page ─────────────────────────────────────────────────────────────
interface Business { id: string; name: string; city?: string | null }
type CompareMode = 'none' | 'prev' | 'yoy' | 'ytd_yoy' | { custom: PeriodKey }

export default function PerformancePage() {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [granularity, setGranularity] = useState<Granularity>('month')
  const [period,      setPeriod]      = useState<PeriodKey>(currentPeriod('month'))
  const [compare,     setCompare]     = useState<CompareMode>('none')

  // Data cache keyed by year so year-changes don't refetch everything.
  // The caches are wiped whenever bizId changes (see effect below) — they're
  // scoped to a single business, so stale year-keys from a previous
  // selection would otherwise be reused when switching to a new business.
  const [trackerByYear, setTrackerByYear]     = useState<Record<number, any[]>>({})
  const [lineItemsByYear, setLineItemsByYear] = useState<Record<number, any[]>>({})
  const [dailyByRange,  setDailyByRange]      = useState<Record<string, any[]>>({})
  const [loading, setLoading] = useState(false)

  // Wipe caches on business change so the next fetch effect re-pulls for
  // the newly-selected business. Without this, switching from Vero →
  // Rosali would see "2025 already cached" and silently show Vero's
  // numbers under Rosali's name.
  useEffect(() => {
    setTrackerByYear({})
    setLineItemsByYear({})
    setDailyByRange({})
  }, [bizId])

  // Load businesses + restore selection.
  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((arr: any[]) => {
      if (!Array.isArray(arr) || !arr.length) return
      setBusinesses(arr)
      const saved = localStorage.getItem('cc_selected_biz')
      const id    = (saved && arr.find(b => b.id === saved)) ? saved : arr[0].id
      setBizId(id)
    }).catch(() => {})
    const onStorage = () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Resolve what yearly data we need for the current + compare period.
  const yearsNeeded = useMemo(() => {
    const ys = new Set<number>()
    ys.add(period.year)
    if (compare === 'prev')    ys.add(previousPeriod(period).year)
    if (compare === 'yoy')     ys.add(period.year - 1)
    if (compare === 'ytd_yoy') ys.add(period.year - 1)
    if (typeof compare === 'object' && compare?.custom) ys.add(compare.custom.year)
    // Always include the prior year for sparklines (12 back from current).
    ys.add(period.year - 1)
    return Array.from(ys)
  }, [period, compare])

  // Fetch yearly month-level data (tracker + overhead line-items) — covers
  // month/quarter/ytd granularities AND the sparkline trend cards.
  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    setLoading(true)

    const missingTracker   = yearsNeeded.filter(y => !trackerByYear[y])
    const missingLineItems = yearsNeeded.filter(y => !lineItemsByYear[y])

    Promise.all([
      ...missingTracker.map(y =>
        fetch(`/api/tracker?business_id=${bizId}&year=${y}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : []).then(j => ({ y, rows: Array.isArray(j) ? j : [] }))),
      ...missingLineItems.map(y =>
        fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${y}&year_to=${y}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : { rows: [] }).then(j => ({ y, rows: j?.rows ?? [] }))),
    ]).then((responses: any[]) => {
      if (cancelled) return
      const newTracker:   Record<number, any[]> = {}
      const newLineItems: Record<number, any[]> = {}
      let   i = 0
      for (const y of missingTracker)   newTracker[y]   = responses[i++]?.rows ?? []
      for (const y of missingLineItems) newLineItems[y] = responses[i++]?.rows ?? []
      if (Object.keys(newTracker).length)   setTrackerByYear  (prev => ({ ...prev, ...newTracker }))
      if (Object.keys(newLineItems).length) setLineItemsByYear(prev => ({ ...prev, ...newLineItems }))
    }).finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [bizId, yearsNeeded.join(',')])

  // Fetch daily data for week granularity (current + compare week if set).
  useEffect(() => {
    if (!bizId) return
    if (granularity !== 'week') return
    const ranges: Array<{ key: string; from: string; to: string }> = []
    const addRange = (k: PeriodKey) => {
      const { from, to } = periodBounds(k)
      const key = `${k.year}-${k.week}`
      if (!dailyByRange[key]) ranges.push({ key, from, to })
    }
    addRange(period)
    if (compare === 'prev') addRange(previousPeriod(period))
    if (compare === 'yoy')  addRange(samePeriodLastYear(period))
    if (typeof compare === 'object' && compare?.custom) addRange(compare.custom)
    if (!ranges.length) return

    let cancelled = false
    Promise.all(
      ranges.map(r =>
        fetch(`/api/metrics/daily?business_id=${bizId}&from=${r.from}&to=${r.to}`)
          .then(x => x.ok ? x.json() : { rows: [] })
          .then(j => ({ key: r.key, rows: j?.rows ?? [] })),
      ),
    ).then((responses: any[]) => {
      if (cancelled) return
      const next: Record<string, any[]> = {}
      for (const resp of responses) next[resp.key] = resp.rows
      setDailyByRange(prev => ({ ...prev, ...next }))
    })
    return () => { cancelled = true }
  }, [bizId, granularity, period.year, period.week, compare])

  // Compute current-period data.
  const currentData = useMemo<PeriodData | null>(() => {
    if (!bizId) return null
    if (period.granularity === 'week') {
      const key = `${period.year}-${period.week}`
      const rows = dailyByRange[key]
      return rows ? aggregateDaily(rows) : null
    }
    const tracker = trackerByYear[period.year]
    const lines   = lineItemsByYear[period.year]
    if (!tracker || !lines) return null
    return aggregateMonths(tracker, lines, monthIncluder(period))
  }, [bizId, period, trackerByYear, lineItemsByYear, dailyByRange])

  // Compute the compare-period key.
  const comparePeriod = useMemo<PeriodKey | null>(() => {
    if (compare === 'none') return null
    if (compare === 'prev') return previousPeriod(period)
    if (compare === 'yoy')  return samePeriodLastYear(period)
    if (compare === 'ytd_yoy') return { granularity: 'ytd', year: period.year - 1 }
    if (typeof compare === 'object' && compare?.custom) return compare.custom
    return null
  }, [compare, period])

  const compareData = useMemo<PeriodData | null>(() => {
    if (!comparePeriod) return null
    if (comparePeriod.granularity === 'week') {
      const key = `${comparePeriod.year}-${comparePeriod.week}`
      const rows = dailyByRange[key]
      return rows ? aggregateDaily(rows) : null
    }
    const tracker = trackerByYear[comparePeriod.year]
    const lines   = lineItemsByYear[comparePeriod.year]
    if (!tracker || !lines) return null
    return aggregateMonths(tracker, lines, monthIncluder(comparePeriod))
  }, [comparePeriod, trackerByYear, lineItemsByYear, dailyByRange])

  // Sparkline series — last 12 periods of each metric ending at `period`.
  const sparks = useMemo(() => {
    const out = { margin: [] as SparkRow[], labour: [] as SparkRow[], food: [] as SparkRow[] }
    const make = (k: PeriodKey): SparkRow[] => {
      const src: SparkRow[] = []
      // Only available at month / quarter / ytd. For week, we show last 12
      // weeks by stepping back; but food/overhead metrics will be null so
      // the Food sparkline renders with dashed/no-data.
      for (let i = 11; i >= 0; i--) {
        const step = stepPeriod(k, -1 as any)   // trick to use the stepper
        // Build the "k - i" period manually:
        let pk: PeriodKey = { ...k }
        for (let s = 0; s < i; s++) pk = stepPeriod(pk, -1)
        const tracker = trackerByYear[pk.year]
        const lines   = lineItemsByYear[pk.year]
        if (pk.granularity === 'week') {
          const key = `${pk.year}-${pk.week}`
          const rows = dailyByRange[key]
          if (rows) src.push({ label: `W${pk.week}`, value: 0 }) // label only; values filled below per-metric
        } else if (tracker && lines) {
          src.push({ label: periodLabel(pk), value: 0 })
        } else {
          src.push({ label: '—', value: 0 })
        }
      }
      return src
    }
    const fillValues = (getter: (pd: PeriodData | null) => number): number[] => {
      const arr: number[] = []
      for (let i = 11; i >= 0; i--) {
        let pk: PeriodKey = { ...period }
        for (let s = 0; s < i; s++) pk = stepPeriod(pk, -1)
        let pd: PeriodData | null = null
        if (pk.granularity === 'week') {
          const rows = dailyByRange[`${pk.year}-${pk.week}`]
          pd = rows ? aggregateDaily(rows) : null
        } else {
          const tracker = trackerByYear[pk.year]
          const lines   = lineItemsByYear[pk.year]
          if (tracker && lines) pd = aggregateMonths(tracker, lines, monthIncluder(pk))
        }
        arr.push(pd ? getter(pd) : 0)
      }
      return arr
    }
    return {
      margin:  fillValues(pd => (pd?.margin_pct   ?? 0)),
      labour:  fillValues(pd => (pd?.staff_pct    ?? 0)),
      food:    fillValues(pd => (pd?.food_pct     ?? 0)),
    }
  }, [period, trackerByYear, lineItemsByYear, dailyByRange])

  // ─── Render ─────────────────────────────────────────────────────────────
  const selectedBiz = businesses.find(b => b.id === bizId) ?? null
  const compareLabel = comparePeriod ? periodLabel(comparePeriod) : null

  return (
    <AppShell>
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {/* Header — granularity + period + compare controls */}
        <HeaderRow
          granularity={granularity}
          period={period}
          compare={compare}
          onGranularityChange={g => {
            setGranularity(g)
            setPeriod(currentPeriod(g))
          }}
          onPeriodStep={dir => setPeriod(stepPeriod(period, dir))}
          onCompareChange={setCompare}
          canStepNext={!isFuturePeriod(stepPeriod(period, 1))}
        />

        {/* KPI strip */}
        <KpiStrip data={currentData} compare={compareData} compareLabel={compareLabel} />

        {loading && !currentData && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
            Loading…
          </div>
        )}

        {!loading && !currentData && (
          <EmptyCard
            title={`No data for ${periodLabel(period)}`}
            body="Period is closed or hasn't been synced yet."
          />
        )}

        {currentData && (
          <>
            {/* Profit composition — waterfall + donut. Side-by-side on
                desktop/tablet; stacks on mobile via auto-fit minmax. */}
            <div style={{
              display:             'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
              gap:                 12,
            }}>
              <WaterfallCard data={currentData} />
              <CostMixCard data={currentData} />
            </div>

            {/* Line-by-line breakdown */}
            <BreakdownCard data={currentData} compare={compareData} compareLabel={compareLabel} />

            {/* Trend strip — 12-period mini history per ratio */}
            <TrendStrip sparks={sparks} granularity={granularity} current={currentData} />

            {/* What's tunable */}
            <TunableCard items={buildTunableItems(period, currentData, compareData)} />
          </>
        )}
      </PageContainer>

      <AskAI
        page="performance"
        context={buildAskContext(period, currentData, comparePeriod, compareData, selectedBiz?.name)}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components — all UXP, 0.5px hairlines, tabular-nums
// ════════════════════════════════════════════════════════════════════

// ── Header controls ─────────────────────────────────────────────────
interface HeaderRowProps {
  granularity:        Granularity
  period:             PeriodKey
  compare:            CompareMode
  onGranularityChange: (g: Granularity) => void
  onPeriodStep:       (dir: -1 | 1) => void
  onCompareChange:    (c: CompareMode) => void
  canStepNext:        boolean
}

function HeaderRow({ granularity, period, compare, onGranularityChange, onPeriodStep, onCompareChange, canStepNext }: HeaderRowProps) {
  return (
    <div style={{
      display:        'flex',
      justifyContent: 'space-between',
      alignItems:     'center',
      gap:            10,
      flexWrap:       'wrap' as const,
    }}>
      <PeriodStepper label={periodLabel(period)} onPrev={() => onPeriodStep(-1)} onNext={canStepNext ? () => onPeriodStep(1) : undefined} />
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
        <Toggle
          opts={[
            { k: 'week',    lab: 'Week'    },
            { k: 'month',   lab: 'Month'   },
            { k: 'quarter', lab: 'Quarter' },
            { k: 'ytd',     lab: 'YTD'     },
          ]}
          value={granularity}
          onChange={(v) => onGranularityChange(v as Granularity)}
        />
        <CompareToggle value={compare} onChange={onCompareChange} />
      </div>
    </div>
  )
}

function PeriodStepper({ label, onPrev, onNext }: { label: string; onPrev?: () => void; onNext?: () => void }) {
  return (
    <div style={{
      display:      'inline-flex',
      alignItems:   'center',
      gap:          4,
      padding:      '4px 6px',
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: 7,
    }}>
      <button type="button" onClick={onPrev} disabled={!onPrev} style={stepBtn(!!onPrev)} aria-label="Previous">◄</button>
      <span style={{ fontSize: 11, color: UXP.ink1, fontWeight: 500, padding: '0 8px', minWidth: 100, textAlign: 'center' as const }}>
        {label}
      </span>
      <button type="button" onClick={onNext} disabled={!onNext} style={stepBtn(!!onNext)} aria-label="Next">►</button>
    </div>
  )
}

function stepBtn(enabled: boolean): React.CSSProperties {
  return {
    width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', cursor: enabled ? 'pointer' : 'not-allowed',
    color: enabled ? UXP.ink3 : UXP.ink4, fontSize: 11, padding: 0, fontFamily: 'inherit',
  }
}

function Toggle({ opts, value, onChange }: { opts: Array<{ k: string; lab: string }>; value: string; onChange: (v: string) => void }) {
  return (
    <div style={{
      display:      'inline-flex',
      gap:          2,
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: 7,
      padding:      2,
    }}>
      {opts.map(o => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          style={{
            padding:       '4px 12px',
            background:    value === o.k ? UXP.lavFill : 'transparent',
            color:         value === o.k ? UXP.lavText : UXP.ink3,
            border:        'none',
            borderRadius:  5,
            fontSize:      10,
            fontWeight:    500,
            fontFamily:    'inherit',
            cursor:        'pointer',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
          }}
        >
          {o.lab}
        </button>
      ))}
    </div>
  )
}

function CompareToggle({ value, onChange }: { value: CompareMode; onChange: (c: CompareMode) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as any)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current =
    value === 'none'    ? 'No compare' :
    value === 'prev'    ? 'vs Previous' :
    value === 'yoy'     ? 'vs Last year' :
    value === 'ytd_yoy' ? 'vs YTD last year' :
                          'Custom'

  return (
    <div ref={ref} style={{ position: 'relative' as const }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{
          padding:      '4px 12px',
          background:   value === 'none' ? UXP.cardBg : UXP.lavFill,
          color:        value === 'none' ? UXP.ink2   : UXP.lavText,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: 7,
          fontSize:     10,
          fontWeight:   500,
          fontFamily:   'inherit',
          cursor:       'pointer',
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
          display:      'inline-flex',
          alignItems:   'center',
          gap:          5,
        }}
      >
        Compare: {current}
        <span aria-hidden style={{ fontSize: 9 }}>▾</span>
      </button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        align="right"
        menuWidth={200}
        title="Compare"
      >
        {([
          ['none',    'No compare'],
          ['prev',    'Previous period'],
          ['yoy',     'Same period last year'],
          ['ytd_yoy', 'YTD last year'],
        ] as Array<[CompareMode, string]>).map(([k, lab]) => (
          <button
            key={String(k)}
            type="button"
            onClick={() => { onChange(k); setOpen(false) }}
            style={{
              display:      'block',
              width:        '100%',
              textAlign:    'left' as const,
              padding:      '9px 10px',
              background:   value === k ? UXP.lavFill : 'transparent',
              color:        value === k ? UXP.lavText : UXP.ink1,
              border:       'none',
              borderRadius: UXP.r_sm,
              cursor:       'pointer',
              fontSize:     12,
              fontFamily:   'inherit',
            }}
          >
            {lab}
          </button>
        ))}
      </Popover>
    </div>
  )
}

// ── KPI strip ───────────────────────────────────────────────────────
function KpiStrip({ data, compare, compareLabel }: any) {
  if (!data) {
    return (
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
        gap:                 12,
      }}>
        {[0,1,2,3].map(i => (
          <div key={i} style={{
            background:    UXP.cardBg,
            border:        `0.5px solid ${UXP.border}`,
            borderRadius:  UXP.r_lg,
            padding:       '20px 16px',
            color:         UXP.ink4,
            fontSize:      11,
          }}>—</div>
        ))}
      </div>
    )
  }

  const cogsPct  = data.has_food && data.revenue > 0 ? (data.food_cost / data.revenue) * 100 : null
  const labPct   = data.staff_pct
  const marginPct = data.margin_pct

  const revDelta = compare && compare.revenue > 0
    ? `${data.revenue - compare.revenue >= 0 ? '+' : ''}${(((data.revenue - compare.revenue) / compare.revenue) * 100).toFixed(1)}%`
    : null
  const marginDelta = compare && compare.margin_pct != null && marginPct != null
    ? `${marginPct - compare.margin_pct >= 0 ? '+' : ''}${(marginPct - compare.margin_pct).toFixed(1)}pp`
    : null
  const cogsDelta = compare && compare.food_pct != null && cogsPct != null
    ? `${cogsPct - compare.food_pct >= 0 ? '+' : ''}${(cogsPct - compare.food_pct).toFixed(1)}pp`
    : null
  const labDelta = compare && compare.staff_pct != null && labPct != null
    ? `${labPct - compare.staff_pct >= 0 ? '+' : ''}${(labPct - compare.staff_pct).toFixed(1)}pp`
    : null

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Sales"
        value={data.revenue > 0 ? fmtKr(data.revenue) : '—'}
        delta={revDelta}
        deltaGood
        microLabel={compareLabel ? `vs ${compareLabel}` : ''}
      />
      <KpiCardUX
        title="CoGS"
        value={data.has_food ? fmtKr(data.food_cost) : '—'}
        delta={cogsDelta}
        deltaGood={false}
        variant="stacked"
        stackedBars={cogsPct != null ? [
          { label: 'Current', value: cogsPct, max: 100, color: UXP.lav   },
          { label: 'Target',  value: 30,      max: 100, color: UXP.green },
        ] : undefined}
        microLabel={cogsPct != null ? `${cogsPct.toFixed(1)}% of revenue` : 'No CoGS data'}
      />
      <KpiCardUX
        title="Labour"
        value={data.staff_cost > 0 ? fmtKr(data.staff_cost) : '—'}
        delta={labDelta}
        deltaGood={false}
        variant="targetBand"
        targetBand={labPct != null ? {
          actualPct:    Math.min(100, labPct),
          targetMinPct: DEFAULT_TIER_CONFIG.targetMin,
          targetMaxPct: DEFAULT_TIER_CONFIG.targetMax,
        } : undefined}
        microLabel={labPct != null ? `${labPct.toFixed(1)}% of revenue` : ''}
      />
      <KpiCardUX
        title="Flash profit"
        value={fmtKr(data.net_margin)}
        delta={marginDelta}
        deltaGood
        microLabel={marginPct != null ? `${marginPct.toFixed(1)}% net margin` : ''}
      />
    </div>
  )
}

// ── Waterfall ───────────────────────────────────────────────────────
function WaterfallCard({ data }: { data: PeriodData }) {
  const steps: Array<{ label: string; kind: 'start' | 'sub' | 'end'; value: number }> = [
    { label: 'Sales',       kind: 'start', value: data.revenue       },
    { label: 'CoGS',        kind: 'sub',   value: data.food_cost     },
    { label: 'Labour',      kind: 'sub',   value: data.staff_cost    },
    { label: 'Overheads',   kind: 'sub',   value: data.overheads     },
    { label: 'Flash profit', kind: 'end',  value: data.net_margin    },
  ]
  const max = Math.max(1, data.revenue)
  return (
    <div style={cardStyleP()}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Profit composition</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Sales − CoGS − Labour − Overheads
        </div>
      </div>
      <div style={{ display: 'grid', gap: 10 }}>
        {steps.map((s, i) => {
          const isNeg  = s.kind === 'sub'
          const isEnd  = s.kind === 'end'
          const w      = Math.max(0, Math.min(100, (Math.abs(s.value) / max) * 100))
          const colour = s.kind === 'start' ? UXP.lav
                       : s.kind === 'end'   ? (s.value >= 0 ? UXP.green : UXP.rose)
                       :                      UXP.lavMid
          const valueColour = s.kind === 'end'   ? (s.value >= 0 ? UXP.greenDeep : UXP.roseText)
                            : s.kind === 'start' ? UXP.lavText
                            :                      UXP.coral
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '100px 1fr 120px', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{s.label}</span>
              <span style={{
                position:     'relative' as const,
                height:       isEnd ? 16 : 8,
                background:   UXP.subtleBg,
                borderRadius: 4,
                overflow:     'hidden' as const,
              }}>
                <span style={{
                  display:      'block',
                  height:       '100%',
                  width:        `${w}%`,
                  background:   colour,
                  borderRadius: 4,
                }} />
              </span>
              <span style={{
                textAlign:          'right' as const,
                fontSize:           isEnd ? 14 : 11,
                fontWeight:         isEnd ? 500 : 400,
                color:              valueColour,
                fontFamily:         isEnd ? 'var(--font-display)' : 'inherit',
                fontVariantNumeric: 'tabular-nums' as const,
                letterSpacing:      isEnd ? '-0.02em' : 0,
              }}>
                {isNeg && '−'}{fmtKr(Math.abs(s.value))}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Cost mix (replaces the legacy donut) ───────────────────────────
function CostMixCard({ data }: { data: PeriodData }) {
  const total = data.food_cost + data.staff_cost + data.overheads
  const items = [
    { label: 'CoGS',      value: data.food_cost,  color: UXP.lav     },
    { label: 'Labour',    value: data.staff_cost, color: UXP.lavMid  },
    { label: 'Overheads', value: data.overheads,  color: UXP.lavPale },
  ]
  return (
    <div style={cardStyleP()}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Cost mix</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {total > 0 ? `${fmtKr(total)} total` : 'No cost data'}
        </div>
      </div>
      {total > 0 && (
        <>
          {/* Stacked bar */}
          <div style={{ display: 'flex', height: 10, borderRadius: 5, overflow: 'hidden' as const, background: UXP.subtleBg, marginBottom: 12 }}>
            {items.map(it => {
              const w = (it.value / total) * 100
              if (w === 0) return null
              return <span key={it.label} style={{ width: `${w}%`, background: it.color, display: 'inline-block' }} />
            })}
          </div>
          {/* Legend */}
          <div style={{ display: 'grid', gap: 8 }}>
            {items.map(it => {
              const pct = total > 0 ? (it.value / total) * 100 : 0
              return (
                <div key={it.label} style={{ display: 'grid', gridTemplateColumns: '12px 1fr auto auto', gap: 8, alignItems: 'center' }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: it.color, display: 'inline-block' }} />
                  <span style={{ fontSize: 11, color: UXP.ink2 }}>{it.label}</span>
                  <span style={{ fontSize: 11, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const, minWidth: 64, textAlign: 'right' as const }}>
                    {fmtKr(it.value)}
                  </span>
                  <span style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const, minWidth: 40, textAlign: 'right' as const }}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
              )
            })}
          </div>
        </>
      )}
      {/* Overhead sub-split when available */}
      {data.has_overheads && (data.overhead_split.rent + data.overhead_split.utilities + data.overhead_split.other) > 0 && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `0.5px solid ${UXP.borderSoft}` }}>
          <div style={{ fontSize: 9, color: UXP.ink4, marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            Overheads split
          </div>
          {[
            ['Rent',      data.overhead_split.rent],
            ['Utilities', data.overhead_split.utilities],
            ['Other',     data.overhead_split.other],
          ].map(([lab, val]) => {
            const t = data.overheads
            return (
              <div key={lab as string} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: UXP.ink3, padding: '3px 0' }}>
                <span>{lab as string}</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' as const }}>
                  {fmtKr(val as number)} <span style={{ color: UXP.ink4 }}>· {t > 0 ? (((val as number) / t) * 100).toFixed(1) : '0'}%</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Line-by-line breakdown ──────────────────────────────────────────
function BreakdownCard({ data, compare, compareLabel }: { data: PeriodData; compare: PeriodData | null; compareLabel: string | null }) {
  type Row = { line: string; value: number; pct: number | null; cmp?: number | null; cmpPct?: number | null; positiveIsGood?: boolean }
  const rows: Row[] = [
    { line: 'Sales',                       value: data.revenue,    pct: 100,                  cmp: compare?.revenue,    cmpPct: compare && compare.revenue > 0 ? 100 : null, positiveIsGood: true },
    { line: data.has_alcohol ? 'Food cost'  : 'CoGS', value: data.has_alcohol ? data.food_only_cost : data.food_cost, pct: data.food_pct,    cmp: compare ? (compare.has_alcohol ? compare.food_only_cost : compare.food_cost) : null, cmpPct: compare?.food_pct ?? null, positiveIsGood: false },
  ]
  if (data.has_alcohol) {
    rows.push({ line: 'Alcohol cost', value: data.alcohol_cost, pct: data.alcohol_pct, cmp: compare?.alcohol_cost ?? null, cmpPct: compare?.alcohol_pct ?? null, positiveIsGood: false })
  }
  rows.push(
    { line: 'Labour',    value: data.staff_cost, pct: data.staff_pct,    cmp: compare?.staff_cost   ?? null, cmpPct: compare?.staff_pct   ?? null, positiveIsGood: false },
    { line: 'Overheads', value: data.overheads,  pct: data.overheads_pct, cmp: compare?.overheads   ?? null, cmpPct: compare?.overheads_pct ?? null, positiveIsGood: false },
    { line: 'Flash profit', value: data.net_margin, pct: data.margin_pct, cmp: compare?.net_margin ?? null, cmpPct: compare?.margin_pct ?? null, positiveIsGood: true },
  )

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>P&amp;L breakdown</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {compareLabel ? `vs ${compareLabel}` : 'Current period only'}
        </div>
      </div>
      <BreakdownTable<Row>
        columns={[
          { key: 'line', header: 'Line',   align: 'left',  render: (r) => (
            <span style={{ color: UXP.ink1, fontWeight: r.line === 'Sales' || r.line === 'Flash profit' ? 500 : 400 }}>
              {r.line}
            </span>
          ) },
          { key: 'value', header: 'Amount', align: 'right', render: (r) => fmtKr(r.value) },
          { key: 'pct',   header: '%',      align: 'right', render: (r) =>
            r.pct != null ? `${r.pct.toFixed(1)}%` : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'cmp',   header: compareLabel ?? '—', align: 'right', render: (r) =>
            r.cmp != null ? fmtKr(r.cmp) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'delta', header: 'Δ', align: 'right', render: (r) => {
            if (r.cmp == null || r.cmp === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            const pct = ((r.value - r.cmp) / r.cmp) * 100
            return <DeltaChip value={`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`} positiveIsGood={r.positiveIsGood !== false} />
          } },
        ]}
        sections={[{ rows }]}
        rowKey={(row, i) => row.line + i}
      />
    </div>
  )
}

// ── Trend strip ─────────────────────────────────────────────────────
function TrendStrip({ sparks, granularity, current }: { sparks: any; granularity: Granularity; current: PeriodData }) {
  const items: Array<{ label: string; value: string; points: number[]; tone: 'good' | 'warning' | 'bad' | 'neutral'; target: string; invert?: boolean }> = [
    {
      label: 'Net margin',
      value: current.margin_pct != null ? `${current.margin_pct.toFixed(1)}%` : '—',
      points: sparks.margin,
      tone: current.margin_pct != null && current.margin_pct >= 10 ? 'good' : current.margin_pct != null && current.margin_pct >= 5 ? 'warning' : 'bad',
      target: 'Target ≥10%',
    },
    {
      label: 'Labour %',
      value: current.staff_pct != null ? `${current.staff_pct.toFixed(1)}%` : '—',
      points: sparks.labour,
      tone: current.staff_pct == null ? 'neutral' : current.staff_pct <= 42 ? 'good' : current.staff_pct <= 57 ? 'warning' : 'bad',
      target: 'Target ≤42%',
      invert: true,
    },
    {
      label: 'CoGS %',
      value: current.food_pct != null ? `${current.food_pct.toFixed(1)}%` : '—',
      points: sparks.food,
      tone: current.food_pct == null ? 'neutral' : current.food_pct <= 32 ? 'good' : current.food_pct <= 38 ? 'warning' : 'bad',
      target: 'Target ≤32%',
      invert: true,
    },
  ]
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      {items.map(it => (
        <TrendTile key={it.label} {...it} />
      ))}
    </div>
  )
}

function TrendTile({ label, value, points, tone, target }: any) {
  const palette: { bar: string; fg: string; bg: string } = (({
    good:    { bar: UXP.green, fg: UXP.greenDeep, bg: UXP.greenFill },
    warning: { bar: UXP.coral, fg: UXP.coral,     bg: UXP.lavFill   },
    bad:     { bar: UXP.rose,  fg: UXP.roseText,  bg: UXP.roseFill  },
    neutral: { bar: UXP.lav,   fg: UXP.lavText,   bg: UXP.lavFill   },
  } as Record<string, { bar: string; fg: string; bg: string }>)[tone] ?? { bar: UXP.lav, fg: UXP.lavText, bg: UXP.lavFill })
  return (
    <div style={cardStyleP()}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{label}</div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2 }}>{target}</div>
        </div>
        <span style={{
          fontFamily:         'var(--font-display)',
          fontSize:           18,
          fontWeight:         500,
          color:              palette.fg,
          letterSpacing:      '-0.02em',
          fontVariantNumeric: 'tabular-nums' as const,
        }}>{value}</span>
      </div>
      <MiniBars points={points} tone={tone} />
    </div>
  )
}

function MiniBars({ points, tone }: { points: number[]; tone: 'good' | 'warning' | 'bad' | 'neutral' }) {
  if (!points || points.length === 0) return null
  const max = Math.max(1, ...points.map(v => Math.abs(v)))
  const colour = tone === 'good' ? UXP.green
               : tone === 'bad'  ? UXP.rose
               : tone === 'warning' ? UXP.coral
               : UXP.lav
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 28 }}>
      {points.map((v, i) => {
        const h = Math.max(2, (Math.abs(v) / max) * 26)
        return (
          <span key={i} style={{
            flex:         1,
            height:       h,
            background:   i === points.length - 1 ? colour : UXP.lavFill,
            borderRadius: 1,
          }} />
        )
      })}
    </div>
  )
}

// ── Tunable card ────────────────────────────────────────────────────
function TunableCard({ items }: { items: AttentionItem[] }) {
  if (!items || items.length === 0) return null
  return (
    <div style={cardStyleP()}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>What's tunable</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {items.length} lever{items.length === 1 ? '' : 's'}
        </div>
      </div>
      {items.map((it, idx) => {
        const palette = it.tone === 'good'    ? { bar: UXP.green, fg: UXP.greenDeep }
                       : it.tone === 'bad'    ? { bar: UXP.rose,  fg: UXP.roseText  }
                       :                        { bar: UXP.coral, fg: UXP.coral     }
        return (
          <div key={idx} style={{
            display:             'grid',
            gridTemplateColumns: '4px auto 1fr',
            gap:                 12,
            alignItems:          'center',
            padding:             '10px 0',
            borderBottom:        idx < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
          }}>
            <span style={{ width: 4, height: '100%', minHeight: 24, background: palette.bar, borderRadius: 2 }} />
            <span style={{
              fontSize:      9,
              fontWeight:    600,
              letterSpacing: '0.04em',
              color:         palette.fg,
              textTransform: 'uppercase' as const,
              minWidth:      72,
            }}>{it.entity}</span>
            <span style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.4 }}>{it.message}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── Generic helpers ─────────────────────────────────────────────────
function cardStyleP(): React.CSSProperties {
  return {
    background:    UXP.cardBg,
    border:        `0.5px solid ${UXP.border}`,
    borderRadius:  UXP.r_lg,
    padding:       '14px 16px',
  }
}

function EmptyCard({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       40,
      textAlign:     'center' as const,
    }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: UXP.ink3, maxWidth: 440, margin: '0 auto', lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}

// ── buildAskContext — kept for AskAI ───────────────────────────────
function buildAskContext(
  period:        PeriodKey,
  data:          PeriodData | null,
  comparePeriod: PeriodKey | null,
  compare:       PeriodData | null,
  bizName?:      string | null,
): string {
  if (!data) return `Performance page for ${bizName ?? '—'}. No data for ${periodLabel(period)} yet.`
  const lines: string[] = []
  lines.push(`Performance page · ${bizName ?? 'business'} · ${periodLabel(period)}`)
  const foodPart = data.has_alcohol
    ? `food ${fmtKr(data.food_only_cost)} + alcohol ${fmtKr(data.alcohol_cost)}`
    : (data.has_food ? `food cost ${fmtKr(data.food_cost)}` : 'food cost —')
  lines.push(`Revenue ${fmtKr(data.revenue)}, ${foodPart}, labour ${fmtKr(data.staff_cost)}, overheads ${data.has_overheads ? fmtKr(data.overheads) : '—'}, net margin ${fmtKr(data.net_margin)}.`)
  lines.push(`Ratios: margin ${fmtPct(data.margin_pct)}, labour ${fmtPct(data.staff_pct)}${data.has_food ? `, food-total ${fmtPct(data.food_pct)}` : ''}${data.has_alcohol ? ` (alcohol ${fmtPct(data.alcohol_pct)})` : ''}${data.has_overheads ? `, overheads ${fmtPct(data.overheads_pct)}` : ''}.`)
  if (data.has_overheads) {
    const os = data.overhead_split
    lines.push(`Overhead split: rent ${fmtKr(os.rent)}, utilities ${fmtKr(os.utilities)}, other ${fmtKr(os.other)}.`)
  }
  if (comparePeriod && compare) {
    lines.push(`Compare vs ${periodLabel(comparePeriod)}: revenue ${fmtKr(compare.revenue)} (Δ ${fmtKr(data.revenue - compare.revenue)}), margin ${fmtPct(compare.margin_pct)} (Δ ${((data.margin_pct ?? 0) - (compare.margin_pct ?? 0)).toFixed(1)}pp).`)
  }
  if (period.granularity === 'week' && !data.has_food) {
    lines.push('Note: food cost and overheads are tracked monthly in Fortnox, so they show as — at Week granularity.')
  }
  return lines.join('\n')
}

// ── buildTunableItems — heuristic lever-flagger ────────────────────
function buildTunableItems(period: PeriodKey, cur: PeriodData, prev: PeriodData | null): AttentionItem[] {
  const items: AttentionItem[] = []
  // Labour lever
  if (cur.revenue > 0 && cur.staff_pct != null) {
    const over = cur.staff_pct - 42
    const onePpKr = Math.round(cur.revenue * 0.01)
    if (over > 2) {
      items.push({
        tone: over > 10 ? 'bad' : 'warning',
        entity: 'Labour',
        message: `Labour at ${fmtPct(cur.staff_pct)} — ${over.toFixed(1)}pp over the 42% target. Each percentage point ≈ ${fmtShortKr(onePpKr)} on this period's revenue.`,
      })
    } else {
      items.push({ tone: 'good', entity: 'Labour', message: `Labour at ${fmtPct(cur.staff_pct)} — within target.` })
    }
  }
  // Food
  if (cur.has_food && cur.food_pct != null) {
    const over = cur.food_pct - 32
    if (over > 2) {
      items.push({ tone: over > 6 ? 'bad' : 'warning', entity: 'Food cost', message: `CoGS at ${fmtPct(cur.food_pct)} — ${over.toFixed(1)}pp above the 32% target.` })
    } else if (prev && prev.food_pct != null && cur.food_pct < prev.food_pct - 1) {
      items.push({ tone: 'good', entity: 'Food cost', message: `CoGS improved from ${fmtPct(prev.food_pct)} to ${fmtPct(cur.food_pct)} — keep the procurement discipline.` })
    } else {
      items.push({ tone: 'good', entity: 'Food cost', message: `CoGS at ${fmtPct(cur.food_pct)} — within target.` })
    }
  } else if (!cur.has_food) {
    items.push({ tone: 'warning', entity: 'Food cost', message: 'No food cost in this period — upload the Fortnox Resultatrapport to surface CoGS.' })
  }
  // Overheads
  if (cur.has_overheads && cur.overheads_pct != null) {
    if (cur.overheads_pct > 25) {
      items.push({ tone: 'warning', entity: 'Overheads', message: `Overheads at ${fmtPct(cur.overheads_pct)} — high enough to review subscriptions, rent and utility deals.` })
    } else {
      items.push({ tone: 'good', entity: 'Overheads', message: `Overheads at ${fmtPct(cur.overheads_pct)} — within typical band.` })
    }
  } else if (period.granularity === 'week') {
    items.push({ tone: 'warning', entity: 'Weekly view', message: 'Food cost and overheads are tracked monthly in Fortnox — switch to Month to see those rows.' })
  }
  return items.slice(0, 4)
}
