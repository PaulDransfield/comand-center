'use client'
// @ts-nocheck
// app/forecast/page.tsx — full rebuild on the new system
//
// Same treatment as the other rebuilds. Every surface lives on UXP +
// KpiCardUX / PairedBarChart / BreakdownTable. The legacy PageHero /
// StatusPill / AttentionPanel / Sparkline / TopBar / inline year line
// chart are gone.
//
// Data unchanged:
//   GET /api/forecast?business_id           — { forecasts, actuals, pk_forecasts }
//   POST /api/sync                          — refresh trigger
//
// The page is month-level resolution; "next month" / "year projection"
// / "weak spot" are the meaningful surfaces. The dashboard handles
// day-level forecasts via /api/scheduling/ai-suggestion separately.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import KpiCardUX from '@/components/ux/KpiCard'
import PairedBarChart from '@/components/ux/PairedBarChart'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const MONTHS_FULL  = ['January','February','March','April','May','June','July','August','September','October','November','December']

export default function ForecastPage() {
  const now          = new Date()
  const [year,       setYear]       = useState(now.getFullYear())
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [data,       setData]       = useState<any>(null)
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState('')
  const [syncing,    setSyncing]    = useState(false)
  // A2.9 — accuracy badge data from daily_forecast_outcomes (far more
  // signal than the local monthly MAPE because we get 180+ daily rows
  // over 6 months vs 6 monthly pairs). Click toggles the drilldown panel.
  const [accuracy,   setAccuracy]   = useState<any>(null)
  const [accuracyOpen, setAccuracyOpen] = useState(false)

  // Subscribe to BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // Load forecasts
  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/forecast?business_id=${bizId}`)
      if (res.ok) setData(await res.json())
      else setError(`HTTP ${res.status}`)
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }, [bizId])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  // A2.9 — fetch the accuracy summary in parallel. Best-effort.
  useEffect(() => {
    if (!bizId) { setAccuracy(null); return }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/forecast/accuracy?business_id=${bizId}&months=6`, { cache: 'no-store' })
        if (!r.ok) return
        const j = await r.json()
        if (!cancelled && !j.error) setAccuracy(j)
      } catch { /* ignore */ }
    })()
    return () => { cancelled = true }
  }, [bizId])

  async function refresh() {
    setSyncing(true)
    await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: 'personalkollen' }) })
    await load()
    setSyncing(false)
  }

  // ── Shape 12 months ────────────────────────────────────────────
  const monthly = useMemo(() => {
    const forecasts = data?.forecasts ?? []
    const actuals   = data?.actuals   ?? []
    const currentMonth = now.getMonth() + 1
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1
      const f = forecasts.find((r: any) => r.period_year === year && r.period_month === m)
      const a = actuals.find((r: any)   => r.period_year === year && r.period_month === m)
      const isPast    = year < now.getFullYear() || (year === now.getFullYear() && m < currentMonth)
      const isCurrent = year === now.getFullYear() && m === currentMonth
      const isFuture  = !isPast && !isCurrent
      const actualRev   = a ? Number(a.revenue ?? 0) : 0
      const forecastRev = f ? Number(f.revenue_forecast ?? 0) : 0
      const value = isFuture ? forecastRev : (actualRev > 0 ? actualRev : forecastRev)
      let tone: 'good' | 'bad' | 'warning' | 'neutral' = 'neutral'
      if (isPast && actualRev > 0 && forecastRev > 0) {
        const pct = (actualRev - forecastRev) / forecastRev
        tone = pct >= 0 ? 'good' : pct <= -0.10 ? 'bad' : 'warning'
      }
      return {
        m, f, a,
        isPast, isCurrent, isFuture,
        actualRev, forecastRev,
        value, tone,
        margin:         a?.margin_pct      != null ? Number(a.margin_pct)      : null,
        marginForecast: f?.margin_forecast != null ? Number(f.margin_forecast) : null,
      }
    })
  }, [data, year])

  // ── Year-level derived numbers ────────────────────────────────
  const actualMonths = monthly.filter(r => r.actualRev > 0).length
  const forecastCount = (data?.forecasts ?? [])
    .filter((r: any) => r.period_year === year && (r.period_month >= (year === now.getFullYear() ? now.getMonth() + 1 : 1)))
    .length
  const hasProjection = forecastCount > 0 && actualMonths > 0
  const ytdActualProfit = (data?.actuals ?? [])
    .filter((r: any) => r.period_year === year)
    .reduce((s: number, r: any) => s + Number(r.net_profit ?? 0), 0)
  const projectedFullYear = hasProjection
    ? monthly.reduce((s, r) => s + (r.isFuture ? r.forecastRev : Math.max(r.actualRev, r.forecastRev)), 0)
    : null
  const projectedMarginPct = (() => {
    if (!hasProjection) return null
    let rev = 0, profit = 0
    for (const r of monthly) {
      if (r.isPast || r.isCurrent) {
        const revV = Math.max(r.actualRev, r.forecastRev)
        rev += revV
        profit += Number(r.a?.net_profit ?? 0)
      } else {
        rev += r.forecastRev
        const mpct = r.marginForecast
        profit += mpct != null ? (r.forecastRev * mpct / 100) : 0
      }
    }
    return rev > 0 ? (profit / rev) * 100 : null
  })()

  const forecastMargins = monthly
    .filter(r => (r.isFuture || r.isCurrent) && r.marginForecast != null)
    .map(r => r.marginForecast!)
  const avgForecastMargin = forecastMargins.length
    ? forecastMargins.reduce((s, v) => s + v, 0) / forecastMargins.length
    : null

  // Next forecast month (current → next future), and weakest forecast month
  const nextMonth = monthly.find(r => r.isCurrent) ?? monthly.find(r => r.isFuture)
  const weakFuture = monthly
    .filter(r => r.isFuture && r.marginForecast != null)
    .sort((a, b) => (a.marginForecast ?? 1e9) - (b.marginForecast ?? 1e9))[0]

  // ── MAPE / confidence (rough — based on past months) ──────────
  const mape = (() => {
    const pairs = monthly.filter(r => r.isPast && r.actualRev > 0 && r.forecastRev > 0)
    if (pairs.length === 0) return null
    const sumErr = pairs.reduce((s, r) => s + Math.abs((r.actualRev - r.forecastRev) / r.forecastRev), 0)
    return (sumErr / pairs.length) * 100
  })()
  const confidence = mape == null ? null
    : mape <= 5  ? 'high'
    : mape <= 12 ? 'medium'
    :              'low'

  // ── Flags ──────────────────────────────────────────────────────
  interface Flag { tone: 'good' | 'warning' | 'bad'; entity: string; message: string }
  const flags: Flag[] = []
  for (const r of monthly) {
    // Past month that missed forecast > 15%
    if (!r.isFuture && r.actualRev > 0 && r.forecastRev > 0) {
      const pct = ((r.actualRev - r.forecastRev) / r.forecastRev) * 100
      if (pct <= -15) {
        flags.push({
          tone: 'bad',
          entity: MONTHS_SHORT[r.m - 1],
          message: `Missed forecast by ${fmtPct(Math.abs(pct))} — actual ${fmtKr(r.actualRev)} vs forecast ${fmtKr(r.forecastRev)}.`,
        })
      }
    }
    // Future month with margin > 10pp below year average (or below 12% absolute)
    if (r.isFuture && r.marginForecast != null) {
      const belowAvg = avgForecastMargin != null && r.marginForecast <= avgForecastMargin - 10
      const belowAbs = r.marginForecast < 12
      if (belowAvg || belowAbs) {
        flags.push({
          tone: r.marginForecast < 5 ? 'bad' : 'warning',
          entity: MONTHS_SHORT[r.m - 1],
          message: `Forecast margin ${fmtPct(r.marginForecast)} — below typical for the year.`,
        })
      }
    }
  }

  // ── Year nav ──────────────────────────────────────────────────
  const canStepNext = year < now.getFullYear() + 1
  function step(dir: -1 | 1) { setYear(y => y + dir) }

  return (
    <AppShell
      dateLabel={String(year)}
      onPrev={() => step(-1)}
      onNext={canStepNext ? () => step(1) : undefined}
    >
      <PageContainer style={{ display: 'grid', gap: 14 }}>

        {/* Header — accuracy badge + confidence pill + refresh */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, flexWrap: 'wrap' as const }}>
          {accuracy?.overall && (
            <AccuracyBadge
              accuracy={accuracy}
              open={accuracyOpen}
              onClick={() => setAccuracyOpen(o => !o)}
            />
          )}
          {confidence && mape != null && <ConfidenceChip confidence={confidence} mape={mape} />}
          <button
            type="button"
            onClick={refresh}
            disabled={syncing || !bizId}
            aria-label="Refresh forecast"
            title={syncing ? 'Refreshing…' : 'Refresh forecast'}
            style={{
              width:          28,
              height:         28,
              borderRadius:   '50%',
              background:     UXP.cardBg,
              border:         `0.5px solid ${UXP.border}`,
              color:          UXP.ink3,
              cursor:         syncing || !bizId ? 'not-allowed' : 'pointer',
              opacity:        syncing || !bizId ? 0.5 : 1,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
              fontSize:       14,
              padding:        0,
            }}
          >
            <span className={syncing ? 'cc-fc-spin' : undefined} style={{ display: 'inline-block', lineHeight: 1 }}>↻</span>
          </button>
          <style>{`
            @keyframes cc-fc-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
            .cc-fc-spin { animation: cc-fc-spin 1s linear infinite; }
          `}</style>
        </div>

        {error && (
          <Banner tone="bad" text={error} />
        )}

        {/* KPI strip */}
        <KpiStrip
          year={year}
          projectedFullYear={projectedFullYear}
          actualMonths={actualMonths}
          hasProjection={hasProjection}
          ytdActualProfit={ytdActualProfit}
          currentMonthIdx={now.getMonth() + 1}
          nextMonth={nextMonth}
          avgForecastMargin={avgForecastMargin}
          projectedMarginPct={projectedMarginPct}
        />

        {/* Year chart */}
        <YearChart monthly={monthly} loading={loading} />

        {/* Accuracy drilldown (A2.9) — expand-on-badge-click */}
        {accuracyOpen && accuracy && (
          <AccuracyPanel accuracy={accuracy} onClose={() => setAccuracyOpen(false)} />
        )}

        {/* Monthly breakdown */}
        <MonthlyBreakdown
          monthly={monthly}
          totalActual={monthly.reduce((s, r) => s + r.actualRev, 0)}
          totalForecast={monthly.reduce((s, r) => s + r.forecastRev, 0)}
          projectedFullYear={projectedFullYear}
        />

        {/* Flags */}
        {flags.length > 0 && (
          <FlagsCard flags={flags} />
        )}
      </PageContainer>

      <AskAI
        page="forecast"
        context={data ? [
          `Year ${year} forecast view`,
          hasProjection
            ? `Projected ${fmtKr(projectedFullYear!)}; projected margin ${projectedMarginPct != null ? fmtPct(projectedMarginPct) : '—'}.`
            : `Not enough actuals yet (${actualMonths} closed) for a year projection.`,
          confidence ? `Model confidence: ${confidence} (MAPE ${mape!.toFixed(1)}%).` : null,
          weakFuture ? `Weakest forecast month: ${MONTHS_SHORT[weakFuture.m - 1]} at ${fmtPct(weakFuture.marginForecast!)}.` : null,
        ].filter(Boolean).join('\n') : 'No forecast data'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

// ── AccuracyBadge (A2.9) ─────────────────────────────────────────────
// Headline pill: "Last 6 months: X% accurate". Tone follows the same
// green / coral / rose scale used elsewhere. Click toggles the
// AccuracyPanel below the chart.
function AccuracyBadge({
  accuracy, open, onClick,
}: {
  accuracy: any
  open:     boolean
  onClick:  () => void
}) {
  const score = accuracy?.overall?.accuracy_pct ?? null
  const n     = accuracy?.n_observations ?? 0
  const months = accuracy?.months ?? 6
  const tone =
    score == null    ? UXP.ink3
    : score >= 85    ? UXP.green
    : score >= 70    ? UXP.coral
    :                  UXP.rose
  const toneBg =
    score == null    ? UXP.subtleBg
    : score >= 85    ? UXP.greenFill
    : score >= 70    ? UXP.lavFill
    :                  UXP.roseFill
  return (
    <button
      onClick={onClick}
      title={`Click to see the per-layer accuracy breakdown — based on ${n} resolved daily forecasts over the last ${months} months.`}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            8,
        padding:        '4px 12px',
        background:     toneBg,
        color:          tone,
        border:         `0.5px solid ${tone}33`,
        borderRadius:   999,
        fontSize:       10,
        fontWeight:     500,
        letterSpacing:  '0.02em',
        cursor:         'pointer',
      }}
    >
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: tone }} />
      Last {months}m {score != null ? `${score}%` : '—'} accurate
      <span style={{ fontSize: 9, color: tone, opacity: 0.7 }}>{open ? '▴' : '▾'}</span>
    </button>
  )
}

