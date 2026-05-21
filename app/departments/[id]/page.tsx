'use client'
// @ts-nocheck
// app/departments/[id]/page.tsx — full rebuild on the new system
//
// Single-department drill-down. Same treatment as the rest of the
// rebuilds — UXP tokens, KpiCardUX / PairedBarChart / BreakdownTable
// replace the legacy navy/white inline-styled grid. Period nav wires
// into the AppShell toolbar's date stepper.
//
// Data unchanged: /api/departments/{name}?from&to&business_id
// Deep-link preserved: ?year=YYYY&month=M&view=week|month routes from
// /forecast and other parents land directly on a specific period.

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'
import { labourTier, DEFAULT_TIER_CONFIG } from '@/lib/utils/labourTier'
import { deptColor } from '@/lib/constants/colors'

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const DAYS   = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtH = (n: number) => (Math.round((n ?? 0) * 10) / 10).toLocaleString('en-GB') + 'h'

function getISOWeek(d: Date): number {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day  = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - day)
  return Math.ceil(((date.getTime() - new Date(Date.UTC(date.getUTCFullYear(), 0, 1)).getTime()) / 86400000 + 1) / 7)
}
function getWeekBounds(offset = 0) {
  const today = new Date(), dow = today.getDay()
  const mon = new Date(today); mon.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1) + offset * 7); mon.setHours(0,0,0,0)
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6)
  const mM = MONTHS[mon.getMonth()], sM = MONTHS[sun.getMonth()]
  return {
    from: localDate(mon), to: localDate(sun),
    weekNum: getISOWeek(mon),
    label: mM === sM ? `${mon.getDate()}–${sun.getDate()} ${mM}` : `${mon.getDate()} ${mM} – ${sun.getDate()} ${sM}`,
    mon,
  }
}
function getMonthBounds(offset = 0) {
  const now = new Date(), d = new Date(now.getFullYear(), now.getMonth() + offset, 1), last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from: localDate(d), to: localDate(last),
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
    firstDay: d, daysInMonth: last.getDate(),
  }
}

// Suspense boundary required for useSearchParams in Next 14.
export default function DepartmentDetailWrapper() {
  return (
    <Suspense fallback={
      <AppShell>
        <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>…</div>
      </AppShell>
    }>
      <DepartmentDetail />
    </Suspense>
  )
}

