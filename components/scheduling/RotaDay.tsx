'use client'
// components/scheduling/RotaDay.tsx
//
// Nory-style per-day rota visualisation: predicted demand curve at the
// top, scheduled shift bars below, time axis between them. Each staff
// member gets one row in the grid; each shift renders as a coloured bar
// positioned by Stockholm-local start/end time.
//
// Goal of the visual: an operator looking at one day should see at a
// glance where demand peaks DON'T match staffing density. That's where
// the over- and under-staffing lives. Cards (per-meal-period totals)
// are a summary; this is the working layout.
//
// Inputs (per day):
//   hourlyDemand[]   — full 24h array of predicted_revenue / is_closed
//   shifts[]         — staff_name + shift_start_iso + shift_end_iso + cost
//   mealPeriods[]    — for the cut-recommendation summary line below
//
// The time axis collapses to the business's active hours (min open hour
// minus 1 → max open hour plus 1) so we don't waste 9 hours of empty
// strip on every day. Vero ends up with 10:00-00:00, Rosali 09:00-22:00.

import { UX } from '@/lib/constants/tokens'

interface HourlyDemand {
  hour:              number
  predicted_revenue: number
  predicted_covers:  number
  is_closed:         boolean
  confidence:        'high' | 'medium' | 'low'
}

interface Shift {
  staff_name:      string | null
  staff_group:     string | null
  shift_start_iso: string | null
  shift_end_iso:   string | null
  hours_worked:    number
  estimated_cost:  number
}

interface MealPeriod {
  label:               string
  hours_in_period:     number[]
  predicted_revenue:   number
  scheduled_hours:     number
  delta_hours:         number
  delta_cost:          number
}

interface Props {
  hourlyDemand: HourlyDemand[]
  shifts:       Shift[]
  mealPeriods:  MealPeriod[]
  fmt:          (n: number) => string
  fmtHrs:       (h: number) => string
}

const C = {
  ink:        UX.ink1,
  ink2:       UX.ink2,
  ink3:       UX.ink3,
  ink4:       UX.ink4,
  ink5:       UX.ink5,
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
  // Demand-curve palette — blue family so it reads as forecast data
  demandFill: 'rgba(37, 99, 235, 0.18)',
  demandLine: '#2563eb',
  closed:     UX.borderSoft,
}

// Group staff colour palette — keeps similar shifts grouped visually
// without depending on a per-business taxonomy. Deterministic hash so
// the same staff member gets the same colour across re-renders.
const STAFF_PALETTE = [
  '#1e40af', '#7c3aed', '#0891b2', '#15803d', '#a16207',
  '#9f1239', '#0f766e', '#7c2d12', '#3730a3', '#831843',
]
function staffColour(name: string | null): string {
  if (!name) return STAFF_PALETTE[0]
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return STAFF_PALETTE[h % STAFF_PALETTE.length]
}

// ── Helpers ──────────────────────────────────────────────────────────

function stockholmLocalHourFloat(iso: string): number {
  // Stockholm-local hour with fractional minutes (so 13:30 = 13.5).
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return NaN
    const hStr = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Stockholm', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(d)
    const [hh, mm] = hStr.split(':').map(Number)
    return hh + (mm / 60)
  } catch {
    return NaN
  }
}

// ── Component ────────────────────────────────────────────────────────

