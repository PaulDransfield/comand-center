'use client'
// @ts-nocheck
// app/forecast/page.tsx — Phase 5 of the UX redesign, per DESIGN.md § 5.
//
// Structure:
//   PageHero    eyebrow + projected-revenue / weak-spot headline + YTD profit
//               block in the right slot.
//   Primary     one full-year line chart: navy solid line for actual months
//               (Jan–current), indigo dashed for forecast months (current+1–
//               Dec), light-grey band over the forecast region, vertical
//               "today" line at the boundary, dots coloured by tone.
//   Supporting  Forecast flags card — months that missed or are at risk.
//
// Data source is unchanged (/api/forecast + /api/departments). Dept drill-down
// is available on /departments/[id]?year=&month=, which is already wired.

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback, useMemo } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import dynamicImport from 'next/dynamic'
// FIXES §0ll: lazy-load AskAI — see /dashboard for rationale.
const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })
import PageHero from '@/components/ui/PageHero'
import StatusPill from '@/components/ui/StatusPill'
import AttentionPanel, { AttentionItem } from '@/components/ui/AttentionPanel'
import Sparkline from '@/components/ui/Sparkline'
import TopBar from '@/components/ui/TopBar'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

const MONTHS       = ['January','February','March','April','May','June','July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function ForecastPage() {
  const t   = useTranslations('financials.forecast')
  const now           = new Date()
  const currentYear   = now.getFullYear()
  const currentMonth  = now.getMonth() + 1
  const daysInMonth   = new Date(currentYear, currentMonth, 0).getDate()
  const todayProgress = now.getDate() / daysInMonth

  const [businesses, setBusinesses] = useState<any[]>([])
  const [selected,   setSelected]   = useState('')
  const [data,       setData]       = useState<any>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [syncing,    setSyncing]    = useState(false)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) { setLoading(false); return }
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
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/forecast?business_id=${selected}`)
      if (res.ok) setData(await res.json())
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }, [selected])

  useEffect(() => { if (selected) load() }, [selected, load])

  async function triggerSync() {
    setSyncing(true)
    await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'personalkollen' }) })
    await load()
    setSyncing(false)
  }

  // ── Shape the 12 months of this year ──────────────────────────────────────
  const monthly = useMemo(() => {
    const forecasts = data?.forecasts ?? []
    const actuals   = data?.actuals   ?? []
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1
      const f = forecasts.find((r: any) => r.period_year === currentYear && r.period_month === m)
      const a = actuals.find((r: any) => r.period_year === currentYear && r.period_month === m)
      const isPast    = m < currentMonth
      const isCurrent = m === currentMonth
      const isFuture  = m > currentMonth
      const actualRev   = a ? Number(a.revenue ?? 0) : 0
      const forecastRev = f ? Number(f.revenue_forecast ?? 0) : 0
      // Primary Y-value for the line:
      //   past / current month → actual (if any) falling back to forecast
      //   future month → forecast
      const value = isFuture ? forecastRev
                   : (actualRev > 0 ? actualRev : forecastRev)
      // Tone for the marker dot
      let tone: 'good' | 'bad' | 'warning' | 'neutral' = 'neutral'
      if (isPast && actualRev > 0 && forecastRev > 0) {
        const pct = (actualRev - forecastRev) / forecastRev
        tone = pct >= 0 ? 'good' : pct <= -0.10 ? 'bad' : 'warning'
      } else if (isFuture && forecastRev > 0) {
        tone = 'neutral'
      }
      return {
        m, f, a,
        isPast, isCurrent, isFuture,
        actualRev, forecastRev,
        value, tone,
        margin:       a?.margin_pct != null ? Number(a.margin_pct) : null,
        marginForecast: f?.margin_forecast != null ? Number(f.margin_forecast) : null,
      }
    })
  }, [data, currentYear, currentMonth])

  // YTD actual profit
  const ytdActualProfit = (data?.actuals ?? [])
    .filter((r: any) => r.period_year === currentYear)
    .reduce((s: number, r: any) => s + Number(r.net_profit ?? 0), 0)

  // Honesty guards — before we can claim a full-year projection we need
  // (a) at least one non-zero actual and (b) forecasts covering the rest
  // of the year. Without both, saying "Tracking to X kr" is a maths lie.
  const forecastCount = (data?.forecasts ?? [])
    .filter((r: any) => r.period_year === currentYear && r.period_month >= currentMonth)
    .length
  const actualMonths = monthly.filter(r => r.actualRev > 0).length
  const hasProjection = forecastCount > 0 && actualMonths > 0

  // Projected full-year revenue — only meaningful when we have forecasts
  // for the remaining months. Otherwise return null so the hero never
  // shows a "Tracking to {kr}" line that's really just one month's actual.
  const projectedFullYear = hasProjection
    ? monthly.reduce((s, r) => {
        if (r.isPast || r.isCurrent) return s + Math.max(r.actualRev, r.forecastRev)
        return s + r.forecastRev
      }, 0)
    : null

  // Projected full-year margin — same horizon, weighted by revenue. Needed
  // for the hero context (FORECAST-FIX § 5) so we can say
  //   "tracking to X kr · forecast margin Y%"
  // instead of just quoting revenue.
  const projectedMarginPct = (() => {
    if (!hasProjection) return null
    let rev = 0, profit = 0
    for (const r of monthly) {
      if (r.isPast || r.isCurrent) {
        const revV = Math.max(r.actualRev, r.forecastRev)
        rev    += revV
        profit += Number(r.a?.net_profit ?? 0)
      } else {
        rev    += r.forecastRev
        // Prefer margin_forecast when present, fall back to the year's
        // average; zero-pad missing so the ratio stays stable.
        const mpct = r.marginForecast
        profit += mpct != null ? (r.forecastRev * mpct / 100) : 0
      }
    }
    return rev > 0 ? (profit / rev) * 100 : null
  })()

  // Year-average forecast margin — used to flag at-risk months (FORECAST-FIX § 3).
  const forecastMargins = monthly
    .filter(r => (r.isFuture || r.isCurrent) && r.marginForecast != null)
    .map(r => r.marginForecast!)
  const avgForecastMargin = forecastMargins.length
    ? forecastMargins.reduce((s, v) => s + v, 0) / forecastMargins.length
    : null

  // Weak spot = future month with lowest margin forecast (or biggest past miss if none).
  const weakFuture = monthly
    .filter(r => r.isFuture && r.marginForecast != null)
    .sort((a, b) => (a.marginForecast ?? 1e9) - (b.marginForecast ?? 1e9))[0] ?? null
  const biggestMiss = monthly
    .filter(r => r.isPast && r.actualRev > 0 && r.forecastRev > 0 && r.tone === 'bad')
    .sort((a, b) => ((a.actualRev - a.forecastRev) - (b.actualRev - b.forecastRev)))[0] ?? null

  // ── Hero headline ─────────────────────────────────────────────────────────
  const headline = (() => {
    if (loading) return <>{t('loading')}</>
    if (!data) return <>Forecast not available yet.</>

    // No forecast yet. Don't invent a projection — surface the real state.
    if (!hasProjection) {
      if (actualMonths === 0) {
        return <>No actuals or forecast yet for <span style={{ fontWeight: UX.fwMedium }}>{currentYear}</span>.</>
      }
      const monthNames = monthly
        .filter(r => r.actualRev > 0)
        .map(r => MONTHS_SHORT[r.m - 1]).join(', ')
      return (
        <>
          {monthNames} logged — <span style={{ color: UX.amberInk, fontWeight: UX.fwMedium }}>no forecast generated yet</span> for the rest of the year.
        </>
      )
    }

    if (weakFuture && weakFuture.marginForecast != null && weakFuture.marginForecast < 12) {
      return (
        <>
          Tracking to <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{fmtKr(projectedFullYear!)}</span> revenue
          {' '}— <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{MONTHS_SHORT[weakFuture.m - 1]} weak at {fmtPct(weakFuture.marginForecast)} margin</span>.
        </>
      )
    }
    if (biggestMiss) {
      const pct = ((biggestMiss.actualRev - biggestMiss.forecastRev) / biggestMiss.forecastRev) * 100
      return (
        <>
          Tracking to <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{fmtKr(projectedFullYear!)}</span>
          {' '}— <span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{MONTHS_SHORT[biggestMiss.m - 1]} missed by {fmtPct(Math.abs(pct))}</span>.
        </>
      )
    }
    return (
      <>
        Tracking to <span style={{ color: UX.greenInk, fontWeight: UX.fwMedium }}>{fmtKr(projectedFullYear!)}</span> revenue this year.
      </>
    )
  })()

  const heroContextText = (() => {
    if (!data) return undefined
    if (!hasProjection) {
      return `${actualMonths} month${actualMonths === 1 ? '' : 's'} of actuals · forecasts regenerate on the 1st of each month`
    }
    // Full sentence with margin and YTD profit context (FORECAST-FIX § 5).
    const parts: string[] = []
    if (projectedMarginPct != null) {
      parts.push(`forecast margin ${fmtPct(projectedMarginPct)}`)
    }
    parts.push(`${actualMonths} month${actualMonths === 1 ? '' : 's'} actual (${fmtKr(ytdActualProfit)} profit)`)
    return parts.join(' · ')
  })()

  // ── Flags list (supporting row) ───────────────────────────────────────────
  // Rules per FORECAST-FIX § 3:
  //   MISSED — past/current actual is > 15% below forecast
  //   AT RISK — future margin_forecast is > 10pp below year-avg forecast
  //             margin (or, fallback, below 12% absolute when no avg).
  const flags: AttentionItem[] = monthly.flatMap(r => {
    if (!r.isFuture && r.actualRev > 0 && r.forecastRev > 0) {
      const pct = ((r.actualRev - r.forecastRev) / r.forecastRev) * 100
      if (pct <= -15) {
        return [{
          tone: 'bad',
          entity: MONTHS_SHORT[r.m - 1],
          message: `missed forecast by ${fmtPct(Math.abs(pct))} — ${fmtKr(r.actualRev)} vs ${fmtKr(r.forecastRev)}.`,
        } as AttentionItem]
      }
    }
    if (r.isFuture && r.marginForecast != null) {
      const threshold = avgForecastMargin != null ? avgForecastMargin - 10 : 12
      if (r.marginForecast < threshold) {
        const rel = avgForecastMargin != null
          ? `${(Math.round((avgForecastMargin - r.marginForecast) * 10) / 10).toFixed(1)}pp below year avg`
          : `below 12% floor`
        return [{
          tone: 'warning',
          entity: MONTHS_SHORT[r.m - 1],
          message: `margin forecast ${fmtPct(r.marginForecast)} — ${rel} on ${fmtKr(r.forecastRev)} revenue.`,
        } as AttentionItem]
      }
    }
    return []
  })

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        {/* TopBar — crumb trail + refresh + biz picker. Replaces the
            floating right-aligned selectors. */}
        <TopBar
          crumbs={[
            { label: t('crumb.financials') },
            { label: t('crumb.forecast'), active: true },
          ]}
          rightSlot={
            <>
              <select value={selected} onChange={e => setSelected(e.target.value)}
                style={{ padding: '5px 9px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1 }}>
                {businesses.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              {/* Icon-ified refresh (FORECAST-FIX § 4). The full-width
                  "Refresh forecast" button competed with the dropdown for
                  the same corner — a 24 px circular icon is enough. */}
              <button
                onClick={triggerSync}
                disabled={syncing || !selected}
                title={syncing ? t('syncing') : t('refresh')}
                aria-label={t('refresh')}
                style={{
                  width:        28,
                  height:       28,
                  borderRadius: '50%',
                  background:   'transparent',
                  border:       `0.5px solid ${UX.border}`,
                  color:        UX.ink3,
                  cursor:       syncing || !selected ? 'not-allowed' : 'pointer',
                  opacity:      syncing || !selected ? 0.5 : 1,
                  display:      'flex',
                  alignItems:   'center',
                  justifyContent: 'center',
                  fontSize:     14,
                  padding:      0,
                }}
              >
                <span className={syncing ? 'cc-fc-spin' : undefined} style={{ display: 'inline-block', lineHeight: 1 }}>↻</span>
              </button>
              <style>{`
                @keyframes cc-fc-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
                .cc-fc-spin { animation: cc-fc-spin 1s linear infinite; display: inline-block; }
              `}</style>
            </>
          }
        />

        {/* ─── PageHero ──────────────────────────────────────────────────── */}
        <PageHero
          eyebrow={`${currentYear} FORECAST`}
          headline={headline}
          context={heroContextText}
          right={
            <div style={{ minWidth: 160, textAlign: 'right' as const }}>
              <div style={{ fontSize: UX.fsMicro, color: UX.ink4, letterSpacing: '0.05em', textTransform: 'uppercase' as const, fontWeight: UX.fwMedium, marginBottom: 3 }}>
                YTD net profit
              </div>
              <div style={{ fontSize: 22, fontWeight: UX.fwMedium, color: ytdActualProfit >= 0 ? UX.ink1 : UX.redInk, fontVariantNumeric: 'tabular-nums' as const, letterSpacing: '-0.02em' }}>
                {fmtKr(ytdActualProfit)}
              </div>
              <div style={{ fontSize: UX.fsMicro, color: UX.ink3, marginTop: 3 }}>
                {currentMonth - 1} months actual
              </div>
            </div>
          }
        />

        {error && (
          <div style={{ background: UX.redSoft, border: `1px solid ${UX.redBorder}`, borderRadius: UX.r_lg, padding: '10px 14px', fontSize: UX.fsBody, color: UX.redInk, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {/* ─── Primary: full-year line chart ────────────────────────────
            When no forecast exists for the remaining months AND fewer than
            2 past months have actuals, an empty chart is noise — render an
            explainer card instead (FIX-PROMPT § Phase 5). Once we have
            enough signal, show the chart with the actual line connecting
            through zero months so Jan → current is always one stroke. */}
        <div style={{
          background:   UX.cardBg,
          border:       `0.5px solid ${UX.border}`,
          borderRadius: UX.r_lg,
          padding:      '18px 20px',
          marginBottom: 14,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1 }}>Full-year revenue</div>
            <div style={{ display: 'flex', gap: 14, fontSize: UX.fsMicro, color: UX.ink3 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 14, height: 2, background: UX.navy, borderRadius: 1 }} /> Actual
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 14, height: 0, borderTop: `2px dashed ${UX.indigo}` }} /> Forecast
              </span>
            </div>
          </div>
          {!loading && !hasProjection && actualMonths < 2 ? (
            <div style={{
              padding:     '40px 20px',
              textAlign:   'center' as const,
              color:       UX.ink4,
              fontSize:    UX.fsBody,
              lineHeight:  1.55,
            }}>
              {actualMonths === 0
                ? <>No forecast or actuals to plot yet.  The monthly calibration cron generates forecasts from last year's trading data — it runs on the 1st of each month, or click <b>Refresh forecast</b> above.</>
                : <>Only 1 month of actuals and no forecast generated yet. Check back after the 1st of next month, or run the calibration manually.</>}
            </div>
          ) : (
            <ForecastChart
              monthly={monthly}
              currentMonth={currentMonth}
              todayProgress={todayProgress}
              loading={loading}
            />
          )}
        </div>

        {/* ─── Supporting: forecast flags ─────────────────────────────── */}
        {flags.length > 0 && (
          <AttentionPanel
            title="Forecast flags"
            items={flags}
            maxItems={6}
          />
        )}
      </div>

      <AskAI
        page="forecast"
        context={data ? `Year: ${currentYear}. YTD profit: ${fmtKr(ytdActualProfit)}. ${projectedFullYear != null ? `Projected full year: ${fmtKr(projectedFullYear)}. ` : 'No full-year forecast yet. '}${flags.length} flagged months.` : 'No forecast data yet'}
      />
    </AppShell>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// ForecastChart — inline SVG. Navy solid for actual months, indigo dashed for
// forecast months, light-grey rectangle over the forecast region, vertical
// "today" dashed line at the month boundary, coloured dots at each point.
// ─────────────────────────────────────────────────────────────────────────────
function ForecastChart({ monthly, currentMonth, todayProgress, loading }: any) {
  const t = useTranslations('financials.forecast')
  const W   = 720
  const H   = 240
  const PL  = 46
  const PR  = 14
  const PT  = 14
  const PB  = 30
  const plotW = W - PL - PR
  const plotH = H - PT - PB

  const values = monthly.map((m: any) => m.value ?? 0)
  const maxV = Math.max(1, ...values)
  const yMax = Math.ceil(maxV / 100_000) * 100_000

  const xAt = (i: number) => PL + (plotW * (i + 0.5)) / 12
  const yAt = (v: number) => PT + plotH * (1 - v / yMax)

  // Actual line — connects Jan → last COMPLETED month.  The current
  // month is rendered separately as a hollow "in progress" circle and is
  // NOT connected into the solid navy line — part-month actuals drop
  // dramatically from the previous month's total and would otherwise
  // read as "April collapsed" (FORECAST-FIX § 2).
  const pastMonthly = monthly.filter((m: any) => m.isPast)
  const firstActualIdx = pastMonthly.findIndex((m: any) => m.actualRev > 0)
  const lastActualIdx  = pastMonthly.length - 1 - [...pastMonthly].reverse().findIndex((m: any) => m.actualRev > 0)
  const actualPoints = firstActualIdx < 0
    ? []
    : pastMonthly
        .slice(firstActualIdx, lastActualIdx + 1)
        .map((m: any) => ({ x: xAt(m.m - 1), y: yAt(m.actualRev), tone: m.tone, m: m.m, value: m.actualRev, actual: true }))

  // Current month treated specially.  Hollow ring with "in progress"
  // label instead of a solid dot — it's not a final value.
  const currentRow = monthly.find((m: any) => m.isCurrent)
  const currentInProgress = currentRow && currentRow.actualRev > 0
    ? { x: xAt(currentRow.m - 1), y: yAt(currentRow.actualRev), m: currentRow.m, value: currentRow.actualRev }
    : null

  const forecastPoints = monthly.filter((m: any) => m.isFuture && m.value > 0).map((m: any) => ({ x: xAt(m.m - 1), y: yAt(m.value), tone: m.tone, m: m.m, value: m.value, actual: false }))

  const actualPath = actualPoints.length >= 2
    ? actualPoints.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
    : ''
  const forecastPath = forecastPoints.length >= 2
    ? forecastPoints.map((p: any, i: number) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
    : ''

  // Connect last-completed actual → first forecast (dashed).  If the
  // current month is in progress we still connect from its hollow point,
  // so the eye has one continuous dashed trail from the last solid dot
  // through "in progress" to the forecast.
  const lastActual = actualPoints[actualPoints.length - 1] ?? null
  const firstForecast = forecastPoints[0] ?? null
  const connectPath = (() => {
    const anchors: Array<{ x: number; y: number }> = []
    if (lastActual)        anchors.push(lastActual)
    if (currentInProgress) anchors.push(currentInProgress)
    if (firstForecast)     anchors.push(firstForecast)
    if (anchors.length < 2) return ''
    return anchors.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  })()

  // Today line — sits inside current month's cell at month-progress %
  const todayX = xAt(currentMonth - 1) - (plotW / 12) / 2 + (plotW / 12) * todayProgress

  // Y-axis ticks
  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => ({ v: yMax * f, y: yAt(yMax * f) }))

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      width="100%"
      height={H}
      role="img"
      aria-label="Full-year revenue forecast — actual solid navy, forecast dashed indigo"
      style={{ display: 'block' as const }}
    >
      {/* Forecast band */}
      <rect
        x={xAt(currentMonth - 1) - (plotW / 12) / 2}
        y={PT}
        width={(W - PR) - (xAt(currentMonth - 1) - (plotW / 12) / 2)}
        height={plotH}
        fill={UX.indigoBg}
        opacity={0.5}
      />

      {/* Gridlines */}
      {ticks.map(t => (
        <g key={t.v}>
          <line x1={PL} x2={W - PR} y1={t.y} y2={t.y} stroke={UX.borderSoft} strokeWidth={0.5} />
          <text x={PL - 6} y={t.y + 3} textAnchor="end" fontSize={UX.fsNano} fill={UX.ink4}>
            {t.v === 0 ? '0' : formatKShort(t.v)}
          </text>
        </g>
      ))}

      {/* Today marker */}
      <line x1={todayX} x2={todayX} y1={PT} y2={H - PB} stroke={UX.ink3} strokeWidth={0.8} strokeDasharray="2 2" />
      <text x={todayX} y={PT - 2} textAnchor="middle" fontSize={UX.fsNano} fill={UX.ink3}>today</text>

      {/* Actual line */}
      {actualPath && (
        <path d={actualPath} stroke={UX.navy} strokeWidth={2} fill="none" strokeLinejoin="round" />
      )}
      {/* Connector */}
      {connectPath && (
        <path d={connectPath} stroke={UX.indigo} strokeWidth={2} strokeDasharray="4 3" fill="none" />
      )}
      {/* Forecast line */}
      {forecastPath && (
        <path d={forecastPath} stroke={UX.indigo} strokeWidth={2} strokeDasharray="4 3" fill="none" strokeLinejoin="round" />
      )}

      {/* Dots — tone-coloured per FORECAST-FIX § 6 (green ≥ forecast,
          amber within 10% under, red > 10% under; navy default). */}
      {[...actualPoints, ...forecastPoints].map((p: any) => (
        <circle
          key={`${p.actual ? 'a' : 'f'}-${p.m}`}
          cx={p.x}
          cy={p.y}
          r={2.6}
          fill={
            p.tone === 'bad'     ? UX.redInk :
            p.tone === 'warning' ? UX.amberInk :
            p.tone === 'good'    ? UX.greenInk :
            p.actual             ? UX.navy : UX.indigo
          }
        />
      ))}

      {/* Current month — hollow ring + tiny "(in progress)" label so the
          part-month actual isn't misread as "Apr collapsed". */}
      {currentInProgress && (
        <g>
          <circle
            cx={currentInProgress.x}
            cy={currentInProgress.y}
            r={4}
            fill="white"
            stroke={UX.navy}
            strokeWidth={1.4}
          />
          <text
            x={currentInProgress.x}
            y={currentInProgress.y - 8}
            textAnchor="middle"
            fontSize={UX.fsNano}
            fill={UX.ink3}
          >
            in progress
          </text>
        </g>
      )}

      {/* Month labels */}
      {monthly.map((m: any, i: number) => (
        <text
          key={m.m}
          x={xAt(i)}
          y={H - PB + 14}
          textAnchor="middle"
          fontSize={UX.fsNano}
          fill={m.isCurrent ? UX.ink1 : UX.ink4}
          fontWeight={m.isCurrent ? UX.fwMedium : UX.fwRegular}
        >
          {MONTHS_SHORT[m.m - 1]}
        </text>
      ))}

      {/* Loading overlay */}
      {loading && (
        <text x={W / 2} y={H / 2} textAnchor="middle" fill={UX.ink4} fontSize={UX.fsBody}>{t('loadingChart')}</text>
      )}
    </svg>
  )
}

function formatKShort(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1_000)     return `${Math.round(n / 100) / 10}k`
  return String(n)
}
