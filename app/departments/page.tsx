'use client'
// @ts-nocheck
// app/departments/page.tsx — full rebuild on the new system
//
// Same treatment as the other rebuilds. Every surface on UXP +
// KpiCardUX / PairedBarChart / BreakdownTable; the legacy PageHero /
// SupportingStats / StatusPill / Sparkline / SegmentedToggle / TopBar
// are gone from this page.
//
// Data:
//   GET /api/departments?from&to&business_id  → { departments, summary, ... }
//   /departments/[id]                          — drill-down (separate page)

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { deptColor } from '@/lib/constants/colors'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

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
  return { from: localDate(mon), to: localDate(sun), weekNum: wk, label }
}
function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return { from: localDate(d), to: localDate(last), label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
}

type MetricKey = 'revenue' | 'cost' | 'margin'

export default function DepartmentsPage() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(0)
  const [viewMode,    setViewMode]    = useState<'week' | 'month'>('month')
  const [metric,      setMetric]      = useState<MetricKey>('revenue')
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)

  // URL hydration
  useEffect(() => {
    const v = searchParams?.get('view') as 'week' | 'month' | null
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

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    fetch(`/api/departments?from=${curr.from}&to=${curr.to}&business_id=${bizId}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [bizId, weekOffset, monthOffset, viewMode])

  const depts:   any[] = data?.departments ?? []
  const summary: any   = data?.summary ?? {}
  const curr           = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel    = viewMode === 'week'
    ? `Week ${(curr as any).weekNum} · ${curr.label}`
    : curr.label

  const active = useMemo(
    () => depts.filter(d => Number(d.revenue ?? 0) > 0 || Number(d.staff_cost ?? 0) > 0),
    [depts],
  )
  const withGP = useMemo(
    () => active.filter(d => d.gp_pct != null && Number(d.revenue ?? 0) > 0)
                .sort((a, b) => Number(b.gp_pct) - Number(a.gp_pct)),
    [active],
  )
  const best  = withGP[0] ?? null
  const worst = withGP.length > 1 ? withGP[withGP.length - 1] : null
  const atLoss = active.filter(d => (Number(d.revenue ?? 0) - Number(d.staff_cost ?? 0)) < 0)

  const groupLab = Number(summary.labour_pct ?? 0)
  const tier     = labourTier(groupLab > 0 ? groupLab : null)
  const tierLabel = tier === 'no-data' ? 'No data' : tier.replace('-', ' ')

  // Stepper
  const canStepNext = viewMode === 'week' ? weekOffset < 0 : monthOffset < 0
  function step(dir: -1 | 1) {
    if (viewMode === 'week') {
      const next = weekOffset + dir; setWeekOffset(next); writeUrl({ view: 'week', offset: next })
    } else {
      const next = monthOffset + dir; setMonthOffset(next); writeUrl({ view: 'month', offset: next })
    }
  }

  const chartRows = useMemo(() => {
    return [...active].sort((a, b) => pickMetric(b, metric) - pickMetric(a, metric))
  }, [active, metric])

  return (
    <AppShell
      dateLabel={periodLabel}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {/* Header row — Metric + W/M toggles */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
          <MetricToggle value={metric} onChange={setMetric} />
          <ViewModeToggle value={viewMode} onChange={v => {
            setViewMode(v)
            writeUrl({ view: v, offset: v === 'month' ? monthOffset : weekOffset })
          }} />
        </div>

        {/* KPI strip */}
        <KpiStrip summary={summary} active={active} best={best} worst={worst} atLoss={atLoss} tier={tier} tierLabel={tierLabel} groupLab={groupLab} period={periodLabel} />

        {/* Loading + empty states */}
        {loading && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>
            Loading departments…
          </div>
        )}
        {!loading && active.length === 0 && (
          <EmptyCard
            title={`No department activity in ${periodLabel}`}
            body="Revenue and labour show up here when the period has POS or staff data."
          />
        )}

        {!loading && active.length > 0 && (
          <>
            <ChartCard rows={chartRows} metric={metric} />

            <DeptBreakdown
              rows={active}
              summary={summary}
              best={best}
              worst={worst}
              onOpen={(name: string) => router.push(`/departments/${encodeURIComponent(name)}`)}
            />

            {(atLoss.length > 0 || withGP.some(d => Number(d.gp_pct) < 30)) && (
              <AttentionCard depts={active} atLoss={atLoss} withGP={withGP} />
            )}
          </>
        )}
      </PageContainer>

      <AskAI
        page="departments"
        context={summary && active.length > 0 ? [
          `Period: ${periodLabel}`,
          `${active.length} active departments · revenue ${fmtKr(summary.total_revenue ?? 0)} · group labour ${fmtPct(groupLab)} · group GP ${fmtPct(summary.gp_pct ?? 0)}`,
          best  ? `Best:   ${best.name} at ${fmtPct(best.gp_pct)} margin.`  : null,
          worst ? `Worst:  ${worst.name} at ${fmtPct(worst.gp_pct)} margin.` : null,
        ].filter(Boolean).join('\n') : 'No department data yet'}
      />
    </AppShell>
  )
}

function pickMetric(d: any, m: MetricKey): number {
  if (m === 'revenue') return Number(d.revenue    ?? 0)
  if (m === 'cost')    return Number(d.staff_cost ?? 0)
  return Number(d.gp_pct ?? 0)
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function KpiStrip({ summary, active, best, worst, atLoss, tier, tierLabel, groupLab, period }: any) {
  const totalRev   = Number(summary.total_revenue   ?? 0)
  const totalStaff = Number(summary.total_staff_cost ?? 0)
  const groupGp    = Number(summary.gp_pct          ?? 0)
  const profit     = Math.max(0, totalRev - totalStaff)

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Total revenue"
        value={fmtKr(totalRev)}
        microLabel={`${active.length} departments`}
      />
      <KpiCardUX
        title="Best margin"
        value={best ? fmtPct(best.gp_pct ?? 0) : '—'}
        variant="stacked"
        stackedBars={best && worst ? [
          { label: best.name,  value: Math.max(0, Number(best.gp_pct  ?? 0)), max: 100, color: UXP.green },
          { label: worst.name, value: Math.max(0, Number(worst.gp_pct ?? 0)), max: 100, color: UXP.rose  },
        ] : undefined}
        microLabel={best?.name ?? ''}
      />
      <KpiCardUX
        title="Group labour"
        value={fmtPct(groupLab)}
        deltaGood={false}
        variant="targetBand"
        targetBand={groupLab > 0 ? {
          actualPct:    Math.min(100, groupLab),
          targetMinPct: DEFAULT_TIER_CONFIG.targetMin,
          targetMaxPct: DEFAULT_TIER_CONFIG.targetMax,
        } : undefined}
        microLabel={tierLabel}
      />
      <KpiCardUX
        title={atLoss.length > 0 ? 'Departments at loss' : 'Profit (after labour)'}
        value={atLoss.length > 0 ? String(atLoss.length) : fmtKr(profit)}
        deltaGood={atLoss.length === 0}
        delta={atLoss.length > 0 ? `${atLoss.length} flagged` : null}
        microLabel={atLoss.length > 0
          ? atLoss.map((d: any) => d.name).slice(0, 2).join(', ')
          : (groupGp > 0 ? `${fmtPct(groupGp)} group margin` : '')}
      />
    </div>
  )
}

// ── Per-department bar chart ────────────────────────────────────────
function ChartCard({ rows, metric }: { rows: any[]; metric: MetricKey }) {
  const subtitle = metric === 'revenue' ? 'Revenue per department'
                 : metric === 'cost'    ? 'Staff cost per department'
                 :                        'Margin per department'
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{subtitle}</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {rows.length} {rows.length === 1 ? 'department' : 'departments'} · sorted descending
        </div>
      </div>
      <PairedBarChart
        groups={rows.map(r => r.name ?? '—')}
        series={[
          {
            label: subtitle,
            data: rows.map(r => pickMetric(r, metric)),
            color: metric === 'revenue' ? UXP.lav : metric === 'cost' ? UXP.lavMid : UXP.green,
          },
        ]}
        leftAxisUnit={metric === 'margin' ? '%' : 'kr'}
        leftMax={metric === 'margin' ? 100 : undefined}
        width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
        height={220}
      />
    </div>
  )
}

// ── Per-department BreakdownTable ───────────────────────────────────
function DeptBreakdown({ rows, summary, best, worst, onOpen }: any) {
  const sorted = [...rows].sort((a: any, b: any) => Number(b.revenue ?? 0) - Number(a.revenue ?? 0))
  const totalRev   = Number(summary.total_revenue   ?? 0)
  const totalStaff = Number(summary.total_staff_cost ?? 0)
  const groupLab   = Number(summary.labour_pct ?? 0)
  const groupGp    = Number(summary.gp_pct ?? 0)

  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Departments</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Click a row to drill into the department
        </div>
      </div>
      <BreakdownTable
        columns={[
          { key: 'name', header: 'Department', align: 'left', render: (r: any) => (
            <button type="button" onClick={() => onOpen(r.name)} style={{
              background: 'none', border: 'none', padding: 0, cursor: 'pointer',
              fontFamily: 'inherit', textAlign: 'left' as const, minWidth: 0,
            }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: r.colour ?? deptColor(r.name) ?? UXP.ink4, display: 'inline-block' }} />
                <span style={{ color: UXP.ink1, fontWeight: 500 }}>{r.name}</span>
                {best  && r.name === best.name  && <Status tone="good">Best</Status>}
                {worst && r.name === worst.name && best && r.name !== best.name && <Status tone="bad">Weakest</Status>}
                {(Number(r.revenue ?? 0) - Number(r.staff_cost ?? 0)) < 0 && <Status tone="bad">At loss</Status>}
              </span>
            </button>
          ) },
          { key: 'revenue', header: 'Revenue', align: 'right', render: (r: any) =>
            r.revenue > 0 ? fmtKr(r.revenue) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'staff_cost', header: 'Staff cost', align: 'right', render: (r: any) =>
            r.staff_cost > 0 ? fmtKr(r.staff_cost) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'labour', header: 'Labour %', align: 'right', render: (r: any) => {
            if (r.labour_pct == null) return <span style={{ color: UXP.ink4 }}>—</span>
            const t = labourTier(r.labour_pct)
            const palette =
              t === 'on-target' ? { bg: UXP.greenFill, fg: UXP.greenDeep }
              : t === 'low'     ? { bg: UXP.lavFill,   fg: UXP.lavText   }
              : t === 'watch'   ? { bg: UXP.lavFill,   fg: UXP.coral     }
              :                   { bg: UXP.roseFill,  fg: UXP.roseText  }
            return (
              <span style={{
                display:      'inline-block',
                fontSize:     9,
                fontWeight:   500,
                padding:      '2px 7px',
                borderRadius: 6,
                background:   palette.bg,
                color:        palette.fg,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>
                {fmtPct(r.labour_pct)}
              </span>
            )
          } },
          { key: 'margin', header: 'Margin', align: 'right', render: (r: any) => {
            if (r.gp_pct == null) return <span style={{ color: UXP.ink4 }}>—</span>
            const tone =
              r.gp_pct >= 55 ? 'good' :
              r.gp_pct >= 30 ? 'warning' :
                               'bad'
            const palette = tone === 'good'    ? { bg: UXP.greenFill, fg: UXP.greenDeep }
                          : tone === 'warning' ? { bg: UXP.lavFill,   fg: UXP.coral     }
                          :                      { bg: UXP.roseFill,  fg: UXP.roseText  }
            return (
              <span style={{
                display:      'inline-block',
                fontSize:     9,
                fontWeight:   500,
                padding:      '2px 7px',
                borderRadius: 6,
                background:   palette.bg,
                color:        palette.fg,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>
                {fmtPct(r.gp_pct)}
              </span>
            )
          } },
          { key: 'rph', header: 'Rev/hour', align: 'right', render: (r: any) =>
            r.rev_per_hour ? fmtKr(r.rev_per_hour) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'hours', header: 'Hours', align: 'right', render: (r: any) =>
            (r.hours ?? 0) > 0 ? `${Math.round(r.hours).toLocaleString('sv-SE')}h` : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'share', header: '% of revenue', align: 'right', render: (r: any) => {
            const rev = Number(r.revenue ?? 0)
            const pct = totalRev > 0 ? (rev / totalRev) * 100 : 0
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <span style={{
                  display: 'inline-block', width: 60, height: 3, background: UXP.lavFill,
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct)}%`, background: r.colour ?? deptColor(r.name) ?? UXP.lav }} />
                </span>
                <span style={{ fontSize: 10, color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const, minWidth: 30, textAlign: 'right' as const }}>
                  {pct.toFixed(1)}%
                </span>
              </span>
            )
          } },
        ]}
        sections={[{ rows: sorted }]}
        footer={{
          label: 'Total',
          cells: {
            revenue:    fmtKr(totalRev),
            staff_cost: fmtKr(totalStaff),
            labour:     fmtPct(groupLab),
            margin:     fmtPct(groupGp),
            rph:        summary.rev_per_hour ? fmtKr(summary.rev_per_hour) : '',
            hours:      summary.total_hours ? `${Math.round(summary.total_hours).toLocaleString('sv-SE')}h` : '',
            share:      '100%',
          },
        }}
        rowKey={(row: any) => row.name}
      />
    </div>
  )
}