export function RotaDay({ hourlyDemand, shifts, mealPeriods, fmt, fmtHrs }: Props) {
  // ── Determine visible hour range ───────────────────────────────────
  // Open hours = hours with predicted_revenue > 0 OR not closed.
  // Pad with 1 hour either side so the curve has visual breathing room.
  const openHours = hourlyDemand
    .filter(h => !h.is_closed && h.predicted_revenue > 0)
    .map(h => h.hour)
  if (openHours.length === 0) {
    return (
      <div style={{ padding: '12px 14px', fontSize: 12, color: C.ink4, fontStyle: 'italic' as const, background: C.bgPage }}>
        No predicted trading hours for this day.
      </div>
    )
  }
  const minHour = Math.max(0,  Math.min(...openHours) - 1)
  const maxHour = Math.min(23, Math.max(...openHours) + 1)
  const hourCount = maxHour - minHour + 1   // inclusive

  // Max predicted revenue across visible hours — drives the demand curve y-scale
  const visibleDemand = hourlyDemand.filter(h => h.hour >= minHour && h.hour <= maxHour)
  const maxRev = Math.max(...visibleDemand.map(h => h.predicted_revenue), 1)

  // ── Group shifts by staff name ─────────────────────────────────────
  const byStaff = new Map<string, Shift[]>()
  for (const s of shifts) {
    if (!s.shift_start_iso || !s.shift_end_iso) continue
    const key = s.staff_name ?? '(unknown)'
    if (!byStaff.has(key)) byStaff.set(key, [])
    byStaff.get(key)!.push(s)
  }
  // Sort staff by their earliest shift start — gives a natural top-to-bottom
  // reading order (morning prep → late dinner).
  const staffEntries = Array.from(byStaff.entries()).sort((a, b) => {
    const aStart = Math.min(...a[1].map(s => stockholmLocalHourFloat(s.shift_start_iso!)))
    const bStart = Math.min(...b[1].map(s => stockholmLocalHourFloat(s.shift_start_iso!)))
    return aStart - bStart
  })

  // ── Geometry ──────────────────────────────────────────────────────
  const TRACK_HEIGHT     = 18    // px per staff row
  const TRACK_GAP        = 2
  const STAFF_LABEL_COL  = 90    // px reserved for staff name column
  const DEMAND_HEIGHT    = 60    // px — height of the demand-curve area
  const AXIS_HEIGHT      = 16
  const containerHeight  = DEMAND_HEIGHT + AXIS_HEIGHT + Math.max(staffEntries.length, 1) * (TRACK_HEIGHT + TRACK_GAP) + 12

  // SVG inner geometry — uses 0..hourCount on the x-axis.
  // We render in a flex container with a fixed-px label column on the left
  // and an SVG taking the remainder; the SVG uses a preserveAspectRatio
  // 'none' viewBox so x-coordinates map directly to hour fractions.

  function hourToX(hour: number): number {
    // hour can be fractional. 0..hourCount mapped to 0..1000 internal viewbox.
    return ((hour - minHour) / hourCount) * 1000
  }

  // Demand curve path — area chart with smooth steps per hour.
  const demandPathPoints: string[] = []
  for (let i = 0; i <= hourCount; i++) {
    const h = minHour + i
    const cell = visibleDemand.find(d => d.hour === h)
    const rev = cell?.predicted_revenue ?? 0
    const xLeft  = hourToX(h)
    const xRight = hourToX(h + 1)
    const y      = DEMAND_HEIGHT - (rev / maxRev) * (DEMAND_HEIGHT - 4) - 2
    if (i === 0) demandPathPoints.push(`M${xLeft.toFixed(2)},${DEMAND_HEIGHT}`)
    demandPathPoints.push(`L${xLeft.toFixed(2)},${y.toFixed(2)}`)
    demandPathPoints.push(`L${xRight.toFixed(2)},${y.toFixed(2)}`)
  }
  demandPathPoints.push(`L${hourToX(maxHour + 1).toFixed(2)},${DEMAND_HEIGHT}`)
  demandPathPoints.push('Z')
  const demandPath = demandPathPoints.join(' ')

  // Cut summary
  const cutPeriods = mealPeriods.filter(mp => mp.delta_hours <= -0.5)
  const totalCutHours = cutPeriods.reduce((s, m) => s + Math.abs(m.delta_hours), 0)
  const totalCutCost  = cutPeriods.reduce((s, m) => s + Math.abs(m.delta_cost), 0)

  return (
    <div style={{
      padding:    '10px 14px 14px',
      background: C.bgPage,
      borderTop:  `0.5px dashed ${C.border}`,
    }}>
      <div style={{
        fontSize:      9,
        fontWeight:    700,
        letterSpacing: '0.07em',
        color:         C.ink4,
        textTransform: 'uppercase' as const,
        marginBottom:  6,
      }}>
        Demand · Shifts
      </div>

      <div style={{ display: 'flex', alignItems: 'stretch', gap: 8 }}>
        {/* Staff label column */}
        <div style={{
          width:         STAFF_LABEL_COL,
          paddingTop:    DEMAND_HEIGHT + AXIS_HEIGHT,
          fontSize:      11,
          color:         C.ink3,
        }}>
          {staffEntries.map(([name]) => (
            <div key={name} style={{
              height:       TRACK_HEIGHT,
              marginBottom: TRACK_GAP,
              display:      'flex',
              alignItems:   'center',
              whiteSpace:   'nowrap' as const,
              overflow:     'hidden',
              textOverflow: 'ellipsis',
            }}>
              <span style={{
                width:        4,
                height:       12,
                borderRadius: 2,
                background:   staffColour(name),
                marginRight:  6,
                flexShrink:   0,
              }} />
              {name}
            </div>
          ))}
          {staffEntries.length === 0 && (
            <div style={{ fontStyle: 'italic' as const, color: C.ink4 }}>no shifts</div>
          )}
        </div>

        {/* Grid SVG */}
        <svg
          viewBox={`0 0 1000 ${containerHeight}`}
          preserveAspectRatio="none"
          style={{
            flex:    1,
            height:  containerHeight,
            background: C.bgCard,
            border:  `0.5px solid ${C.border}`,
            borderRadius: 4,
          }}
        >
          {/* Demand curve area */}
          <path d={demandPath} fill={C.demandFill} stroke={C.demandLine} strokeWidth="1" />

          {/* Demand peak hour label */}
          {(() => {
            const peak = visibleDemand.reduce((b, c) => c.predicted_revenue > b.predicted_revenue ? c : b, visibleDemand[0])
            if (!peak || peak.predicted_revenue <= 0) return null
            const xCenter = hourToX(peak.hour + 0.5)
            const y = DEMAND_HEIGHT - (peak.predicted_revenue / maxRev) * (DEMAND_HEIGHT - 4) - 6
            return (
              <text
                x={xCenter} y={Math.max(y, 10)}
                fontSize="9"
                fill={C.demandLine}
                textAnchor="middle"
                style={{ fontWeight: 600 } as any}
              >
                {fmt(peak.predicted_revenue)}
              </text>
            )
          })()}

          {/* Hour grid lines */}
          {Array.from({ length: hourCount + 1 }, (_, i) => {
            const x = hourToX(minHour + i)
            return (
              <line
                key={`gl-${i}`}
                x1={x} y1={DEMAND_HEIGHT}
                x2={x} y2={containerHeight - 4}
                stroke={C.borderSoft}
                strokeWidth="0.5"
                strokeDasharray={i % 3 === 0 ? undefined : '2,3'}
              />
            )
          })}

          {/* Hour axis labels */}
          {Array.from({ length: hourCount + 1 }, (_, i) => {
            const h = minHour + i
            if (i % 2 !== 0 && hourCount > 8) return null   // skip every-other when dense
            const x = hourToX(h)
            return (
              <text
                key={`ax-${i}`}
                x={x} y={DEMAND_HEIGHT + AXIS_HEIGHT - 4}
                fontSize="9"
                fill={C.ink4}
                textAnchor="middle"
              >
                {String(h).padStart(2, '0')}
              </text>
            )
          })}

          {/* Staff shift bars */}
          {staffEntries.map(([name, staffShifts], rowIdx) => {
            const y = DEMAND_HEIGHT + AXIS_HEIGHT + rowIdx * (TRACK_HEIGHT + TRACK_GAP)
            const colour = staffColour(name)
            return (
              <g key={name}>
                {/* Row background */}
                <rect
                  x={0} y={y}
                  width={1000} height={TRACK_HEIGHT}
                  fill={rowIdx % 2 === 0 ? C.bgPage : 'transparent'}
                  opacity={0.4}
                />
                {/* Shift bars */}
                {staffShifts.map((s, sIdx) => {
                  const startH = stockholmLocalHourFloat(s.shift_start_iso!)
                  const endH   = stockholmLocalHourFloat(s.shift_end_iso!)
                  if (!Number.isFinite(startH) || !Number.isFinite(endH)) return null
                  // Clip to visible range
                  const sH = Math.max(startH, minHour)
                  const eH = Math.min(endH,   maxHour + 1)
                  if (eH <= sH) return null
                  const x  = hourToX(sH)
                  const x2 = hourToX(eH)
                  return (
                    <g key={sIdx}>
                      <rect
                        x={x} y={y + 2}
                        width={Math.max(2, x2 - x)} height={TRACK_HEIGHT - 4}
                        fill={colour}
                        fillOpacity={0.85}
                        rx={2}
                      />
                      <title>{`${s.staff_name ?? '?'} · ${startH.toFixed(1)}–${endH.toFixed(1)} · ${fmtHrs(s.hours_worked)} · ${fmt(s.estimated_cost)}`}</title>
                    </g>
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>

      {/* Cut summary line — keeps the actionable recommendation explicit */}
      {cutPeriods.length > 0 && (
        <div style={{
          marginTop:    8,
          padding:      '6px 10px',
          background:   C.greenBg,
          border:       `0.5px solid ${C.green}`,
          borderRadius: 4,
          fontSize:     12,
          color:        C.green,
          fontWeight:   500,
        }}>
          {cutPeriods.map(p => `${labelForPeriod(p.label)} ${fmtHrs(Math.abs(p.delta_hours))}`).join(' · ')}
          {' → '}
          <span style={{ fontWeight: 600 }}>save {fmt(Math.round(totalCutCost))}</span>
          <span style={{ color: C.ink3, fontWeight: 400 }}>{' '}({fmtHrs(totalCutHours)} total)</span>
        </div>
      )}
    </div>
  )
}

function labelForPeriod(s: string): string {
  const m: Record<string, string> = {
    breakfast: 'Breakfast cut', brunch: 'Brunch cut', lunch: 'Lunch cut',
    afternoon: 'Afternoon cut', dinner: 'Dinner cut', late: 'Late cut',
    overnight: 'Overnight cut',
  }
  return m[s] ?? `${s} cut`
}
