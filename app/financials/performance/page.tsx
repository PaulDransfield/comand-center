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
import AskAI from '@/components/AskAI'
import TopBar from '@/components/ui/TopBar'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import Sparkline from '@/components/ui/Sparkline'
import SegmentedToggle from '@/components/ui/SegmentedToggle'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

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
  food_cost:    number
  staff_cost:   number
  overheads:    number
  net_margin:   number
  margin_pct:   number | null
  food_pct:     number | null
  staff_pct:    number | null
  overheads_pct: number | null
  // Breakdown of overheads by subcategory for the donut + table
  overhead_split: { rent: number; utilities: number; other: number }
  // Data completeness flags — used to show `—` and explain honestly.
  has_food:      boolean
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
function aggregateMonths(
  trackerRows: any[],
  lineItems:   any[],
  includeMonths: (yr: number, mo: number) => boolean,
): PeriodData {
  let revenue = 0, food = 0, staff = 0, overheads = 0, depreciation = 0, financial = 0
  let anyFood = false, anyOverheads = false
  for (const r of trackerRows) {
    if (!includeMonths(r.period_year, r.period_month)) continue
    revenue      += Number(r.revenue      ?? 0)
    food         += Number(r.food_cost    ?? 0)
    staff        += Number(r.staff_cost   ?? 0)
    overheads    += Number(r.other_cost   ?? 0)
    depreciation += Number(r.depreciation ?? 0)
    financial    += Number(r.financial    ?? 0)
    if (Number(r.food_cost  ?? 0) > 0) anyFood      = true
    if (Number(r.other_cost ?? 0) > 0) anyOverheads = true
  }
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
  const netMargin = revenue - food - staff - overheads - depreciation - financial
  const marginPct = revenue > 0 ? (netMargin / revenue) * 100 : null
  return {
    revenue, food_cost: food, staff_cost: staff, overheads,
    net_margin: netMargin,
    margin_pct:   marginPct,
    food_pct:     revenue > 0 ? (food / revenue) * 100      : null,
    staff_pct:    revenue > 0 ? (staff / revenue) * 100     : null,
    overheads_pct: revenue > 0 ? (overheads / revenue) * 100 : null,
    overhead_split: split,
    has_food:      anyFood,
    has_overheads: anyOverheads,
  }
}

// Aggregation for week granularity using daily rows (revenue + staff_cost
// only — food/overheads are N/A weekly).
function aggregateDaily(dailyRows: any[]): PeriodData {
  let revenue = 0, staff = 0
  for (const r of dailyRows) {
    revenue += Number(r.revenue ?? 0)
    staff   += Number(r.staff_cost ?? 0)
  }
  const net = revenue - staff
  return {
    revenue, food_cost: 0, staff_cost: staff, overheads: 0,
    net_margin: net,
    margin_pct: revenue > 0 ? (net / revenue) * 100 : null,
    food_pct: null, staff_pct: revenue > 0 ? (staff / revenue) * 100 : null,
    overheads_pct: null,
    overhead_split: { rent: 0, utilities: 0, other: 0 },
    has_food: false, has_overheads: false,
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
        fetch(`/api/metrics/daily?business_id=${bizId}&from=${r.from}&to=${r.to}`, { cache: 'no-store' })
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
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '12px 16px 40px' }}>
        <TopBar
          crumbs={[{ label: 'Financials' }, { label: 'Performance', active: true }]}
          rightSlot={
            <ControlCluster
              granularity={granularity}
              onGranularityChange={g => {
                setGranularity(g)
                setPeriod(currentPeriod(g))
              }}
              period={period}
              onPeriodChange={setPeriod}
              compare={compare}
              onCompareChange={setCompare}
            />
          }
        />

        {/* Hero */}
        <PageHero
          eyebrow={`${periodLabelCaps(period)} · FULL PERFORMANCE${compareLabel ? ` · VS ${compareLabel.toUpperCase()}` : ''}`}
          headline={<HeroHeadline period={period} data={currentData} compare={compareData} compareLabel={compareLabel} />}
          context={heroContext(currentData, compareData, compareLabel)}
          right={
            currentData && (
              <SupportingStats
                items={[
                  {
                    label: 'Revenue',
                    value: currentData.revenue > 0 ? fmtKr(currentData.revenue) : '—',
                    sub:   compareData && compareLabel ? `vs ${fmtKr(compareData.revenue)}` : undefined,
                  },
                  {
                    label: 'Net margin',
                    value: fmtPct(currentData.margin_pct),
                    sub:   compareData && compareLabel ? `vs ${fmtPct(compareData.margin_pct)}` : undefined,
                    deltaTone: currentData.margin_pct != null && currentData.margin_pct >= 10 ? 'good'
                             : currentData.margin_pct != null && currentData.margin_pct >=  5 ? 'neutral' : 'bad',
                  },
                ]}
              />
            )
          }
        />

        {loading && !currentData && (
          <div style={{ padding: 20, fontSize: UX.fsBody, color: UX.ink3 }}>Loading…</div>
        )}

        {/* Primary: Profit waterfall */}
        {currentData && (
          <WaterfallCard
            period={period} data={currentData}
            compare={compareData} compareLabel={compareLabel}
          />
        )}

        {/* Second row: Donut + full breakdown */}
        {currentData && (
          <div style={{ display: 'grid', gridTemplateColumns: '1.35fr 1fr', gap: 12, marginTop: 12 }}>
            <DonutCard  data={currentData} />
            <BreakdownTable
              data={currentData} compare={compareData} compareLabel={compareLabel}
            />
          </div>
        )}

        {/* Third row: Trend sparklines */}
        {currentData && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginTop: 12 }}>
            <TrendCard
              label={`NET MARGIN · 12 ${granLabel(granularity)}`}
              value={fmtPct(currentData.margin_pct)}
              points={sparks.margin}
              tone={currentData.margin_pct != null && currentData.margin_pct >= 10 ? 'good' : currentData.margin_pct != null && currentData.margin_pct >= 5 ? 'warning' : 'bad'}
              target="Target 10%+"
            />
            <TrendCard
              label={`LABOUR % · 12 ${granLabel(granularity)}`}
              value={fmtPct(currentData.staff_pct)}
              points={sparks.labour}
              tone={currentData.staff_pct == null ? 'neutral' : currentData.staff_pct <= 42 ? 'good' : currentData.staff_pct <= 57 ? 'warning' : 'bad'}
              target="Target ≤ 42%"
              invert
            />
            <TrendCard
              label={`FOOD COST % · 12 ${granLabel(granularity)}`}
              value={fmtPct(currentData.food_pct)}
              points={sparks.food}
              tone={currentData.food_pct == null ? 'neutral' : currentData.food_pct <= 32 ? 'good' : currentData.food_pct <= 38 ? 'warning' : 'bad'}
              target="Target 28–32%"
              invert
            />
          </div>
        )}

        {/* Fourth row: What's tunable */}
        {currentData && (
          <div style={{ marginTop: 12 }}>
            <AttentionPanel
              title="What's tunable"
              items={buildTunableItems(period, currentData, compareData)}
              maxItems={4}
            />
          </div>
        )}
      </div>

      {/* Floating Ask AI — plain-text summary of the current view so Claude
          can answer questions like "why is margin lower than last month?"
          without needing to re-query the DB. Mirrors the pattern on every
          other AppShell page (dashboard, revenue, overheads, etc). */}
      <AskAI
        page="performance"
        context={buildAskContext(period, currentData, comparePeriod, compareData, selectedBiz?.name)}
      />
    </AppShell>
  )
}