// ── AccuracyPanel (A2.9 drilldown) ───────────────────────────────────
// Expands below the chart when the badge is clicked. Per-surface
// breakdown + per-horizon bucket. Read-only.
function AccuracyPanel({ accuracy, onClose }: { accuracy: any; onClose: () => void }) {
  const SURFACE_LABELS: Record<string, string> = {
    consolidated_daily:    'Consolidated daily',
    llm_adjusted:          'LLM adjusted',
    scheduling_ai_revenue: 'Scheduling AI',
    weather_demand:        'Weather demand',
  }
  const surfaces = Object.entries(accuracy?.by_surface ?? {}) as Array<[string, any]>
  const horizons = Object.entries(accuracy?.by_horizon ?? {}) as Array<[string, any]>
  const tone = (acc: number) =>
      acc >= 85 ? UXP.green
    : acc >= 70 ? UXP.coral
    :             UXP.rose

  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '16px 18px',
      boxShadow:     UXP.shadowCard,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Accuracy breakdown</div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            {accuracy.n_observations} resolved forecasts · {accuracy.months}-month window
          </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          width: 22, height: 22, border: 'none', background: 'transparent',
          color: UXP.ink3, fontSize: 14, cursor: 'pointer',
        }}>×</button>
      </div>

      {/* By surface */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
          By forecast layer
        </div>
        {surfaces.length === 0 ? (
          <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>No per-layer data yet.</div>
        ) : (
          <div style={{ display: 'grid', gap: 0 }}>
            {surfaces.map(([key, v]: any, idx) => (
              <div key={key} style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto auto',
                gap: 12,
                padding: '8px 0',
                borderBottom: idx < surfaces.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
                alignItems: 'baseline',
              }}>
                <div style={{ fontSize: 11, color: UXP.ink1 }}>
                  {SURFACE_LABELS[key] ?? key}
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const }}>
                  n {v.n}
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const, minWidth: 70, textAlign: 'right' as const }}>
                  bias {v.bias_pct >= 0 ? '+' : ''}{v.bias_pct.toFixed(1)}%
                </div>
                <div style={{
                  fontSize: 11,
                  color: tone(v.accuracy_pct),
                  fontWeight: 500,
                  fontVariantNumeric: 'tabular-nums' as const,
                  minWidth: 56,
                  textAlign: 'right' as const,
                }}>
                  {v.accuracy_pct.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* By horizon */}
      <div>
        <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
          By prediction horizon
        </div>
        {horizons.length === 0 ? (
          <div style={{ fontSize: 11, color: UXP.ink4, padding: '8px 0' }}>—</div>
        ) : (
          <div style={{ display: 'grid', gap: 0 }}>
            {horizons.map(([key, v]: any, idx) => (
              <div key={key} style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto auto auto',
                gap: 12,
                padding: '8px 0',
                borderBottom: idx < horizons.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
                alignItems: 'baseline',
              }}>
                <div style={{ fontSize: 11, color: UXP.ink1 }}>
                  {key === '0' ? 'Same day'
                    : key === '1-3' ? '1-3 days out'
                    : key === '4-7' ? '4-7 days out'
                    : '8+ days out'}
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const }}>
                  n {v.n}
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, fontVariantNumeric: 'tabular-nums' as const, minWidth: 70, textAlign: 'right' as const }}>
                  bias {v.bias_pct >= 0 ? '+' : ''}{v.bias_pct.toFixed(1)}%
                </div>
                <div style={{
                  fontSize: 11,
                  color: tone(v.accuracy_pct),
                  fontWeight: 500,
                  fontVariantNumeric: 'tabular-nums' as const,
                  minWidth: 56,
                  textAlign: 'right' as const,
                }}>
                  {v.accuracy_pct.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 14, lineHeight: 1.5 }}>
        Accuracy = 100 − MAPE (mean absolute percentage error). Bias is the average signed error: positive = we tend to overshoot, negative = we tend to undershoot. n = resolved daily predictions in this group.
      </div>
    </div>
  )
}