function DepartmentDetail() {
  const params   = useParams()
  const router   = useRouter()
  const search   = useSearchParams()
  const deptName = decodeURIComponent(params.id as string)

  const qYear  = Number(search?.get('year')  ?? 0)
  const qMonth = Number(search?.get('month') ?? 0)
  const qView  = search?.get('view') as 'week' | 'month' | null
  const now0   = new Date()
  const initialMonthOffset = (qYear && qMonth)
    ? (qYear - now0.getFullYear()) * 12 + (qMonth - (now0.getMonth() + 1))
    : 0
  const initialView: 'week' | 'month' = qView === 'week' ? 'week' : 'month'

  const [bizId,       setBizId]       = useState<string | null>(null)
  const [weekOffset,  setWeekOffset]  = useState(0)
  const [monthOffset, setMonthOffset] = useState(initialMonthOffset)
  const [viewMode,    setViewMode]    = useState<'week' | 'month'>(initialView)
  const [data,        setData]        = useState<any>(null)
  const [loading,     setLoading]     = useState(true)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync(); window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
    fetch(`/api/departments/${encodeURIComponent(deptName)}?from=${curr.from}&to=${curr.to}&business_id=${bizId}`)
      .then(r => r.json()).then(setData).catch(() => {}).finally(() => setLoading(false))
  }, [bizId, deptName, weekOffset, monthOffset, viewMode])

  const now  = new Date()
  const curr = viewMode === 'week' ? getWeekBounds(weekOffset) : getMonthBounds(monthOffset)
  const periodLabel = viewMode === 'week'
    ? `Week ${(curr as any).weekNum} · ${curr.label}`
    : curr.label

  const summary = data?.summary ?? {}
  const trend   = data?.trend ?? []
  const staff   = data?.staff ?? []
  const color   = data?.color ?? deptColor(deptName)

  // Chart day grid
  const dayCount = viewMode === 'week' ? 7 : (curr as any).daysInMonth ?? 30
  const chartDays = useMemo(() => {
    return Array.from({ length: dayCount }, (_, i) => {
      const d = viewMode === 'week' ? new Date((curr as any).mon) : new Date((curr as any).firstDay)
      d.setDate(d.getDate() + i)
      const ds  = localDate(d)
      const row = trend.find((t: any) => t.date === ds)
      const dayIdx = (d.getDay() + 6) % 7
      return {
        date:    ds,
        dayName: viewMode === 'week' ? DAYS[dayIdx] : String(i + 1),
        revenue: row?.revenue    ?? 0,
        cost:    row?.staff_cost ?? 0,
        isToday: ds === localDate(now),
        isFuture: d > now,
      }
    })
  }, [viewMode, weekOffset, monthOffset, trend, dayCount])

  // Period stepper
  const canStepNext = viewMode === 'week' ? weekOffset < 0 : monthOffset < 0
  function step(dir: -1 | 1) {
    if (viewMode === 'week') setWeekOffset(o => o + dir)
    else                     setMonthOffset(o => o + dir)
  }

  const hasData = (summary.revenue ?? 0) > 0 || (summary.staff_cost ?? 0) > 0
  const tier    = labourTier(summary.labour_pct ?? null)
  const tierLabel = tier === 'no-data' ? 'No data' : tier.replace('-', ' ')

  return (
    <AppShell
      dateLabel={periodLabel}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {/* Header */}
        <div style={{
          display:         'flex',
          alignItems:      'center',
          justifyContent:  'space-between',
          gap:             12,
          flexWrap:        'wrap' as const,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const }}>
            <button
              type="button"
              onClick={() => router.push('/departments')}
              style={{
                background: 'none', border: 'none',
                fontSize: 11, color: UXP.ink3,
                cursor: 'pointer', padding: 0, fontFamily: 'inherit',
              }}
            >← All departments</button>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 12, height: 12, borderRadius: '50%', background: color }} />
              <h1 style={{ margin: 0, fontSize: 20, fontWeight: 500, color: UXP.ink1, fontFamily: 'var(--font-display, inherit)', letterSpacing: '-0.01em' }}>
                {deptName}
              </h1>
            </div>
          </div>
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
        </div>

        {/* Loading + empty states */}
        {loading && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
            Loading {deptName} for {periodLabel}…
          </div>
        )}

        {!loading && !hasData && (
          <EmptyCard
            title={`No ${deptName} activity in ${periodLabel}`}
            body={viewMode === 'week' && weekOffset === 0
              ? "Week's still warming up. Try the previous week or switch to month."
              : "No revenue or labour data for this period. Try a different range."}
            onPrev={() => step(-1)}
            onView={viewMode === 'week' ? () => setViewMode('month') : null}
          />
        )}

        {!loading && hasData && (
          <>
            {/* KPI strip */}
            <div style={{
              display:             'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap:                 12,
            }}>
              <KpiCardUX
                title="Revenue"
                value={summary.revenue > 0 ? fmtKr(summary.revenue) : '—'}
                microLabel={summary.covers > 0
                  ? `${summary.covers} covers · ${summary.avg_spend > 0 ? fmtKr(summary.avg_spend) : '—'} per cover`
                  : ''}
              />
              <KpiCardUX
                title="Labour cost"
                value={summary.staff_cost > 0 ? fmtKr(summary.staff_cost) : '—'}
                microLabel={`${fmtH(summary.hours ?? 0)} · ${summary.shifts ?? 0} shift${summary.shifts === 1 ? '' : 's'}`}
              />
              <KpiCardUX
                title="Labour %"
                value={fmtPct(summary.labour_pct)}
                deltaGood={false}
                variant="targetBand"
                targetBand={summary.labour_pct != null ? {
                  actualPct:    Math.min(100, Number(summary.labour_pct)),
                  targetMinPct: DEFAULT_TIER_CONFIG.targetMin,
                  targetMaxPct: DEFAULT_TIER_CONFIG.targetMax,
                } : undefined}
                microLabel={tierLabel}
              />
              <KpiCardUX
                title="GP %"
                value={fmtPct(summary.gp_pct)}
                deltaGood
                microLabel={summary.rev_per_hour > 0 ? `${fmtKr(summary.rev_per_hour)} per hour` : ''}
              />
            </div>

            {/* OB / late strip — when applicable */}
            {(summary.ob_supplement > 0 || summary.late_shifts > 0) && (
              <div style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap:                 12,
              }}>
                {summary.ob_supplement > 0 && (
                  <div style={cardStyle()}>
                    <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                      OB supplements
                    </div>
                    <div style={{
                      fontSize:           20,
                      fontWeight:         500,
                      color:              UXP.ink1,
                      fontFamily:         'var(--font-display, inherit)',
                      letterSpacing:      '-0.02em',
                      fontVariantNumeric: 'tabular-nums' as const,
                    }}>{fmtKr(summary.ob_supplement)}</div>
                    {summary.ob_type_breakdown?.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' as const, marginTop: 8 }}>
                        {summary.ob_type_breakdown.map((ob: any) => (
                          <span key={ob.type} style={{
                            fontSize:     10,
                            background:   UXP.lavFill,
                            color:        UXP.lavText,
                            borderRadius: 6,
                            padding:      '2px 7px',
                          }}>{ob.type}: {fmtKr(ob.kr)}</span>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                {summary.late_shifts > 0 && (
                  <div style={cardStyle()}>
                    <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>
                      Late shifts
                    </div>
                    <div style={{
                      fontSize:           20,
                      fontWeight:         500,
                      color:              UXP.coral,
                      fontFamily:         'var(--font-display, inherit)',
                      letterSpacing:      '-0.02em',
                      fontVariantNumeric: 'tabular-nums' as const,
                    }}>{summary.late_shifts}</div>
                    <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>
                      Avg {summary.avg_late_minutes} min late
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Daily chart */}
            <div style={cardStyle()}>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Daily revenue &amp; labour</div>
                <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                  {deptName} · {periodLabel}
                </div>
              </div>
              <PairedBarChart
                groups={chartDays.map(d => d.dayName)}
                series={[
                  { label: 'Revenue', data: chartDays.map(d => Number(d.revenue ?? 0)), color: color || UXP.lav   },
                  { label: 'Labour',  data: chartDays.map(d => Number(d.cost    ?? 0)), color: UXP.lavMid },
                ]}
                lines={[{
                  label:  'Labour %',
                  data:   chartDays.map(d => {
                    const r = Number(d.revenue ?? 0)
                    return r > 0 ? (Number(d.cost ?? 0) / r) * 100 : null
                  }),
                  color:  UXP.coral,
                  dashed: false,
                }]}
                rightMax={100}
                width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
                height={240}
              />
            </div>

            {/* Staff table */}
            {staff.length > 0 && (
              <div>
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Staff in {deptName}</div>
                  <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                    {staff.length} {staff.length === 1 ? 'person' : 'people'} · {fmtH(summary.hours ?? 0)} total
                  </div>
                </div>
                <BreakdownTable
                  columns={[
                    { key: 'name', header: 'Name', align: 'left', render: (s: any) => (
                      <span>
                        <span style={{ color: UXP.ink1, fontWeight: 500 }}>{s.name}</span>
                        {summary.staff_cost > 0 && (
                          <span style={{
                            display: 'block', height: 3, background: UXP.lavFill,
                            borderRadius: 2, width: 70, marginTop: 3, overflow: 'hidden',
                          }}>
                            <span style={{
                              display: 'block', height: '100%',
                              width: `${Math.min(100, (s.cost / summary.staff_cost) * 100)}%`,
                              background: color,
                            }} />
                          </span>
                        )}
                      </span>
                    ) },
                    { key: 'hours',     header: 'Hours',   align: 'right', render: (s: any) => fmtH(s.hours) },
                    { key: 'cost',      header: 'Cost',    align: 'right', render: (s: any) => fmtKr(s.cost) },
                    { key: 'costPerHr', header: 'Cost/hr', align: 'right', render: (s: any) => s.cost_per_hour > 0 ? fmtKr(s.cost_per_hour) : <span style={{ color: UXP.ink4 }}>—</span> },
                    { key: 'shifts',    header: 'Shifts',  align: 'right', render: (s: any) => s.shifts },
                    { key: 'late',      header: 'Late',    align: 'right', render: (s: any) => {
                      if (!s.late_shifts) return <span style={{ color: UXP.ink4 }}>—</span>
                      return <DeltaChip value={`${s.late_shifts}×`} positiveIsGood={false} />
                    } },
                  ]}
                  sections={[{ rows: staff }]}
                  footer={{
                    label: 'Total',
                    cells: {
                      hours:     fmtH(summary.hours ?? 0),
                      cost:      fmtKr(summary.staff_cost ?? 0),
                      costPerHr: summary.hours > 0 ? fmtKr(Math.round((summary.staff_cost ?? 0) / summary.hours)) : '',
                      shifts:    String(summary.shifts ?? ''),
                      late:      '',
                    },
                  }}
                  rowKey={(row: any) => row.name}
                />
              </div>
            )}
          </>
        )}
      </div>

      <AskAI
        page="departments"
        context={hasData ? [
          `Department: ${deptName} · ${periodLabel}`,
          `Revenue ${fmtKr(summary.revenue ?? 0)} · Labour ${fmtKr(summary.staff_cost ?? 0)} (${fmtPct(summary.labour_pct ?? 0)}) · GP ${fmtPct(summary.gp_pct ?? 0)}`,
          summary.late_shifts > 0 ? `${summary.late_shifts} late shifts (avg ${summary.avg_late_minutes} min).` : null,
        ].filter(Boolean).join('\n') : `No data for ${deptName} in ${periodLabel}.`}
      />
    </AppShell>
  )
}

// ── Atoms ──────────────────────────────────────────────────────────

function cardStyle(): React.CSSProperties {
  return {
    background:    UXP.cardBg,
    border:        `0.5px solid ${UXP.border}`,
    borderRadius:  UXP.r_lg,
    padding:       '14px 16px',
  }
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
        >{v === 'week' ? 'W' : 'M'}</button>
      ))}
    </div>
  )
}

function EmptyCard({ title, body, onPrev, onView }: any) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       40,
      textAlign:     'center' as const,
    }}>
      <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 11, color: UXP.ink3, maxWidth: 440, margin: '0 auto 14px', lineHeight: 1.5 }}>{body}</div>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8 }}>
        <button type="button" onClick={onPrev} style={{
          padding:      '6px 14px',
          background:   UXP.cardBg,
          color:        UXP.ink2,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: 999,
          fontSize:     11,
          fontWeight:   500,
          cursor:       'pointer',
          fontFamily:   'inherit',
        }}>Previous period</button>
        {onView && (
          <button type="button" onClick={onView} style={{
            padding:      '6px 14px',
            background:   UXP.lavDeep,
            color:        '#fff',
            border:       'none',
            borderRadius: 999,
            fontSize:     11,
            fontWeight:   500,
            cursor:       'pointer',
            fontFamily:   'inherit',
          }}>View month</button>
        )}
      </div>
    </div>
  )
}
