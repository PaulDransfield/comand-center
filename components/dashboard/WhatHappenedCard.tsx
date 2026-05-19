'use client'
// components/dashboard/WhatHappenedCard.tsx
//
// "What happened on <day>" — post-hoc variance attribution. Closes the
// loop on the forward-looking WhyThisWeekCard: the operator opens the
// dashboard on Monday morning, sees the upcoming-week story above, and
// reads this card to understand which day surprised them last week and
// why.
//
// Logic: walk the past resolved days in aiSched.suggested + dailyRows,
// find the one with the largest absolute relative variance. If it's
// > 10% off predicted, render the card explaining likely drivers. The
// drivers come from the same attribution payload the forward-looking
// card uses — same definitions, same colour scheme, just framed as
// "this is what we knew about that day at prediction time."
//
// Hidden when:
//   - No past resolved days
//   - Worst day was within ±10% (boring weeks stay quiet)
//   - aiSched not yet loaded
//
// Phase B (Nordic Plan / v2 roadmap) — completes the forward + backward
// attribution pair.

import { UX } from '@/lib/constants/tokens'

interface AttributionEvent {
  name:        string | null
  category:    string
  venue_name:  string | null
  start_at:    string
  days_until:  number
  distance_km: number
  lift_pct:    number
}
interface Attribution {
  weekday_name:              string
  baseline_kr:               number
  baseline_sample_n:         number
  weather_summary:           string | null
  weather_bucket:            string | null
  weather_lift_pct:          number
  weather_used_subset:       boolean
  bucket_samples:            number
  salary_phase:              'around_payday' | 'mid_month' | 'end_month'
  salary_label:              string
  salary_effect_pct:         number
  holiday_name:              string | null
  holiday_impact:            string | null
  klamdag:                   boolean
  klamdag_adjacent:          string | null
  recent_trend_pct:          number
  this_week_scaler:          number
  this_week_scaler_clamped:  boolean
  events?:                   AttributionEvent[]
  events_aggregate_lift_pct?: number
}
interface SuggestedDay {
  date:        string
  weekday:     string
  est_revenue: number
  attribution: Attribution | null
}
interface DailyRow {
  date:    string
  revenue: number
}
interface Props {
  aiSched:   { suggested?: SuggestedDay[] } | null
  dailyRows: DailyRow[]
  fmtKr:     (n: number) => string
}

const VARIANCE_THRESHOLD_PCT = 10   // ignore days within ±10%

const WEEKDAY_FULL: Record<string, string> = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday',
}

const C = {
  ink:        UX.ink1,
  ink2:       UX.ink2,
  ink3:       UX.ink3,
  ink4:       UX.ink4,
  border:     UX.border,
  bgCard:     UX.cardBg,
  bgPage:     UX.pageBg,
  green:      UX.greenInk,
  greenBg:    UX.greenBg,
  amber:      UX.amberInk,
  amberBg:    UX.amberBg,
  red:        '#b91c1c',
  redBg:      '#fef2f2',
}

interface Driver {
  label:  string
  effect: string | null
  tone:   'good' | 'bad' | 'neutral'
}

function extractDrivers(a: Attribution): Driver[] {
  const drivers: Driver[] = []
  if (a.holiday_name) {
    const tone: 'good' | 'bad' | 'neutral' =
      a.holiday_impact === 'high' ? 'good'
      : a.holiday_impact === 'low' ? 'bad' : 'neutral'
    const effect = a.holiday_impact === 'high' ? '+15%'
                 : a.holiday_impact === 'low'  ? '−60%' : null
    drivers.push({ label: a.holiday_name, effect, tone })
  }
  if (a.klamdag) {
    drivers.push({ label: `Klämdag (next to ${a.klamdag_adjacent ?? 'a holiday'})`, effect: '−10%', tone: 'bad' })
  }
  if (a.salary_phase !== 'mid_month' && a.salary_effect_pct !== 0) {
    drivers.push({
      label:  a.salary_label,
      effect: (a.salary_effect_pct > 0 ? '+' : '') + a.salary_effect_pct + '%',
      tone:   a.salary_effect_pct > 0 ? 'good' : 'bad',
    })
  }
  if (a.weather_used_subset && Math.abs(a.weather_lift_pct) >= 3) {
    drivers.push({
      label:  `${a.weather_summary ?? 'Weather'}${a.bucket_samples ? ` (${a.bucket_samples} similar days)` : ''}`,
      effect: (a.weather_lift_pct > 0 ? '+' : '') + a.weather_lift_pct.toFixed(0) + '%',
      tone:   a.weather_lift_pct > 0 ? 'good' : 'bad',
    })
  }
  if (Math.abs(a.recent_trend_pct) >= 5) {
    drivers.push({
      label:  'Recent 4 weeks vs longer-term',
      effect: (a.recent_trend_pct > 0 ? '+' : '') + a.recent_trend_pct.toFixed(0) + '%',
      tone:   a.recent_trend_pct > 0 ? 'good' : 'bad',
    })
  }
  // Events nearby on that day — useful post-hoc context (e.g. "we knew
  // about the Tele2 Arena concert; that's why the prediction was high")
  if (a.events && a.events.length > 0) {
    for (const ev of a.events.slice(0, 2)) {
      drivers.push({
        label:  eventChipLabel(ev),
        effect: `+${ev.lift_pct.toFixed(0)}%`,
        tone:   'good',
      })
    }
  }
  return drivers
}