function ConfidenceChip({ confidence, mape }: { confidence: 'high' | 'medium' | 'low'; mape: number }) {
  const palette = {
    high:   { bg: UXP.greenFill, fg: UXP.greenDeep, dot: UXP.green },
    medium: { bg: UXP.lavFill,   fg: UXP.lavText,   dot: UXP.coral },
    low:    { bg: UXP.roseFill,  fg: UXP.roseText,  dot: UXP.rose  },
  }[confidence]
  return (
    <span style={{
      display:        'inline-flex',
      alignItems:     'center',
      gap:            6,
      padding:        '4px 10px',
      background:     palette.bg,
      color:          palette.fg,
      borderRadius:   999,
      fontSize:       10,
      fontWeight:     500,
      letterSpacing:  '0.02em',
    }}>
      <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: palette.dot }} />
      Model {confidence} confidence · MAPE {mape.toFixed(1)}%
    </span>
  )
}

function KpiStrip({
  year, projectedFullYear, actualMonths, hasProjection,
  ytdActualProfit, currentMonthIdx, nextMonth, avgForecastMargin, projectedMarginPct,
}: any) {
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title={`Projected ${year}`}
        value={projectedFullYear != null ? fmtKr(projectedFullYear) : '—'}
        microLabel={hasProjection
          ? `${actualMonths} month${actualMonths === 1 ? '' : 's'} closed`
          : 'Not enough actuals yet'}
      />
      <KpiCardUX
        title="YTD net profit"
        value={fmtKr(ytdActualProfit)}
        deltaGood
        delta={ytdActualProfit >= 0 ? '+' : '−'}
        microLabel={`${currentMonthIdx - 1} closed months`}
      />
      <KpiCardUX
        title={nextMonth?.isCurrent ? 'This month forecast' : 'Next month forecast'}
        value={nextMonth?.forecastRev ? fmtKr(nextMonth.forecastRev) : '—'}
        variant={nextMonth?.marginForecast != null && avgForecastMargin != null ? 'stacked' : 'plain'}
        stackedBars={nextMonth?.marginForecast != null && avgForecastMargin != null ? [
          { label: 'This month', value: nextMonth.marginForecast, max: 100, color: UXP.lav   },
          { label: 'Year avg',   value: avgForecastMargin,        max: 100, color: UXP.lavMid },
        ] : undefined}
        microLabel={nextMonth ? MONTHS_SHORT[nextMonth.m - 1] : ''}
      />
      <KpiCardUX
        title="Projected margin"
        value={projectedMarginPct != null ? fmtPct(projectedMarginPct) : '—'}
        variant="targetBand"
        targetBand={projectedMarginPct != null ? {
          actualPct:    Math.max(0, Math.min(100, projectedMarginPct)),
          targetMinPct: 5,
          targetMaxPct: 15,
        } : undefined}
        microLabel="Target 5-15%"
      />
    </div>
  )
}

