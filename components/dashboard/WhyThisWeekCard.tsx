'use client'
// components/dashboard/WhyThisWeekCard.tsx
//
// "Why this week's numbers" — attribution-first UX on the dashboard.
// Reuses the `attribution` payload already on each suggested[] entry
// from /api/scheduling/ai-suggestion. Renders one row per future day
// with the predicted revenue + operator-readable drivers (weekday
// baseline, weather lift, salary cycle, holidays, recent trend).
//
// Skips days where the ONLY driver is the baseline (no story to tell
// — keeps the panel focused on days where the prediction has real
// context attached). Empty state when no days have signal.
//
// Phase B of the Nordic Plan — the dashboard equivalent of the
// per-day attribution line in /scheduling (components/scheduling/
// RotaDay.tsx). Same drivers, dashboard-appropriate layout.

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

interface Props {
  aiSched: { suggested?: SuggestedDay[] } | null
  fmtKr:   (n: number) => string
}

const C = {
  ink:        UX.ink1,
  ink2:       UX.ink2,
  ink3:       UX.ink3,
  ink4:       UX.ink4,
  border:     UX.border,
  borderSoft: UX.borderSoft,
  bgCard:     UX.cardBg,
  bgPage:     UX.pageBg,
  green:      UX.greenInk,
  greenBg:    UX.greenBg,
  amber:      UX.amberInk,
  amberBg:    UX.amberBg,
  red:        '#b91c1c',
  redBg:      '#fef2f2',
  demand:     '#2563eb',
}

const WEEKDAY_SHORT: Record<string, string> = {
  Sun: 'Sun', Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat',
}

interface Driver {
  label:  string
  effect: string | null
  tone:   'good' | 'bad' | 'neutral'
}

// Extract the non-neutral drivers — same logic as RotaDay's AttributionLine.
// Pulled out separately so the card can short-circuit when only baseline applies.
function extractDrivers(a: Attribution): Driver[] {
  const drivers: Driver[] = []

  // Holiday
  if (a.holiday_name) {
    const tone: 'good' | 'bad' | 'neutral' =
      a.holiday_impact === 'high' ? 'good'
      : a.holiday_impact === 'low'  ? 'bad'
      : 'neutral'
    const effectLabel =
      a.holiday_impact === 'high' ? '+15%'
      : a.holiday_impact === 'low'  ? '−60%'
      : null
    drivers.push({ label: a.holiday_name, effect: effectLabel, tone })
  }

  // Klämdag
  if (a.klamdag) {
    drivers.push({
      label:  `Klämdag (next to ${a.klamdag_adjacent ?? 'a holiday'})`,
      effect: '−10%',
      tone:   'bad',
    })
  }

  // Salary cycle (skip neutral mid-month)
  if (a.salary_phase !== 'mid_month' && a.salary_effect_pct !== 0) {
    drivers.push({
      label:  a.salary_label,
      effect: (a.salary_effect_pct > 0 ? '+' : '') + a.salary_effect_pct + '%',
      tone:   a.salary_effect_pct > 0 ? 'good' : 'bad',
    })
  }

  // Weather subset substitution
  if (a.weather_used_subset && Math.abs(a.weather_lift_pct) >= 3) {
    drivers.push({
      label:  `${a.weather_summary ?? 'Weather'}${a.bucket_samples ? ` (${a.bucket_samples} similar days)` : ''}`,
      effect: (a.weather_lift_pct > 0 ? '+' : '') + a.weather_lift_pct.toFixed(0) + '%',
      tone:   a.weather_lift_pct > 0 ? 'good' : 'bad',
    })
  }

  // Recent trend
  if (Math.abs(a.recent_trend_pct) >= 5) {
    drivers.push({
      label:  'Recent 4 weeks vs longer-term',
      effect: (a.recent_trend_pct > 0 ? '+' : '') + a.recent_trend_pct.toFixed(0) + '%',
      tone:   a.recent_trend_pct > 0 ? 'good' : 'bad',
    })
  }

  // This-week scaler clamped at ceiling/floor — only if extreme
  if (a.this_week_scaler_clamped) {
    const isHigh = a.this_week_scaler >= 1.24
    drivers.push({
      label:  isHigh ? 'This week running above pattern (capped)' : 'This week running below pattern (capped)',
      effect: isHigh ? '+25% max' : '−25% min',
      tone:   isHigh ? 'good' : 'bad',
    })
  }

  // Events nearby — top 2 to keep chip-strip tidy
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
  const name = ev.name ? (ev.name.length > 30 ? ev.name.slice(0, 28) + '…' : ev.name) : 'event'
  let when = ''
  if (ev.days_until === 0)       when = ' tonight'
  else if (ev.days_until === 1)  when = ' tomorrow'
  else if (ev.days_until === 2)  when = ' in 2 days'
  else if (ev.days_until === -1) when = ' (yesterday)'
  return `${name} · ${venue}${when}`
}

