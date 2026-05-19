'use client'
// app/dashboard/day/[date]/page.tsx
//
// Click-to-drill detail view for a single day. Reached by clicking a
// day on the OverviewChart. Shows predicted vs actual, full attribution,
// hourly breakdown, scheduled shifts, weather, and any anomaly alert.
//
// All data sourced from /api/dashboard/day which composes existing data
// (daily_metrics, hourly_metrics, staff_logs, weather_daily, anomaly_alerts,
// events) into one payload. No new tables.

import { useEffect, useState } from 'react'
import { useParams, useSearchParams, useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UX } from '@/lib/constants/tokens'
import { fmtKr, fmtPct } from '@/lib/format'

interface DayResponse {
  business: {
    id:               string
    name:             string
    city:             string | null
    country:          string
    target_staff_pct: number
    target_food_pct:  number
  }
  date:    string
  actual:  {
    revenue:      number
    staff_cost:   number
    food_cost:    number
    covers:       number
    hours_worked: number
    labour_pct:   number | null
    cost_source:  string | null
  } | null
  hourly: Array<{ hour: number; revenue: number; covers: number; transactions: number }>
  shifts: Array<{
    staff_name:     string | null
    staff_group:    string | null
    hours_worked:   number
    estimated_cost: number
    kind:           'scheduled' | 'logged'
  }>
  weather: {
    summary:     string | null
    temp_min:    number
    temp_max:    number
    precip_mm:   number
    is_forecast: boolean
  } | null
  anomaly: {
    id:                  string
    alert_type:          string
    severity:            string
    status:              string
    confirmation_status: string
    message:             string | null
  } | null
  attribution: {
    weekday_name:        string
    baseline_kr:         number
    baseline_sample_n:   number
    recent_trend_pct:    number
    holiday:             { name: string; impact: string | null } | null
    klamdag:             { adjacent: string | null } | null
    salary_phase:        'around_payday' | 'mid_month' | 'end_month'
    salary_label:        string
    salary_effect_pct:   number
    events:              Array<{
      name:        string | null
      category:    string
      venue_name:  string | null
      start_at:    string
      days_until:  number
      distance_km: number
      lift_pct:    number
    }>
    events_aggregate_lift_pct: number
  }
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAY_FULL: Record<string, string> = {
  Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday',
  Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday',
}

export default function DayDetailPage() {
  const params       = useParams() as { date: string }
  const searchParams = useSearchParams()
  const router       = useRouter()
  const businessId   = searchParams.get('business_id')
  const [data,    setData]    = useState<DayResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    if (!businessId) { setError('business_id missing'); setLoading(false); return }
    const qs = new URLSearchParams({ business_id: businessId, date: params.date })
    fetch(`/api/dashboard/day?${qs.toString()}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { setData(j); setLoading(false) })
      .catch(e => { setError(e.message); setLoading(false) })
  }, [businessId, params.date])

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '16px 24px 60px' }}>
        <button
          onClick={() => router.push('/dashboard')}
          style={{
            background: 'none', border: 'none', padding: 0,
            fontSize: 12, color: UX.ink3, cursor: 'pointer',
            marginBottom: 8, display: 'inline-flex', alignItems: 'center', gap: 4,
          }}
        >
          ← Back to dashboard
        </button>

        {loading && <Empty text="Loading day details…" />}
        {error   && <Banner tone="bad" text={error} />}

        {data && <DayContent data={data} />}
      </div>
    </AppShell>
  )
}

function DayContent({ data }: { data: DayResponse }) {
  const dateObj = new Date(data.date + 'T12:00:00Z')
  const dayLabel = `${WEEKDAY_FULL[data.attribution.weekday_name] ?? data.attribution.weekday_name}, ${dateObj.getUTCDate()} ${MONTH_NAMES[dateObj.getUTCMonth()]} ${dateObj.getUTCFullYear()}`

  return (
    <>
      {/* Header */}
      <div style={{ marginBottom: 18 }}>
        <h1 style={{ fontSize: 24, fontWeight: 600, color: UX.ink1, margin: 0 }}>
          {dayLabel}
        </h1>
        <div style={{ fontSize: 13, color: UX.ink3, marginTop: 4 }}>
          {data.business.name}{data.business.city && ` · ${data.business.city}`}
        </div>
      </div>

      {/* Headline P&L if actuals exist */}
      {data.actual ? (
        <ActualSummary data={data} />
      ) : (
        <Section title="No actuals yet">
          <div style={{ fontSize: 13, color: UX.ink3, padding: '0 4px' }}>
            This day hasn't been reconciled yet. Check back after the next master-sync cron.
          </div>
        </Section>
      )}

      {/* Hourly breakdown */}
      {data.hourly.length > 0 && (
        <Section title="Revenue by hour (Stockholm-local)">
          <HourlyChart hourly={data.hourly} />
        </Section>
      )}

      {/* Attribution */}
      <AttributionSection attr={data.attribution} weather={data.weather} />

      {/* Anomaly */}
      {data.anomaly && <AnomalyCard anomaly={data.anomaly} />}

      {/* Shifts */}
      {data.shifts.length > 0 && (
        <Section title={`Shifts scheduled (${data.shifts.length})`}>
          <ShiftsTable shifts={data.shifts} />
        </Section>
      )}
    </>
  )
}

// ─── Sections ────────────────────────────────────────────────────────

function ActualSummary({ data }: { data: DayResponse }) {
  const a = data.actual!
  const labourPct = a.labour_pct
  const labourTone = labourPct == null ? 'neutral'
    : labourPct <= data.business.target_staff_pct      ? 'good'
    : labourPct <= data.business.target_staff_pct + 5  ? 'warn'
    : 'bad'
  return (
    <Section title="P&L for the day">
      <div style={{
        display:    'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
        gap:        14,
        padding:    '6px 4px',
      }}>
        <Metric label="Revenue"        value={fmtKr(a.revenue)}     tone="neutral" />
        <Metric label="Staff cost"     value={fmtKr(a.staff_cost)}  tone="neutral" />
        <Metric label="Food cost"      value={fmtKr(a.food_cost)}   tone="neutral" />
        <Metric label="Covers"         value={String(a.covers)}     tone="neutral" />
        <Metric label="Hours worked"   value={a.hours_worked.toFixed(1)} tone="neutral" />
        <Metric
          label="Labour %"
          value={labourPct == null ? '—' : labourPct.toFixed(1) + '%'}
          tone={labourTone as any}
          sub={`target ≤ ${data.business.target_staff_pct}%`}
        />
      </div>
      {a.cost_source && (
        <div style={{ fontSize: 11, color: UX.ink4, padding: '8px 4px 0' }}>
          Staff cost source: <strong style={{ color: UX.ink3 }}>{a.cost_source}</strong>
        </div>
      )}
    </Section>
  )
}

function HourlyChart({ hourly }: { hourly: DayResponse['hourly'] }) {
  // Find max for scaling
  const maxRev = Math.max(...hourly.map(h => h.revenue), 1)
  // Determine visible hour range
  const activeHours = hourly.filter(h => h.revenue > 0).map(h => h.hour)
  if (activeHours.length === 0) return <Empty text="No hourly revenue recorded" />
  const minHour = Math.max(0, Math.min(...activeHours) - 1)
  const maxHour = Math.min(23, Math.max(...activeHours) + 1)

  return (
    <div style={{ padding: '8px 4px' }}>
      <div style={{
        display:    'flex',
        alignItems: 'flex-end',
        gap:        2,
        height:     120,
      }}>
        {Array.from({ length: maxHour - minHour + 1 }, (_, i) => {
          const h = minHour + i
          const cell = hourly.find(x => x.hour === h)
          const rev  = cell?.revenue ?? 0
          const heightPct = (rev / maxRev) * 100
          return (
            <div key={h} style={{
              flex:           1,
              display:        'flex',
              flexDirection:  'column' as const,
              alignItems:     'center',
              justifyContent: 'flex-end',
              minWidth:       16,
            }}>
              {rev > 0 && (
                <div title={`${String(h).padStart(2, '0')}:00 — ${fmtKr(rev)} · ${cell?.covers ?? 0} covers`} style={{
                  width:        '100%',
                  height:       `${heightPct}%`,
                  background:   rev >= maxRev * 0.8 ? '#1e40af' : rev >= maxRev * 0.4 ? '#3b82f6' : '#93c5fd',
                  borderRadius: '3px 3px 0 0',
                }} />
              )}
            </div>
          )
        })}
      </div>
      <div style={{
        display:    'flex',
        gap:        2,
        marginTop:  4,
        fontSize:   10,
        color:      UX.ink4,
      }}>
        {Array.from({ length: maxHour - minHour + 1 }, (_, i) => (
          <div key={i} style={{ flex: 1, textAlign: 'center' as const }}>
            {String(minHour + i).padStart(2, '0')}
          </div>
        ))}
      </div>
    </div>
  )
}

function AttributionSection({ attr, weather }: { attr: DayResponse['attribution']; weather: DayResponse['weather'] }) {
  const drivers: Array<{ label: string; effect: string | null; tone: 'good' | 'bad' | 'neutral' }> = [
    {
      label:  `${attr.weekday_name} baseline (${attr.baseline_sample_n} ${attr.baseline_sample_n === 1 ? 'sample' : 'samples'})`,
      effect: fmtKr(attr.baseline_kr),
      tone:   'neutral',
    },
  ]
  if (attr.holiday) {
    const tone: 'good' | 'bad' | 'neutral' =
      attr.holiday.impact === 'high' ? 'good'
      : attr.holiday.impact === 'low' ? 'bad' : 'neutral'
    drivers.push({ label: attr.holiday.name, effect: attr.holiday.impact === 'high' ? '+15%' : attr.holiday.impact === 'low' ? '−60%' : null, tone })
  }
  if (attr.klamdag) {
    drivers.push({
      label:  `Klämdag (next to ${attr.klamdag.adjacent ?? 'a holiday'})`,
      effect: '−10%',
      tone:   'bad',
    })
  }
  if (attr.salary_phase !== 'mid_month' && attr.salary_effect_pct !== 0) {
    drivers.push({
      label:  attr.salary_label,
      effect: (attr.salary_effect_pct > 0 ? '+' : '') + attr.salary_effect_pct + '%',
      tone:   attr.salary_effect_pct > 0 ? 'good' : 'bad',
    })
  }
  if (Math.abs(attr.recent_trend_pct) >= 5) {
    drivers.push({
      label:  'Recent 4 weeks vs longer-term',
      effect: (attr.recent_trend_pct > 0 ? '+' : '') + attr.recent_trend_pct.toFixed(0) + '%',
      tone:   attr.recent_trend_pct > 0 ? 'good' : 'bad',
    })
  }
  for (const ev of attr.events) {
    drivers.push({
      label:  `${ev.name ?? 'Event'} · ${ev.venue_name ?? 'venue'}${ev.days_until === 0 ? ' that night' : ev.days_until === 1 ? ' next day' : ev.days_until === -1 ? ' previous night' : ''}`,
      effect: `+${ev.lift_pct.toFixed(0)}%`,
      tone:   'good',
    })
  }

  return (
    <Section title="Why this day's prediction">
      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '6px 10px', padding: '4px 4px' }}>
        {drivers.map((dr, i) => (
          <span key={i} style={{
            display:      'inline-flex',
            alignItems:   'center',
            gap:          5,
            padding:      '3px 10px',
            fontSize:     12,
            background:   dr.tone === 'good' ? UX.greenBg : dr.tone === 'bad' ? '#fef2f2' : 'white',
            color:        dr.tone === 'good' ? UX.greenInk : dr.tone === 'bad' ? '#b91c1c' : UX.ink2,
            border:       `0.5px solid ${dr.tone === 'good' ? UX.greenInk : dr.tone === 'bad' ? '#fecaca' : UX.border}`,
            borderRadius: 999,
          }}>
            <span>{dr.label}</span>
            {dr.effect && <span style={{ fontWeight: 600 }}>{dr.effect}</span>}
          </span>
        ))}
      </div>
      {weather && (
        <div style={{ fontSize: 12, color: UX.ink3, padding: '10px 4px 0' }}>
          <strong style={{ color: UX.ink2 }}>Weather:</strong>{' '}
          {weather.summary ?? 'unknown'} · {weather.temp_min.toFixed(0)}°–{weather.temp_max.toFixed(0)}°C · {weather.precip_mm.toFixed(0)} mm precip
          {weather.is_forecast && <span style={{ marginLeft: 6, color: UX.ink4, fontStyle: 'italic' }}>forecasted</span>}
        </div>
      )}
    </Section>
  )
}

function AnomalyCard({ anomaly }: { anomaly: NonNullable<DayResponse['anomaly']> }) {
  const isDrop = anomaly.alert_type === 'revenue_drop'
  return (
    <Section title={isDrop ? 'Anomaly: revenue dropped' : 'Anomaly: revenue spike'}>
      <div style={{
        padding:      '10px 12px',
        background:   isDrop ? '#fef2f2' : '#f0fdf4',
        border:       `1px solid ${isDrop ? '#fecaca' : '#bbf7d0'}`,
        borderRadius: 8,
        fontSize:     13,
        color:        isDrop ? '#b91c1c' : UX.greenInk,
      }}>
        {anomaly.message ?? 'No additional detail.'}
      </div>
      <div style={{ fontSize: 11, color: UX.ink4, marginTop: 6 }}>
        Severity: {anomaly.severity} · Confirmation: {anomaly.confirmation_status ?? 'pending'}
      </div>
    </Section>
  )
}

function ShiftsTable({ shifts }: { shifts: DayResponse['shifts'] }) {
  const total = shifts.reduce((s, x) => s + x.hours_worked, 0)
  const totalCost = shifts.reduce((s, x) => s + x.estimated_cost, 0)
  return (
    <div style={{ padding: '6px 4px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
        <thead>
          <tr style={{ color: UX.ink3, textAlign: 'left' as const, borderBottom: `1px solid ${UX.border}` }}>
            <th style={th()}>Staff</th>
            <th style={th()}>Group</th>
            <th style={{ ...th(), textAlign: 'right' as const }}>Hours</th>
            <th style={{ ...th(), textAlign: 'right' as const }}>Est. cost</th>
            <th style={th()}>Type</th>
          </tr>
        </thead>
        <tbody>
          {shifts.map((s, i) => (
            <tr key={i} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
              <td style={td()}>{s.staff_name ?? '—'}</td>
              <td style={{ ...td(), color: UX.ink3 }}>{s.staff_group ?? '—'}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{s.hours_worked.toFixed(1)}</td>
              <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(s.estimated_cost)}</td>
              <td style={td()}>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 3,
                  background: s.kind === 'scheduled' ? '#eef2ff' : UX.greenBg,
                  color:      s.kind === 'scheduled' ? '#4338ca' : UX.greenInk,
                }}>
                  {s.kind}
                </span>
              </td>
            </tr>
          ))}
          <tr style={{ borderTop: `1px solid ${UX.border}`, fontWeight: 600 }}>
            <td style={td()}>Total</td>
            <td style={td()}></td>
            <td style={{ ...td(), textAlign: 'right' as const }}>{total.toFixed(1)}</td>
            <td style={{ ...td(), textAlign: 'right' as const }}>{fmtKr(totalCost)}</td>
            <td style={td()}></td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{
      background:   UX.cardBg,
      border:       `1px solid ${UX.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginBottom: 12,
    }}>
      <h2 style={{ fontSize: 13, fontWeight: 600, color: UX.ink1, margin: 0, marginBottom: 10 }}>
        {title}
      </h2>
      {children}
    </section>
  )
}

function Metric({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const TONE: Record<string, string> = { good: UX.greenInk, warn: UX.amberInk, bad: '#b91c1c', neutral: UX.ink1 }
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: UX.ink4, textTransform: 'uppercase' as const, marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 500, color: TONE[tone] }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Banner({ tone, text }: { tone: 'good' | 'warn' | 'bad'; text: string }) {
  const T = {
    good: { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' },
    warn: { bg: '#fef3c7', border: '#fde68a', fg: '#92400e' },
    bad:  { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
    }}>{text}</div>
  )
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: 12 }}>{text}</div>
}
function th(): React.CSSProperties {
  return { padding: '8px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const }
}
function td(): React.CSSProperties {
  return { padding: '8px 8px', verticalAlign: 'middle' as const }
}