function eventChipLabel(ev: AttributionEvent): string {
  const venue = ev.venue_name ?? 'venue'
  const name  = ev.name ? (ev.name.length > 30 ? ev.name.slice(0, 28) + '…' : ev.name) : 'event'
  let when = ''
  if (ev.days_until === 0)       when = ' that night'
  else if (ev.days_until === 1)  when = ' next day'
  else if (ev.days_until === -1) when = ' previous night'
  return `${name} · ${venue}${when}`
}

export default function WhatHappenedCard({ aiSched, dailyRows, fmtKr }: Props) {
  if (!aiSched?.suggested?.length) return null

  // Build candidate list: past days that have both predicted and actual.
  const todayIso = new Date().toISOString().slice(0, 10)
  const candidates = aiSched.suggested
    .filter(s => s.date < todayIso && Number(s.est_revenue ?? 0) > 0)
    .map(s => {
      const actualRow = dailyRows.find(d => d.date === s.date)
      const actual    = actualRow ? Number(actualRow.revenue ?? 0) : 0
      const predicted = Number(s.est_revenue ?? 0)
      if (actual <= 0) return null      // no resolved actual
      const err_pct = ((actual - predicted) / predicted) * 100
      return { ...s, actual, predicted, err_pct }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  if (candidates.length === 0) return null

  // Pick the worst (biggest absolute variance)
  const worst = candidates.reduce((best, c) =>
    Math.abs(c.err_pct) > Math.abs(best.err_pct) ? c : best
  )
  if (Math.abs(worst.err_pct) < VARIANCE_THRESHOLD_PCT) return null

  const isHigh = worst.err_pct > 0
  const headerTone: 'good' | 'bad' = isHigh ? 'good' : 'bad'
  const drivers = worst.attribution ? extractDrivers(worst.attribution) : []
  const deltaKr = Math.round(worst.actual - worst.predicted)

  // Interpretation — short plain-language summary that doesn't repeat the
  // numbers. Adapts to whether the day exceeded or missed plan.
  const interpretation = (() => {
    if (drivers.length === 0) {
      // No flagged drivers — variance is "unexplained" by signals we surface.
      return isHigh
        ? 'No flagged drivers — busier than the model expected. Was there an event we didn\'t know about?'
        : 'No flagged drivers — quieter than expected. Worth confirming whether this should be marked as an anomaly so future predictions exclude it.'
    }
    const directionMatches = drivers.some(d =>
      (isHigh && d.tone === 'good') || (!isHigh && d.tone === 'bad'),
    )
    return directionMatches
      ? 'Drivers below pointed in the right direction. The model captured this — actual variance may simply be the magnitude being larger than the signals estimated.'
      : 'Drivers below pushed the prediction in the OPPOSITE direction from the actual outcome. Worth investigating what other factor was at play.'
  })()

  return (
    <div style={{
      background:   C.bgCard,
      border:       `1px solid ${C.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginTop:    8,
    }}>
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'baseline',
        marginBottom:   8,
      }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, color: C.ink, margin: 0 }}>
          What happened on {WEEKDAY_FULL[worst.weekday] ?? worst.weekday}?
        </h2>
        <div style={{
          fontSize:    13,
          fontWeight:  600,
          color:       headerTone === 'good' ? C.green : C.red,
        }}>
          {isHigh ? '↑' : '↓'} {Math.abs(worst.err_pct).toFixed(0)}% off predicted
        </div>
      </div>

      <div style={{
        display:    'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
        gap:        10,
        padding:    '6px 0 10px',
        borderBottom: `0.5px solid ${C.border}`,
        marginBottom: 10,
      }}>
        <Metric label="Predicted" value={fmtKr(worst.predicted)} tone="neutral" />
        <Metric label="Actual"    value={fmtKr(worst.actual)}    tone={headerTone} />
        <Metric
          label={isHigh ? 'Exceeded by' : 'Below plan by'}
          value={fmtKr(Math.abs(deltaKr))}
          tone={headerTone}
        />
      </div>

      <div style={{ fontSize: 12, color: C.ink2, marginBottom: 8 }}>
        {interpretation}
      </div>

      {drivers.length > 0 && (
        <>
          <div style={{
            fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
            color: C.ink4, textTransform: 'uppercase' as const,
            marginBottom: 4,
          }}>
            Drivers the model knew about
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '4px 8px' }}>
            {drivers.map((dr, i) => <DriverChip key={i} driver={dr} />)}
          </div>
        </>
      )}
    </div>
  )
}

function Metric({ label, value, tone }: { label: string; value: string; tone: 'good' | 'bad' | 'neutral' }) {
  const TONE: Record<string, string> = { good: C.green, bad: C.red, neutral: C.ink }
  return (
    <div>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
        color: C.ink4, textTransform: 'uppercase' as const, marginBottom: 2,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: TONE[tone] }}>
        {value}
      </div>
    </div>
  )
}

function DriverChip({ driver }: { driver: Driver }) {
  const color = driver.tone === 'good' ? C.green : driver.tone === 'bad' ? C.red : C.ink2
  const bg    = driver.tone === 'good' ? C.greenBg : driver.tone === 'bad' ? C.redBg : 'transparent'
  const border = driver.tone === 'good' ? C.green : driver.tone === 'bad' ? C.red : C.border
  return (
    <span style={{
      display:      'inline-flex',
      alignItems:   'center',
      gap:          4,
      padding:      '2px 8px',
      fontSize:     11,
      lineHeight:   1.4,
      background:   bg,
      color:        color,
      border:       `0.5px solid ${border}`,
      borderRadius: 999,
      whiteSpace:   'nowrap' as const,
    }}>
      <span>{driver.label}</span>
      {driver.effect && <span style={{ fontWeight: 600 }}>{driver.effect}</span>}
    </span>
  )
}
