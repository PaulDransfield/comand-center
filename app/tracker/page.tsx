'use client'
// @ts-nocheck
// app/tracker/page.tsx — Phase 3 of the UX redesign, per DESIGN.md § 3.
//
// Structure:
//   PageHero    eyebrow + best/worst-month contrast headline + YTD profit
//               block in the right slot (label + big number + 12-month
//               sparkline under it).
//   Primary     12-row monthly list. Each row: MONTH | inline bar showing
//               revenue (navy) with staff_cost (burnt) overlay on the left |
//               REVENUE | MARGIN | sparkline | expand-in-place chevron.
//               Expanded rows reveal a daily breakdown table beneath.
//   Supporting  none (detail is in the expanded row).
//
// Kept the AI narrative fetch logic so the Claude-written P&L paragraph still
// reaches the page — but demoted from a standalone purple gradient card into
// a compact AttentionPanel that renders only when a narrative exists.

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import PageHero from '@/components/ui/PageHero'
import AttentionPanel from '@/components/ui/AttentionPanel'
import Sparkline from '@/components/ui/Sparkline'
import StatusPill from '@/components/ui/StatusPill'
import TopBar from '@/components/ui/TopBar'
import SupportingStats from '@/components/ui/SupportingStats'
import { UX } from '@/lib/constants/tokens'

interface Business { id: string; name: string; city: string | null }
interface TrackerRow {
  id?: string
  period_month: number
  period_year: number
  revenue: number
  food_cost: number
  staff_cost: number
  net_profit: number
  margin_pct: number
}
interface DailyRow {
  date: string
  total: number
  revenue: number
  revenue_per_cover: number
  staff_cost?: number
  is_closed?: boolean
}

const MONTHS       = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
const fmtPct = (n: number | null) => n == null ? '—' : (Math.round(n * 10) / 10).toFixed(1) + '%'

