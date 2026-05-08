'use client'
// components/dashboard/WeatherDemandWidget.tsx
//
// 7-day demand outlook strip on the dashboard. Shows the next 7 days with
// weather + predicted revenue + delta vs typical. Click a day to see the
// full detail card with confidence + recommendation.
//
// Hidden when:
//   - No bizId provided
//   - Endpoint returns < 1 day of forecast data (e.g. business has no
//     correlation history yet — happens when daily_metrics is empty)
//
// Confidence display:
//   - high   → solid border, bold delta
//   - medium → solid border, regular delta
//   - low    → dashed border, muted delta + (?) icon
//   - unavailable → dashed border, no delta value, just weather

import { useEffect, useState } from 'react'
import { useTranslations }     from 'next-intl'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

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

// Weather bucket → emoji icon. Kept tiny to avoid dependency surface.
const BUCKET_ICON: Record<string, string> = {
  clear:    '☀️',
  mild:     '🌤',
  cold_dry: '🌬',
  wet:      '🌧',
  snow:     '❄️',
  freezing: '🥶',
  hot:      '🔥',
  thunder:  '⛈',
}

// ISO weekday short labels — Mon=0 convention to match the API's weekday strings.
const WEEKDAY_TO_TKEY: Record<string, string> = {
  Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun',
}

