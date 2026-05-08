'use client'
// components/dashboard/DemandOutlook.tsx
//
// Replaces WeatherDemandWidget on the redesigned /dashboard. Same data
// source (`/api/weather/demand-forecast`) — visual restructure only.
// Renders a 7-day grid of day-cards combining weather, holidays and
// AI sales pattern. Holiday days get an amber background + corner H
// badge. Today gets a white-paper background. Peak/dip days get
// green/red backgrounds based on `delta_pct`.
//
// Hidden when:
//   - No bizId
//   - Endpoint returns < 1 day (business has no correlation history yet)
//
// Per the redesign prompt: data shapes are unchanged. The headline copy
// adapts to whether the week has a holiday and whether any peak/dip
// days exist.

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface DemandDay {
  date:                string
  weekday:             string
  weather: {
    summary:           string
    temp_min:          number
    temp_max:          number
    precip_mm:         number
    wind_max:          number
    weather_code:      number
    bucket:            string
  }
  is_holiday:          boolean
  holiday_name:        string | null
  baseline_revenue:    number
  predicted_revenue:   number
  delta_pct:           number
  confidence:          'high' | 'medium' | 'low' | 'unavailable'
  sample_size:         number
  recommendation:      string | null
}

interface DemandForecast {
  business_id:    string
  business_name:  string
  generated_at:   string
  baseline_window: { from_date: string; to_date: string; weeks: number }
  correlation:    { sample_days: number; overall_avg_rev: number }
  days:           DemandDay[]
}

const BUCKET_ICON: Record<string, string> = {
  clear:    '☀',
  mild:     '🌤',
  cold_dry: '🌬',
  wet:      '🌧',
  snow:     '❄',
  freezing: '🥶',
  hot:      '🔥',
  thunder:  '⛈',
}

// Per-day cut-hours pulled from the scheduling forecast (same `aiSched`
// the labour scheduling card already loads at the page level). Optional
// — when omitted, day cards just won't show the "−Xh cut" flag.
export interface CutHoursByDate { [date: string]: number }

interface Props {
  bizId:           string | null
  // Optional: per-date scheduling delta from `/api/scheduling/ai-suggestion`.
  // Negative = hours that can be cut. The page passes this in so we don't
  // re-fetch the same endpoint at component scope.
  cutHoursByDate?: CutHoursByDate
}