// Plain-text context passed to /api/ask. Keep under a few hundred chars —
// the AI already has system-prompt rules + benchmarks baked in; this only
// needs to carry what's on screen RIGHT NOW.
function buildAskContext(
  period:       PeriodKey,
  data:         PeriodData | null,
  comparePeriod: PeriodKey | null,
  compare:      PeriodData | null,
  bizName?:     string | null,
): string {
  if (!data) return `Performance page for ${bizName ?? '—'}. No data for ${periodLabel(period)} yet.`
  const lines: string[] = []
  lines.push(`Performance page · ${bizName ?? 'business'} · ${periodLabel(period)}`)
  lines.push(`Revenue ${fmtKr(data.revenue)}, food cost ${data.has_food ? fmtKr(data.food_cost) : '—'}, labour ${fmtKr(data.staff_cost)}, overheads ${data.has_overheads ? fmtKr(data.overheads) : '—'}, net margin ${fmtKr(data.net_margin)}.`)
  lines.push(`Ratios: margin ${fmtPct(data.margin_pct)}, labour ${fmtPct(data.staff_pct)}${data.has_food ? `, food ${fmtPct(data.food_pct)}` : ''}${data.has_overheads ? `, overheads ${fmtPct(data.overheads_pct)}` : ''}.`)
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

// ─── Hero headline + context (template-driven) ────────────────────────────
function HeroHeadline({ period, data, compare, compareLabel }: {
  period: PeriodKey; data: PeriodData | null; compare: PeriodData | null; compareLabel: string | null
}) {
  if (!data) return <>No data for {periodLabel(period)} yet.</>
  const mp = data.margin_pct
  const marginWord = mp == null ? '—' : fmtPct(mp)
  const marginSpan = <span style={{ color: mp == null ? UX.ink3 : mp >= 10 ? UX.greenInk : mp >= 5 ? UX.amberInk : UX.redInk }}>{marginWord}</span>

  if (!compare) {
    const story = pickBiggestStory(data)
    return <>Margin {marginSpan} — {story}.</>
  }
  const delta = (mp ?? 0) - (compare.margin_pct ?? 0)
  const dirWord = delta >= 0 ? 'up' : 'down'
  const dirSpan = <span style={{ color: delta >= 0 ? UX.greenInk : UX.redInk }}>{dirWord} {Math.abs(delta).toFixed(1)}pp</span>
  return <>Margin {marginSpan} — {dirSpan} vs {compareLabel}, {pickChangeExplanation(data, compare)}.</>
}

function heroContext(data: PeriodData | null, compare: PeriodData | null, compareLabel: string | null): string {
  if (!data) return 'Data syncs nightly at 06:00. Try a previous period or wait for the next sync.'
  const net = data.net_margin
  const lines: string[] = []
  lines.push(`Revenue ${fmtKr(data.revenue)}, costs ${fmtKr(data.food_cost + data.staff_cost + data.overheads)}, net ${fmtKr(net)}.`)
  if (compare && compareLabel) {
    const revDelta = data.revenue - compare.revenue
    if (revDelta !== 0) lines.push(`Revenue ${revDelta >= 0 ? '+' : '−'}${fmtKr(Math.abs(revDelta))} vs ${compareLabel}.`)
  }
  if (!data.has_overheads) lines.push('Overheads not yet loaded from Fortnox — waterfall shows `—`.')
  return lines.join(' ')
}

function pickBiggestStory(d: PeriodData): string {
  if (d.revenue === 0) return 'no revenue recorded yet'
  const staffOver = (d.staff_pct ?? 0) - 42
  const foodOver  = (d.food_pct ?? 0)  - 32
  if (!d.has_food && !d.has_overheads) return 'revenue and labour in range, cost data still loading'
  if (staffOver > 5 && staffOver >= foodOver) return `labour ${staffOver.toFixed(1)}pp over target`
  if (foodOver  > 5) return `food cost ${foodOver.toFixed(1)}pp over target`
  if (staffOver <= 2 && foodOver <= 2) return 'all three costs in range'
  return 'costs broadly in range'
}

function pickChangeExplanation(cur: PeriodData, prev: PeriodData): string {
  const revDelta    = cur.revenue - prev.revenue
  const labourDelta = (cur.staff_pct ?? 0) - (prev.staff_pct ?? 0)
  if (Math.abs(labourDelta) >= 1.5) return labourDelta > 0 ? 'labour ate most of the gain' : 'labour came down'
  if (Math.abs(revDelta) / Math.max(prev.revenue, 1) > 0.1) return revDelta >= 0 ? 'revenue grew' : 'revenue fell'
  return 'costs held steady'
}

// ─── Control cluster (granularity + period + compare) ─────────────────────
function ControlCluster({
  granularity, onGranularityChange,
  period,      onPeriodChange,
  compare,     onCompareChange,
}: {
  granularity: Granularity; onGranularityChange: (g: Granularity) => void
  period: PeriodKey;         onPeriodChange: (p: PeriodKey) => void
  compare: CompareMode;      onCompareChange: (c: CompareMode) => void
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <SegmentedToggle
        ariaLabel="Granularity"
        options={[
          { value: 'week',    label: 'Week'    },
          { value: 'month',   label: 'Month'   },
          { value: 'quarter', label: 'Quarter' },
          { value: 'ytd',     label: 'YTD'     },
        ]}
        value={granularity}
        onChange={v => onGranularityChange(v as Granularity)}
      />
      <PeriodPicker period={period} onChange={onPeriodChange} />
      <CompareButton period={period} compare={compare} onChange={onCompareChange} />
    </div>
  )
}

function PeriodPicker({ period, onChange }: { period: PeriodKey; onChange: (p: PeriodKey) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [])
  const canNext = !isFuturePeriod(stepPeriod(period, 1))
  return (
    <div ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, background: UX.cardBg }}>
      <button onClick={() => onChange(stepPeriod(period, -1))}
              aria-label="Previous period"
              style={arrowBtn()}>◂</button>
      <button onClick={() => setOpen(o => !o)} style={labelBtn()}>{periodLabel(period)} ▾</button>
      <button onClick={() => canNext && onChange(stepPeriod(period, 1))}
              aria-label="Next period"
              disabled={!canNext}
              style={arrowBtn(!canNext)}>▸</button>
      {open && <PeriodMenu period={period} onPick={p => { onChange(p); setOpen(false) }} />}
    </div>
  )
}

