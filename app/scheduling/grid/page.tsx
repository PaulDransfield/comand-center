'use client'
// app/scheduling/grid/page.tsx
//
// Phase 1 of AI-SCHEDULING-PLAN.md — the rota grid page. Reads live
// data from /api/scheduling/week (which sources from M100 tables that
// scheduling-sync cron populates from PK).
//
// Two views, owner-togglable:
//   - Shift view (default, PK-native): rows = templates grouped by
//     section, columns = days, cells stack assigned-staff blocks.
//   - Staff view: rows = staff grouped by primary section, columns =
//     days, cells = the shifts that person is on that day.
//
// Phase 2 will overlay AI-suggested cells (orange dashed) and the
// pre-publish review panel. This page already supports the data shape
// they need.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface DayHeader {
  date: string
  day_of_week: string
  day_number: number
  planned_hours: number
  planned_cost: number
  forecast_revenue: number | null
  projected_staff_pct: number | null
  target_staff_pct: number | null
  weather: { icon: string; temp_c: number | null; precip_mm: number | null } | null
  holiday: { name_sv: string; name_en: string; impact: 'high' | 'low' | null } | null
  shifts_count: number
}
interface Template {
  id: string
  name: string
  section: string | null
  display_colour: string | null
  modal_start_time: string | null
  modal_end_time: string | null
  sort_order: number
  shifts_count_60d: number
}
interface Profile {
  staff_uid: string
  display_name: string | null
  full_name: string | null
  primary_section: string | null
  salary_type: string | null
  hourly_rate_sek: number | null
  service_grade_pct: number | null
  typical_shift_window: string | null
}
interface Shift {
  id: string
  staff_uid: string | null
  shift_date: string
  start_at: string
  end_at: string
  start_time_local: string | null
  end_time_local: string | null
  staff_name: string | null
  period_name: string | null
  description: string | null
  estimated_cost: number | null
  shift_template_id: string | null
  shift_kind: string
  breaks_seconds: number
  has_ob: boolean
  ob_hours: number | null
  is_published: boolean
  is_ai_suggested: boolean
}
interface WeekPayload {
  business: { id: string; name: string; country: string; target_staff_pct: number | null }
  week: {
    week_iso: string
    range_from: string
    range_to: string
    planned_cost_sek: number
    forecast_revenue_sek: number
    projected_staff_pct: number | null
    target_staff_pct: number | null
    gap_pct: number | null
    total_shifts: number
    semester_shifts: number
    staff_scheduled: number
  }
  days: DayHeader[]
  templates: Template[]
  profiles: Profile[]
  shifts: Shift[]
}

type ViewMode = 'shift' | 'staff'

const SECTION_LABELS: Record<string, string> = {
  management: 'Management',
  foh:        'Front of House',
  kitchen:    'Kitchen',
  bar:        'Bar',
  office:     'Office',
  other:      'Other',
}
const SECTION_ORDER = ['management', 'foh', 'kitchen', 'bar', 'office', 'other']