function Status({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'lav' | 'neutral' }) {
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
    lav:     { bg: UXP.lavFill,   fg: UXP.lavText   },
    neutral: { bg: UXP.subtleBg,  fg: UXP.ink4      },
  }[tone]
  return (
    <span style={{
      display:        'inline-block',
      fontSize:       8,
      padding:        '1px 6px',
      borderRadius:   6,
      background:     palette.bg,
      color:          palette.fg,
      fontWeight:     500,
      letterSpacing:  '0.04em',
      textTransform:  'uppercase' as const,
    }}>{children}</span>
  )
}

// ── Attention card ─────────────────────────────────────────────────
function AttentionCard({ depts, atLoss, withGP }: any) {
  const items: Array<{ tone: 'bad' | 'warning'; title: string; detail: string }> = []
  for (const d of atLoss.slice(0, 3)) {
    const profit = Number(d.revenue ?? 0) - Number(d.staff_cost ?? 0)
    items.push({
      tone: 'bad',
      title: `${d.name}: ${fmtKr(Math.abs(profit))} loss`,
      detail: `Revenue ${fmtKr(d.revenue ?? 0)} vs staff cost ${fmtKr(d.staff_cost ?? 0)}.`,
    })
  }
  for (const d of withGP.filter((d: any) => Number(d.gp_pct) < 30).slice(0, 2)) {
    items.push({
      tone: 'warning',
      title: `${d.name}: ${fmtPct(d.gp_pct)} margin`,
      detail: 'Below the 30% threshold — review labour share or pricing.',
    })
  }
  for (const d of depts) {
    if (d.gp_pct != null && d.gp_pct > 95 && Number(d.staff_cost ?? 0) === 0 && Number(d.revenue ?? 0) > 1000 && items.length < 5) {
      items.push({
        tone: 'warning',
        title: `${d.name}: ${fmtPct(d.gp_pct)} margin (no labour logged)`,
        detail: 'Likely a data gap — staff_logs missing for this period.',
      })
    }
  }
  if (items.length === 0) return null
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
    }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>What needs attention</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          {items.length} item{items.length === 1 ? '' : 's'}
        </div>
      </div>
      {items.map((it, idx) => {
        const palette = it.tone === 'bad'
          ? { bar: UXP.rose,  fg: UXP.roseText }
          : { bar: UXP.coral, fg: UXP.coral    }
        return (
          <div key={idx} style={{
            display:             'grid',
            gridTemplateColumns: '4px 1fr',
            gap:                 12,
            padding:             '10px 0',
            borderBottom:        idx < items.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
            alignItems:          'center',
          }}>
            <span style={{ width: 4, height: '100%', minHeight: 28, background: palette.bar, borderRadius: 2 }} />
            <div>
              <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1, marginBottom: 2 }}>{it.title}</div>
              <div style={{ fontSize: 11, color: UXP.ink3, lineHeight: 1.4 }}>{it.detail}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Toggles ─────────────────────────────────────────────────────────
function MetricToggle({ value, onChange }: { value: MetricKey; onChange: (v: MetricKey) => void }) {
  const opts: Array<{ k: MetricKey; lab: string }> = [
    { k: 'revenue', lab: 'Revenue' },
    { k: 'cost',    lab: 'Cost'    },
    { k: 'margin',  lab: 'Margin'  },
  ]
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