function arrowBtn(disabled = false) {
  return {
    padding:   '5px 9px', fontSize: UX.fsBody, color: disabled ? UX.ink5 : UX.ink3,
    background: 'transparent', border: 'none', cursor: disabled ? 'default' : 'pointer',
  } as const
}
function labelBtn() {
  return {
    padding: '5px 10px', fontSize: UX.fsBody, color: UX.ink1, fontWeight: UX.fwMedium,
    background: 'transparent', border: 'none', borderLeft: `0.5px solid ${UX.border}`,
    borderRight: `0.5px solid ${UX.border}`, cursor: 'pointer',
  } as const
}

function PeriodMenu({ period, onPick }: { period: PeriodKey; onPick: (p: PeriodKey) => void }) {
  const [viewYear, setViewYear] = useState(period.year)
  const now = new Date()
  const cur = currentPeriod(period.granularity)

  return (
    <div style={{
      position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 20,
      background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md,
      padding: 14, minWidth: 260, boxShadow: UX.shadowPop,
    }}>
      {/* Year header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 10 }}>
        <button onClick={() => setViewYear(y => y - 1)} style={yearArrowBtn()}>◂</button>
        <div style={{ fontSize: UX.fsBody, fontWeight: UX.fwMedium, color: UX.ink1 }}>{viewYear}</div>
        <button onClick={() => setViewYear(y => y + 1)} disabled={viewYear >= now.getFullYear()} style={yearArrowBtn(viewYear >= now.getFullYear())}>▸</button>
      </div>

      {/* Grid based on granularity */}
      {period.granularity === 'month' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {MONTHS_SHORT.map((m, i) => {
            const pk: PeriodKey = { granularity: 'month', year: viewYear, month: i + 1 }
            const disabled = isFuturePeriod(pk)
            const isCurrent = cur.granularity === 'month' && viewYear === cur.year && (i + 1) === cur.month
            const selected  = period.year === viewYear && period.month === i + 1
            return (
              <button key={m} disabled={disabled}
                onClick={() => onPick(pk)}
                style={gridCellBtn({ disabled, selected, current: isCurrent })}>{m}</button>
            )
          })}
        </div>
      )}
      {period.granularity === 'quarter' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {QUARTERS.map((q, i) => {
            const pk: PeriodKey = { granularity: 'quarter', year: viewYear, quarter: i + 1 }
            const disabled = isFuturePeriod(pk)
            const isCurrent = cur.granularity === 'quarter' && viewYear === cur.year && (i + 1) === cur.quarter
            const selected  = period.year === viewYear && period.quarter === i + 1
            return (
              <button key={q} disabled={disabled}
                onClick={() => onPick(pk)}
                style={gridCellBtn({ disabled, selected, current: isCurrent })}>{q}</button>
            )
          })}
        </div>
      )}
      {period.granularity === 'week' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4, maxHeight: 240, overflowY: 'auto' as const }}>
          {Array.from({ length: 53 }, (_, i) => i + 1).map(w => {
            const pk: PeriodKey = { granularity: 'week', year: viewYear, week: w }
            const disabled = isFuturePeriod(pk)
            const isCurrent = cur.granularity === 'week' && viewYear === cur.year && w === cur.week
            const selected  = period.year === viewYear && period.week === w
            return (
              <button key={w} disabled={disabled}
                onClick={() => onPick(pk)}
                style={gridCellBtn({ disabled, selected, current: isCurrent, small: true })}>{w}</button>
            )
          })}
        </div>
      )}
      {period.granularity === 'ytd' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
          {Array.from({ length: 4 }, (_, i) => now.getFullYear() - 3 + i).map(y => {
            const pk: PeriodKey = { granularity: 'ytd', year: y }
            const disabled = y > now.getFullYear()
            const selected = period.year === y
            return (
              <button key={y} disabled={disabled}
                onClick={() => onPick(pk)}
                style={gridCellBtn({ disabled, selected, current: y === now.getFullYear() })}>{y}</button>
            )
          })}
        </div>
      )}

      {/* Quick buttons */}
      <div style={{ marginTop: 12, paddingTop: 10, borderTop: `0.5px solid ${UX.borderSoft}` }}>
        <div style={{ fontSize: UX.fsNano, color: UX.ink4, textTransform: 'uppercase' as const, letterSpacing: '.08em', marginBottom: 6 }}>Quick</div>
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
          <QuickPill onClick={() => onPick(currentPeriod(period.granularity))}>This {period.granularity === 'ytd' ? 'year' : period.granularity}</QuickPill>
          <QuickPill onClick={() => onPick(previousPeriod(currentPeriod(period.granularity)))}>Last {period.granularity === 'ytd' ? 'year' : period.granularity}</QuickPill>
          {period.granularity !== 'ytd' && <QuickPill onClick={() => onPick({ granularity: 'ytd', year: now.getFullYear() })}>YTD {now.getFullYear()}</QuickPill>}
          <QuickPill onClick={() => onPick({ granularity: 'ytd', year: now.getFullYear() - 1 })}>{now.getFullYear() - 1}</QuickPill>
        </div>
      </div>
    </div>
  )
}
function yearArrowBtn(disabled = false) {
  return { padding: '3px 8px', fontSize: UX.fsBody, color: disabled ? UX.ink5 : UX.ink3, background: 'transparent', border: 'none', cursor: disabled ? 'default' : 'pointer' } as const
}
function gridCellBtn({ disabled, selected, current, small }: { disabled?: boolean; selected?: boolean; current?: boolean; small?: boolean }) {
  return {
    padding: small ? '4px 0' : '6px 0',
    fontSize: small ? UX.fsLabel : UX.fsBody,
    background: selected ? UX.navy : 'transparent',
    color: disabled ? UX.ink5 : selected ? 'white' : UX.ink1,
    border: current && !selected ? `1px solid ${UX.indigo}` : `0.5px solid ${UX.border}`,
    borderRadius: UX.r_sm,
    cursor: disabled ? 'default' : 'pointer',
    fontWeight: UX.fwMedium,
    fontFamily: 'inherit',
  } as const
}
function QuickPill({ onClick, children }: any) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', fontSize: UX.fsLabel, border: `0.5px solid ${UX.border}`,
      borderRadius: UX.r_md, background: UX.cardBg, color: UX.ink2, cursor: 'pointer',
    }}>{children}</button>
  )
}

