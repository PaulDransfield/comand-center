'use client'
// components/scheduling/RotaDay.tsx
//
// Nory-style per-day rota visualisation: predicted demand curve at the
// top with staff coverage bars below it, sharing one hour axis. Mismatch
// between demand and staffing is visible at a glance — no scrolling
// through per-staff rows.
//
// Bars are colour-coded by demand-vs-staffing ratio:
//   green  — staff ≈ ideal coverage for that hour
//   amber  — overstaffed (staff > 130 % of ideal)
//   red    — understaffed (staff < 70 % of ideal)
//   gray   — closed or no data
//
// Ideal staff per hour = predicted_revenue / target_rev_per_hour. The
// target rph comes from the meal_periods response (P75 of historical
// rev/hour for the containing meal period). Hours without a target rph
// default to green tone (no recommendation).
//
// Total height ≈ 110 px per day (vs ~400 px for the per-staff-row
// version). Designed to fit ~5 days on a 1080-tall screen without
// scrolling.

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
  target_rev_per_hour?: number | null
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
  demandFill: 'rgba(37, 99, 235, 0.16)',
  demandLine: '#2563eb',
}

// ── Helpers ──────────────────────────────────────────────────────────

function stockholmLocalHourFloat(iso: string): number {
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

function labelForPeriod(s: string): string {
  const m: Record<string, string> = {
    breakfast: 'Breakfast', brunch: 'Brunch', lunch: 'Lunch',
    afternoon: 'Afternoon', dinner: 'Dinner', late: 'Late', overnight: 'Overnight',
  }
  return m[s] ?? s
}

// ── Component ────────────────────────────────────────────────────────

export function RotaDay({ hourlyDemand, shifts, mealPeriods, fmt, fmtHrs }: Props) {
  // ── Visible hour range — collapse to active hours with 1-h padding ─
  const openHours = hourlyDemand
    .filter(h => !h.is_closed && h.predicted_revenue > 0)
    .map(h => h.hour)
  if (openHours.length === 0) {
    return (
      <div style={{ padding: '10px 14px', fontSize: 12, color: C.ink4, fontStyle: 'italic' as const, background: C.bgPage }}>
        No predicted trading hours for this day.
      </div>
    )
  }
  const minHour = Math.max(0, Math.min(...openHours) - 1)
  const maxHour = Math.min(23, Math.max(...openHours) + 1)
  const hourCount = maxHour - minHour + 1

  const demandByHour: Record<number, number> = {}
  for (const h of hourlyDemand) demandByHour[h.hour] = h.predicted_revenue
  const maxRev = Math.max(...Object.values(demandByHour), 1)

  // ── Staff coverage: count shifts overlapping each hour ─────────────
  const staffPerHour: number[] = new Array(24).fill(0)
  for (const shift of shifts) {
    if (!shift.shift_start_iso || !shift.shift_end_iso) continue
    const start = stockholmLocalHourFloat(shift.shift_start_iso)
    const end   = stockholmLocalHourFloat(shift.shift_end_iso)
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue
    for (let h = Math.floor(start); h < Math.ceil(end); h++) {
      if (h >= 0 && h <= 23) staffPerHour[h] += 1
    }
  }
  const maxStaff = Math.max(...staffPerHour, 1)
  const totalStaffPeak = maxStaff
  const totalShiftCount = new Set(
    shifts.map(s => s.staff_name).filter(Boolean),
  ).size

  // Target rev/hour per hour (from the containing meal period)
  function targetRphFor(hour: number): number | null {
    for (const mp of mealPeriods) {
      if (mp.hours_in_period.includes(hour)) {
        return mp.target_rev_per_hour ?? null
      }
    }
    return null
  }

  // Ratio colour for a given hour's staffing
  function staffColour(hour: number): string {
    const rev = demandByHour[hour] ?? 0
    const staff = staffPerHour[hour]
    if (rev <= 0 || staff <= 0) return C.borderSoft
    const target = targetRphFor(hour)
    if (target == null || target <= 0) return C.demandLine
    const idealStaff = rev / target
    const ratio = staff / idealStaff
    if (ratio < 0.7)  return C.red
    if (ratio > 1.3)  return C.amber
    return C.green
  }

  // ── Geometry ──────────────────────────────────────────────────────
  const DEMAND_H = 50
  const STAFF_H  = 26
  const AXIS_H   = 14
  const TOTAL_H  = DEMAND_H + STAFF_H + AXIS_H + 4

  function hourToX(h: number): number {
    return ((h - minHour) / hourCount) * 1000
  }

  // ── Demand area path ──────────────────────────────────────────────
  // Stepped: each hour cell is a flat plateau at its predicted value.
  const points: string[] = [`M${hourToX(minHour).toFixed(2)},${DEMAND_H}`]
  for (let i = 0; i <= hourCount; i++) {
    const h = minHour + i
    const rev = demandByHour[h] ?? 0
    const y = DEMAND_H - (rev / maxRev) * (DEMAND_H - 6) - 3
    points.push(`L${hourToX(h).toFixed(2)},${y.toFixed(2)}`)
    points.push(`L${hourToX(h + 1).toFixed(2)},${y.toFixed(2)}`)
  }
  points.push(`L${hourToX(maxHour + 1).toFixed(2)},${DEMAND_H}`)
  points.push('Z')
  const demandPath = points.join(' ')

  // Peak hour label
  let peakHour = minHour
  for (let h = minHour; h <= maxHour; h++) {
    if ((demandByHour[h] ?? 0) > (demandByHour[peakHour] ?? 0)) peakHour = h
  }
  const peakRev = demandByHour[peakHour] ?? 0

  // Cut summary
  const cutPeriods = mealPeriods.filter(mp => mp.delta_hours <= -0.5)
  const totalCutCost  = cutPeriods.reduce((s, m) => s + Math.abs(m.delta_cost), 0)

  return (
    <div style={{
      padding:    '8px 14px 12px',
      background: C.bgPage,
      borderTop:  `0.5px dashed ${C.border}`,
    }}>
      <div style={{
        display:       'flex',
        justifyContent: 'space-between',
        alignItems:    'baseline',
        marginBottom:  4,
      }}>
        <div style={{
          fontSize: 9, fontWeight: 700, letterSpacing: '0.07em',
          color: C.ink4, textTransform: 'uppercase' as const,
        }}>
          Demand × Staffing
        </div>
        <div style={{ fontSize: 11, color: C.ink3 }}>
          Peak <strong style={{ color: C.demandLine }}>{fmt(peakRev)}</strong> at {String(peakHour).padStart(2, '0')}:00
          {totalShiftCount > 0 && (
            <>{' · '}<strong style={{ color: C.ink2 }}>{totalShiftCount}</strong> staff · peak <strong style={{ color: C.ink2 }}>{totalStaffPeak}</strong> on shift</>
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 1000 ${TOTAL_H}`}
        preserveAspectRatio="none"
        style={{
          width:        '100%',
          height:       TOTAL_H,
          background:   C.bgCard,
          border:       `0.5px solid ${C.border}`,
          borderRadius: 4,
          display:      'block',
        }}
      >
        {/* Demand curve area */}
        <path d={demandPath} fill={C.demandFill} stroke={C.demandLine} strokeWidth="1" />

        {/* Hour grid lines (light) */}
        {Array.from({ length: hourCount + 1 }, (_, i) => {
          const x = hourToX(minHour + i)
          return (
            <line
              key={`gl-${i}`}
              x1={x} y1={0}
              x2={x} y2={DEMAND_H + AXIS_H + STAFF_H}
              stroke={C.borderSoft}
              strokeWidth="0.5"
            />
          )
        })}

        {/* Hour axis labels — under demand curve */}
        {Array.from({ length: hourCount }, (_, i) => {
          const h = minHour + i
          // Skip every other label when very dense (>12 visible hours)
          if (hourCount > 12 && i % 2 !== 0 && i !== hourCount - 1) return null
          const x = hourToX(h) + (hourToX(h + 1) - hourToX(h)) / 2  // centre of cell
          return (
            <text
              key={`ax-${i}`}
              x={x} y={DEMAND_H + AXIS_H - 4}
              fontSize="9"
              fill={C.ink4}
              textAnchor="middle"
            >
              {String(h).padStart(2, '0')}
            </text>
          )
        })}

        {/* Staff coverage bars — one per hour */}
        {Array.from({ length: hourCount }, (_, i) => {
          const h = minHour + i
          const count = staffPerHour[h]
          if (count === 0) return null
          const x = hourToX(h)
          const w = hourToX(h + 1) - x - 1   // 1px gap
          const barH = (count / maxStaff) * (STAFF_H - 6)
          const y = DEMAND_H + AXIS_H + (STAFF_H - barH - 2)
          const color = staffColour(h)
          return (
            <g key={`sb-${i}`}>
              <rect
                x={x + 0.5} y={y}
                width={Math.max(1, w)} height={barH}
                fill={color}
                fillOpacity={0.85}
                rx={1.5}
              />
              {/* Staff count label inside bar when tall enough */}
              {barH > 10 && (
                <text
                  x={x + w / 2} y={y + barH / 2 + 3}
                  fontSize="8" fontWeight="600"
                  fill="white"
                  textAnchor="middle"
                >
                  {count}
                </text>
              )}
              <title>{`${String(h).padStart(2, '0')}:00 — ${fmt(demandByHour[h] ?? 0)} predicted · ${count} staff`}</title>
            </g>
          )
        })}

        {/* Baseline under staff bars */}
        <line
          x1={0} y1={DEMAND_H + AXIS_H + STAFF_H - 1}
          x2={1000} y2={DEMAND_H + AXIS_H + STAFF_H - 1}
          stroke={C.borderSoft} strokeWidth="0.5"
        />
      </svg>

      {/* Cut summary line */}
      {cutPeriods.length > 0 && (
        <div style={{
          marginTop:    6,
          padding:      '5px 10px',
          background:   C.greenBg,
          border:       `0.5px solid ${C.green}`,
          borderRadius: 4,
          fontSize:     11,
          color:        C.green,
          fontWeight:   500,
        }}>
          {cutPeriods.map(p => `${labelForPeriod(p.label)} cut ${fmtHrs(Math.abs(p.delta_hours))}`).join(' · ')}
          {' → '}
          <span style={{ fontWeight: 600 }}>save {fmt(Math.round(totalCutCost))}</span>
        </div>
      )}

      {/* Legend */}
      <div style={{
        marginTop: 6,
        fontSize: 10, color: C.ink4,
        display: 'flex', gap: 12, alignItems: 'center',
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: C.green }} />
          matched
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: C.amber }} />
          overstaffed
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: C.red }} />
          understaffed
        </span>
        <span style={{ marginLeft: 'auto', color: C.demandLine }}>
          ▬ predicted demand
        </span>
      </div>
    </div>
  )
}