// ── Year chart ──────────────────────────────────────────────────────
function YearChart({ monthly, loading }: { monthly: any[]; loading: boolean }) {
  return (
    <Card title="Year at a glance" subtitle="Actuals + forecast · margin overlay">
      {loading ? (
        <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>
      ) : (
        <div>
          <PairedBarChart
            groups={monthly.map(r => MONTHS_SHORT[r.m - 1])}
            series={[
              { label: 'Actual',   data: monthly.map(r => r.actualRev),   color: UXP.lav    },
              { label: 'Forecast', data: monthly.map(r => r.isFuture ? r.forecastRev : 0), color: UXP.lavPale },
            ]}
            lines={[{
              label:  'Margin %',
              data:   monthly.map(r => {
                if (r.isFuture) return r.marginForecast ?? null
                return r.margin ?? r.marginForecast ?? null
              }),
              color:  UXP.coral,
              dashed: false,
            }]}
            width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}
            height={260}
          />
          {/* "Idag" divider note — points at the current month index */}
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 6 }}>
            Solid bars = actuals (Jan → current month) · Pale bars = forecast (current → Dec)
          </div>
        </div>
      )}
    </Card>
  )
}

// ── Monthly BreakdownTable ──────────────────────────────────────────
function MonthlyBreakdown({ monthly, totalActual, totalForecast, projectedFullYear }: any) {
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>Monthly forecast</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          Actual vs forecast per month
        </div>
      </div>
      <BreakdownTable
        columns={[
          { key: 'month', header: 'Month', align: 'left', render: (r: any) => (
            <span style={{
              display:     'inline-flex',
              alignItems:  'center',
              gap:         8,
              color:       UXP.ink1,
              fontWeight:  500,
            }}>
              {MONTHS_FULL[r.m - 1]}
              {r.isCurrent && <Status tone="lav">Now</Status>}
              {r.isFuture  && <Status tone="neutral">Future</Status>}
            </span>
          ) },
          { key: 'actual', header: 'Actual', align: 'right', render: (r: any) =>
            r.actualRev > 0 ? fmtKr(r.actualRev) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'forecast', header: 'Forecast', align: 'right', render: (r: any) =>
            r.forecastRev > 0 ? fmtKr(r.forecastRev) : <span style={{ color: UXP.ink4 }}>—</span>
          },
          { key: 'delta', header: 'Δ vs forecast', align: 'right', render: (r: any) => {
            if (!(r.actualRev > 0 && r.forecastRev > 0)) return <span style={{ color: UXP.ink4 }}>—</span>
            const pct = ((r.actualRev - r.forecastRev) / r.forecastRev) * 100
            return <DeltaChip value={`${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`} positiveIsGood />
          } },
          { key: 'margin', header: 'Margin', align: 'right', render: (r: any) => {
            const m = r.isFuture ? r.marginForecast : (r.margin ?? r.marginForecast)
            return m != null ? fmtPct(m) : <span style={{ color: UXP.ink4 }}>—</span>
          } },
          { key: 'tone', header: 'Status', align: 'right', render: (r: any) => {
            if (r.isFuture) return <Status tone="lav">Forecast</Status>
            if (r.tone === 'good')    return <Status tone="good">Beat</Status>
            if (r.tone === 'bad')     return <Status tone="bad">Missed</Status>
            if (r.tone === 'warning') return <Status tone="warning">Under</Status>
            return <Status tone="neutral">—</Status>
          } },
        ]}
        sections={[{ rows: monthly }]}
        footer={{
          label: 'Year',
          cells: {
            actual:    fmtKr(totalActual),
            forecast:  fmtKr(totalForecast),
            delta:     '',
            margin:    '',
            tone:      projectedFullYear != null ? fmtKr(projectedFullYear) : '',
          },
        }}
        rowKey={(row: any) => String(row.m)}
      />
    </div>
  )
}