function CompareButton({ period, compare, onChange }: {
  period: PeriodKey; compare: CompareMode; onChange: (c: CompareMode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    function onDoc(e: MouseEvent) { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey) }
  }, [])

  const label = compare === 'none' ? '+ Compare'
              : compare === 'prev' ? `vs ${periodLabel(previousPeriod(period))}`
              : compare === 'yoy'  ? `vs ${periodLabel(samePeriodLastYear(period))}`
              : compare === 'ytd_yoy' ? `vs YTD ${period.year - 1}`
              : typeof compare === 'object' && compare?.custom ? `vs ${periodLabel(compare.custom)}` : '+ Compare'
  const active = compare !== 'none'
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button onClick={() => setOpen(o => !o)} style={{
        padding: '5px 10px', fontSize: UX.fsBody,
        background: active ? UX.indigoBg : UX.cardBg,
        color: active ? '#4338ca' : UX.ink2,
        border: `0.5px solid ${active ? UX.indigo : UX.border}`,
        borderRadius: UX.r_md, cursor: 'pointer', fontFamily: 'inherit',
      }}>{label}</button>
      {open && (
        <div style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 20, background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, padding: 6, minWidth: 200, boxShadow: UX.shadowPop }}>
          <MenuRow onClick={() => { onChange('none'); setOpen(false) }}>No comparison</MenuRow>
          <MenuRow onClick={() => { onChange('prev'); setOpen(false) }}>Previous {period.granularity === 'ytd' ? 'year' : period.granularity}</MenuRow>
          <MenuRow onClick={() => { onChange('yoy'); setOpen(false) }}>Same period last year</MenuRow>
          {period.granularity === 'ytd' && <MenuRow onClick={() => { onChange('ytd_yoy'); setOpen(false) }}>YTD last year</MenuRow>}
          {/* Pick custom — simple: steps back one more period at a time */}
          <MenuRow onClick={() => {
            const target = previousPeriod(previousPeriod(period))   // 2 periods back as starting point
            onChange({ custom: target })
            setOpen(false)
          }}>Pick custom (2 {period.granularity}s ago)</MenuRow>
        </div>
      )}
    </div>
  )
}
function MenuRow({ onClick, children }: any) {
  return (
    <button onClick={onClick} style={{
      display: 'block', width: '100%', padding: '6px 10px', textAlign: 'left' as const,
      background: 'transparent', border: 'none', fontSize: UX.fsBody, color: UX.ink2,
      borderRadius: UX.r_sm, cursor: 'pointer', fontFamily: 'inherit',
    }}>{children}</button>
  )
}

