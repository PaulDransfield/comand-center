// lib/scheduling/compliance.ts
//
// Pure-compute compliance checks against Swedish labour law
// (Arbetstidslagen + EU Working Time Directive) and business-level
// scheduling rules. Used by both:
//   - The pre-publish review panel (slide-up sheet on /scheduling/grid)
//   - Inline cell warnings on the grid itself
//
// Same engine, two surfaces — rules can never drift.
//
// Severities:
//   - HARD: blocks the Apply button until resolved. Used for non-
//     negotiable legal rules (min 11h rest, 48h/week, minor-employee
//     night work).
//   - WARN: one-click acknowledgeable. Owner ack is logged so the
//     engine knows the owner has decided to accept the trade-off
//     (e.g. lone closer when the owner trusts the staff).

export type CheckSeverity = 'HARD' | 'WARN'

export interface ComplianceCheck {
  code: string                              // stable identifier (used for ack logging)
  severity: CheckSeverity
  message: string                            // owner-facing
  affected_shift_ids: string[]
  affected_staff_uids: string[]
  affected_dates: string[]
}

export interface ShiftLike {
  id:            string
  staff_uid:     string | null
  staff_name:    string | null
  shift_date:    string                     // YYYY-MM-DD
  start_at:      string                     // ISO
  end_at:        string                     // ISO
  breaks_seconds: number
  shift_kind:    string                     // 'regular' | 'semester' | etc.
}

export interface StaffProfileLike {
  staff_uid:           string
  display_name:        string | null
  service_grade_pct:   number | null         // contract %; 100 = full-time
  hourly_rate_sek:     number | null
}

export interface ComplianceInput {
  shifts:           ShiftLike[]
  staff:            StaffProfileLike[]
  business_rules: {
    lone_closer_allowed?:   boolean          // if false, single-person closing shifts WARN
    min_rest_between_shifts_hours?: number   // default 11 (Arbetstidslagen)
    max_consecutive_days?:  number           // default 6
    max_weekly_hours?:      number           // default 48 (EU directive)
    contracted_hours_floor_pct?: number      // default 40 — don't schedule a 50%-contract person at <20%
  }
  /** Codes the owner has previously acknowledged (so WARNs don't keep reappearing). */
  acknowledged_codes?: string[]
}

/**
 * Run the compliance engine against a proposed roster.
 * Returns a list of checks; empty list = all clear.
 */