export default function SchedulingGridPage() {
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [weekIso,  setWeekIso]  = useState<string>(() => isoWeekToday())
  const [view,     setView]     = useState<ViewMode>('shift')
  const [data,     setData]     = useState<WeekPayload | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [syncing,  setSyncing]  = useState(false)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    const v = localStorage.getItem('cc_scheduling_view') as ViewMode | null
    if (v === 'shift' || v === 'staff') setView(v)
  }, [])

  const setViewPersist = (v: ViewMode) => {
    setView(v)
    try { localStorage.setItem('cc_scheduling_view', v) } catch {}
  }

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/scheduling/week?business_id=${encodeURIComponent(bizId)}&week=${weekIso}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId, weekIso])

  useEffect(() => { if (bizId) load() }, [bizId, load])

  function shiftWeek(delta: number) {
    setWeekIso(prev => addWeeks(prev, delta))
  }

  // Index shifts by (date, template_id) and by (date, staff_uid) for O(1) cell lookup
  const shiftsByDateTemplate = useMemo(() => {
    const m = new Map<string, Shift[]>()
    if (!data) return m
    for (const s of data.shifts) {
      const k = `${s.shift_date}|${s.shift_template_id ?? 'null'}`
      const arr = m.get(k); if (arr) arr.push(s); else m.set(k, [s])
    }
    return m
  }, [data])

  const shiftsByDateStaff = useMemo(() => {
    const m = new Map<string, Shift[]>()
    if (!data) return m
    for (const s of data.shifts) {
      const k = `${s.shift_date}|${s.staff_uid ?? 'unassigned'}`
      const arr = m.get(k); if (arr) arr.push(s); else m.set(k, [s])
    }
    return m
  }, [data])

  // Group templates by section, ordered
  const templatesBySection = useMemo(() => {
    const groups: Record<string, Template[]> = {}
    if (!data) return groups
    for (const t of data.templates) {
      const sec = t.section ?? 'other'
      if (!groups[sec]) groups[sec] = []
      groups[sec].push(t)
    }
    return groups
  }, [data])

  const profilesBySection = useMemo(() => {
    const groups: Record<string, Profile[]> = {}
    if (!data) return groups
    for (const p of data.profiles) {
      const sec = p.primary_section ?? 'other'
      if (!groups[sec]) groups[sec] = []
      groups[sec].push(p)
    }
    return groups
  }, [data])

  async function syncFromPK() {
    if (!bizId || syncing) return
    setSyncing(true)
    try {
      const r = await fetch('/api/scheduling/sync-now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId }),
        cache: 'no-store',
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(`Sync failed: ${j.error ?? r.status}`)
      } else {
        await load()
      }
    } finally { setSyncing(false) }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1400, padding: '20px 24px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Scheduling</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
              Live roster from Personalkollen. Week {weekIso}.
              {data && ` ${data.week.staff_scheduled} staff · ${data.week.total_shifts} shifts.`}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <button onClick={() => shiftWeek(-1)} style={navBtn()}>&lt; Prev</button>
            <button onClick={() => setWeekIso(isoWeekToday())} style={navBtn()}>This week</button>
            <button onClick={() => shiftWeek(+1)} style={navBtn()}>Next &gt;</button>
            <span style={{ width: 14 }} />
            <div style={{ display: 'flex', background: UXP.subtleBg, border: `0.5px solid ${UXP.border}`, borderRadius: 6, padding: 2 }}>
              <button onClick={() => setViewPersist('shift')} style={viewToggleBtn(view === 'shift')}>By shift</button>
              <button onClick={() => setViewPersist('staff')} style={viewToggleBtn(view === 'staff')}>By staff</button>
            </div>
            <button onClick={syncFromPK} disabled={syncing} style={navBtn()}>
              {syncing ? 'Syncing…' : 'Sync from PK'}
            </button>
          </div>
        </div>

        {/* Week summary strip */}
        {data && (
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 14,
          }}>
            <Kpi label="Planned cost (week)" value={fmtKr(data.week.planned_cost_sek)} />
            <Kpi label="Forecast revenue" value={data.week.forecast_revenue_sek > 0 ? fmtKr(data.week.forecast_revenue_sek) : '—'} />
            <Kpi
              label="Projected labour %"
              value={data.week.projected_staff_pct != null ? data.week.projected_staff_pct.toFixed(1) + '%' : '—'}
              sub={data.week.target_staff_pct != null ? `Target ${data.week.target_staff_pct}%` : undefined}
              tone={data.week.gap_pct != null ? (data.week.gap_pct > 2 ? 'rose' : data.week.gap_pct < -2 ? 'green' : 'neutral') : 'neutral'}
            />
            <Kpi
              label="Gap to target"
              value={data.week.gap_pct != null ? (data.week.gap_pct > 0 ? '+' : '') + data.week.gap_pct.toFixed(1) + '%' : '—'}
              tone={data.week.gap_pct != null ? (data.week.gap_pct > 2 ? 'rose' : data.week.gap_pct < -2 ? 'green' : 'neutral') : 'neutral'}
            />
          </div>
        )}

        {error && (
          <div style={{ padding: 12, background: UXP.roseFill, color: UXP.roseText, borderRadius: 6, marginBottom: 12, fontSize: 12 }}>
            {error}
          </div>
        )}

        {loading && !data && <div style={{ fontSize: 12, color: UXP.ink3 }}>Loading…</div>}

        {!loading && data && data.shifts.length === 0 && (
          <Empty>
            <strong>No shifts yet for this week.</strong><br />
            Click <em>Sync from PK</em> above to pull the latest roster from Personalkollen.
            {data.templates.length === 0 && ' No templates have been seen yet either — first sync will build them.'}
          </Empty>
        )}

        {data && data.shifts.length > 0 && (
          <div style={{
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 10, overflow: 'hidden',
          }}>
            {/* Day headers row */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: `220px repeat(7, 1fr)`,
              borderBottom: `0.5px solid ${UXP.border}`,
              background: UXP.subtleBg,
            }}>
              <div style={{ padding: '10px 14px', fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                {view === 'shift' ? 'Shift template' : 'Staff'}
              </div>
              {data.days.map(d => (
                <DayHeaderCell key={d.date} day={d} />
              ))}
            </div>

            {/* Body — shift view */}
            {view === 'shift' && SECTION_ORDER.filter(sec => templatesBySection[sec]?.length > 0).map(sec => (
              <div key={sec}>
                <SectionHeader label={SECTION_LABELS[sec] ?? sec} count={templatesBySection[sec].length} />
                {templatesBySection[sec].map(template => (
                  <TemplateRow
                    key={template.id}
                    template={template}
                    days={data.days}
                    shifts={shiftsByDateTemplate}
                  />
                ))}
              </div>
            ))}

            {/* Body — staff view */}
            {view === 'staff' && SECTION_ORDER.filter(sec => profilesBySection[sec]?.length > 0).map(sec => (
              <div key={sec}>
                <SectionHeader label={SECTION_LABELS[sec] ?? sec} count={profilesBySection[sec].length} />
                {profilesBySection[sec].map(profile => (
                  <StaffRow
                    key={profile.staff_uid}
                    profile={profile}
                    days={data.days}
                    shifts={shiftsByDateStaff}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        <p style={{ fontSize: 11, color: UXP.ink4, marginTop: 12, lineHeight: 1.6 }}>
          Phase 1. AI-recommended changes overlay coming in Phase 2 (orange dashed cells with Approve / Modify / Reject).
          Source of truth is Personalkollen — apply changes there until Phase 2 ships the clipboard-export flow.
        </p>
      </div>
    </AppShell>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components

function DayHeaderCell({ day }: { day: DayHeader }) {
  const isWeekend = day.day_of_week === 'Sat' || day.day_of_week === 'Sun'
  const isHoliday = !!day.holiday
  const dateFg = (isWeekend || isHoliday) ? UXP.rose : UXP.ink2
  return (
    <div style={{
      padding: '8px 10px',
      borderLeft: `0.5px solid ${UXP.borderSoft}`,
      minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 11, fontWeight: 500, color: dateFg }}>{day.day_of_week} {day.day_number}</span>
        {day.holiday && (
          <span title={day.holiday.name_en} style={{ fontSize: 9, color: UXP.roseText, fontStyle: 'italic' as const }}>
            {day.holiday.name_en.slice(0, 12)}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: UXP.ink4, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>
        <span>{day.forecast_revenue != null ? fmtKr(day.forecast_revenue) : '—'}</span>
        <span>{day.planned_hours}h</span>
      </div>
      <div style={{ marginTop: 4 }}>
        {day.projected_staff_pct != null && day.target_staff_pct != null && (() => {
          const gap = day.projected_staff_pct - day.target_staff_pct
          const tone = gap > 2 ? 'rose' : gap < -2 ? 'green' : 'neutral'
          const bg = tone === 'rose' ? UXP.roseFill : tone === 'green' ? UXP.greenFill : UXP.subtleBg
          const fg = tone === 'rose' ? UXP.roseText : tone === 'green' ? UXP.greenDeep : UXP.ink3
          return (
            <span style={{ fontSize: 9, fontWeight: 500, color: fg, background: bg, borderRadius: 999, padding: '2px 7px' }}>
              {day.projected_staff_pct.toFixed(0)}%
            </span>
          )
        })()}
      </div>
    </div>
  )
}

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `220px repeat(7, 1fr)`,
      background: UXP.lavFill, borderBottom: `0.5px solid ${UXP.borderSoft}`,
    }}>
      <div style={{ padding: '6px 14px', fontSize: 10, fontWeight: 500, color: UXP.lavText, letterSpacing: '0.02em' }}>
        {label} <span style={{ color: UXP.ink4, fontWeight: 400, marginLeft: 6 }}>{count}</span>
      </div>
      <div style={{ gridColumn: 'span 7', borderLeft: `0.5px solid ${UXP.borderSoft}` }} />
    </div>
  )
}

function TemplateRow({ template, days, shifts }: {
  template: Template
  days:     DayHeader[]
  shifts:   Map<string, Shift[]>
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `220px repeat(7, 1fr)`,
      borderBottom: `0.5px solid ${UXP.borderSoft}`,
    }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: template.display_colour ?? '#9b9b9b', flexShrink: 0 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {template.name}
          </div>
          {template.modal_start_time && template.modal_end_time && (
            <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>
              {template.modal_start_time.slice(0,5)}–{template.modal_end_time.slice(0,5)}
            </div>
          )}
        </div>
      </div>
      {days.map(d => {
        const cellShifts = shifts.get(`${d.date}|${template.id}`) ?? []
        return (
          <div key={d.date} style={{ borderLeft: `0.5px solid ${UXP.borderSoft}`, padding: 4, display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
            {cellShifts.map(s => (
              <ShiftBlock key={s.id} shift={s} colour={template.display_colour ?? '#a99ce6'} showStaff />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function StaffRow({ profile, days, shifts }: {
  profile: Profile
  days:    DayHeader[]
  shifts:  Map<string, Shift[]>
}) {
  const initials = (profile.display_name ?? profile.full_name ?? '?').split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase()
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `220px repeat(7, 1fr)`,
      borderBottom: `0.5px solid ${UXP.borderSoft}`,
    }}>
      <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 9 }}>
        <span style={{
          width: 26, height: 26, borderRadius: '50%', background: UXP.lavFill, color: UXP.lavText,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 9, fontWeight: 500, flexShrink: 0,
        }}>{initials}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 11, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {profile.display_name ?? profile.full_name ?? profile.staff_uid}
          </div>
          {profile.service_grade_pct != null && (
            <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1 }}>
              {profile.service_grade_pct}% {profile.salary_type === 'monthly' ? 'monthly' : 'hourly'}
            </div>
          )}
        </div>
      </div>
      {days.map(d => {
        const cellShifts = shifts.get(`${d.date}|${profile.staff_uid}`) ?? []
        return (
          <div key={d.date} style={{ borderLeft: `0.5px solid ${UXP.borderSoft}`, padding: 4, display: 'flex', flexDirection: 'column' as const, gap: 3 }}>
            {cellShifts.map(s => (
              <ShiftBlock key={s.id} shift={s} colour={'#a99ce6'} showTemplate />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function ShiftBlock({ shift, colour, showStaff, showTemplate }: {
  shift: Shift; colour: string; showStaff?: boolean; showTemplate?: boolean
}) {
  if (shift.shift_kind === 'semester') {
    return (
      <div style={{
        background: '#e6eef8', borderRadius: 4, padding: '5px 8px', textAlign: 'center' as const,
      }}>
        <div style={{ fontSize: 9, fontWeight: 500, color: '#3f6aa3' }}>Semester</div>
        {showStaff && shift.staff_name && (
          <div style={{ fontSize: 9, color: '#3f6aa3', opacity: 0.7 }}>{shift.staff_name}</div>
        )}
      </div>
    )
  }
  const isAi  = shift.is_ai_suggested
  const isDraft = !shift.is_published
  const bg = isAi
    ? '#fbf2eb'                                       // dashed orange when AI-suggested
    : isDraft
      ? `${colour}33`                                  // 20% opacity draft tint
      : `${colour}55`                                  // 33% opacity published
  const borderStyle = isAi ? '0.5px dashed rgba(192,112,58,0.5)' : `0.5px solid ${colour}66`
  return (
    <div style={{
      background: bg, border: borderStyle, borderRadius: 4, padding: '5px 7px',
      minWidth: 0, overflow: 'hidden' as const,
    }}>
      {showStaff && shift.staff_name && (
        <div style={{ fontSize: 9, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
          {shift.staff_name}
        </div>
      )}
      {showTemplate && shift.period_name && (
        <div style={{ fontSize: 9, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
          {shift.period_name}
        </div>
      )}
      <div style={{ fontSize: 9, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
        {(shift.start_time_local ?? '').slice(0, 5)}–{(shift.end_time_local ?? '').slice(0, 5)}
        {isAi && <span style={{ color: '#a96a3c', marginLeft: 4, fontWeight: 500 }}>AI</span>}
      </div>
    </div>
  )
}

// ── Atoms ────────────────────────────────────────────────────────────

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'rose' | 'green' | 'neutral' }) {
  const colour = tone === 'rose' ? UXP.rose : tone === 'green' ? UXP.green : UXP.ink1
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, padding: 12 }}>
      <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 500, color: colour, marginTop: 4, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
      {sub && <div style={{ fontSize: 10, color: UXP.ink3, marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 32, textAlign: 'center' as const, fontSize: 12, color: UXP.ink3, background: UXP.cardBg, border: `0.5px dashed ${UXP.border}`, borderRadius: 8, lineHeight: 1.7 }}>{children}</div>
  )
}

function navBtn(): React.CSSProperties {
  return {
    padding: '5px 12px', fontSize: 11, fontWeight: 500,
    background: 'transparent', color: UXP.ink2,
    border: `0.5px solid ${UXP.border}`, borderRadius: 6,
    cursor: 'pointer', fontFamily: 'inherit',
  }
}
function viewToggleBtn(active: boolean): React.CSSProperties {
  return {
    padding: '4px 12px', fontSize: 11, fontWeight: 500,
    background: active ? UXP.cardBg : 'transparent',
    color: active ? UXP.ink1 : UXP.ink3,
    border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.05)' : 'none',
  }
}

// ── Week helpers ─────────────────────────────────────────────────────

function isoWeekToday(): string {
  return isoWeekFor(new Date())
}
function isoWeekFor(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dn = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - dn + 3)
  const ft = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const wn = 1 + Math.round(((t.getTime() - ft.getTime()) / 86400000 - 3 + ((ft.getUTCDay() + 6) % 7)) / 7)
  return `${t.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`
}
function addWeeks(weekIso: string, delta: number): string {
  const [y, w] = weekIso.split('-W').map(Number)
  // Approx: find Monday of given week, add 7×delta days, recompute ISO
  const jan4 = new Date(Date.UTC(y, 0, 4))
  const jan4Dow = (jan4.getUTCDay() + 6) % 7
  const week1Mon = new Date(jan4); week1Mon.setUTCDate(jan4.getUTCDate() - jan4Dow)
  const mon = new Date(week1Mon); mon.setUTCDate(week1Mon.getUTCDate() + (w - 1) * 7 + delta * 7)
  return isoWeekFor(mon)
}
