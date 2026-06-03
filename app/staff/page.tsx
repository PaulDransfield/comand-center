'use client'
// @ts-nocheck
// app/staff/page.tsx — full rebuild on the new system
//
// Same treatment as the dashboard rebuild: every surface lives on UXP
// tokens + KpiCardUX / PairedBarChart / BreakdownTable. The legacy
// PageHero / SupportingStats / SegmentedToggle / inline interactive
// <table> are gone. Period nav lives in the AppShell toolbar's date
// stepper; W/M sits inline at the top right.
//
// Data sources (unchanged):
//   /api/staff?from&to&business_id              — per-staff breakdown
//   /api/metrics/daily (curr + prev) ?from&to   — revenue + labour rollups
//
// labourTier() is the single source for every labour-cost colour
// decision; no inline thresholds.

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'

import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import { labourTier, DEFAULT_TIER_CONFIG } from '@/lib/utils/labourTier'

// ── Period helpers ────────────────────────────────────────────────────
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day  = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  const y1   = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  return Math.ceil(((date.getTime() - y1.getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date()
  const dow   = today.getDay()
  const mon   = new Date(today)
  mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7)
  mon.setHours(0, 0, 0, 0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const wk    = getISOWeek(mon)
  const mMon  = MONTHS[mon.getMonth()]
  const sMon  = MONTHS[sun.getMonth()]
  const label = mMon === sMon
    ? `${mon.getDate()}–${sun.getDate()} ${mMon}`
    : `${mon.getDate()} ${mMon} – ${sun.getDate()} ${sMon}`
  return { from: localDate(mon), to: localDate(sun), weekNum: wk, label, mon }
}
function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from:        localDate(d),
    to:          localDate(last),
    label:       `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    firstDay:    d,
    daysInMonth: last.getDate(),
  }
}

// ── Suspense wrapper ──────────────────────────────────────────────────
export default function StaffPage() {
  return (
    <Suspense fallback={<div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>}>
      <StaffInner />
    </Suspense>
  )
}

function StaffInner() {
  const searchParams = useSearchParams()
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week' | 'month'>('month')
  const [staffData,   setStaffData]   = useState<any>(null)
  const [srData,      setSrData]      = useState<any>(null)
  const [prevSr,      setPrevSr]      = useState<any>(null)
  const [loading,     setLoading]     = useState(true)
  const [search,      setSearch]      = useState('')

  // URL hydration
  useEffect(() => {
    const v   = searchParams?.get('view')   as 'week' | 'month' | null
    const off = searchParams?.get('offset')
    if (v === 'week' || v === 'month') setViewMode(v)
    if (off != null && !Number.isNaN(Number(off))) {
      if (v === 'month') setMonthOffset(Number(off))
      else               setWeekOffset(Number(off))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function writeUrl(next: { view?: string; offset?: number }) {
    const p = new URLSearchParams()
    const v   = next.view   ?? viewMode
    const off = next.offset ?? (v === 'month' ? monthOffset : weekOffset)
    if (v !== 'month') p.set('view', v)
    if (off !== 0)    p.set('offset', String(off))
    const qs = p.toString()
    window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }

  // Business sync
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Data fetch
  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const biz  = `business_id=${bizId}`
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    const prev = viewMode === 'week' ? getWeekBounds(weekOffset - 1) : getMonthBounds(monthOffset - 1)

    Promise.all([
      fetch(`/api/staff?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/metrics/daily?from=${curr.from}&to=${curr.to}&${biz}`).then(r => r.json()).catch(() => ({})),
      fetch(`/api/metrics/daily?from=${prev.from}&to=${prev.to}&${biz}`).then(r => r.json()).catch(() => ({})),
    ]).then(([staffRes, srRes, prevRes]) => {
      setStaffData(staffRes)
      const mapped = { ...srRes, rows: (srRes.rows ?? []).map((r: any) => ({ ...r, staff_pct: r.labour_pct })) }
      setSrData(mapped)
      setPrevSr(prevRes)
      setLoading(false)
    })
  }, [bizId, weekOffset, monthOffset, viewMode])

  // Derived values
  const now      = new Date()
  const curr     = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const dayCount = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30

  const summary   = staffData?.summary ?? null
  const staff     = staffData?.staff ?? []
  const deptLate  = staffData?.dept_lateness ?? []
  const srRows    = srData?.rows ?? []
  const srSum     = srData?.summary ?? null

  const totalCost   = summary?.staff_cost_effective ?? 0
  const totalHours  = summary?.logged_hours ?? 0
  const lateShifts  = summary?.late_shifts ?? 0
  const totalOb     = summary?.total_ob_supplement ?? 0

  const prevTotalCost = prevSr?.summary?.total_staff_cost ?? 0
  const prevTotalRev  = prevSr?.summary?.total_revenue ?? 0
  const curRev        = srSum?.total_revenue ?? 0
  const labourPct     = curRev > 0 ? (totalCost / curRev) * 100 : 0
  const prevLabPct    = prevTotalRev > 0 && prevTotalCost > 0 ? (prevTotalCost / prevTotalRev) * 100 : null
  const tier          = labourTier(curRev > 0 ? labourPct : null)
  const tierLabel     = tier === 'no-data' ? 'No data' : tier.replace('-', ' ')

  // Chart days
  const chartDays = useMemo(() => {
    return Array.from({ length: dayCount }, (_, i) => {
      const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
      d.setDate(d.getDate() + i)
      const ds  = localDate(d)
      const row = srRows.find((r: any) => r.date === ds)
      const isToday  = ds === localDate(now)
      const isFuture = d > now
      const dayIdx   = (d.getDay() + 6) % 7
      return {
        date:    ds,
        dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1),
        revenue: row?.revenue    ?? 0,
        cost:    row?.staff_cost ?? 0,
        pct:     row?.staff_pct  ?? null,
        isToday, isFuture,
      }
    })
  }, [viewMode, weekOffset, monthOffset, srRows, dayCount])

  // Period-stepper wiring for the AppShell toolbar
  const periodLabel = viewMode === 'week'
    ? `Week ${(curr as any).weekNum} · ${curr.label}`
    : curr.label
  function step(dir: -1 | 1) {
    if (viewMode === 'week') {
      const next = weekOffset + dir; setWeekOffset(next); writeUrl({ view: 'week', offset: next })
    } else {
      const next = monthOffset + dir; setMonthOffset(next); writeUrl({ view: 'month', offset: next })
    }
  }
  const canStepNext = viewMode === 'week' ? weekOffset < 0 : monthOffset < 0

  // Filtered + sorted employee rows
  const filtered = staff.filter((s: any) =>
    !search
    || (s.name  ?? '').toLowerCase().includes(search.toLowerCase())
    || (s.group ?? '').toLowerCase().includes(search.toLowerCase())
  )
  const sorted = [...filtered].sort((a: any, b: any) => (b.effective_cost ?? b.cost_actual) - (a.effective_cost ?? a.cost_actual))

  // Attention items
  const attention = useMemo(() => buildAttention({
    lateShifts, totalOb, totalCost, labourPct, tier, deptLate, sorted, srSum,
  }), [lateShifts, totalOb, totalCost, labourPct, tier, deptLate, sorted, srSum])

  return (
    <AppShell
      dateLabel={periodLabel}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {/* W/M toggle row */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <ViewModeToggle value={viewMode} onChange={v => {
            setViewMode(v)
            writeUrl({ view: v, offset: v === 'month' ? monthOffset : weekOffset })
          }} />
        </div>

        {/* ── KPI strip ─────────────────────────────────────────── */}
        <KpiStrip
          staffCount={staff.length}
          activeCount={staff.filter((s: any) => (s.hours_logged ?? 0) > 0).length}
          totalHours={totalHours}
          dayCount={dayCount}
          totalCost={totalCost}
          prevTotalCost={prevTotalCost}
          labourPct={labourPct}
          prevLabPct={prevLabPct}
          tier={tier}
          tierLabel={tierLabel}
          lateShifts={lateShifts}
          totalOb={totalOb}
          periodLabel={periodLabel}
        />

        {/* ── Best / worst day strip ────────────────────────────── */}
        {(srSum?.best_day || srSum?.worst_day) && (
          <BestWorstStrip best={srSum?.best_day} worst={srSum?.worst_day} />
        )}

        {/* ── Revenue / labour chart ────────────────────────────── */}
        <ChartCard days={chartDays} loading={loading} />

        {/* ── Attention card ────────────────────────────────────── */}
        {attention.length > 0 && (
          <AttentionCard items={attention} />
        )}

        {/* ── Employee breakdown ────────────────────────────────── */}
        <EmployeeBreakdown
          rows={sorted}
          totalRev={curRev}
          totalCost={totalCost}
          totalHours={totalHours}
          search={search}
          onSearch={setSearch}
        />
      </PageContainer>

      <AskAI
        page="staff"
        context={summary ? [
          `Period: ${periodLabel}`,
          `Team: ${staff.length} (${staff.filter((s: any) => (s.hours_logged ?? 0) > 0).length} active)`,
          `Labour ${fmtKr(totalCost)} (${fmtPct(labourPct)} of ${fmtKr(curRev)} revenue), ${totalHours}h.`,
          lateShifts > 0 ? `${lateShifts} late shift${lateShifts === 1 ? '' : 's'}.` : 'No late shifts.',
        ].join('\n') : 'No staff data'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components — all UXP, 0.5px hairlines, tabular-nums
// ════════════════════════════════════════════════════════════════════

function KpiStrip({
  staffCount, activeCount, totalHours, dayCount, totalCost, prevTotalCost,
  labourPct, prevLabPct, tier, tierLabel, lateShifts, totalOb, periodLabel,
}: any) {
  const hoursPerDay = dayCount > 0 ? totalHours / dayCount : 0
  const costDelta = prevTotalCost > 0
    ? `${totalCost - prevTotalCost >= 0 ? '+' : ''}${(((totalCost - prevTotalCost) / prevTotalCost) * 100).toFixed(1)}%`
    : null
  const labDelta = prevLabPct != null
    ? `${labourPct - prevLabPct >= 0 ? '+' : ''}${(labourPct - prevLabPct).toFixed(1)}pp`
    : null

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Team"
        value={String(staffCount)}
        microLabel={`${activeCount} active this period`}
      />
      <KpiCardUX
        title="Hours"
        value={totalHours > 0 ? `${Math.round(totalHours).toLocaleString('sv-SE')}h` : '—'}
        microLabel={`${hoursPerDay.toFixed(1)}h / day`}
      />
      <KpiCardUX
        title="Labour cost"
        value={totalCost > 0 ? fmtKr(totalCost) : '—'}
        delta={costDelta}
        deltaGood={false}
        variant="targetBand"
        targetBand={labourPct > 0 ? {
          actualPct:    Math.min(100, labourPct),
          targetMinPct: DEFAULT_TIER_CONFIG.targetMin,
          targetMaxPct: DEFAULT_TIER_CONFIG.targetMax,
        } : undefined}
        microLabel={tierLabel}
      />
      <KpiCardUX
        title="Late arrivals"
        value={String(lateShifts)}
        deltaGood={false}
        delta={lateShifts > 0 ? '+ flagged' : null}
        microLabel={totalOb > 0 ? `OB ${fmtKr(totalOb)}` : 'No OB this period'}
      />
    </div>
  )
}

// ── Best / worst day ─────────────────────────────────────────────────
function BestWorstStrip({ best, worst }: { best: any; worst: any }) {
  const cards: Array<{ kind: 'best' | 'worst'; day: any }> = []
  if (best)  cards.push({ kind: 'best',  day: best  })
  if (worst) cards.push({ kind: 'worst', day: worst })
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: `repeat(${cards.length}, minmax(0, 1fr))`,
      gap:                 12,
    }}>
      {cards.map(({ kind, day }) => {
        const tone   = kind === 'best' ? labourTier(day.pct) : labourTier(day.pct)
        const isGood = kind === 'best' && (tone === 'on-target' || tone === 'low')
        const palette = isGood
          ? { bg: UXP.greenFill, fg: UXP.greenDeep, accent: UXP.green }
          : kind === 'worst'
            ? { bg: UXP.roseFill, fg: UXP.roseText, accent: UXP.rose }
            : { bg: UXP.lavFill, fg: UXP.lavText, accent: UXP.lav }
        const dateLabel = new Date(day.date).toLocaleDateString('en-GB', {
          weekday: 'short', day: 'numeric', month: 'short',
        })
        return (
          <div key={kind} style={{
            background:   UXP.cardBg,
            border:       `0.5px solid ${UXP.border}`,
            borderRadius: UXP.r_lg,
            padding:      '14px 16px',
            display:      'flex',
            gap:          12,
            alignItems:   'center',
            flexWrap:     'wrap' as const,   // pill / date / pct wrap onto new lines on narrow widths
          }}>
            <span style={{
              padding:      '4px 10px',
              background:   palette.bg,
              color:        palette.fg,
              borderRadius: 999,
              fontSize:     9,
              fontWeight:   600,
              letterSpacing: '0.04em',
              textTransform: 'uppercase' as const,
            }}>
              {kind === 'best' ? 'Lowest labour %' : 'Highest labour %'}
            </span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500 }}>{dateLabel}</div>
              <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                {kind === 'best' ? 'Strongest day' : 'Most expensive day'}
              </div>
            </div>
            <span style={{
              fontFamily:         'var(--font-display)',
              fontSize:           22,
              fontWeight:         500,
              color:              palette.accent,
              letterSpacing:      '-0.02em',
              fontVariantNumeric: 'tabular-nums' as const,
            }}>
              {fmtPct(day.pct)}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ── Chart card ───────────────────────────────────────────────────────
function ChartCard({ days, loading }: { days: any[]; loading: boolean }) {
  return (
    <Card title="Revenue & labour" subtitle="Daily bars · labour as % of revenue">
      {loading ? (
        <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>
      ) : (
        <PairedBarChart
          groups={days.map(d => d.dayName)}
          series={[
            { label: 'Revenue', data: days.map(d => Number(d.revenue ?? 0)), color: UXP.lav    },
            { label: 'Labour',  data: days.map(d => Number(d.cost    ?? 0)), color: UXP.lavMid },
          ]}
          lines={[{
            label:  'Labour %',
            data:   days.map(d => {
              const r = Number(d.revenue ?? 0)
              return r > 0 ? (Number(d.cost ?? 0) / r) * 100 : null
            }),
            color:  UXP.coral,
            dashed: false,
          }]}
          rightMax={100}
          width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
          height={260}
        />
      )}
    </Card>
  )
}

// ── Attention ────────────────────────────────────────────────────────
interface AttentionItem {
  id:    string
  tone:  'good' | 'warning' | 'bad'
  title: string
  detail: string
}

function buildAttention({
  lateShifts, totalOb, totalCost, labourPct, tier, deptLate, sorted, srSum,
}: any): AttentionItem[] {
  const items: AttentionItem[] = []

  if (tier === 'over') {
    items.push({
      id: 'tier-over',
      tone: 'bad',
      title: `Labour at ${fmtPct(labourPct)} — over target`,
      detail: `Target ${DEFAULT_TIER_CONFIG.targetMin}–${DEFAULT_TIER_CONFIG.targetMax}%. Trim shifts on the highest-cost days first.`,
    })
  } else if (tier === 'watch') {
    items.push({
      id: 'tier-watch',
      tone: 'warning',
      title: `Labour at ${fmtPct(labourPct)} — watch`,
      detail: `Inside the ${DEFAULT_TIER_CONFIG.targetMax}–${DEFAULT_TIER_CONFIG.watchCeiling}% band. One slow day pushes it over.`,
    })
  } else if (tier === 'on-target') {
    items.push({
      id: 'tier-good',
      tone: 'good',
      title: `Labour at ${fmtPct(labourPct)} — on target`,
      detail: `Within ${DEFAULT_TIER_CONFIG.targetMin}–${DEFAULT_TIER_CONFIG.targetMax}%. Hold the line.`,
    })
  } else if (tier === 'low') {
    items.push({
      id: 'tier-low',
      tone: 'warning',
      title: `Labour at ${fmtPct(labourPct)} — below target`,
      detail: `Verify service quality isn't suffering — under-staffing can cost more in covers lost.`,
    })
  }

  if (deptLate && deptLate.length > 0) {
    const worst = [...deptLate].sort((a: any, b: any) => b.late_rate_pct - a.late_rate_pct)[0]
    if (worst?.late_rate_pct > 15) {
      items.push({
        id: 'dept-late',
        tone: 'warning',
        title: `${worst.dept}: ${Math.round(worst.late_rate_pct)}% late rate`,
        detail: `${worst.late_count} late shift${worst.late_count === 1 ? '' : 's'} in this period.`,
      })
    }
  }

  if (totalOb > 0 && totalCost > 0) {
    const obPct = (totalOb / totalCost) * 100
    if (obPct > 5) {
      items.push({
        id: 'ob-share',
        tone: 'warning',
        title: `OB supplements ${fmtPct(obPct)} of total labour`,
        detail: `${fmtKr(totalOb)} in OB this period — review evening/weekend coverage.`,
      })
    }
  }

  const topLate = sorted.filter((s: any) => (s.late_shifts ?? 0) > 0).slice(0, 2)
  for (const s of topLate) {
    items.push({
      id: `late-${s.id}`,
      tone: 'warning',
      title: `${s.name}: ${s.late_shifts} late shift${s.late_shifts > 1 ? 's' : ''}`,
      detail: `Average ${s.avg_late_minutes} min late.`,
    })
  }

  return items.slice(0, 5)
}