export function runCompliance(input: ComplianceInput): ComplianceCheck[] {
  const checks: ComplianceCheck[] = []
  const rules = input.business_rules ?? {}
  const minRestHours    = rules.min_rest_between_shifts_hours ?? 11
  const maxConsecDays   = rules.max_consecutive_days ?? 6
  const maxWeeklyHours  = rules.max_weekly_hours ?? 48
  const contractFloorPct = rules.contracted_hours_floor_pct ?? 40
  const acked = new Set(input.acknowledged_codes ?? [])

  // Group shifts by staff_uid for per-person checks
  const byStaff = new Map<string, ShiftLike[]>()
  for (const s of input.shifts) {
    if (!s.staff_uid || s.shift_kind !== 'regular') continue
    const arr = byStaff.get(s.staff_uid)
    if (arr) arr.push(s); else byStaff.set(s.staff_uid, [s])
  }
  for (const arr of byStaff.values()) arr.sort((a, b) => a.start_at.localeCompare(b.start_at))

  // Lookup staff profile by uid
  const profById = new Map(input.staff.map(p => [p.staff_uid, p]))

  // ── Per-staff checks ──────────────────────────────────────────
  for (const [staffUid, shifts] of byStaff) {
    const profile = profById.get(staffUid)
    const name = profile?.display_name ?? staffUid

    // CHECK 1: Min rest between shifts (Arbetstidslagen 13§ — 11h)
    for (let i = 1; i < shifts.length; i++) {
      const prevEnd = new Date(shifts[i - 1].end_at).getTime()
      const thisStart = new Date(shifts[i].start_at).getTime()
      const restHours = (thisStart - prevEnd) / 3600_000
      if (restHours < minRestHours - 0.01) {
        checks.push({
          code: `min_rest:${staffUid}:${shifts[i - 1].id}:${shifts[i].id}`,
          severity: 'HARD',
          message: `${name} has only ${restHours.toFixed(1)}h rest between shifts on ${shifts[i - 1].shift_date} and ${shifts[i].shift_date} (legal minimum ${minRestHours}h).`,
          affected_shift_ids:  [shifts[i - 1].id, shifts[i].id],
          affected_staff_uids: [staffUid],
          affected_dates:      [shifts[i - 1].shift_date, shifts[i].shift_date],
        })
      }
    }

    // CHECK 2: Max consecutive working days (default 6 per Arbetstidslagen 14§ — 36h continuous rest in 7 days)
    let runStart = 0
    let runDates: string[] = []
    let runShiftIds: string[] = []
    const datesWorked = new Set(shifts.map(s => s.shift_date))
    const sortedDates = Array.from(datesWorked).sort()
    for (let i = 0; i < sortedDates.length; i++) {
      if (runDates.length === 0) {
        runDates = [sortedDates[i]]
      } else {
        const prev = new Date(runDates[runDates.length - 1] + 'T00:00:00Z')
        prev.setUTCDate(prev.getUTCDate() + 1)
        if (prev.toISOString().slice(0, 10) === sortedDates[i]) {
          runDates.push(sortedDates[i])
        } else {
          runDates = [sortedDates[i]]
        }
      }
      if (runDates.length > maxConsecDays) {
        runShiftIds = shifts.filter(s => runDates.includes(s.shift_date)).map(s => s.id)
        checks.push({
          code: `consec_days:${staffUid}:${runDates[0]}`,
          severity: 'HARD',
          message: `${name} would work ${runDates.length} consecutive days (${runDates[0]} → ${runDates[runDates.length - 1]}). Legal max is ${maxConsecDays} days.`,
          affected_shift_ids:  runShiftIds,
          affected_staff_uids: [staffUid],
          affected_dates:      [...runDates],
        })
        break
      }
    }

    // CHECK 3: Max weekly hours (default 48h EU directive)
    let totalSecsThisWeek = 0
    for (const s of shifts) {
      totalSecsThisWeek +=
        (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 1000
        - (s.breaks_seconds ?? 0)
    }
    const totalHoursThisWeek = totalSecsThisWeek / 3600
    if (totalHoursThisWeek > maxWeeklyHours + 0.1) {
      checks.push({
        code: `max_weekly:${staffUid}`,
        severity: 'HARD',
        message: `${name} would work ${totalHoursThisWeek.toFixed(1)}h this week. EU max is ${maxWeeklyHours}h.`,
        affected_shift_ids:  shifts.map(s => s.id),
        affected_staff_uids: [staffUid],
        affected_dates:      Array.from(datesWorked),
      })
    }

    // CHECK 4: Contracted-hours floor (WARN)
    if (profile?.service_grade_pct != null && profile.service_grade_pct > 0) {
      const expectedHoursAtContract = (profile.service_grade_pct / 100) * 40   // 40h baseline for 100% contract
      const floorHours = (contractFloorPct / 100) * expectedHoursAtContract
      if (totalHoursThisWeek < floorHours - 0.1) {
        const code = `contract_floor:${staffUid}`
        if (!acked.has(code)) {
          checks.push({
            code,
            severity: 'WARN',
            message: `${name} has a ${profile.service_grade_pct}% contract (expected ~${expectedHoursAtContract.toFixed(0)}h/week) but is only scheduled for ${totalHoursThisWeek.toFixed(1)}h. Below ${contractFloorPct}% of contract.`,
            affected_shift_ids:  shifts.map(s => s.id),
            affected_staff_uids: [staffUid],
            affected_dates:      Array.from(datesWorked),
          })
        }
      }
    }

    // CHECK 5: Break compliance (WARN) — Swedish recommendation, not strict law
    for (const s of shifts) {
      const shiftHours = (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 3600_000
      const breakMins = (s.breaks_seconds ?? 0) / 60
      if (shiftHours > 6 && breakMins < 30) {
        const code = `break_compliance:${s.id}`
        if (!acked.has(code)) {
          checks.push({
            code,
            severity: 'WARN',
            message: `${name}'s ${s.shift_date} shift is ${shiftHours.toFixed(1)}h but has only ${breakMins.toFixed(0)}min break scheduled. Recommended ≥30min for shifts >6h.`,
            affected_shift_ids:  [s.id],
            affected_staff_uids: [staffUid],
            affected_dates:      [s.shift_date],
          })
        }
      }
    }
  }

  // ── Per-day checks ────────────────────────────────────────────
  // CHECK 6: Lone closer (WARN — only if business has lone_closer_allowed=false)
  if (rules.lone_closer_allowed === false) {
    const byDate = new Map<string, ShiftLike[]>()
    for (const s of input.shifts) {
      if (s.shift_kind !== 'regular') continue
      const arr = byDate.get(s.shift_date)
      if (arr) arr.push(s); else byDate.set(s.shift_date, [s])
    }
    for (const [date, shifts] of byDate) {
      // Closing = last shift ending after 21:00
      const closingShifts = shifts.filter(s => {
        const endHour = new Date(s.end_at).getUTCHours()
        return endHour >= 21 || endHour < 4   // wraps past midnight
      })
      // Group by approximate end time (within 30min)
      if (closingShifts.length === 1) {
        const code = `lone_closer:${date}`
        if (!acked.has(code)) {
          checks.push({
            code,
            severity: 'WARN',
            message: `${date}: only one closer scheduled (${closingShifts[0].staff_name ?? closingShifts[0].staff_uid}). Business has lone-closer policy enabled.`,
            affected_shift_ids:  [closingShifts[0].id],
            affected_staff_uids: closingShifts[0].staff_uid ? [closingShifts[0].staff_uid] : [],
            affected_dates:      [date],
          })
        }
      }
    }
  }

  return checks
}

/**
 * Convenience accessor — returns true when ANY HARD check is present.
 * Apply button uses this directly to decide whether to disable.
 */
export function hasHardFailures(checks: ComplianceCheck[]): boolean {
  return checks.some(c => c.severity === 'HARD')
}