// ─── Waterfall ─────────────────────────────────────────────────────────────
function WaterfallCard({ period, data, compare, compareLabel }: {
  period: PeriodKey; data: PeriodData; compare: PeriodData | null; compareLabel: string | null
}) {
  const { revenue, food_cost, staff_cost, overheads, net_margin } = data
  const maxVal = Math.max(revenue, 1)
  const W = 700, H = 240
  const padX = 40, padY = 30
  const innerW = W - padX - 20, innerH = H - padY - 30
  const yBase  = padY + innerH            // baseline (value = 0)
  const xFor  = (i: number) => padX + (innerW / 5) * (i + 0.5)
  // Clamp y into the chart area so bars can't overflow the x-axis when a
  // cumulative value goes negative (e.g. overheads push afterOh < 0).
  const yFor  = (v: number) => Math.max(padY, Math.min(yBase, padY + innerH - (v / maxVal) * innerH))
  const barW  = (innerW / 5) * 0.6

  // Stepping heights.
  const afterRev   = revenue
  const afterFood  = afterRev - food_cost
  const afterStaff = afterFood - staff_cost
  const afterOh    = afterStaff - overheads

  const grid = [0, maxVal * 0.33, maxVal * 0.66, maxVal]
  const bars = [
    { label: 'Revenue',   value: revenue,      top: yFor(revenue),       bot: yFor(0),            fill: UX.navy,                           x: xFor(0) },
    { label: 'Food cost', value: food_cost,    top: yFor(afterRev),      bot: yFor(afterFood),    fill: UX.burnt,                          x: xFor(1),  show: data.has_food      },
    { label: 'Labour',    value: staff_cost,   top: yFor(afterFood),     bot: yFor(afterStaff),   fill: UX.burnt, opacity: 0.75,           x: xFor(2) },
    { label: 'Overheads', value: overheads,    top: yFor(afterStaff),    bot: yFor(afterOh),      fill: UX.burnt, opacity: 0.45,           x: xFor(3),  show: data.has_overheads },
    // Height mirrors the displayed value, not the running total after
    // overheads — otherwise a business with depreciation/financial costs
    // would see a Net bar taller than the net_margin text on it.
    { label: 'Net',       value: net_margin,   top: yFor(Math.max(net_margin, 0)), bot: yFor(0), fill: net_margin >= 0 ? UX.marginLine : UX.redInk, x: xFor(4) },
  ]

  return (
    <div style={cardStyle()}>
      <div style={titleRowStyle()}>
        <span>Profit waterfall — {periodLabel(period)}</span>
        {compareLabel && (
          <span style={{ fontSize: UX.fsLabel, color: '#4338ca', background: UX.indigoBg, padding: '2px 7px', borderRadius: UX.r_sm, border: `0.5px solid ${UX.indigo}` }}>◂ overlay: {compareLabel}</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Profit waterfall for ${periodLabel(period)}`} style={{ width: '100%', height: 260 }}>
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={padX} x2={W - 20} y1={yFor(g)} y2={yFor(g)} stroke={UX.borderSoft} strokeDasharray="3 3" strokeWidth="0.5" />
            <text x={padX - 6} y={yFor(g) + 3} textAnchor="end" fontSize="9" fill={UX.ink4}>{fmtShortKr(g)}</text>
          </g>
        ))}
        {/* Connectors */}
        {bars.slice(0, -1).map((b, i) => (
          <line key={`c${i}`} x1={b.x + barW / 2} x2={bars[i + 1].x - barW / 2} y1={b.top} y2={b.top} stroke={UX.ink5} strokeDasharray="3 2" strokeWidth="0.5" />
        ))}
        {bars.map((b, i) => {
          const show = (b.show ?? true) && (b.value !== 0 || i === 0 || i === 4)
          return (
            <g key={b.label}>
              {show ? (
                <rect x={b.x - barW / 2} y={Math.min(b.top, b.bot)} width={barW} height={Math.abs(b.bot - b.top) || 1} fill={b.fill} opacity={(b as any).opacity ?? 1} rx={2} />
              ) : (
                <rect x={b.x - barW / 2} y={yFor(maxVal * 0.05)} width={barW} height={2} fill={UX.ink5} />
              )}
              <text x={b.x} y={(show ? Math.min(b.top, b.bot) : yFor(maxVal * 0.05)) - 5} textAnchor="middle" fontSize="10" fontWeight="500" fill={UX.ink1}>
                {show ? (i === 0 || i === 4 ? fmtShortKr(b.value) + ' kr' : '−' + fmtShortKr(b.value)) : '—'}
              </text>
              <text x={b.x} y={H - 12} textAnchor="middle" fontSize="11" fill={UX.ink2}>{b.label}</text>
              <text x={b.x} y={H - 1}  textAnchor="middle" fontSize="9"  fill={UX.ink4}>
                {b.label === 'Revenue' ? '100%' :
                  b.label === 'Net'    ? fmtPct(data.margin_pct) :
                  show && revenue > 0  ? fmtPct((b.value / revenue) * 100) : '—'}
              </text>
              {/* Compare overlay: dashed indigo line at compare-value's height */}
              {compare && show && (() => {
                const compareBar = i === 0 ? compare.revenue : i === 1 ? compare.food_cost : i === 2 ? compare.staff_cost : i === 3 ? compare.overheads : compare.net_margin
                // Compute the y of the compare value at this bar position using the same step logic, applied to compare.
                const cRev = compare.revenue, cFood = compare.food_cost, cStaff = compare.staff_cost, cOh = compare.overheads, cNet = compare.net_margin
                const yTopCompare = i === 0 ? yFor(cRev)
                                  : i === 1 ? yFor(cRev - cFood)
                                  : i === 2 ? yFor(cRev - cFood - cStaff)
                                  : i === 3 ? yFor(cRev - cFood - cStaff - cOh)
                                  : yFor(cNet >= 0 ? cNet : 0)
                return <line x1={b.x - barW / 2 - 3} x2={b.x + barW / 2 + 3} y1={yTopCompare} y2={yTopCompare} stroke={UX.indigo} strokeDasharray="3 2" strokeWidth="1.2" />
              })()}
            </g>
          )
        })}
      </svg>
      <Legend compare={!!compare} />
    </div>
  )
}
function Legend({ compare }: { compare: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 14, paddingTop: 8, fontSize: UX.fsLabel, color: UX.ink3 }}>
      <LegendSwatch colour={UX.navy}   label="Revenue" />
      <LegendSwatch colour={UX.burnt}  label="Costs" />
      <LegendSwatch colour={UX.marginLine} label="Net margin" />
      {compare && <LegendSwatch colour={UX.indigo} label="Compare overlay" dashed />}
    </div>
  )
}
function LegendSwatch({ colour, label, dashed }: { colour: string; label: string; dashed?: boolean }) {
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 14, height: 2, background: dashed ? 'transparent' : colour, borderTop: dashed ? `2px dashed ${colour}` : 'none' }} />
      {label}
    </div>
  )
}

// ─── Donut ─────────────────────────────────────────────────────────────────
function DonutCard({ data }: { data: PeriodData }) {
  const total = data.food_cost + data.staff_cost + data.overheads
  const slices = [
    { label: 'Labour',    value: data.staff_cost, opacity: 0.75 },
    { label: 'Food cost', value: data.food_cost,  opacity: 1    },
    { label: 'Overheads', value: data.overheads,  opacity: 0.45 },
  ].filter(s => s.value > 0)
  // SVG stroke straddles the path radius, so the donut actually extends
  // from (R - strokeWidth/2) to (R + strokeWidth/2). With R=55 and
  // strokeWidth=20, outer edge is at radius 65 from centre. Centring at
  // (75,75) inside a 150×150 viewBox gives 10 px of safe padding on all
  // sides — no clipping, regardless of renderer anti-aliasing.
  const R = 55, r = 35
  const strokeW = R - r
  const circumference = 2 * Math.PI * R
  let offset = 0
  const arcs = slices.map(s => {
    const frac = total > 0 ? s.value / total : 0
    const len  = frac * circumference
    const arc  = { ...s, dashArray: `${len} ${circumference - len}`, dashOffset: -offset, fraction: frac }
    offset += len
    return arc
  })

  return (
    <div style={cardStyle()}>
      <div style={titleRowStyle()}>
        <span>Cost breakdown</span>
        <span style={{ fontSize: UX.fsLabel, color: UX.ink4 }}>
          {total > 0 ? `${fmtKr(total)} · ${data.revenue > 0 ? fmtPct((total / data.revenue) * 100) : '—'}` : '—'}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', padding: '6px 0' }}>
        <svg viewBox="0 0 150 150" width="150" height="150" role="img" aria-label="Cost breakdown donut" style={{ flexShrink: 0 }}>
          <circle cx="75" cy="75" r={R} fill="none" stroke={UX.borderSoft} strokeWidth={strokeW} />
          {arcs.map((a, i) => (
            <circle key={i} cx="75" cy="75" r={R} fill="none"
              stroke={UX.burnt} strokeOpacity={a.opacity}
              strokeWidth={strokeW}
              strokeDasharray={a.dashArray}
              strokeDashoffset={a.dashOffset}
              transform="rotate(-90 75 75)" />
          ))}
          <text x="75" y="71" textAnchor="middle" fontSize="16" fontWeight="500" fill={UX.ink1}>{fmtShortKr(total)}</text>
          <text x="75" y="86" textAnchor="middle" fontSize="10" fill={UX.ink4}>total cost</text>
        </svg>
        <div style={{ flex: 1, minWidth: 0 }}>
          {slices.map(s => (
            <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: UX.fsLabel }}>
              <span style={{ width: 10, height: 10, background: UX.burnt, opacity: s.opacity, borderRadius: 2 }} />
              <span style={{ flex: 1, color: UX.ink2 }}>{s.label}</span>
              <span style={{ color: UX.ink1, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' }}>{fmtKr(s.value)}</span>
              <span style={{ color: UX.ink4, width: 48, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' }}>
                {total > 0 ? fmtPct((s.value / total) * 100) : '—'}
              </span>
            </div>
          ))}
          {slices.length === 0 && <div style={{ fontSize: UX.fsLabel, color: UX.ink4 }}>No cost data for this period</div>}
        </div>
      </div>
    </div>
  )
}

// ─── Breakdown table ───────────────────────────────────────────────────────
function BreakdownTable({ data, compare, compareLabel }: {
  data: PeriodData; compare: PeriodData | null; compareLabel: string | null
}) {
  const rows = [
    { label: 'Revenue',         kr: data.revenue,                 swatch: UX.navy,                  ccKr: compare?.revenue,          compareable: true },
    { label: 'Food cost',       kr: data.food_cost,               swatch: UX.burnt,                 ccKr: compare?.food_cost,        compareable: data.has_food },
    { label: 'Labour',          kr: data.staff_cost,              swatch: UX.burnt,  opacity: 0.75, ccKr: compare?.staff_cost,       compareable: true },
    { label: 'Rent & utilities',kr: data.overhead_split.rent + data.overhead_split.utilities, swatch: UX.burnt, opacity: 0.45, ccKr: (compare?.overhead_split.rent ?? 0) + (compare?.overhead_split.utilities ?? 0), compareable: data.has_overheads },
    { label: 'Other overheads', kr: data.overhead_split.other,    swatch: UX.burnt,  opacity: 0.45, ccKr: compare?.overhead_split.other, compareable: data.has_overheads },
  ]
  return (
    <div style={cardStyle()}>
      <div style={titleRowStyle()}>
        <span>Full breakdown</span>
        <span style={{ fontSize: UX.fsLabel, color: UX.ink4 }}>{compareLabel ? `◂ vs ${compareLabel}` : '% of revenue'}</span>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsBody }}>
        <thead>
          <tr style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
            <th style={thStyle()}></th>
            <th style={thStyle()}>Category</th>
            <th style={{ ...thStyle(), textAlign: 'right' as const }}>{compareLabel ? 'Current' : 'Amount'}</th>
            <th style={{ ...thStyle(), textAlign: 'right' as const }}>{compareLabel ? 'Compare' : '% rev'}</th>
            <th style={{ ...thStyle(), textAlign: 'right' as const }}>{compareLabel ? 'Δ' : ''}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => {
            const pct = data.revenue > 0 ? (r.kr / data.revenue) * 100 : null
            const delta = r.ccKr != null ? r.kr - (r.ccKr ?? 0) : null
            const deltaGood = r.label === 'Revenue' ? (delta ?? 0) >= 0 : (delta ?? 0) <= 0
            const compareShow = r.compareable
            return (
              <tr key={r.label} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
                <td style={tdStyle({ width: 14 })}><span style={{ display: 'inline-block', width: 10, height: 10, background: r.swatch, opacity: (r as any).opacity ?? 1, borderRadius: 2 }} /></td>
                <td style={tdStyle()}>{r.label}</td>
                <td style={{ ...tdStyle(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' }}>{r.compareable || r.label === 'Revenue' || r.label === 'Labour' ? fmtKr(r.kr) : '—'}</td>
                <td style={{ ...tdStyle(), textAlign: 'right' as const, color: UX.ink3, fontVariantNumeric: 'tabular-nums' }}>
                  {compareLabel
                    ? (compareShow ? (r.ccKr != null ? fmtKr(r.ccKr) : '—') : '—')
                    : (pct != null ? fmtPct(pct) : '—')}
                </td>
                <td style={{ ...tdStyle(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums',
                             color: compareLabel ? (delta == null || !compareShow ? UX.ink4 : deltaGood ? UX.greenInk : UX.redInk) : UX.ink4 }}>
                  {compareLabel ? (compareShow && delta != null ? `${delta >= 0 ? '+' : '−'}${fmtShortKr(Math.abs(delta))}` : '—') : ''}
                </td>
              </tr>
            )
          })}
          <tr>
            <td style={tdStyle()}></td>
            <td style={{ ...tdStyle(), color: UX.greenInk, fontWeight: UX.fwMedium }}>Net margin</td>
            <td style={{ ...tdStyle(), textAlign: 'right' as const, color: UX.greenInk, fontWeight: UX.fwMedium, fontVariantNumeric: 'tabular-nums' }}>{fmtKr(data.net_margin)}</td>
            <td style={{ ...tdStyle(), textAlign: 'right' as const, color: UX.ink3, fontVariantNumeric: 'tabular-nums' }}>{fmtPct(data.margin_pct)}</td>
            <td style={tdStyle()}></td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ─── Trend cards ───────────────────────────────────────────────────────────
function TrendCard({ label, value, points, tone, target, invert }: {
  label: string; value: string; points: { value: number }[] | number[]; tone: 'good' | 'bad' | 'warning' | 'neutral'; target: string; invert?: boolean
}) {
  const arr = Array.isArray(points) ? (typeof points[0] === 'number' ? (points as number[]) : (points as any[]).map(p => p.value ?? 0)) : []
  const avg = arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0
  const latest = arr.length ? arr[arr.length - 1] : 0
  const delta  = arr.length > 1 ? latest - arr[arr.length - 2] : 0
  const up    = delta >= 0
  const deltaGood = invert ? !up : up
  return (
    <div style={cardStyle()}>
      <div style={{ fontSize: UX.fsNano, color: UX.ink4, letterSpacing: '.08em', textTransform: 'uppercase' as const, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <div style={{ fontSize: 22, fontWeight: UX.fwMedium, color: tone === 'good' ? UX.greenInk : tone === 'warning' ? UX.amberInk : tone === 'bad' ? UX.redInk : UX.ink1, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div style={{ fontSize: UX.fsLabel, color: deltaGood ? UX.greenInk : UX.redInk }}>{up ? '↑' : '↓'} {Math.abs(delta).toFixed(1)}pp</div>
      </div>
      <div style={{ marginTop: 4 }}>
        <Sparkline points={arr} tone={tone} width={240} height={36} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: UX.fsNano, color: UX.ink4 }}>
        <span>{target}</span>
        <span>12-period avg {avg.toFixed(1)}%</span>
      </div>
    </div>
  )
}
function granLabel(g: Granularity): string {
  return g === 'week' ? 'WEEKS' : g === 'month' ? 'MONTHS' : g === 'quarter' ? 'QUARTERS' : 'YEARS'
}

// ─── Template "What's tunable" items ──────────────────────────────────────
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
        message: `Running ${over.toFixed(1)}pp over target. Each 1pp move on labour is worth ${fmtShortKr(onePpKr)} kr for this period.`,
      })
    } else {
      items.push({ tone: 'good', entity: 'Labour', message: `Holding at ${fmtPct(cur.staff_pct)} — inside the 42% target band. No action needed.` })
    }
  }
  // Food
  if (cur.has_food && cur.food_pct != null) {
    const over = cur.food_pct - 32
    if (over > 2) {
      items.push({ tone: over > 6 ? 'bad' : 'warning', entity: 'Food cost', message: `At ${fmtPct(cur.food_pct)}, ${over.toFixed(1)}pp over the 32% target — worth auditing supplier prices or portion sizes.` })
    } else if (prev && prev.food_pct != null && cur.food_pct < prev.food_pct - 1) {
      items.push({ tone: 'good', entity: 'Food cost', message: `Improved from ${fmtPct(prev.food_pct)} to ${fmtPct(cur.food_pct)} — keep whatever changed.` })
    } else {
      items.push({ tone: 'good', entity: 'Food cost', message: `At ${fmtPct(cur.food_pct)} — inside the 28–32% band.` })
    }
  } else if (!cur.has_food) {
    items.push({ tone: 'warning', entity: 'Food cost', message: 'No Fortnox data for this period — upload the Resultatrapport to complete the picture.' })
  }
  // Overheads
  if (cur.has_overheads && cur.overheads_pct != null) {
    if (cur.overheads_pct > 25) {
      items.push({ tone: 'warning', entity: 'Overheads', message: `At ${fmtPct(cur.overheads_pct)} of revenue — above the 15–25% typical range. See /overheads for category split.` })
    } else {
      items.push({ tone: 'good', entity: 'Overheads', message: `At ${fmtPct(cur.overheads_pct)} — inside the typical 15–25% range.` })
    }
  } else if (period.granularity === 'week') {
    items.push({ tone: 'warning', entity: 'Week view', message: 'Food and overheads are tracked monthly in Fortnox — switch to Month for the full breakdown.' })
  }
  return items.slice(0, 4)
}

// ─── Shared card styles ───────────────────────────────────────────────────
function cardStyle() {
  return {
    background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_lg,
    padding: '14px 16px',
  } as const
}
function titleRowStyle() {
  return {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1, marginBottom: 8,
  } as const
}
function thStyle() {
  return { padding: '6px 8px', fontSize: UX.fsNano, fontWeight: 500, color: UX.ink4, textAlign: 'left' as const, textTransform: 'uppercase' as const, letterSpacing: '.06em' } as const
}
function tdStyle(extra: any = {}) {
  return { padding: '8px', color: UX.ink2, ...extra } as const
}