export default function DemandOutlook({ bizId, cutHoursByDate }: Props) {
  const t = useTranslations('dashboard.outlook')
  const [data,    setData]    = useState<DemandForecast | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!bizId) { setData(null); return }
    let cancelled = false
    setLoading(true); setError(null)
    fetch(`/api/weather/demand-forecast?business_id=${bizId}&days=7`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then((j: DemandForecast) => { if (!cancelled) { setData(j); setLoading(false) } })
      .catch(async (e) => {
        if (cancelled) return
        setLoading(false)
        try { const body = await (e as Response).json?.(); setError(body?.error ?? 'unknown') }
        catch { setError('unknown') }
      })
    return () => { cancelled = true }
  }, [bizId])

  // ALL hooks must run unconditionally before any early-return. Past
  // bug (2026-05-08, SupplierPriceChart): a useMemo placed after the
  // loading/empty branches changed the hook count between renders and
  // React threw "Rendered more hooks than during the previous render."
  // Hoist BEFORE the conditional returns.
  const days  = data?.days ?? []
  const today = new Date().toISOString().slice(0, 10)
  const totalForecast = useMemo(
    () => days.reduce((s, d) => s + Number(d.predicted_revenue ?? 0), 0),
    [days],
  )
  const avgBaseline = useMemo(
    () => days.length ? days.reduce((s, d) => s + Number(d.baseline_revenue ?? 0), 0) : 0,
    [days],
  )

  if (!bizId) return null

  // Hide entirely when there's no usable forecast — same behaviour as the
  // legacy WeatherDemandWidget. No empty-state clutter.
  if (!loading && (!data || data.days.length === 0)) return null

  // "+X% vs typical week" — comparing forecast to baseline-summed week.
  // Both are 7-day windows so the comparison is apples-to-apples.
  const totalDelta = avgBaseline > 0 ? Math.round(((totalForecast - avgBaseline) / avgBaseline) * 100) : null

  const headline = buildHeadline(days, t)

  return (
    <div style={cardStyle}>
      <div style={headStyle}>
        <div style={{ minWidth: 0 }}>
          <div style={eyebrowStyle}>{t('eyebrow')}</div>
          <h2 style={titleStyle}>{headline}</h2>
          <div style={subStyle}>{t('confidenceLine', {
            samples: data?.correlation?.sample_days ?? 0,
            weeks:   data?.baseline_window?.weeks ?? 0,
          })}</div>
        </div>
        <div style={summaryStyle}>
          <div style={{ color: UX.ink3 }}>{t('totalLabel')}</div>
          <div style={{ ...summaryNumStyle, color: totalDelta != null && totalDelta >= 0 ? UX.greenInk : UX.ink1 }}>
            {fmtKr(totalForecast)}
          </div>
          {totalDelta != null && (
            <div style={{ marginTop: 4, color: UX.ink4, fontSize: 11 }}>
              {t('vsTypical')} ·{' '}
              <span style={{
                color:     totalDelta >= 0 ? UX.greenInk : UX.redInk,
                fontWeight:600,
                fontSize:  12,
              }}>
                {totalDelta >= 0 ? '+' : ''}{totalDelta}%
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="cc-outlook-grid" style={gridStyle}>
        {days.map(d => (
          <DayCard
            key={d.date}
            day={d}
            isToday={d.date === today}
            cutHours={cutHoursByDate?.[d.date]}
          />
        ))}
      </div>

      <style>{`
        @media (max-width: 1100px) {
          .cc-outlook-grid { grid-template-columns: repeat(4, 1fr) !important; }
        }
        @media (max-width: 880px) {
          .cc-outlook-grid { grid-template-columns: repeat(2, 1fr) !important; }
        }
      `}</style>
    </div>
  )
}

function buildHeadline(days: DemandDay[], t: ReturnType<typeof useTranslations>): React.ReactNode {
  const holiday = days.find(d => d.is_holiday)
  const peak    = days.filter(d => !d.is_holiday).reduce<DemandDay | null>((best, d) =>
    !best || (d.delta_pct ?? 0) > (best.delta_pct ?? 0) ? d : best, null)
  const dip     = days.filter(d => !d.is_holiday).reduce<DemandDay | null>((worst, d) =>
    !worst || (d.delta_pct ?? 0) < (worst.delta_pct ?? 0) ? d : worst, null)

  // Fallback when nothing stands out — keep it simple.
  if (!holiday && (!peak || (peak.delta_pct ?? 0) < 10) && (!dip || (dip.delta_pct ?? 0) > -10)) {
    return t('headlineSteady')
  }

  const parts: React.ReactNode[] = []
  if (peak && (peak.delta_pct ?? 0) >= 10) {
    parts.push(<span key="p" style={{ color: UX.greenInk }}>{t('headlinePeak', { day: peak.weekday })}</span>)
  }
  if (holiday) {
    parts.push(<span key="h" style={{ color: UX.amberInk }}>{t('headlineHoliday', { day: holiday.weekday })}</span>)
  }
  if (dip && (dip.delta_pct ?? 0) <= -10) {
    parts.push(<span key="d" style={{ color: UX.redInk }}>{t('headlineDip', { day: dip.weekday })}</span>)
  }

  return parts.flatMap((p, i) =>
    i === 0 ? [p] : [<span key={`s${i}`} style={{ color: UX.ink2 }}>, </span>, p],
  )
}

// ─── Day card ────────────────────────────────────────────────────────────────

function DayCard({ day, isToday, cutHours }: { day: DemandDay; isToday: boolean; cutHours?: number }) {
  const t = useTranslations('dashboard.outlook')
  const icon = BUCKET_ICON[day.weather.bucket] ?? '⛅'
  const dateLabel = new Date(day.date + 'T12:00:00').getDate()

  // Tier classification → background color
  let tier: 'normal' | 'today' | 'holiday' | 'peak' | 'dip' = 'normal'
  if (day.is_holiday) tier = 'holiday'
  else if ((day.delta_pct ?? 0) >= 15) tier = 'peak'
  else if ((day.delta_pct ?? 0) <= -15) tier = 'dip'
  if (isToday) tier = 'today'  // today wins over peak/dip but NOT over holiday — handled below

  // Holiday + today both apply: keep holiday styling, add today's border emphasis.
  const isHolidayToday = day.is_holiday && isToday

  const palette = (() => {
    if (isHolidayToday)        return { bg: UX.amberSoft, border: UX.amberBorder, emphasis: true }
    if (tier === 'today')      return { bg: 'white',      border: UX.ink1,        emphasis: true }
    if (tier === 'holiday')    return { bg: UX.amberSoft, border: UX.amberBorder, emphasis: false }
    if (tier === 'peak')       return { bg: UX.greenBg,   border: UX.greenBorder, emphasis: false }
    if (tier === 'dip')        return { bg: UX.redSoft,   border: UX.redBorder,   emphasis: false }
    return                          { bg: UX.subtleBg,    border: UX.borderSoft,  emphasis: false }
  })()

  const revToneColor =
    day.is_holiday        ? UX.ink1 :
    (day.delta_pct ?? 0) >= 15  ? UX.greenInk :
    (day.delta_pct ?? 0) <= -15 ? UX.redInk :
                                  UX.ink1

  const revPrefix = day.is_holiday ? '~ ' : ''
  const revLabel  = day.is_holiday
    ? t('baselineEst')
    : (day.delta_pct ?? 0) >= 15  ? t('peakLabel')
    : (day.delta_pct ?? 0) <= -15 ? t('dipLabel')
    :                               t('forecastLabel')

  const showCut = cutHours != null && cutHours <= -2  // "cut available" threshold

  return (
    <div style={{
      ...dayCardBase,
      background:   palette.bg,
      borderColor:  palette.border,
      boxShadow:    palette.emphasis ? '0 1px 4px rgba(0,0,0,0.06)' : 'none',
      position:     'relative' as const,
    }}>
      {day.is_holiday && (
        <div style={cornerHolidayStyle} aria-label={day.holiday_name ?? 'Holiday'}>H</div>
      )}
      <div style={odNameStyle}>{day.weekday}</div>
      <div style={odDateStyle}>{dateLabel}</div>
      <div style={odWeatherStyle} aria-label={day.weather.bucket}>{icon}</div>
      <div style={odTempStyle}>
        {Math.round(day.weather.temp_min)}° / {Math.round(day.weather.temp_max)}°
      </div>
      <div style={{ ...odRevStyle, color: revToneColor }}>
        {revPrefix}{fmtKr(day.predicted_revenue)}
      </div>
      <div style={odRevLabelStyle}>{revLabel}</div>

      {(day.is_holiday || showCut) && (
        <div style={odFlagsStyle}>
          {day.is_holiday && day.holiday_name && (
            <span style={{ ...flagStyle, color: UX.amberInk }}>{day.holiday_name}</span>
          )}
          {showCut && cutHours != null && (
            <span style={{ ...flagStyle, color: UX.greenInk }}>
              {t('cutAvailable', { hours: Math.abs(cutHours).toFixed(1) })}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

// ─── styles ──────────────────────────────────────────────────────────────────

const cardStyle: React.CSSProperties = {
  background:   UX.cardBg,
  border:       `1px solid ${UX.border}`,
  borderRadius: 12,
  padding:      '22px 28px 24px',
  marginBottom: 16,
}

const headStyle: React.CSSProperties = {
  display:        'flex',
  justifyContent: 'space-between',
  alignItems:     'flex-end',
  marginBottom:   18,
  paddingBottom:  16,
  borderBottom:   `1px solid ${UX.borderSoft}`,
  gap:            16,
  flexWrap:       'wrap' as const,
}

const eyebrowStyle: React.CSSProperties = {
  fontSize:      11,
  color:         UX.ink4,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  fontWeight:    500,
  marginBottom:  6,
}

const titleStyle: React.CSSProperties = {
  fontSize:      18,
  fontWeight:    700,
  color:         UX.ink1,
  letterSpacing: '-0.01em',
  lineHeight:    1.3,
  margin:        '0 0 4px 0',
}

const subStyle: React.CSSProperties = {
  fontSize: 12,
  color:    UX.ink3,
}

const summaryStyle: React.CSSProperties = {
  textAlign:  'right' as const,
  fontSize:   12,
  color:      UX.ink3,
  flexShrink: 0,
}

const summaryNumStyle: React.CSSProperties = {
  fontWeight: 700,
  color:      UX.ink1,
  fontSize:   16,
  marginTop:  2,
}

const gridStyle: React.CSSProperties = {
  display:             'grid',
  gridTemplateColumns: 'repeat(7, 1fr)',
  gap:                 8,
}

const dayCardBase: React.CSSProperties = {
  border:        '1px solid',
  borderRadius: 10,
  padding:       '12px 8px 10px',
  textAlign:     'center' as const,
  cursor:        'default',
  transition:    'border-color 0.15s',
  minWidth:      0,
}

const cornerHolidayStyle: React.CSSProperties = {
  position:     'absolute' as const,
  top:           6,
  right:         6,
  width:         14,
  height:        14,
  borderRadius:  4,
  display:       'grid',
  placeItems:    'center',
  fontSize:      9,
  fontWeight:    700,
  background:    UX.amberInk,
  color:         'white',
}

const odNameStyle: React.CSSProperties = {
  fontSize:      10,
  color:         UX.ink4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.06em',
  fontWeight:    500,
}

const odDateStyle: React.CSSProperties = {
  fontSize:   17,
  fontWeight: 700,
  color:      UX.ink1,
  lineHeight: 1,
  margin:     '3px 0 8px',
}

const odWeatherStyle: React.CSSProperties = {
  fontSize:     22,
  lineHeight:   1,
  marginBottom: 4,
}

const odTempStyle: React.CSSProperties = {
  fontSize:     10,
  color:        UX.ink4,
  marginBottom: 8,
  fontWeight:   500,
}

const odRevStyle: React.CSSProperties = {
  fontSize:   13,
  fontWeight: 700,
  color:      UX.ink1,
  lineHeight: 1,
}

const odRevLabelStyle: React.CSSProperties = {
  fontSize:      9,
  color:         UX.ink4,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.05em',
  fontWeight:    500,
  marginTop:     2,
}

const odFlagsStyle: React.CSSProperties = {
  marginTop:     8,
  paddingTop:    8,
  borderTop:     `1px dashed ${UX.borderSoft}`,
  display:       'flex',
  flexDirection: 'column' as const,
  gap:           3,
}

const flagStyle: React.CSSProperties = {
  fontSize:      9,
  fontWeight:    700,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.04em',
}