function Status({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'warning' | 'lav' | 'neutral' }) {
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
    warning: { bg: UXP.lavFill,   fg: UXP.coral     },
    lav:     { bg: UXP.lavFill,   fg: UXP.lavText   },
    neutral: { bg: UXP.subtleBg,  fg: UXP.ink4      },
  }[tone]
  return (
    <span style={{
      display:        'inline-block',
      fontSize:       9,
      padding:        '2px 7px',
      borderRadius:   6,
      background:     palette.bg,
      color:          palette.fg,
      fontWeight:     500,
      letterSpacing:  '0.02em',
    }}>{children}</span>
  )
}

// ── Flags card ──────────────────────────────────────────────────────
function FlagsCard({ flags }: { flags: any[] }) {
  return (
    <Card title="Forecast flags" subtitle={`${flags.length} attention item${flags.length === 1 ? '' : 's'}`}>
      <div style={{ display: 'grid', gap: 0 }}>
        {flags.map((f: any, idx: number) => {
          const palette: { bar: string; fg: string } = (({
            good:    { bar: UXP.green, fg: UXP.greenDeep },
            bad:     { bar: UXP.rose,  fg: UXP.roseText  },
            warning: { bar: UXP.coral, fg: UXP.coral     },
          } as Record<string, { bar: string; fg: string }>)[f.tone] ?? { bar: UXP.coral, fg: UXP.coral })
          return (
            <div key={idx} style={{
              display:             'grid',
              gridTemplateColumns: '4px auto 1fr',
              gap:                 12,
              alignItems:          'center',
              padding:             '10px 0',
              borderBottom:        idx < flags.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
            }}>
              <span style={{ width: 4, height: '100%', minHeight: 24, background: palette.bar, borderRadius: 2 }} />
              <span style={{
                fontSize:      9,
                fontWeight:    600,
                letterSpacing: '0.04em',
                color:         palette.fg,
                textTransform: 'uppercase' as const,
                minWidth:      36,
              }}>{f.entity}</span>
              <span style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.4 }}>{f.message}</span>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

// ── Atoms ──────────────────────────────────────────────────────────
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

function Banner({ tone, text }: { tone: 'bad' | 'good'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: UXP.roseFill,  border: UXP.rose,  fg: UXP.roseText  }
    : { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep }
  return (
    <div style={{
      background:    palette.bg,
      border:        `0.5px solid ${palette.border}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         palette.fg,
    }}>
      {text}
    </div>
  )
}