// Pick the next N future days (skip past dates by relying on backend filter)
const MAX_DAYS_SHOWN = 7

export default function WhyThisWeekCard({ aiSched, fmtKr }: Props) {
  if (!aiSched?.suggested?.length) return null

  // Build per-day rows, including ones with no extra drivers — operators
  // may want to see "Tue: just a normal Tuesday" as confirmation that
  // nothing unusual is driving the day.
  const allRows = aiSched.suggested.slice(0, MAX_DAYS_SHOWN).map(s => {
    const a = s.attribution
    return {
      date:    s.date,
      weekday: s.weekday,
      rev:     Number(s.est_revenue ?? 0),
      drivers: a ? extractDrivers(a) : [],
      baseline_kr: a?.baseline_kr ?? 0,
      sample_n:    a?.baseline_sample_n ?? 0,
    }
  })

  // If literally no day has any non-baseline driver, hide the whole card.
  const anyStoryDay = allRows.some(r => r.drivers.length > 0)
  if (!anyStoryDay) return null

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
        marginBottom:   10,
      }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: C.ink, margin: 0 }}>
            Why this week's numbers
          </h2>
          <div style={{ fontSize: 11, color: C.ink4, marginTop: 2 }}>
            The drivers behind each day's predicted revenue — weather, payday timing, holidays, and recent trends.
          </div>
        </div>
        <Legend />
      </div>

      <div style={{ display: 'grid', gap: 6 }}>
        {allRows.map(row => (
          <DayRow key={row.date} row={row} fmtKr={fmtKr} />
        ))}
      </div>
    </div>
  )
}

// ─── Atoms ──────────────────────────────────────────────────────────

function DayRow({ row, fmtKr }: { row: any; fmtKr: (n: number) => string }) {
  const isQuiet = row.drivers.length === 0
  return (
    <div style={{
      display:        'grid',
      gridTemplateColumns: 'minmax(70px, 90px) minmax(95px, 110px) 1fr',
      gap:            12,
      alignItems:     'center',
      padding:        '8px 10px',
      background:     C.bgPage,
      border:         `0.5px solid ${C.border}`,
      borderRadius:   6,
    }}>
      {/* Day */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 600, color: C.ink }}>
          {WEEKDAY_SHORT[row.weekday] ?? row.weekday}{' '}
          <span style={{ color: C.ink3, fontWeight: 400 }}>{formatDate(row.date)}</span>
        </div>
        <div style={{ fontSize: 10, color: C.ink4, marginTop: 1 }}>
          {row.sample_n} {row.weekday}{row.sample_n === 1 ? '' : 's'} of history
        </div>
      </div>

      {/* Predicted revenue */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: C.demand }}>
          {fmtKr(row.rev)}
        </div>
        <div style={{ fontSize: 10, color: C.ink4, marginTop: 1 }}>
          baseline {fmtKr(row.baseline_kr)}
        </div>
      </div>

      {/* Drivers */}
      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '4px 8px' }}>
        {isQuiet ? (
          <span style={{ fontSize: 11, color: C.ink4, fontStyle: 'italic' as const }}>
            No unusual drivers — typical {WEEKDAY_SHORT[row.weekday] ?? row.weekday}
          </span>
        ) : (
          row.drivers.map((dr: Driver, i: number) => <DriverChip key={i} driver={dr} />)
        )}
      </div>
    </div>
  )
}

function DriverChip({ driver }: { driver: Driver }) {
  const color =
    driver.tone === 'good' ? C.green
    : driver.tone === 'bad'  ? C.red
    : C.ink2
  const bg =
    driver.tone === 'good' ? C.greenBg
    : driver.tone === 'bad'  ? C.redBg
    : 'transparent'
  const border =
    driver.tone === 'good' ? C.green
    : driver.tone === 'bad'  ? C.red
    : C.border
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
      {driver.effect && (
        <span style={{ fontWeight: 600 }}>{driver.effect}</span>
      )}
    </span>
  )
}

function Legend() {
  return (
    <div style={{
      display:     'flex',
      gap:         10,
      alignItems:  'center',
      fontSize:    10,
      color:       C.ink4,
    }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: C.green }} />
        lift
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: C.red }} />
        dip
      </span>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso + 'T12:00:00Z')
    const day = d.getUTCDate()
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
    return `${day} ${month}`
  } catch {
    return iso
  }
}