export default function TrackerPage() {
  const now = new Date()
  const currentMonth = now.getMonth() + 1
  const currentYear  = now.getFullYear()

  const [businesses,   setBusinesses]   = useState<Business[]>([])
  const [selected,     setSelected]     = useState('')
  const [year,         setYear]         = useState(currentYear)
  const [rows,         setRows]         = useState<TrackerRow[]>([])
  const [editing,      setEditing]      = useState<number | null>(null)
  const [form,         setForm]         = useState<Partial<TrackerRow>>({})
  const [loading,      setLoading]      = useState(true)
  const [saving,       setSaving]       = useState(false)
  const [expanded,     setExpanded]     = useState<number | null>(null)
  const [dailyData,    setDailyData]    = useState<Record<number, DailyRow[]>>({})
  const [loadingDaily, setLoadingDaily] = useState<number | null>(null)
  const [narrative,    setNarrative]    = useState<any>(null)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const sync = () => {
        const saved = localStorage.getItem('cc_selected_biz')
        const id = (saved && data.find((b: any) => b.id === saved)) ? saved : data[0].id
        setSelected(id)
      }
      sync()
      window.addEventListener('storage', sync)
    }).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    const res = await fetch(`/api/metrics/monthly?business_id=${selected}&year=${year}`, { cache: 'no-store' })
    const data = await res.json()
    if (data.rows) {
      setRows(data.rows.map((r: any) => ({
        period_month: r.month, period_year: r.year,
        revenue: r.revenue, food_cost: r.food_cost, staff_cost: r.staff_cost,
        net_profit: r.net_profit, margin_pct: r.margin_pct,
      })))
    } else if (Array.isArray(data)) {
      setRows(data)
    }
    setLoading(false)
  }, [selected, year])

  useEffect(() => { if (selected) load() }, [selected, year, load])

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    setNarrative(null)
    fetch(`/api/tracker/narrative?business_id=${selected}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled && j && !j.error) setNarrative(j) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [selected, year])

  async function save() {
    if (!form.period_month) return
    setSaving(true)
    await fetch('/api/tracker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, business_id: selected, period_year: year }),
    })
    setSaving(false)
    setEditing(null)
    load()
  }

  async function toggleExpand(month: number) {
    if (expanded === month) { setExpanded(null); return }
    setExpanded(month)
    if (!dailyData[month]) {
      setLoadingDaily(month)
      const fromDate = `${year}-${String(month).padStart(2,'0')}-01`
      const lastDay  = new Date(year, month, 0).getDate()
      const toDate   = `${year}-${String(month).padStart(2,'0')}-${lastDay}`
      try {
        const res = await fetch(`/api/metrics/daily?business_id=${selected}&from=${fromDate}&to=${toDate}`)
        const data = await res.json()
        if (data.rows) {
          const mapped = data.rows
            .filter((r: any) => r.revenue > 0 || r.staff_cost > 0)
            .map((r: any) => ({
              date:              r.date,
              total:             r.covers ?? 0,
              revenue:           r.revenue ?? 0,
              revenue_per_cover: r.rev_per_cover ?? 0,
              staff_cost:        r.staff_cost ?? 0,
              is_closed:         r.revenue === 0 && r.staff_cost === 0,
            }))
          setDailyData(prev => ({ ...prev, [month]: mapped }))
        }
      } catch {}
      setLoadingDaily(null)
    }
  }

  // ── Derived metrics for hero ──────────────────────────────────────────────
  const withData   = rows.filter(r => Number(r.revenue ?? 0) > 0)
  const totRev     = withData.reduce((s, r) => s + Number(r.revenue ?? 0), 0)
  const totProfit  = withData.reduce((s, r) => s + Number(r.net_profit ?? 0), 0)
  const avgMargin  = withData.length ? withData.reduce((s, r) => s + Number(r.margin_pct ?? 0), 0) / withData.length : 0
  const bestMargin = withData.length ? withData.reduce((a, b) => Number(a.margin_pct) > Number(b.margin_pct) ? a : b) : null
  const worstMargin = withData.length ? withData.reduce((a, b) => Number(a.margin_pct) < Number(b.margin_pct) ? a : b) : null
  const maxRevenue = rows.length ? Math.max(...rows.map(r => Number(r.revenue ?? 0)), 1) : 1

  // 12-month sparkline of net profit
  const profitPoints = Array.from({ length: 12 }, (_, i) => {
    const r = rows.find(row => row.period_month === i + 1)
    return r ? Number(r.net_profit ?? 0) : 0
  })

  const allMonths = Array.from({ length: 12 }, (_, i) => {
    const existing = rows.find(r => r.period_month === i + 1)
    return existing ?? { period_month: i + 1, period_year: year, revenue: 0, food_cost: 0, staff_cost: 0, net_profit: 0, margin_pct: 0 }
  })

  // ── Honesty check — if any logged month has revenue>0 but food_cost=0
  //    the displayed "margin" is inflated. PNL-FIX § 2 calls this out.
  const foodGapMonth = withData.find(r => Number(r.food_cost ?? 0) === 0) ?? null
  const hasFoodGap   = !!foodGapMonth

  // ── Labour % of revenue (YTD) — for the hero context ───────────────────
  const totLabour    = withData.reduce((s, r) => s + Number(r.staff_cost ?? 0), 0)
  const labourPctYtd = totRev > 0 ? (totLabour / totRev) * 100 : null

  // ── Hero headline ─────────────────────────────────────────────────────────
  const heroHeadline = (() => {
    if (withData.length === 0) {
      return <>Nothing logged for <span style={{ fontWeight: UX.fwMedium }}>{year}</span> yet.</>
    }
    // Single month + food gap → the 50.3% margin is synthetic, say so.
    if (withData.length === 1 && hasFoodGap) {
      const m = withData[0]
      return (
        <>
          {MONTHS_SHORT[m.period_month - 1]} margin <span style={{ color: UX.amberInk, fontWeight: UX.fwMedium }}>{fmtPct(Number(m.margin_pct))}</span>
          {' '}— but food cost is missing, so this isn't the real number.
        </>
      )
    }
    if (bestMargin && worstMargin && bestMargin !== worstMargin && Math.abs(Number(bestMargin.margin_pct) - Number(worstMargin.margin_pct)) > 5) {
      const bestPct  = fmtPct(Number(bestMargin.margin_pct))
      const worstPct = fmtPct(Number(worstMargin.margin_pct))
      return (
        <>
          YTD margin <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{fmtPct(avgMargin)}</span>
          , but <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{MONTHS_SHORT[worstMargin.period_month - 1]} crashed to {worstPct}</span>
          {' '}vs {MONTHS_SHORT[bestMargin.period_month - 1]} at {bestPct}.
        </>
      )
    }
    return (
      <>
        YTD margin <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{fmtPct(avgMargin)}</span> across {withData.length} month{withData.length === 1 ? '' : 's'}.
      </>
    )
  })()

  const heroContext = (() => {
    if (withData.length === 0) return undefined
    const parts: string[] = []
    parts.push(`${withData.length} month${withData.length === 1 ? '' : 's'} of data out of 12`)
    if (labourPctYtd != null) parts.push(`Labour ate ${fmtPct(labourPctYtd)} of revenue (target 35%)`)
    if (hasFoodGap)           parts.push(`Food cost shows 0 kr — likely a sync gap, not a win`)
    if (!hasFoodGap && worstMargin && bestMargin && worstMargin !== bestMargin) {
      const diff = Math.round(Math.abs(Number(bestMargin.margin_pct) - Number(worstMargin.margin_pct)) * 10) / 10
      parts.push(`${diff}pp swing between best and worst month`)
    }
    return parts.join(' · ')
  })()

  return (
    <AppShell>
      <div style={{ maxWidth: 1000 }}>
        {/* Row-hover reveal for the pencil action.  Keeps the row visually
            clean by default — the ✎ only appears on hover, keyboard focus,
            or when editing.  FIX-PROMPT § Phase 3 ("actions live on hover"). */}
        <style>{`
          .cc-pnl-action { opacity: 0; transition: opacity .12s ease; }
          .cc-pnl-row:hover .cc-pnl-action,
          .cc-pnl-row:focus-within .cc-pnl-action { opacity: 1; }
        `}</style>

        {/* TopBar — breadcrumb + business/year pickers. Stops the selectors
            floating in the top-right corner with no visual anchor.
            PNL-FIX § 7. */}
        <TopBar
          crumbs={[
            { label: 'Financials' },
            { label: 'P&L Tracker', active: true },
          ]}
          rightSlot={
            <>
              <select value={selected} onChange={e => setSelected(e.target.value)} style={selectStyle}>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select value={year} onChange={e => setYear(parseInt(e.target.value))} style={selectStyle}>
                {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </>
          }
        />

        {/* ─── PageHero ──────────────────────────────────────────────────── */}
        <PageHero
          eyebrow={`YTD — ${year}${withData.length ? ` · ${withData.length} MONTH${withData.length === 1 ? '' : 'S'} LOGGED` : ''}`}
          headline={heroHeadline}
          context={heroContext}
          right={
            <div style={{ minWidth: 160, textAlign: 'right' as const }}>
              <div style={{ fontSize: UX.fsMicro, color: UX.ink4, letterSpacing: '0.05em', textTransform: 'uppercase' as const, fontWeight: UX.fwMedium, marginBottom: 3 }}>
                YTD profit
              </div>
              <div style={{ fontSize: 22, fontWeight: UX.fwMedium, color: totProfit >= 0 ? UX.ink1 : UX.redInk, letterSpacing: '-0.02em', fontVariantNumeric: 'tabular-nums' as const }}>
                {fmtKr(totProfit)}
              </div>
              {/* Sparkline only renders once there's a real trend to draw
                  (≥3 months with revenue). A 1-point line is noise — PNL-FIX § 2. */}
              {withData.length >= 3 && (
                <div style={{ marginTop: 5 }}>
                  <Sparkline
                    points={profitPoints}
                    tone={totProfit >= 0 ? 'good' : 'bad'}
                    width={160}
                    height={20}
                  />
                </div>
              )}
            </div>
          }
        />

        {/* AI narrative — compact AttentionPanel, not a big purple banner.
            Full text renders (PNL-FIX § 4 Option A) — no mid-word truncation.
            Card title already says "AI P&L", so the "AI" pill was redundant
            and has been removed. */}
        {narrative?.narrative && (
          <div style={{ marginBottom: 12 }}>
            <AttentionPanel
              title={`AI P&L — ${narrative.month ? MONTHS_SHORT[(narrative.month ?? 1) - 1] : ''} ${narrative.year ?? ''}`.trim()}
              items={[{
                tone:    'warning',
                entity:  'Claude',
                message: narrative.narrative,
              }]}
            />
          </div>
        )}

        {/* ─── Primary: monthly list ─────────────────────────────────────── */}
        <div style={{
          background:   UX.cardBg,
          border:       `0.5px solid ${UX.border}`,
          borderRadius: UX.r_lg,
          overflow:     'hidden' as const,
        }}>
          <div style={{
            padding:      '10px 16px',
            background:   UX.subtleBg,
            borderBottom: `0.5px solid ${UX.borderSoft}`,
            display:      'grid',
            gridTemplateColumns: '44px 90px 1fr 100px 90px 90px 60px',
            gap:          12,
            alignItems:   'center',
            fontSize:     UX.fsMicro,
            fontWeight:   UX.fwMedium,
            color:        UX.ink4,
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
          }}>
            <span />
            <span>Month</span>
            <span>Revenue vs cost</span>
            <span style={{ textAlign: 'right' as const }}>Revenue</span>
            <span style={{ textAlign: 'right' as const }}>Margin</span>
            <span style={{ textAlign: 'right' as const }}>Profit</span>
            <span />
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Loading…</div>
          ) : (
            allMonths.map((row) => {
              // "Has data" now means real revenue logged — a row with all
              // zeros should render as a dashed placeholder, not a full row
              // with a 0 kr bar (FIX-PROMPT § Phase 3).
              const hasRev     = Number(row.revenue ?? 0) > 0
              const hasData    = rows.some(r => r.period_month === row.period_month) && hasRev
              const isFuture   = year === currentYear && row.period_month > currentMonth
                                || year > currentYear
              const isCurrent  = year === currentYear && row.period_month === currentMonth
              const isExpanded = expanded === row.period_month && hasData
              const isEdit     = editing === row.period_month

              const foodPct  = hasRev ? (Number(row.food_cost)  / Number(row.revenue)) * 100 : 0
              const staffPct = hasRev ? (Number(row.staff_cost) / Number(row.revenue)) * 100 : 0
              const marginPct = Number(row.margin_pct ?? 0)
              const marginTone: 'good' | 'bad' | 'warning' | 'neutral' =
                !hasData    ? 'neutral'
                : marginPct >= 12 ? 'good'
                : marginPct >=  5 ? 'warning'
                :                   'bad'

              // Inline bar math — revPct is the navy width (revenue as % of
              // year max).  costPct is the burnt overlay, which sits AT THE
              // LEFT of the navy bar and represents staff_cost / revenue as
              // a fraction of the navy bar.  So: 70% margin → narrow burnt
              // slice at the start and a long navy tail. Not two segments
              // scaled independently to the track.
              const revPct       = hasRev ? Math.max(0, Math.min(100, (Number(row.revenue ?? 0) / maxRevenue) * 100)) : 0
              const costShareRev = hasRev ? Math.min(1, Number(row.staff_cost ?? 0) / Number(row.revenue)) : 0
              const costPct      = revPct * costShareRev

              const rowBg =
                isCurrent && hasData ? (marginTone === 'bad' ? UX.redSoft : marginTone === 'warning' ? UX.amberSoft : UX.greenSoft)
                : isExpanded ? UX.subtleBg
                : UX.cardBg

              return (
                <div key={row.period_month}>
                  {isEdit ? (
                    <div
                      style={{
                        display:             'grid',
                        gridTemplateColumns: '44px 90px 1fr 100px 90px 90px 60px',
                        gap:                 12,
                        padding:             '10px 16px',
                        alignItems:          'center',
                        borderBottom:        `0.5px solid ${UX.borderSoft}`,
                        background:          UX.cardBg,
                      }}
                    >
                      <span />
                      <span style={{ fontWeight: UX.fwMedium, color: UX.ink1 }}>{MONTHS_SHORT[row.period_month - 1]}</span>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
                        {(['revenue','food_cost','staff_cost'] as const).map(field => (
                          <input
                            key={field}
                            type="number" placeholder={field}
                            value={(form as any)[field] ?? ''}
                            onChange={e => setForm(f => ({ ...f, [field]: parseFloat(e.target.value) || 0 }))}
                            style={{ padding: '5px 8px', border: `1px solid ${UX.indigo}`, borderRadius: UX.r_sm, fontSize: UX.fsBody }}
                          />
                        ))}
                      </div>
                      <span />
                      <span />
                      <span />
                      <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                        <button onClick={save} disabled={saving} style={{ padding: '4px 10px', background: UX.navy, color: 'white', border: 'none', borderRadius: UX.r_sm, fontSize: UX.fsMicro, cursor: 'pointer', fontWeight: UX.fwMedium }}>
                          {saving ? '…' : 'Save'}
                        </button>
                        <button onClick={() => setEditing(null)} style={{ padding: '4px 8px', background: UX.borderSoft, border: 'none', borderRadius: UX.r_sm, fontSize: UX.fsMicro, cursor: 'pointer', color: UX.ink2 }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="cc-pnl-row"
                      onClick={() => hasData && toggleExpand(row.period_month)}
                      style={{
                        display:             'grid',
                        gridTemplateColumns: '44px 90px 1fr 100px 90px 90px 60px',
                        gap:                 12,
                        padding:             '11px 16px',
                        alignItems:          'center',
                        borderBottom:        isExpanded ? 'none' : `0.5px solid ${UX.borderSoft}`,
                        background:          rowBg,
                        opacity:             !hasData && !isCurrent ? 0.55 : 1,
                        cursor:              hasData ? 'pointer' : 'default',
                      }}
                    >
                      <span style={{ textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsMicro }}>
                        {hasData ? (isExpanded ? '▾' : '▸') : ''}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontWeight: UX.fwMedium, color: (isFuture || !hasRev) ? UX.ink4 : UX.ink1, fontSize: UX.fsBody }}>
                          {MONTHS_SHORT[row.period_month - 1]}
                        </span>
                        {isCurrent && <StatusPill tone="info">NOW</StatusPill>}
                        {/* No `forecast` label on future months — PNL-FIX § 6.
                            Forecast data is not wired in; the label was
                            writing a cheque the data couldn't cash. Grey
                            month name is signal enough. */}
                      </div>
                      {/* Revenue vs cost bar.
                          - hasData (real revenue): navy width scaled to year
                            max revenue, with a burnt-orange overlay at the
                            LEFT covering staff_cost/revenue × revPct of the
                            total track.
                          - no revenue: empty cell (PNL-FIX § 8). No dashed
                            line — an empty cell is clearer than a drawn line
                            that implies data. */}
                      {hasData ? (
                        <div style={{ position: 'relative' as const, height: 10, background: UX.borderSoft, borderRadius: 2 }}>
                          <div style={{
                            position: 'absolute' as const, left: 0, top: 0, bottom: 0,
                            width: `${revPct}%`, background: UX.navy,
                            borderRadius: revPct >= 99.5 ? '2px' : '2px 0 0 2px',
                          }} />
                          {costPct > 0 && (
                            <div style={{
                              position: 'absolute' as const, left: 0, top: 0, bottom: 0,
                              width: `${costPct}%`, background: UX.burnt,
                              borderRadius: '2px 0 0 2px',
                            }} />
                          )}
                        </div>
                      ) : (
                        <span aria-hidden />
                      )}
                      <span style={{ textAlign: 'right' as const, color: hasData ? UX.ink1 : UX.ink5, fontVariantNumeric: 'tabular-nums' as const, fontSize: UX.fsBody }}>
                        {hasData ? fmtKr(Number(row.revenue)) : '—'}
                      </span>
                      <span style={{ textAlign: 'right' as const }}>
                        {hasData ? (
                          <span style={{
                            fontSize:     UX.fsMicro,
                            fontWeight:   UX.fwMedium,
                            padding:      '2px 7px',
                            borderRadius: UX.r_sm,
                            background:   marginTone === 'good' ? UX.greenBg : marginTone === 'warning' ? UX.amberBg : UX.redBg,
                            color:        marginTone === 'good' ? UX.greenInk : marginTone === 'warning' ? UX.amberInk2 : UX.redInk2,
                          }}>
                            {fmtPct(marginPct)}
                          </span>
                        ) : <span style={{ color: UX.ink5 }}>—</span>}
                      </span>
                      <span style={{ textAlign: 'right' as const, fontWeight: UX.fwMedium, color: hasData ? (Number(row.net_profit) >= 0 ? UX.ink1 : UX.redInk) : UX.ink5, fontVariantNumeric: 'tabular-nums' as const, fontSize: UX.fsBody }}>
                        {hasData ? fmtKr(Number(row.net_profit)) : '—'}
                      </span>
                      {/* Hover-only pencil — no persistent Edit/+Add buttons.
                          Future months render nothing (just dimmed grey row).
                          Past months with data show ✎ on row hover.
                          The CSS for .cc-pnl-action is injected at the page
                          root below. */}
                      <div
                        className="cc-pnl-action"
                        style={{ textAlign: 'right' as const }}
                        onClick={e => e.stopPropagation()}
                      >
                        {!isFuture && (
                          <button
                            aria-label={hasData ? `Edit ${MONTHS_SHORT[row.period_month - 1]}` : `Add ${MONTHS_SHORT[row.period_month - 1]}`}
                            onClick={() => { setEditing(row.period_month); setForm({ period_month: row.period_month, revenue: Number(row.revenue), food_cost: Number(row.food_cost), staff_cost: Number(row.staff_cost) }) }}
                            style={{
                              padding:      '3px 8px',
                              background:   'transparent',
                              border:       'none',
                              borderRadius: UX.r_sm,
                              fontSize:     13,
                              cursor:       'pointer',
                              color:        UX.ink4,
                              lineHeight:   1,
                            }}
                          >
                            ✎
                          </button>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Daily breakdown — expanded in place */}
                  {isExpanded && !isEdit && (
                    <div style={{
                      padding:      '0 16px 14px 60px',
                      background:   UX.subtleBg,
                      borderBottom: `0.5px solid ${UX.borderSoft}`,
                    }}>
                      <div style={{ fontSize: UX.fsMicro, color: UX.ink4, letterSpacing: '0.06em', textTransform: 'uppercase' as const, fontWeight: UX.fwMedium, padding: '8px 0' }}>
                        Daily — {MONTHS[row.period_month - 1]} {year}
                      </div>
                      {loadingDaily === row.period_month ? (
                        <div style={{ fontSize: UX.fsMicro, color: UX.ink4, padding: '6px 0' }}>Loading daily data…</div>
                      ) : (dailyData[row.period_month] ?? []).length === 0 ? (
                        <div style={{ fontSize: UX.fsMicro, color: UX.ink5, padding: '6px 0' }}>
                          No daily data yet for this month.
                        </div>
                      ) : (
                        <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsMicro }}>
                          <thead>
                            <tr style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
                              {['Date', 'Revenue', 'Staff cost', 'Labour %', 'Covers', 'Rev / cover'].map(h => (
                                <th key={h} style={{ textAlign: h === 'Date' ? 'left' as const : 'right' as const, padding: '4px 8px', color: UX.ink4, fontWeight: UX.fwMedium, letterSpacing: '.06em', textTransform: 'uppercase' as const, fontSize: 9 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {(dailyData[row.period_month] ?? []).filter((d: any) => !d.is_closed).map((d: any) => {
                              const labPct = d.revenue > 0 && d.staff_cost > 0 ? (d.staff_cost / d.revenue) * 100 : null
                              return (
                                <tr key={d.date} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
                                  <td style={{ padding: '5px 8px', color: UX.ink2, fontWeight: UX.fwMedium }}>
                                    {new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                                  </td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right' as const, color: d.revenue > 0 ? UX.ink1 : UX.ink5, fontWeight: d.revenue > 0 ? UX.fwMedium : UX.fwRegular }}>
                                    {d.revenue > 0 ? fmtKr(d.revenue) : '—'}
                                  </td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right' as const, color: d.staff_cost > 0 ? UX.ink2 : UX.ink5 }}>
                                    {d.staff_cost > 0 ? fmtKr(d.staff_cost) : '—'}
                                  </td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right' as const }}>
                                    {labPct !== null ? (
                                      <span style={{ fontWeight: UX.fwMedium, color: labPct > 40 ? UX.redInk : UX.greenInk }}>{fmtPct(labPct)}</span>
                                    ) : <span style={{ color: UX.ink5 }}>—</span>}
                                  </td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right' as const, color: d.total > 0 ? UX.ink2 : UX.ink5 }}>{d.total > 0 ? d.total : '—'}</td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right' as const, color: d.revenue_per_cover > 0 ? UX.ink2 : UX.ink5 }}>{d.revenue_per_cover > 0 ? fmtKr(d.revenue_per_cover) : '—'}</td>
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div style={{ marginTop: 10, fontSize: UX.fsMicro, color: UX.ink4 }}>
          Management view — not a regulated financial statement.
        </div>
      </div>

      <AskAI
        page="tracker"
        context={rows.length > 0 ? [
          `Year: ${year}`,
          `Monthly P&L:`,
          ...rows.map((r: TrackerRow) =>
            `  ${MONTHS[r.period_month - 1]}: Revenue ${fmtKr(r.revenue)}, Food ${fmtKr(r.food_cost)}, Staff ${fmtKr(r.staff_cost)}, Net ${fmtKr(r.net_profit)}, Margin ${fmtPct(r.margin_pct)}`
          ),
        ].join('\n') : 'No P&L data entered yet'}
      />
    </AppShell>
  )
}

const selectStyle = {
  padding:      '6px 10px',
  border:       `0.5px solid ${UX.border}`,
  borderRadius: UX.r_md,
  fontSize:     UX.fsBody,
  background:   UX.cardBg,
  color:        UX.ink1,
  cursor:       'pointer',
} as const