export default function WeatherDemandWidget({ bizId }: { bizId: string | null }) {
  const t = useTranslations('weather.demand')
  const [data,    setData]    = useState<DemandForecast | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error,   setError]   = useState<string | null>(null)
  const [expandedDate, setExpandedDate] = useState<string | null>(null)

  useEffect(() => {
    if (!bizId) { setData(null); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/weather/demand-forecast?business_id=${bizId}&days=7`, { cache: 'no-store' })
      .then(r => r.ok ? r.json() : Promise.reject(r))
      .then((j: DemandForecast) => {
        if (cancelled) return
        setData(j)
        setLoading(false)
      })
      .catch(async (e) => {
        if (cancelled) return
        setLoading(false)
        try {
          const body = await (e as Response).json?.()
          setError(body?.error ?? 'unknown')
        } catch { setError('unknown') }
      })
    return () => { cancelled = true }
  }, [bizId])

  if (!bizId) return null

  // Hide entirely when there's no usable data — no point cluttering the
  // dashboard with an empty widget. Loading state shows the skeleton briefly.
  if (!loading && (!data || data.days.length === 0)) return null

  const expanded = expandedDate
    ? data?.days.find(d => d.date === expandedDate) ?? null
    : null

  return (
    <div style={{
      marginTop:    12,
      marginBottom: 16,
      padding:      16,
      background:   'white',
      border:       `1px solid ${UX.borderSoft}`,
      borderRadius: 10,
    }}>
      <div style={{
        display:       'flex',
        alignItems:    'baseline',
        justifyContent:'space-between',
        marginBottom:  10,
      }}>
        <div>
          <div style={{
            fontSize:      11,
            fontWeight:    600,
            color:         UX.ink4,
            textTransform: 'uppercase' as const,
            letterSpacing: '0.07em',
          }}>{t('eyebrow')}</div>
          <div style={{ fontSize: 14, fontWeight: 500, color: UX.ink1, marginTop: 2 }}>
            {t('title')}
          </div>
        </div>
        {data && (
          <div style={{ fontSize: 11, color: UX.ink4 }}>
            {t('basedOn', {
              weeks:   data.baseline_window.weeks,
              samples: data.correlation.sample_days,
            })}
          </div>
        )}
      </div>

      {loading && <SkeletonRow />}

      {!loading && data && (
        <>
          <div style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
            gap:                 8,
          }}>
            {data.days.map(day => (
              <DayCard
                key={day.date}
                day={day}
                isExpanded={expandedDate === day.date}
                onClick={() => setExpandedDate(expandedDate === day.date ? null : day.date)}
                t={t}
              />
            ))}
          </div>

          {expanded && (
            <DayDetail day={expanded} t={t} onClose={() => setExpandedDate(null)} />
          )}

          {error && (
            <div style={{ marginTop: 10, fontSize: 11, color: '#b91c1c' }}>
              {t('error')}: {error}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── Day card ─────────────────────────────────────────────────────────────────

function DayCard({ day, isExpanded, onClick, t }: {
  day:        DemandDay
  isExpanded: boolean
  onClick:    () => void
  t:          (key: string, vars?: any) => string
}) {
  const isWeak    = day.confidence === 'low' || day.confidence === 'unavailable'
  const isHoliday = day.is_holiday
  const deltaTone = isHoliday || day.confidence === 'unavailable'
    ? UX.ink4
    : day.delta_pct >= 5  ? '#15803d'
    : day.delta_pct <= -5 ? '#b91c1c'
    : UX.ink3

  // Borrow the weekday short labels from the parent translator namespace if we
  // can; otherwise fall back to the English label provided by the API.
  const weekdayKey = WEEKDAY_TO_TKEY[day.weekday]
  const weekdayLabel = weekdayKey ? t(`weekday.${weekdayKey}`) : day.weekday
  const dayOfMonth = new Date(day.date).getUTCDate()

  return (
    <button
      onClick={onClick}
      style={{
        background:   isExpanded ? '#fafbfc' : 'white',
        border:       isWeak
          ? `1px dashed ${UX.borderSoft}`
          : isExpanded
            ? `1px solid ${UX.indigo}`
            : `1px solid ${UX.borderSoft}`,
        borderRadius: 8,
        padding:      '10px 8px',
        cursor:       'pointer',
        textAlign:    'center' as const,
        fontFamily:   'inherit',
        transition:   'border-color 0.15s, background 0.15s',
      }}
      title={day.recommendation ?? day.holiday_name ?? `${day.weather.summary}, ${day.weather.temp_min}°-${day.weather.temp_max}°C`}
    >
      <div style={{ fontSize: 10, color: UX.ink4, fontWeight: 600, letterSpacing: '0.04em' }}>
        {weekdayLabel.toUpperCase()} {dayOfMonth}
      </div>
      <div style={{ fontSize: 22, lineHeight: '28px', marginTop: 2 }}>
        {BUCKET_ICON[day.weather.bucket] ?? '·'}
      </div>
      <div style={{ fontSize: 10, color: UX.ink3, fontWeight: 500 }}>
        {Math.round(day.weather.temp_min)}°–{Math.round(day.weather.temp_max)}°
      </div>
      <div style={{
        fontSize:           11,
        marginTop:          6,
        color:              UX.ink1,
        fontVariantNumeric: 'tabular-nums' as const,
        fontWeight:         500,
      }}>
        {fmtKrCompact(day.predicted_revenue)}
      </div>
      <div style={{
        fontSize:           10,
        marginTop:          1,
        color:              deltaTone,
        fontWeight:         day.confidence === 'high' ? 600 : 500,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>
        {isHoliday
          ? t('holiday')
          : day.confidence === 'unavailable'
            ? '—'
            : `${day.delta_pct >= 0 ? '+' : ''}${Math.round(day.delta_pct)}%`}
      </div>
    </button>
  )
}

// ── Day detail (expanded card below the strip) ───────────────────────────────

function DayDetail({ day, t, onClose }: {
  day:     DemandDay
  t:       (key: string, vars?: any) => string
  onClose: () => void
}) {
  return (
    <div style={{
      marginTop:    12,
      padding:      14,
      background:   '#fafbfc',
      border:       `1px solid ${UX.borderSoft}`,
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: UX.ink1 }}>
            {day.weekday} · {day.date}
            {day.is_holiday && day.holiday_name && (
              <span style={{
                marginLeft: 8,
                fontSize:   10,
                fontWeight: 700,
                padding:    '2px 6px',
                background: '#fef3c7',
                color:      '#92400e',
                borderRadius: 4,
                letterSpacing: '0.04em',
              }}>
                {day.holiday_name.toUpperCase()}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: UX.ink3, marginTop: 2 }}>
            {day.weather.summary} · {day.weather.temp_min}°–{day.weather.temp_max}°C ·{' '}
            {day.weather.precip_mm > 0 ? `${day.weather.precip_mm} mm rain · ` : ''}
            {day.weather.wind_max} m/s wind
          </div>
        </div>
        <button
          onClick={onClose}
          style={{
            background: 'transparent', border: 'none', cursor: 'pointer',
            fontSize: 16, color: UX.ink4, padding: 0,
          }}
          title={t('close')}
        >×</button>
      </div>

      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 10,
      }}>
        <Stat label={t('detail.baseline')} value={fmtKr(day.baseline_revenue)} />
        <Stat label={t('detail.predicted')} value={fmtKr(day.predicted_revenue)}
              tone={day.delta_pct >= 5 ? 'good' : day.delta_pct <= -5 ? 'bad' : 'neutral'} />
        <Stat
          label={t('detail.confidence')}
          value={t(`confidence.${day.confidence}`)}
          sub={day.confidence !== 'unavailable' ? t('detail.basedOnSamples', { count: day.sample_size }) : undefined}
        />
      </div>

      {day.recommendation && (
        <div style={{
          padding:      10,
          background:   day.delta_pct < 0 ? '#fef3c7' : '#ecfdf5',
          border:       `1px solid ${day.delta_pct < 0 ? '#fde68a' : '#a7f3d0'}`,
          borderRadius: 6,
          fontSize:     12,
          color:        UX.ink2,
          lineHeight:   1.5,
        }}>
          {day.recommendation}
        </div>
      )}

      {!day.recommendation && day.is_holiday && (
        <div style={{ fontSize: 11, color: UX.ink4, fontStyle: 'italic' as const }}>
          {t('detail.holidayNote')}
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, sub, tone }: {
  label: string
  value: string
  sub?:  string
  tone?: 'good' | 'bad' | 'neutral'
}) {
  const valueColor = tone === 'good' ? '#15803d' : tone === 'bad' ? '#b91c1c' : UX.ink1
  return (
    <div>
      <div style={{ fontSize: 10, color: UX.ink4, fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase' as const }}>
        {label}
      </div>
      <div style={{ fontSize: 14, fontWeight: 500, color: valueColor, fontVariantNumeric: 'tabular-nums' as const, marginTop: 2 }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 10, color: UX.ink4, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

// ── Skeleton row ─────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(7, minmax(0, 1fr))',
      gap:                 8,
    }}>
      {Array.from({ length: 7 }).map((_, i) => (
        <div key={i} style={{
          height:       110,
          background:   '#f3f4f6',
          borderRadius: 8,
          opacity:      0.6,
        }} />
      ))}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compact kr — "12.5k" / "180k" / "1.2M" — fits inside a narrow day card. */
function fmtKrCompact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000)    return `${Math.round(n / 1000)}k`
  if (abs >= 1_000)     return `${(n / 1000).toFixed(1)}k`
  return String(Math.round(n))
}
