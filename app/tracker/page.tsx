'use client'
// @ts-nocheck
// app/tracker/page.tsx — full rebuild on the new system
//
// Same treatment as the other rebuilds. Every surface on UXP +
// KpiCardUX / BreakdownTable; the legacy PageHero / SupportingStats /
// StatusPill / Sparkline / TopBar / AttentionPanel are gone.
//
// Data unchanged:
//   GET  /api/metrics/monthly?business_id&year       → monthly P&L rows
//   GET  /api/overheads/line-items?...&month=0       → annual Fortnox rollup
//   GET  /api/tracker/narrative?business_id          → AI paragraph
//   GET  /api/metrics/daily?business_id&from&to      → daily expansion
//   POST /api/tracker                                — manual month upsert
//
// Click a month row → side drawer with the month's daily breakdown +
// the manual-edit form.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import KpiCardUX from '@/components/ux/KpiCard'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

const MONTHS       = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

interface TrackerRow {
  period_month: number
  period_year:  number
  revenue:      number
  food_cost:    number
  staff_cost:   number
  net_profit:   number
  margin_pct:   number
}

interface DailyRow {
  date:              string
  total:             number
  revenue:           number
  revenue_per_cover: number
  staff_cost:        number
  is_closed:         boolean
}

export default function TrackerPage() {
  const now          = new Date()
  const currentYear  = now.getFullYear()
  const currentMonth = now.getMonth() + 1

  const [bizId,        setBizId]        = useState<string | null>(null)
  const [year,         setYear]         = useState(currentYear)
  const [rows,         setRows]         = useState<TrackerRow[]>([])
  const [annualRollup, setAnnualRollup] = useState<any>(null)
  const [narrative,    setNarrative]    = useState<any>(null)
  const [loading,      setLoading]      = useState(true)
  // Drawer state — opens when a month row is clicked
  const [openRow,      setOpenRow]      = useState<TrackerRow | null>(null)
  const [dailyData,    setDailyData]    = useState<Record<number, DailyRow[]>>({})
  const [loadingDaily, setLoadingDaily] = useState<number | null>(null)
  const [editForm,     setEditForm]     = useState<any>({})
  const [saving,       setSaving]       = useState(false)

  // Subscribe to BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    const [metricsRes, annualRes] = await Promise.all([
      fetch(`/api/metrics/monthly?business_id=${bizId}&year=${year}`, { cache: 'no-store' }),
      fetch(`/api/overheads/line-items?business_id=${bizId}&year_from=${year}&year_to=${year}&month=0`, { cache: 'no-store' }),
    ])
    const data = await metricsRes.json()
    if (data.rows) {
      setRows(data.rows.map((r: any) => ({
        period_month: r.month,
        period_year:  r.year,
        revenue:      r.revenue,
        food_cost:    r.food_cost,
        staff_cost:   r.staff_cost,
        net_profit:   r.net_profit,
        margin_pct:   r.margin_pct,
      })))
    } else if (Array.isArray(data)) {
      setRows(data)
    } else {
      setRows([])
    }
    // Annual Fortnox rollup (period_month = 0 convention)
    try {
      const aj   = await annualRes.json()
      const lines = Array.isArray(aj.rows) ? aj.rows : []
      if (lines.length) {
        const totals: Record<string, number> = {}
        for (const l of lines) totals[l.category] = (totals[l.category] ?? 0) + Number(l.amount ?? 0)
        const revenue   = totals.revenue ?? 0
        const netProfit = revenue - (totals.food_cost ?? 0) - (totals.staff_cost ?? 0) - (totals.other_cost ?? 0) - (totals.depreciation ?? 0) + (totals.financial ?? 0)
        setAnnualRollup({
          revenue,
          food_cost:  totals.food_cost  ?? 0,
          staff_cost: totals.staff_cost ?? 0,
          other_cost: totals.other_cost ?? 0,
          net_profit: netProfit,
          margin_pct: revenue > 0 ? (netProfit / revenue) * 100 : 0,
          line_count: lines.length,
        })
      } else {
        setAnnualRollup(null)
      }
    } catch {
      setAnnualRollup(null)
    }
    setLoading(false)
  }, [bizId, year])
  useEffect(() => { if (bizId) load() }, [bizId, year, load])

  // AI narrative
  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    setNarrative(null)
    fetch(`/api/tracker/narrative?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled && j && !j.error) setNarrative(j) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [bizId, year])

  async function openMonth(row: TrackerRow) {
    setOpenRow(row)
    setEditForm({
      period_month: row.period_month,
      revenue:      row.revenue ?? '',
      food_cost:    row.food_cost ?? '',
      staff_cost:   row.staff_cost ?? '',
      net_profit:   row.net_profit ?? '',
    })
    // Fetch daily if not cached
    const m = row.period_month
    if (!dailyData[m]) {
      setLoadingDaily(m)
      const from = `${year}-${String(m).padStart(2,'0')}-01`
      const last = new Date(year, m, 0).getDate()
      const to   = `${year}-${String(m).padStart(2,'0')}-${last}`
      try {
        const res  = await fetch(`/api/metrics/daily?business_id=${bizId}&from=${from}&to=${to}`)
        const data = await res.json()
        if (data.rows) {
          const mapped = data.rows
            .filter((r: any) => Number(r.revenue ?? 0) > 0 || Number(r.staff_cost ?? 0) > 0)
            .map((r: any) => ({
              date:              r.date,
              total:             r.covers ?? 0,
              revenue:           Number(r.revenue ?? 0),
              revenue_per_cover: r.rev_per_cover ?? 0,
              staff_cost:        Number(r.staff_cost ?? 0),
              is_closed:         Number(r.revenue ?? 0) === 0 && Number(r.staff_cost ?? 0) === 0,
            }))
          setDailyData(prev => ({ ...prev, [m]: mapped }))
        }
      } catch {}
      setLoadingDaily(null)
    }
  }

  async function saveMonth() {
    if (!openRow || !bizId) return
    setSaving(true)
    await fetch('/api/tracker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...editForm,
        period_year: year,
        business_id: bizId,
      }),
    })
    setSaving(false)
    setOpenRow(null)
    load()
  }

  // Derived
  const withData    = rows.filter(r => Number(r.revenue ?? 0) > 0)
  const totRev      = withData.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
  const totProfit   = withData.reduce((s, r) => s + Number(r.net_profit ?? 0), 0)
  const totLabour   = withData.reduce((s, r) => s + Number(r.staff_cost ?? 0), 0)
  const totFood     = withData.reduce((s, r) => s + Number(r.food_cost ?? 0), 0)
  const avgMargin   = withData.length ? withData.reduce((s, r) => s + Number(r.margin_pct ?? 0), 0) / withData.length : 0
  const labourPctYtd = totRev > 0 ? (totLabour / totRev) * 100 : null
  const foodPctYtd   = totRev > 0 ? (totFood   / totRev) * 100 : null
  const bestMargin  = withData.length ? withData.reduce((a, b) => Number(a.margin_pct) > Number(b.margin_pct) ? a : b) : null
  const worstMargin = withData.length ? withData.reduce((a, b) => Number(a.margin_pct) < Number(b.margin_pct) ? a : b) : null
  const foodGapMonth = withData.find(r => Number(r.food_cost ?? 0) === 0) ?? null

  // 12-month rows (with placeholders for missing months)
  const allMonths: TrackerRow[] = Array.from({ length: 12 }, (_, i) => {
    const existing = rows.find(r => r.period_month === i + 1)
    return existing ?? { period_month: i + 1, period_year: year, revenue: 0, food_cost: 0, staff_cost: 0, net_profit: 0, margin_pct: 0 }
  })
  const maxRevenue = Math.max(1, ...allMonths.map(r => Number(r.revenue ?? 0)))

  // Year stepper
  const canStepNext = year < currentYear + 1
  function step(dir: -1 | 1) { setYear(y => y + dir) }

  return (
    <AppShell
      dateLabel={String(year)}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {/* KPI strip */}
        <KpiStrip
          year={year}
          totRev={totRev}
          totProfit={totProfit}
          totLabour={totLabour}
          totFood={totFood}
          avgMargin={avgMargin}
          labourPctYtd={labourPctYtd}
          foodPctYtd={foodPctYtd}
          bestMargin={bestMargin}
          worstMargin={worstMargin}
          monthsClosed={withData.length}
        />

        {/* Honesty banner — food cost gap */}
        {foodGapMonth && (
          <Banner tone="warning" text={`${MONTHS[foodGapMonth.period_month - 1]} has revenue but no food cost — margin is overstated until the Fortnox PDF for that month is applied.`} />
        )}

        {/* AI narrative */}
        {narrative?.text && (
          <NarrativeCard narrative={narrative} />
        )}

        {/* Annual Fortnox rollup */}
        {annualRollup && (
          <AnnualRollupCard year={year} rollup={annualRollup} />
        )}

        {/* Loading + empty */}
        {loading && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
            Loading…
          </div>
        )}

        {!loading && (
          <MonthlyTable
            rows={allMonths}
            maxRevenue={maxRevenue}
            currentMonth={currentMonth}
            currentYear={currentYear}
            year={year}
            totals={{ revenue: totRev, food: totFood, staff: totLabour, profit: totProfit, marginAvg: avgMargin }}
            onOpen={openMonth}
          />
        )}

        {openRow && (
          <MonthDrawer
            row={openRow}
            year={year}
            editForm={editForm}
            saving={saving}
            daily={dailyData[openRow.period_month] ?? null}
            loadingDaily={loadingDaily === openRow.period_month}
            onChange={setEditForm}
            onSave={saveMonth}
            onClose={() => setOpenRow(null)}
          />
        )}
      </PageContainer>

      <AskAI
        page="tracker"
        context={withData.length > 0 ? [
          `Year ${year} P&L overview`,
          `${withData.length} of 12 months logged. Revenue ${fmtKr(totRev)}, labour ${fmtKr(totLabour)} (${fmtPct(labourPctYtd ?? 0)}), food ${fmtKr(totFood)} (${fmtPct(foodPctYtd ?? 0)}), net ${fmtKr(totProfit)}.`,
          bestMargin  ? `Best month: ${MONTHS_SHORT[bestMargin.period_month - 1]} at ${fmtPct(bestMargin.margin_pct)}.`  : null,
          worstMargin ? `Worst month: ${MONTHS_SHORT[worstMargin.period_month - 1]} at ${fmtPct(worstMargin.margin_pct)}.` : null,
        ].filter(Boolean).join('\n') : `No P&L logged for ${year} yet.`}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function KpiStrip({ year, totRev, totProfit, totLabour, totFood, avgMargin, labourPctYtd, foodPctYtd, bestMargin, worstMargin, monthsClosed }: any) {
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Revenue YTD"
        value={fmtKr(totRev)}
        microLabel={`${monthsClosed} of 12 months closed`}
      />
      <KpiCardUX
        title="Net profit YTD"
        value={fmtKr(totProfit)}
        deltaGood
        delta={totProfit >= 0 ? '+' : '−'}
        microLabel={`Avg margin ${fmtPct(avgMargin)}`}
      />
      <KpiCardUX
        title="Cost mix YTD"
        value={totRev > 0 ? `${fmtPct((totLabour + totFood) / totRev * 100)}` : '—'}
        variant="stacked"
        stackedBars={totRev > 0 ? [
          { label: 'Labour', value: labourPctYtd ?? 0, max: 100, color: UXP.lavMid },
          { label: 'Food',   value: foodPctYtd   ?? 0, max: 100, color: UXP.lav    },
        ] : undefined}
        microLabel={totRev > 0 ? `Labour ${fmtPct(labourPctYtd ?? 0)} · Food ${fmtPct(foodPctYtd ?? 0)}` : 'No data'}
      />
      <KpiCardUX
        title="Best vs worst"
        value={bestMargin && worstMargin
          ? `${fmtPct(bestMargin.margin_pct)} / ${fmtPct(worstMargin.margin_pct)}`
          : '—'}
        microLabel={bestMargin && worstMargin
          ? `${MONTHS_SHORT[bestMargin.period_month - 1]} vs ${MONTHS_SHORT[worstMargin.period_month - 1]}`
          : '—'}
      />
    </div>
  )
}

// ── AI narrative ────────────────────────────────────────────────────
function NarrativeCard({ narrative }: { narrative: any }) {
  return (
    <div style={cardStyle()}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{
          padding:       '3px 8px',
          background:    UXP.lavFill,
          color:         UXP.lavText,
          borderRadius:  999,
          fontSize:      9,
          fontWeight:    600,
          letterSpacing: '0.04em',
          textTransform: 'uppercase' as const,
        }}>
          AI narrative
        </span>
        {narrative.period && (
          <span style={{ fontSize: 10, color: UXP.ink4 }}>{narrative.period}</span>
        )}
      </div>
      <div style={{ fontSize: 12, color: UXP.ink1, lineHeight: 1.55, whiteSpace: 'pre-wrap' as const }}>
        {narrative.text}
      </div>
    </div>
  )
}

// ── Annual rollup ───────────────────────────────────────────────────
function AnnualRollupCard({ year, rollup }: any) {
  return (
    <div style={cardStyle()}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Fortnox annual rollup · {year}</div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            From the annual Resultatrapport · {rollup.line_count} lines
          </div>
        </div>
        <span style={{
          fontFamily:         'var(--font-display)',
          fontSize:           20,
          fontWeight:         500,
          color:              rollup.net_profit >= 0 ? UXP.greenDeep : UXP.roseText,
          letterSpacing:      '-0.02em',
          fontVariantNumeric: 'tabular-nums' as const,
        }}>
          {fmtKr(rollup.net_profit)}
        </span>
      </div>
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap:                 12,
      }}>
        <MiniStat label="Revenue"    value={fmtKr(rollup.revenue)} />
        <MiniStat label="Food cost"  value={fmtKr(rollup.food_cost)} />
        <MiniStat label="Labour"     value={fmtKr(rollup.staff_cost)} />
        <MiniStat label="Other"      value={fmtKr(rollup.other_cost)} />
        <MiniStat label="Margin"     value={fmtPct(rollup.margin_pct)} />
      </div>
    </div>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: UXP.subtleBg, padding: '8px 10px', borderRadius: 8 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{
        fontSize:           14,
        fontWeight:         500,
        color:              UXP.ink1,
        marginTop:          2,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>{value}</div>
    </div>
  )
}

// ── Monthly BreakdownTable ──────────────────────────────────────────
function MonthlyTable({ rows, maxRevenue, currentMonth, currentYear, year, totals, onOpen }: any) {
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Monthly P&amp;L</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Click a row to edit or view the daily breakdown
        </div>
      </div>
      <BreakdownTable<TrackerRow>
        columns={[
          { key: 'month', header: 'Month', align: 'left', render: (r) => {
            const isFuture  = year > currentYear || (year === currentYear && r.period_month > currentMonth)
            const isCurrent = year === currentYear && r.period_month === currentMonth
            return (
              <button type="button" onClick={() => onOpen(r)} style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontFamily: 'inherit', textAlign: 'left' as const, display: 'inline-flex',
                alignItems: 'center', gap: 8,
              }}>
                <span style={{
                  color: isFuture ? UXP.ink4 : UXP.ink1,
                  fontWeight: 500,
                  fontStyle: isFuture ? 'italic' as const : 'normal' as const,
                }}>
                  {MONTHS[r.period_month - 1]}
                </span>
                {isCurrent && <Status tone="lav">Now</Status>}
                {isFuture  && <Status tone="neutral">Future</Status>}
              </button>
            )
          } },
          { key: 'revBar', header: 'Revenue', align: 'right', render: (r) => {
            const isFuture = year > currentYear || (year === currentYear && r.period_month > currentMonth)
            if (isFuture || Number(r.revenue ?? 0) === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            const pct = (Number(r.revenue ?? 0) / maxRevenue) * 100
            return (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                <span style={{
                  display: 'inline-block', width: 70, height: 4, background: UXP.lavFill,
                  borderRadius: 2, overflow: 'hidden',
                }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct)}%`, background: UXP.lav }} />
                </span>
                <span style={{
                  fontVariantNumeric: 'tabular-nums' as const,
                  color:              UXP.ink1,
                  fontWeight:         500,
                  minWidth:           70,
                  textAlign:          'right' as const,
                }}>
                  {fmtKr(r.revenue)}
                </span>
              </span>
            )
          } },
          { key: 'food', header: 'Food', align: 'right', render: (r) => {
            if (Number(r.revenue ?? 0) === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            if (Number(r.food_cost ?? 0) === 0) {
              return <span style={{ color: UXP.coral, fontSize: 10, fontStyle: 'italic' as const }}>missing</span>
            }
            const pct = Number(r.revenue) > 0 ? (Number(r.food_cost) / Number(r.revenue)) * 100 : 0
            return (
              <span>
                <span style={{ color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(r.food_cost)}</span>
                <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>{pct.toFixed(1)}%</span>
              </span>
            )
          } },
          { key: 'staff', header: 'Labour', align: 'right', render: (r) => {
            if (Number(r.revenue ?? 0) === 0 && Number(r.staff_cost ?? 0) === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            const pct = Number(r.revenue) > 0 ? (Number(r.staff_cost) / Number(r.revenue)) * 100 : 0
            return (
              <span>
                <span style={{ color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(r.staff_cost ?? 0)}</span>
                {Number(r.revenue) > 0 && (
                  <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>{pct.toFixed(1)}%</span>
                )}
              </span>
            )
          } },
          { key: 'net', header: 'Net profit', align: 'right', render: (r) => {
            if (Number(r.revenue ?? 0) === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            const np = Number(r.net_profit ?? 0)
            return (
              <span style={{
                color: np >= 0 ? UXP.greenDeep : UXP.roseText,
                fontWeight: 500,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>
                {np >= 0 ? '' : '−'}{fmtKr(Math.abs(np))}
              </span>
            )
          } },
          { key: 'margin', header: 'Margin', align: 'right', render: (r) => {
            if (Number(r.revenue ?? 0) === 0) return <span style={{ color: UXP.ink4 }}>—</span>
            const m = Number(r.margin_pct ?? 0)
            const tone =
              m >= 10 ? 'good'  :
              m >=  5 ? 'warning' :
                        'bad'
            const palette = tone === 'good'    ? { bg: UXP.greenFill, fg: UXP.greenDeep }
                          : tone === 'warning' ? { bg: UXP.lavFill,   fg: UXP.coral     }
                          :                      { bg: UXP.roseFill,  fg: UXP.roseText  }
            return (
              <span style={{
                display:        'inline-block',
                fontSize:       9,
                fontWeight:     500,
                padding:        '2px 7px',
                borderRadius:   6,
                background:     palette.bg,
                color:          palette.fg,
                fontVariantNumeric: 'tabular-nums' as const,
              }}>{fmtPct(m)}</span>
            )
          } },
        ]}
        sections={[{ rows }]}
        footer={{
          label: 'YTD',
          cells: {
            revBar: fmtKr(totals.revenue),
            food:   fmtKr(totals.food),
            staff:  fmtKr(totals.staff),
            net:    fmtKr(totals.profit),
            margin: fmtPct(totals.marginAvg),
          },
        }}
        rowKey={(row) => String(row.period_month)}
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

// ── Month drawer (edit + daily) ─────────────────────────────────────
function MonthDrawer({ row, year, editForm, saving, daily, loadingDaily, onChange, onSave, onClose }: any) {
  return (
    <div role="dialog" aria-label="Month details" style={drawerStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            Month detail
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, color: UXP.ink1, marginTop: 2 }}>
            {MONTHS[row.period_month - 1]} {year}
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16 }}>×</button>
      </div>

      {/* Manual edit form */}
      <div style={{
        background:    UXP.subtleBg,
        border:        `0.5px solid ${UXP.borderSoft}`,
        borderRadius:  UXP.r_md,
        padding:       '12px 14px',
        marginBottom:  14,
      }}>
        <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 8 }}>
          Manual entry
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          <FormField label="Revenue (kr)">
            <input type="number" value={editForm.revenue ?? ''}
                   onChange={e => onChange({ ...editForm, revenue: e.target.value })}
                   style={formInput} />
          </FormField>
          <FormField label="Food cost (kr)">
            <input type="number" value={editForm.food_cost ?? ''}
                   onChange={e => onChange({ ...editForm, food_cost: e.target.value })}
                   style={formInput} />
          </FormField>
          <FormField label="Staff cost (kr)">
            <input type="number" value={editForm.staff_cost ?? ''}
                   onChange={e => onChange({ ...editForm, staff_cost: e.target.value })}
                   style={formInput} />
          </FormField>
          <FormField label="Net profit (kr)">
            <input type="number" value={editForm.net_profit ?? ''}
                   onChange={e => onChange({ ...editForm, net_profit: e.target.value })}
                   style={formInput} />
          </FormField>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button type="button" onClick={onSave} disabled={saving} style={primaryBtn}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button type="button" onClick={onClose} style={ghostBtn}>Cancel</button>
        </div>
      </div>

      {/* Daily breakdown */}
      <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500, marginBottom: 6 }}>
        Daily breakdown
      </div>
      {loadingDaily ? (
        <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>Loading daily…</div>
      ) : daily == null ? (
        <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>No daily data fetched yet.</div>
      ) : daily.length === 0 ? (
        <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>No revenue or labour logged this month.</div>
      ) : (
        <div style={{ display: 'grid', gap: 0 }}>
          {daily.map((d: DailyRow, idx: number) => (
            <div key={d.date} style={{
              display:             'grid',
              gridTemplateColumns: '1fr auto auto',
              gap:                 12,
              padding:             '6px 0',
              borderBottom:        idx < daily.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
              fontSize:            11,
            }}>
              <span style={{ color: UXP.ink2 }}>
                {new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
              </span>
              <span style={{ color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
                {d.total > 0 ? `${d.total} cov` : '—'}
              </span>
              <span style={{ color: UXP.ink1, fontWeight: 500, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, minWidth: 80 }}>
                {fmtKr(d.revenue)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Banner ──────────────────────────────────────────────────────────
function Banner({ tone, text }: { tone: 'warning'; text: string }) {
  return (
    <div style={{
      background:    UXP.lavFill,
      border:        `0.5px solid ${UXP.lavMid}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         UXP.lavText,
    }}>
      {text}
    </div>
  )
}

// ── Generic atoms ───────────────────────────────────────────────────
function cardStyle(): React.CSSProperties {
  return {
    background:    UXP.cardBg,
    border:        `0.5px solid ${UXP.border}`,
    borderRadius:  UXP.r_lg,
    padding:       '14px 16px',
  }
}

function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
      <span style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</span>
      {children}
    </label>
  )
}

const drawerStyle: React.CSSProperties = {
  position:   'fixed' as const,
  top:        0, right: 0, bottom: 0,
  width:      'min(440px, 100%)',
  background: UXP.cardBg,
  borderLeft: `0.5px solid ${UXP.border}`,
  boxShadow:  '-8px 0 24px rgba(58,53,80,0.08)',
  padding:    '18px 22px',
  overflow:   'auto' as const,
  zIndex:     50,
}

const formInput: React.CSSProperties = {
  padding:      '6px 10px',
  background:   UXP.cardBg,
  color:        UXP.ink1,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 7,
  fontSize:     11,
  fontFamily:   'inherit',
}

const primaryBtn: React.CSSProperties = {
  padding:      '6px 14px',
  background:   UXP.lavDeep,
  color:        '#fff',
  border:       'none',
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}

const ghostBtn: React.CSSProperties = {
  padding:      '6px 12px',
  background:   UXP.cardBg,
  color:        UXP.ink2,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}