function AttentionCard({ items }: { items: AttentionItem[] }) {
  return (
    <Card title="What needs attention" subtitle={`${items.length} item${items.length === 1 ? '' : 's'}`}>
      <div style={{ display: 'grid', gap: 0 }}>
        {items.map((it, idx) => {
          const tonePalette = {
            good:    { bar: UXP.green, bg: UXP.greenFill, fg: UXP.greenDeep },
            warning: { bar: UXP.coral, bg: UXP.lavFill,   fg: UXP.coral     },
            bad:     { bar: UXP.rose,  bg: UXP.roseFill,  fg: UXP.roseText  },
          }[it.tone]
          return (
            <div key={it.id} style={{
              display:        'grid',
              gridTemplateColumns: '4px 1fr',
              gap:            12,
              padding:        '12px 0',
              borderBottom:   idx < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
              alignItems:     'center',
            }}>
              <span style={{ width: 4, height: '100%', minHeight: 32, background: tonePalette.bar, borderRadius: 2 }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1, marginBottom: 2 }}>{it.title}</div>
                <div style={{ fontSize: 11, color: UXP.ink3, lineHeight: 1.4 }}>{it.detail}</div>
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Employee BreakdownTable ──────────────────────────────────────────
function EmployeeBreakdown({ rows, totalRev, totalCost, totalHours, search, onSearch }: {
  rows: any[]; totalRev: number; totalCost: number; totalHours: number;
  search: string; onSearch: (s: string) => void;
}) {
  if (rows.length === 0) {
    return (
      <Card title="Employees" subtitle="No staff data in this period">
        <Empty>Empty period — no shifts logged.</Empty>
      </Card>
    )
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Employees</div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            {rows.length} {rows.length === 1 ? 'person' : 'people'} · sorted by cost
          </div>
        </div>
        <input
          value={search}
          onChange={e => onSearch(e.target.value)}
          placeholder="Search name or dept…"
          style={{
            padding:        '6px 10px',
            background:     UXP.cardBg,
            color:          UXP.ink1,
            border:         `0.5px solid ${UXP.border}`,
            borderRadius:   7,
            fontSize:       11,
            fontFamily:     'inherit',
            width:          200,
          }}
        />
      </div>

      <BreakdownTable
        columns={[
          { key: 'name',  header: 'Name',    align: 'left', render: (r: any) => (
            <span>
              <span style={{ color: UXP.ink1, fontWeight: 500 }}>{r.name}</span>
              {r.group && <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1 }}>{r.group}</span>}
            </span>
          ) },
          { key: 'hours', header: 'Hours',   align: 'right', render: (r: any) => `${(r.hours_logged ?? 0).toFixed(1)}h` },
          { key: 'cost',  header: 'Cost',    align: 'right', render: (r: any) => fmtKr(r.effective_cost ?? r.cost_actual ?? 0) },
          { key: 'rate',  header: 'Cost/hr', align: 'right', render: (r: any) => {
            const eff = r.effective_cost ?? r.cost_actual ?? 0
            const hrs = r.hours_logged ?? 0
            return hrs > 0 ? fmtKr(Math.round(eff / hrs)) : '—'
          } },
          { key: 'late',  header: 'Late',    align: 'right', render: (r: any) => {
            const n = r.late_shifts ?? 0
            return n === 0
              ? <span style={{ color: UXP.ink4 }}>—</span>
              : <DeltaChip value={`${n}×${r.avg_late_minutes ? ` ${r.avg_late_minutes}m` : ''}`} positiveIsGood={false} />
          } },
          { key: 'ob',    header: 'OB',      align: 'right', render: (r: any) =>
            (r.ob_supplement_kr ?? 0) > 0 ? fmtKr(r.ob_supplement_kr) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'tier',  header: 'Share',   align: 'right', render: (r: any) => {
            const eff = r.effective_cost ?? r.cost_actual ?? 0
            const pct = totalCost > 0 ? (eff / totalCost) * 100 : 0
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <span style={{
                  display: 'inline-block', width: 60, height: 3, background: UXP.lavFill,
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct)}%`, background: UXP.lav }} />
                </span>
                <span style={{ fontSize: 10, color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const, minWidth: 30, textAlign: 'right' as const }}>
                  {pct.toFixed(1)}%
                </span>
              </span>
            )
          } },
        ]}
        sections={[{ rows }]}
        footer={{
          label: 'Total',
          cells: {
            hours: `${Math.round(totalHours).toLocaleString('sv-SE')}h`,
            cost:  fmtKr(totalCost),
            rate:  totalHours > 0 ? fmtKr(Math.round(totalCost / totalHours)) : '—',
            late:  '',
            ob:    '',
            tier:  '100%',
          },
        }}
        rowKey={(row: any) => row.id}
      />
    </div>
  )
}

// ── Shared primitives ────────────────────────────────────────────────
function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
        {subtitle && <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>{children}</div>
}

function ViewModeToggle({ value, onChange }: { value: 'week' | 'month'; onChange: (v: 'week' | 'month') => void }) {
  return (
    <div style={{
      display:      'inline-flex',
      gap:          2,
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: 7,
      padding:      2,
    }}>
      {(['week', 'month'] as const).map(v => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          style={{
            padding:       '4px 12px',
            background:    value === v ? UXP.lavFill : 'transparent',
            color:         value === v ? UXP.lavText : UXP.ink3,
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
          {v === 'week' ? 'W' : 'M'}
        </button>
      ))}
    </div>
  )
}
