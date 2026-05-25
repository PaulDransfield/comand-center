'use client'
// app/scheduling/page.tsx
//
// The rota grid (Phase 1 + 2 of AI-SCHEDULING-PLAN.md). Reads live
// data from /api/scheduling/week (which sources from M100 tables that
// scheduling-sync cron populates from PK).
//
// Two views, owner-togglable:
//   - Shift view (default, PK-native): rows = templates grouped by
//     section, columns = days, cells stack assigned-staff blocks.
//   - Staff view: rows = staff grouped by primary section, columns =
//     days, cells = the shifts that person is on that day.
//
// AI Phase 2 overlay: pending suggestions render INLINE on the affected
// shift cell — orange-dashed border, strike-through original time,
// proposed time + saving, mini ✓/× buttons. Tap to expand reasoning.
// Pre-publish ReviewPanel slide-up has 4 KPI tabs + compliance engine.

export const dynamic = 'force-dynamic'

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import { runCompliance, hasHardFailures, type ComplianceCheck } from '@/lib/scheduling/compliance'

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
interface AISuggestion {
  id: string
  week_iso: string
  shift_date: string | null
  action: 'cut' | 'reduce' | 'extend' | 'reassign' | 'add' | 'swap_template'
  target_staff_uid: string | null
  target_shift_id: string | null
  target_template_id: string | null
  before: any
  proposed: any
  reasoning: string | null
  est_sek_saving: number | null
  confidence: number
  status: 'pending' | 'approved' | 'modified' | 'rejected' | 'applied' | 'expired'
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
  suggestions: AISuggestion[]
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
  const [bizId,        setBizId]        = useState<string | null>(null)
  const [weekIso,      setWeekIso]      = useState<string>(() => isoWeekToday())
  const [view,         setView]         = useState<ViewMode>('shift')
  const [data,         setData]         = useState<WeekPayload | null>(null)
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState<string | null>(null)
  const [syncing,      setSyncing]      = useState(false)
  const [generatingAi, setGeneratingAi] = useState(false)
  const [reviewOpen,   setReviewOpen]   = useState(false)
  const [applying,     setApplying]     = useState(false)

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

  // Index pending suggestions by the shift they target — for inline grid overlay.
  // Multiple suggestions on the same shift: keep the highest-confidence one.
  const pendingByShiftId = useMemo(() => {
    const m = new Map<string, AISuggestion>()
    if (!data) return m
    for (const s of data.suggestions) {
      if (s.status !== 'pending' || !s.target_shift_id) continue
      const existing = m.get(s.target_shift_id)
      if (!existing || s.confidence > existing.confidence) m.set(s.target_shift_id, s)
    }
    return m
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

  async function generateAiSuggestions(force = false) {
    if (!bizId || generatingAi) return
    setGeneratingAi(true)
    try {
      const r = await fetch('/api/scheduling/ai-recommend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ business_id: bizId, week_iso: weekIso, force }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) {
        alert(`AI generation failed: ${j.error ?? r.status}`)
      } else {
        await load()
      }
    } finally { setGeneratingAi(false) }
  }

  async function actOnSuggestion(suggestionId: string, action: 'approved' | 'rejected', reason?: string) {
    try {
      const r = await fetch('/api/scheduling/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ suggestion_id: suggestionId, action, reason }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        alert(`Action failed: ${j.error ?? r.status}`)
      }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function applyApproved() {
    if (!data) return
    const approved = data.suggestions.filter(s => s.status === 'approved')
    if (approved.length === 0) {
      alert('No approved suggestions to apply. Approve at least one first.')
      return
    }
    setApplying(true)
    try {
      // Generate clipboard summary
      const summary = renderApplySummary(data, approved)
      try { await navigator.clipboard.writeText(summary) } catch {
        // older browser fallback — show in a prompt for manual copy
        window.prompt('Copy this summary then click OK to open Personalkollen:', summary)
      }
      // Mark all approved as applied (best-effort)
      for (const s of approved) {
        await fetch('/api/scheduling/learn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ suggestion_id: s.id, action: 'applied' }),
        })
      }
      await load()
      // Open Personalkollen in a new tab
      window.open('https://personalkollen.se/schema/', '_blank', 'noopener,noreferrer')
    } finally { setApplying(false) }
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

        {/* AI assist banner */}
        {data && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
            padding: '12px 16px',
            background: (data.suggestions?.length ?? 0) > 0 ? UXP.lavFill : UXP.subtleBg,
            border: `0.5px solid ${(data.suggestions?.length ?? 0) > 0 ? UXP.lavMid : UXP.border}`,
            borderRadius: 10, flexWrap: 'wrap' as const,
          }}>
            <span style={{
              fontSize: 9, fontWeight: 600, color: '#fff',
              letterSpacing: '0.04em', textTransform: 'uppercase' as const,
              padding: '3px 8px', background: UXP.lavMid, borderRadius: 4,
            }}>AI</span>
            {(() => {
              const sugg = data.suggestions ?? []
              const pending = sugg.filter(s => s.status === 'pending')
              const approved = sugg.filter(s => s.status === 'approved')
              const totalSaving = sugg.reduce((sum, s) => sum + (s.est_sek_saving ?? 0), 0)
              if (sugg.length === 0) {
                return (
                  <>
                    <span style={{ fontSize: 12, color: UXP.ink2, flex: 1 }}>
                      No AI suggestions for this week yet. Generate to see proposed shift changes that move the schedule toward your target staff %.
                    </span>
                    <button
                      onClick={() => generateAiSuggestions(false)}
                      disabled={generatingAi}
                      style={primaryAiBtn(generatingAi)}>
                      {generatingAi ? 'Generating…' : 'Generate AI suggestions'}
                    </button>
                  </>
                )
              }
              return (
                <>
                  <span style={{ fontSize: 12, color: UXP.lavText, fontWeight: 500 }}>
                    {sugg.length} suggestion{sugg.length === 1 ? '' : 's'}
                    {totalSaving > 0 && ` · saves ${fmtKr(totalSaving)} this week`}
                  </span>
                  <span style={{ fontSize: 11, color: UXP.ink3 }}>
                    {pending.length} pending · {approved.length} approved
                  </span>
                  <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
                    <button onClick={() => generateAiSuggestions(true)} disabled={generatingAi} style={navBtn()}>
                      {generatingAi ? 'Generating…' : 'Regenerate'}
                    </button>
                    <button onClick={() => setReviewOpen(true)} style={navBtn()}>
                      Review {approved.length > 0 ? `(${approved.length})` : ''}
                    </button>
                    {approved.length > 0 && (
                      <button onClick={applyApproved} disabled={applying} style={primaryAiBtn(applying)}>
                        {applying ? 'Applying…' : `Apply ${approved.length} & open PK`}
                      </button>
                    )}
                  </div>
                </>
              )
            })()}
          </div>
        )}

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
                    pendingByShiftId={pendingByShiftId}
                    onSuggestionAction={actOnSuggestion}
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
                    pendingByShiftId={pendingByShiftId}
                    onSuggestionAction={actOnSuggestion}
                  />
                ))}
              </div>
            ))}
          </div>
        )}

        {/* AI suggestions panel — appears below the grid when there are pending/approved suggestions */}
        {data && data.suggestions && data.suggestions.length > 0 && (
          <SuggestionsPanel
            suggestions={data.suggestions}
            shifts={data.shifts}
            templates={data.templates}
            profiles={data.profiles}
            onAction={actOnSuggestion}
          />
        )}

        <p style={{ fontSize: 11, color: UXP.ink4, marginTop: 12, lineHeight: 1.6 }}>
          Orange-dashed cells show pending AI suggestions — original time struck through, proposed time in orange, savings on the right.
          Click <strong style={{ color: UXP.greenDeep }}>✓</strong> to approve or <strong>×</strong> to reject directly in the cell. Tap the cell to see the AI's reasoning.
          When you've reviewed the week, click <strong>Apply &amp; open PK</strong> — we'll copy a summary to your clipboard since PK doesn't accept third-party writes.
        </p>
      </div>

      {reviewOpen && data && (
        <ReviewPanel
          data={data}
          onClose={() => setReviewOpen(false)}
          onApply={async () => { setReviewOpen(false); await applyApproved() }}
        />
      )}
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

function TemplateRow({ template, days, shifts, pendingByShiftId, onSuggestionAction }: {
  template: Template
  days:     DayHeader[]
  shifts:   Map<string, Shift[]>
  pendingByShiftId:    Map<string, AISuggestion>
  onSuggestionAction:  (id: string, action: 'approved' | 'rejected', reason?: string) => Promise<void>
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
              <ShiftBlock key={s.id} shift={s}
                colour={template.display_colour ?? '#a99ce6'} showStaff
                pendingSuggestion={pendingByShiftId.get(s.id) ?? null}
                onSuggestionAction={onSuggestionAction} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function StaffRow({ profile, days, shifts, pendingByShiftId, onSuggestionAction }: {
  profile: Profile
  days:    DayHeader[]
  shifts:  Map<string, Shift[]>
  pendingByShiftId:    Map<string, AISuggestion>
  onSuggestionAction:  (id: string, action: 'approved' | 'rejected', reason?: string) => Promise<void>
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
              <ShiftBlock key={s.id} shift={s}
                colour={'#a99ce6'} showTemplate
                pendingSuggestion={pendingByShiftId.get(s.id) ?? null}
                onSuggestionAction={onSuggestionAction} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function ShiftBlock({ shift, colour, showStaff, showTemplate, pendingSuggestion, onSuggestionAction }: {
  shift: Shift; colour: string; showStaff?: boolean; showTemplate?: boolean
  pendingSuggestion?:   AISuggestion | null
  onSuggestionAction?:  (id: string, action: 'approved' | 'rejected', reason?: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState(false)

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
  const isAi    = shift.is_ai_suggested
  const isDraft = !shift.is_published
  const hasSugg = !!pendingSuggestion

  const bg = hasSugg
    ? '#fbf2eb'                                       // soft orange when suggestion is pending
    : isAi
      ? '#fbf2eb'                                     // dashed orange when AI-generated shift
      : isDraft
        ? `${colour}33`                                // 20% opacity draft tint
        : `${colour}55`                                // 33% opacity published
  const borderStyle = (hasSugg || isAi)
    ? '0.5px dashed rgba(192,112,58,0.65)'
    : `0.5px solid ${colour}66`

  const origStart = (shift.start_time_local ?? '').slice(0, 5)
  const origEnd   = (shift.end_time_local   ?? '').slice(0, 5)
  const diff      = hasSugg ? extractDiff(pendingSuggestion!, origStart, origEnd) : null

  async function act(action: 'approved' | 'rejected', e: React.MouseEvent) {
    e.stopPropagation()
    if (!pendingSuggestion || !onSuggestionAction || busy) return
    setBusy(true)
    try { await onSuggestionAction(pendingSuggestion.id, action) } finally { setBusy(false) }
  }

  return (
    <div
      onClick={() => hasSugg && setExpanded(!expanded)}
      style={{
        background: bg, border: borderStyle, borderRadius: 4, padding: '5px 7px',
        minWidth: 0, overflow: 'hidden' as const, position: 'relative' as const,
        cursor: hasSugg ? 'pointer' : 'default',
      }}>
      {/* Mini approve/reject buttons — top-right when suggestion pending */}
      {hasSugg && (
        <div style={{
          position: 'absolute' as const, top: 2, right: 2, display: 'flex', gap: 2,
        }}>
          <button onClick={(e) => act('approved', e)} disabled={busy} title="Approve change"
            style={miniSuggBtn(true)}>✓</button>
          <button onClick={(e) => act('rejected', e)} disabled={busy} title="Reject change"
            style={miniSuggBtn(false)}>×</button>
        </div>
      )}

      {showStaff && shift.staff_name && (
        <div style={{ fontSize: 9, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const, paddingRight: hasSugg ? 32 : 0 }}>
          {shift.staff_name}
        </div>
      )}
      {showTemplate && shift.period_name && (
        <div style={{ fontSize: 9, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const, paddingRight: hasSugg ? 32 : 0 }}>
          {shift.period_name}
        </div>
      )}

      {/* Time line — original times (struck through where changing), then proposed times */}
      {hasSugg && diff ? (
        <div style={{ fontSize: 9, fontVariantNumeric: 'tabular-nums' as const, lineHeight: 1.5, marginTop: 1 }}>
          <span style={{ color: UXP.ink4, textDecoration: 'line-through' }}>
            {origStart}–{origEnd}
          </span>
          <span style={{ color: '#a96a3c', marginLeft: 4, fontWeight: 600 }}>
            → {diff.newRange}
          </span>
          {diff.savedLabel && (
            <span style={{ color: '#a96a3c', marginLeft: 4 }}>
              ({diff.savedLabel})
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 9, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
          {origStart}–{origEnd}
          {isAi && <span style={{ color: '#a96a3c', marginLeft: 4, fontWeight: 500 }}>AI</span>}
        </div>
      )}

      {/* Savings + action label when suggestion present */}
      {hasSugg && (
        <div style={{
          fontSize: 9, marginTop: 2, color: UXP.lavText, display: 'flex',
          justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontWeight: 500 }}>{ACTION_LABELS[pendingSuggestion!.action] ?? pendingSuggestion!.action}</span>
          {pendingSuggestion!.est_sek_saving != null && (
            <span style={{ color: UXP.greenDeep, fontWeight: 500 }}>
              {pendingSuggestion!.est_sek_saving >= 0 ? '+' : ''}{Math.round(pendingSuggestion!.est_sek_saving)} kr
            </span>
          )}
        </div>
      )}

      {/* Click-to-expand reasoning */}
      {hasSugg && expanded && pendingSuggestion!.reasoning && (
        <div style={{
          marginTop: 4, paddingTop: 4, borderTop: `0.5px dashed rgba(192,112,58,0.4)`,
          fontSize: 9, color: UXP.ink2, lineHeight: 1.5, whiteSpace: 'normal' as const,
        }}>
          {pendingSuggestion!.reasoning}
        </div>
      )}
    </div>
  )
}

// Mini approve/reject button style for the inline overlay
function miniSuggBtn(isApprove: boolean): React.CSSProperties {
  return {
    width: 14, height: 14, padding: 0, fontSize: 10, lineHeight: '12px',
    background: isApprove ? UXP.greenDeep : '#fff',
    color: isApprove ? '#fff' : UXP.ink3,
    border: `0.5px solid ${isApprove ? UXP.greenDeep : 'rgba(192,112,58,0.5)'}`,
    borderRadius: 3, cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontWeight: 600,
  }
}

// Extract a compact visual diff between a shift's current times and the
// proposed AI suggestion. Handles reduce/extend/reassign — falls back to
// the proposed.description when we can't parse start/end cleanly.
function extractDiff(sugg: AISuggestion, origStart: string, origEnd: string): {
  newRange: string
  savedLabel: string | null
} | null {
  const p: any = sugg.proposed ?? {}
  const b: any = sugg.before   ?? {}

  // Try to pull HH:MM out of common shapes
  const newStart = pickTime(p.start ?? p.start_time ?? p.start_local)
  const newEnd   = pickTime(p.end   ?? p.end_time   ?? p.end_local)

  if (newStart || newEnd) {
    const ns = newStart ?? origStart
    const ne = newEnd   ?? origEnd
    // Compute hours saved
    let savedLabel: string | null = null
    if (p.hours != null && b.hours != null) {
      const delta = Number(b.hours) - Number(p.hours)
      if (Math.abs(delta) > 0.05) savedLabel = `${delta > 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}h`
    } else if (p.delta_hours != null) {
      const d = Number(p.delta_hours)
      if (d !== 0) savedLabel = `${d > 0 ? '+' : ''}${d.toFixed(1)}h`
    } else {
      // Compute from times directly
      const minsBefore = toMin(origEnd) - toMin(origStart)
      const minsAfter  = toMin(ne) - toMin(ns)
      if (Number.isFinite(minsBefore) && Number.isFinite(minsAfter)) {
        const deltaH = (minsBefore - minsAfter) / 60
        if (Math.abs(deltaH) > 0.05) savedLabel = `${deltaH > 0 ? '−' : '+'}${Math.abs(deltaH).toFixed(1)}h`
      }
    }
    return { newRange: `${ns}–${ne}`, savedLabel }
  }

  // Reassign — new staff name in proposed.staff_name
  if (p.staff_name && p.staff_name !== b.staff_name) {
    return { newRange: `→ ${p.staff_name}`, savedLabel: null }
  }
  // Template swap
  if ((p.template_name || p.period_name) && (p.template_name !== b.template_name || p.period_name !== b.period_name)) {
    return { newRange: `→ ${p.template_name ?? p.period_name}`, savedLabel: null }
  }
  // Cut — no replacement, just remove
  if (sugg.action === 'cut') {
    return { newRange: 'remove', savedLabel: null }
  }
  // Couldn't parse a structured diff — fall back to description
  if (typeof p.description === 'string') {
    return { newRange: p.description.slice(0, 40), savedLabel: null }
  }
  return null
}

function pickTime(v: any): string | null {
  if (!v) return null
  const s = String(v)
  const m = s.match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  return `${m[1].padStart(2, '0')}:${m[2]}`
}
function toMin(t: string): number {
  const m = t?.match?.(/^(\d{1,2}):(\d{2})/)
  if (!m) return NaN
  return Number(m[1]) * 60 + Number(m[2])
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

// ─────────────────────────────────────────────────────────────────────
// AI suggestions panel — collapsed summary below the grid.
//
// The grid cells themselves now render each pending suggestion inline
// (orange-dashed shift with strike-through original time, proposed time,
// savings, and mini ✓/× buttons). This panel is the "show me everything
// at once" fallback for orphan suggestions that don't bind to a shift
// (e.g. action='add' creating a new shift) and for the unsuggested
// orphan/audit view.

function SuggestionsPanel({
  suggestions, shifts, templates, profiles, onAction,
}: {
  suggestions: AISuggestion[]
  shifts:      Shift[]
  templates:   Template[]
  profiles:    Profile[]
  onAction:    (id: string, action: 'approved' | 'rejected', reason?: string) => Promise<void>
}) {
  const [expanded, setExpanded] = useState(false)

  const grouped = useMemo(() => {
    const by: Record<string, AISuggestion[]> = { pending: [], approved: [], rejected: [], applied: [] }
    for (const s of suggestions) if (by[s.status]) by[s.status].push(s)
    return by
  }, [suggestions])

  // Suggestions that don't bind to a shift visible in the grid — only
  // those need to be surfaced here (anything else is already shown inline).
  const orphan = useMemo(() => {
    const shiftIds = new Set(shifts.map(s => s.id))
    return suggestions.filter(s => !s.target_shift_id || !shiftIds.has(s.target_shift_id))
  }, [suggestions, shifts])

  // Sum savings across pending + approved
  const totalPotential = suggestions
    .filter(s => s.status === 'pending' || s.status === 'approved')
    .reduce((sum, s) => sum + (s.est_sek_saving ?? 0), 0)

  return (
    <div style={{
      marginTop: 18, background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
      borderRadius: 10, overflow: 'hidden',
    }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '10px 16px', cursor: 'pointer',
          background: UXP.subtleBg, display: 'flex', alignItems: 'center', gap: 10,
          borderBottom: expanded ? `0.5px solid ${UXP.border}` : 'none',
        }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
          AI summary
        </span>
        <span style={{ fontSize: 11, color: UXP.ink3 }}>
          {grouped.pending.length} pending · {grouped.approved.length} approved · {grouped.rejected.length} rejected
          {totalPotential > 0 && ` · ${fmtKr(totalPotential)} potential weekly saving`}
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: UXP.ink3 }}>
          {expanded ? 'Hide list ▾' : 'Show list ▸'}
        </span>
      </div>

      {/* Always show orphan suggestions (no shift to overlay onto) */}
      {orphan.length > 0 && (
        <div style={{ padding: '8px 16px', background: '#fbf6ee', fontSize: 10, color: UXP.ink2, borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
          {orphan.length} suggestion{orphan.length === 1 ? '' : 's'} can't be overlaid on a shift cell (add / unbound) — see list below:
        </div>
      )}
      {(expanded || orphan.length > 0) && (
        <div>
          {(expanded
            ? [...grouped.pending, ...grouped.approved, ...grouped.rejected, ...grouped.applied]
            : orphan
          ).map(s => (
            <SuggestionRow key={s.id} suggestion={s} onAction={onAction} />
          ))}
        </div>
      )}
    </div>
  )
}

function SuggestionRow({ suggestion, onAction }: {
  suggestion: AISuggestion
  onAction:   (id: string, action: 'approved' | 'rejected', reason?: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const isPending = suggestion.status === 'pending'
  const tone = suggestion.status === 'approved' ? 'lav'
             : suggestion.status === 'rejected' ? 'muted'
             : suggestion.status === 'applied'  ? 'green'
             : 'neutral'
  const accentBg = tone === 'lav'    ? UXP.lavFill
                 : tone === 'muted'  ? UXP.subtleBg
                 : tone === 'green'  ? UXP.greenFill
                 : '#fbf2eb'   // pending = soft orange
  const accentBorder = tone === 'lav'   ? UXP.lavMid
                     : tone === 'muted' ? UXP.borderSoft
                     : tone === 'green' ? UXP.green
                     : 'rgba(192,112,58,0.5)'
  const statusLabel = suggestion.status === 'pending'  ? 'Pending'
                    : suggestion.status === 'approved' ? 'Approved'
                    : suggestion.status === 'rejected' ? 'Rejected'
                    : suggestion.status === 'applied'  ? 'Applied'
                    : suggestion.status

  async function act(action: 'approved' | 'rejected') {
    setBusy(true)
    try { await onAction(suggestion.id, action) } finally { setBusy(false) }
  }

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '90px 1fr auto auto',
      gap: 12, padding: '12px 16px',
      borderBottom: `0.5px solid ${UXP.borderSoft}`,
      background: isPending ? '#ffffff' : (tone === 'muted' ? '#fafafa' : 'transparent'),
      opacity: suggestion.status === 'rejected' ? 0.6 : 1,
      alignItems: 'center',
    }}>
      {/* Status + confidence pill */}
      <div>
        <div style={{
          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
          fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
          background: accentBg, border: `0.5px solid ${accentBorder}`,
          color: tone === 'lav' ? UXP.lavText : tone === 'green' ? UXP.greenDeep : UXP.ink2,
        }}>{statusLabel}</div>
        <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 4 }}>
          {Math.round(suggestion.confidence * 100)}% confidence
        </div>
      </div>

      {/* Reasoning + before/after */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: UXP.ink1, marginBottom: 3 }}>
          {ACTION_LABELS[suggestion.action] ?? suggestion.action}
          {suggestion.shift_date && (
            <span style={{ fontWeight: 400, color: UXP.ink3, marginLeft: 8 }}>
              · {new Date(suggestion.shift_date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}
            </span>
          )}
        </div>
        <div style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.55, marginBottom: 6 }}>
          {suggestion.reasoning ?? '(no reasoning)'}
        </div>
        <div style={{ display: 'flex', gap: 10, fontSize: 10, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const }}>
          {suggestion.before && <span><strong style={{ color: UXP.ink4 }}>Before:</strong> {summarizeStateJson(suggestion.before)}</span>}
          {suggestion.proposed && <span><strong style={{ color: UXP.lavText }}>Proposed:</strong> {summarizeStateJson(suggestion.proposed)}</span>}
        </div>
      </div>

      {/* SEK saving */}
      <div style={{ textAlign: 'right' as const, minWidth: 90 }}>
        {suggestion.est_sek_saving != null && (
          <div style={{
            fontSize: 13, fontWeight: 500,
            color: suggestion.est_sek_saving >= 0 ? UXP.greenDeep : UXP.roseText,
            fontVariantNumeric: 'tabular-nums' as const,
          }}>
            {suggestion.est_sek_saving >= 0 ? '+' : ''}{fmtKr(suggestion.est_sek_saving)}
          </div>
        )}
        <div style={{ fontSize: 9, color: UXP.ink4 }}>est. saving</div>
      </div>

      {/* Approve / Reject buttons */}
      <div style={{ display: 'flex', gap: 6, minWidth: 160, justifyContent: 'flex-end' }}>
        {isPending && (
          <>
            <button onClick={() => act('approved')} disabled={busy}
              style={{ ...navBtn(), background: UXP.ink1, color: '#fff', border: 'none' }}>
              Approve
            </button>
            <button onClick={() => act('rejected')} disabled={busy}
              style={navBtn()}>
              Reject
            </button>
          </>
        )}
        {suggestion.status === 'approved' && (
          <button onClick={() => act('rejected')} disabled={busy} style={navBtn()}>
            Un-approve
          </button>
        )}
        {suggestion.status === 'rejected' && (
          <button onClick={() => act('approved')} disabled={busy} style={navBtn()}>
            Re-approve
          </button>
        )}
      </div>
    </div>
  )
}

const ACTION_LABELS: Record<string, string> = {
  cut:            'Cut shift',
  reduce:         'Reduce hours',
  extend:         'Extend hours',
  reassign:       'Reassign to different staff',
  add:            'Add shift',
  swap_template:  'Swap template',
}

function summarizeStateJson(state: any): string {
  if (!state) return ''
  if (typeof state === 'string') return state.slice(0, 80)
  if (typeof state === 'object') {
    // Try to format common shapes nicely; fall back to JSON
    const parts: string[] = []
    if (state.staff_name) parts.push(state.staff_name)
    if (state.start || state.end) parts.push(`${state.start ?? '?'}-${state.end ?? '?'}`)
    if (state.template_name || state.period_name) parts.push(state.template_name ?? state.period_name)
    if (state.hours != null) parts.push(`${state.hours}h`)
    if (state.description) parts.push(String(state.description).slice(0, 60))
    if (parts.length > 0) return parts.join(' · ')
    const s = JSON.stringify(state)
    return s.length > 100 ? s.slice(0, 97) + '...' : s
  }
  return String(state)
}

// ─────────────────────────────────────────────────────────────────────
// Pre-publish review panel — slide-up sheet with 4 KPI tabs

function ReviewPanel({ data, onClose, onApply }: {
  data:    WeekPayload
  onClose: () => void
  onApply: () => Promise<void>
}) {
  const [tab, setTab] = useState<'forecast' | 'cost' | 'coverage' | 'compliance'>('forecast')
  const approved = data.suggestions.filter(s => s.status === 'approved')

  // Run compliance against the CURRENT shifts (Phase 2 doesn't yet
  // simulate "with approved applied" — that's a follow-up once we have
  // the suggestion → projected shift transform).
  const checks: ComplianceCheck[] = useMemo(() => runCompliance({
    shifts: data.shifts.map((s: any) => ({
      id: s.id, staff_uid: s.staff_uid, staff_name: s.staff_name,
      shift_date: s.shift_date, start_at: s.start_at, end_at: s.end_at,
      breaks_seconds: s.breaks_seconds ?? 0, shift_kind: s.shift_kind,
    })),
    staff: data.profiles.map((p: any) => ({
      staff_uid: p.staff_uid, display_name: p.display_name,
      service_grade_pct: p.service_grade_pct, hourly_rate_sek: p.hourly_rate_sek,
    })),
    business_rules: {},   // pull from business settings when wired
  }), [data])
  const hardCount = checks.filter(c => c.severity === 'HARD').length
  const warnCount = checks.filter(c => c.severity === 'WARN').length
  const applyBlocked = hasHardFailures(checks)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div onClick={onClose} style={{
      position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.55)',
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center', zIndex: 200,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        width: 'min(960px, 100%)', height: '85vh',
        background: '#fff', borderRadius: '12px 12px 0 0', overflow: 'hidden' as const,
        display: 'flex', flexDirection: 'column' as const,
        boxShadow: '0 -8px 40px rgba(0,0,0,0.30)',
      }}>
        <div style={{
          padding: '12px 18px', borderBottom: `0.5px solid ${UXP.borderSoft}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1 }}>
              Pre-publish review · Week {data.week.week_iso}
            </div>
            <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>
              {approved.length} approved suggestion{approved.length === 1 ? '' : 's'}
              {hardCount > 0 && <span style={{ color: UXP.roseText, marginLeft: 8 }}>· {hardCount} HARD failure{hardCount === 1 ? '' : 's'}</span>}
              {warnCount > 0 && <span style={{ color: UXP.coral, marginLeft: 8 }}>· {warnCount} warning{warnCount === 1 ? '' : 's'}</span>}
            </div>
          </div>
          <button onClick={onClose} style={navBtn()}>Close (Esc)</button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', borderBottom: `0.5px solid ${UXP.borderSoft}` }}>
          {(['forecast', 'cost', 'coverage', 'compliance'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              style={{
                padding: '10px 16px', fontSize: 11, fontWeight: 500,
                background: tab === t ? '#fff' : UXP.subtleBg,
                color: tab === t ? UXP.ink1 : UXP.ink3,
                border: 'none', borderBottom: tab === t ? `2px solid ${UXP.lavMid}` : '2px solid transparent',
                cursor: 'pointer', fontFamily: 'inherit',
              }}>
              {t === 'forecast' ? 'Forecast vs hours'
                : t === 'cost' ? 'Cost of labour %'
                : t === 'coverage' ? 'Staff per hour vs demand'
                : `Compliance${hardCount + warnCount > 0 ? ` (${hardCount + warnCount})` : ''}`}
            </button>
          ))}
        </div>

        {/* Tab body */}
        <div style={{ flex: 1, overflow: 'auto', padding: 18 }}>
          {tab === 'forecast'   && <ForecastVsHoursTab days={data.days} />}
          {tab === 'cost'       && <CostOfLabourTab week={data.week} days={data.days} />}
          {tab === 'coverage'   && <CoverageTab days={data.days} shifts={data.shifts} />}
          {tab === 'compliance' && <ComplianceTab checks={checks} />}
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px 18px', borderTop: `0.5px solid ${UXP.borderSoft}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          background: applyBlocked ? UXP.roseFill : UXP.subtleBg,
        }}>
          <span style={{ fontSize: 11, color: applyBlocked ? UXP.roseText : UXP.ink3 }}>
            {applyBlocked
              ? `Apply blocked — ${hardCount} HARD compliance failure${hardCount === 1 ? '' : 's'} must be resolved first`
              : `Ready to apply ${approved.length} approved change${approved.length === 1 ? '' : 's'}`}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={navBtn()}>Back to grid</button>
            <button onClick={onApply} disabled={applyBlocked || approved.length === 0}
              style={{ ...primaryAiBtn(false), opacity: (applyBlocked || approved.length === 0) ? 0.4 : 1 }}>
              Apply &amp; open PK
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ForecastVsHoursTab({ days }: { days: DayHeader[] }) {
  const maxRevenue = Math.max(...days.map(d => d.forecast_revenue ?? 0), 1)
  const maxHours   = Math.max(...days.map(d => d.planned_hours), 1)
  return (
    <div>
      <p style={{ fontSize: 11, color: UXP.ink3, marginBottom: 14 }}>
        Per-day planned hours alongside the revenue forecast. Look for days where hours are out of step with expected demand.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 100px 100px 80px', gap: 8, fontSize: 11 }}>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4 }}>Day</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4 }}>Hours vs Revenue</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4, textAlign: 'right' as const }}>Hours</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4, textAlign: 'right' as const }}>Forecast</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4, textAlign: 'right' as const }}>%</div>
        {days.map(d => (
          <React.Fragment key={d.date}>
            <div style={{ fontSize: 11, color: UXP.ink1, padding: '4px 0' }}>{d.day_of_week} {d.day_number}</div>
            <div style={{ display: 'flex', alignItems: 'center', height: 22, gap: 4 }}>
              <div style={{ flex: d.planned_hours / maxHours, height: 8, background: UXP.lavMid, borderRadius: 2 }} />
              <div style={{ flex: ((d.forecast_revenue ?? 0) / maxRevenue), height: 8, background: UXP.green, borderRadius: 2, opacity: 0.6 }} />
            </div>
            <div style={{ fontSize: 11, color: UXP.ink2, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{d.planned_hours}h</div>
            <div style={{ fontSize: 11, color: UXP.ink2, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{d.forecast_revenue != null ? fmtKr(d.forecast_revenue) : '—'}</div>
            <div style={{ fontSize: 11, color: UXP.ink2, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{d.projected_staff_pct != null ? d.projected_staff_pct.toFixed(0) + '%' : '—'}</div>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function CostOfLabourTab({ week, days }: { week: WeekPayload['week']; days: DayHeader[] }) {
  return (
    <div>
      <p style={{ fontSize: 11, color: UXP.ink3, marginBottom: 14 }}>
        Weekly planned labour cost as a percentage of forecast revenue. Compare to target.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        <Kpi label="Planned cost"     value={fmtKr(week.planned_cost_sek)} />
        <Kpi label="Forecast revenue" value={week.forecast_revenue_sek > 0 ? fmtKr(week.forecast_revenue_sek) : '—'} />
        <Kpi label="Projected %"      value={week.projected_staff_pct != null ? week.projected_staff_pct.toFixed(1) + '%' : '—'} sub={week.target_staff_pct != null ? `Target ${week.target_staff_pct}%` : undefined} tone={week.gap_pct != null ? (week.gap_pct > 2 ? 'rose' : week.gap_pct < -2 ? 'green' : 'neutral') : 'neutral'} />
        <Kpi label="Gap"              value={week.gap_pct != null ? (week.gap_pct > 0 ? '+' : '') + week.gap_pct.toFixed(1) + '%' : '—'} tone={week.gap_pct != null ? (week.gap_pct > 2 ? 'rose' : week.gap_pct < -2 ? 'green' : 'neutral') : 'neutral'} />
      </div>
      <div style={{ fontSize: 11, color: UXP.ink3, marginBottom: 6 }}>Per-day breakdown:</div>
      <div style={{ display: 'grid', gridTemplateColumns: '90px 100px 100px 80px', gap: 8, fontSize: 11 }}>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4 }}>Day</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4, textAlign: 'right' as const }}>Cost</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4, textAlign: 'right' as const }}>Forecast</div>
        <div style={{ fontSize: 10, color: UXP.ink4, textTransform: 'uppercase' as const, letterSpacing: 0.4, textAlign: 'right' as const }}>%</div>
        {days.map(d => (
          <React.Fragment key={d.date}>
            <div>{d.day_of_week} {d.day_number}</div>
            <div style={{ textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(d.planned_cost)}</div>
            <div style={{ textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink3 }}>{d.forecast_revenue != null ? fmtKr(d.forecast_revenue) : '—'}</div>
            <div style={{ textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: d.projected_staff_pct != null && d.target_staff_pct != null && Math.abs(d.projected_staff_pct - d.target_staff_pct) > 2 ? UXP.roseText : UXP.ink2 }}>
              {d.projected_staff_pct != null ? d.projected_staff_pct.toFixed(1) + '%' : '—'}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  )
}

function CoverageTab({ days, shifts }: { days: DayHeader[]; shifts: Shift[] }) {
  // Build per-day per-hour staff count
  return (
    <div>
      <p style={{ fontSize: 11, color: UXP.ink3, marginBottom: 14 }}>
        Hourly headcount per day. Spot under-covered peaks (lunch 12-13, dinner 19-21) and over-staffed troughs.
      </p>
      {days.map(d => {
        const dayShifts = shifts.filter(s => s.shift_date === d.date && s.shift_kind === 'regular')
        const hourly = new Array(24).fill(0)
        for (const s of dayShifts) {
          const startH = new Date(s.start_at).getUTCHours()
          const endH   = new Date(s.end_at).getUTCHours()
          for (let h = startH; h <= endH; h++) hourly[h]++
        }
        const maxCount = Math.max(...hourly, 1)
        return (
          <div key={d.date} style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: UXP.ink2, marginBottom: 4 }}>{d.day_of_week} {d.day_number}</div>
            <div style={{ display: 'flex', gap: 1, height: 28, background: UXP.subtleBg, borderRadius: 2, overflow: 'hidden' as const }}>
              {hourly.map((c, h) => (
                <div key={h} title={`${String(h).padStart(2, '0')}:00 — ${c} staff`} style={{
                  flex: 1, background: c === 0 ? 'transparent' : `rgba(169,156,230,${0.3 + 0.6 * c / maxCount})`,
                  borderTop: c > 0 ? `1px solid ${UXP.lavMid}` : 'none',
                  display: 'flex', alignItems: 'flex-end', justifyContent: 'center', fontSize: 8, color: UXP.lavText,
                }}>{c > 0 ? c : ''}</div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 8, color: UXP.ink4, marginTop: 2 }}>
              <span>00</span><span>06</span><span>12</span><span>18</span><span>23</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ComplianceTab({ checks }: { checks: ComplianceCheck[] }) {
  if (checks.length === 0) {
    return (
      <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.greenDeep, fontSize: 13 }}>
        All compliance checks passed — no rest, overtime, or contract violations detected.
      </div>
    )
  }
  return (
    <div>
      <p style={{ fontSize: 11, color: UXP.ink3, marginBottom: 14 }}>
        Swedish labour law (Arbetstidslagen) + EU directives + business rules. <strong>HARD</strong> failures must be resolved before publishing.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
        {checks.map(c => (
          <div key={c.code} style={{
            padding: '10px 14px',
            background: c.severity === 'HARD' ? UXP.roseFill : UXP.subtleBg,
            border: `0.5px solid ${c.severity === 'HARD' ? UXP.rose : UXP.border}`,
            borderRadius: 6,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{
                fontSize: 9, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
                padding: '2px 7px', borderRadius: 4,
                background: c.severity === 'HARD' ? UXP.rose : UXP.coral, color: '#fff',
              }}>{c.severity}</span>
              <span style={{ fontSize: 10, color: UXP.ink4, fontFamily: 'ui-monospace, monospace' }}>{c.code.split(':')[0]}</span>
            </div>
            <div style={{ fontSize: 12, color: c.severity === 'HARD' ? UXP.roseText : UXP.ink1, lineHeight: 1.5 }}>
              {c.message}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────
// Helpers — render apply summary + button styles

function renderApplySummary(data: WeekPayload, approved: AISuggestion[]): string {
  const lines: string[] = []
  lines.push(`CommandCenter schedule changes — Week ${data.week.week_iso} (${data.business.name})`)
  lines.push(`Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`)
  lines.push('')
  lines.push(`Apply these ${approved.length} change${approved.length === 1 ? '' : 's'} in Personalkollen:`)
  lines.push('')

  // Group by date
  const byDate = new Map<string, AISuggestion[]>()
  for (const s of approved) {
    const k = s.shift_date ?? 'unscheduled'
    const arr = byDate.get(k); if (arr) arr.push(s); else byDate.set(k, [s])
  }
  const sortedDates = Array.from(byDate.keys()).sort()
  for (const date of sortedDates) {
    const dateLabel = date === 'unscheduled' ? 'Unscheduled' :
      new Date(date + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
    lines.push(`${dateLabel}:`)
    for (const s of byDate.get(date)!) {
      const action = ACTION_LABELS[s.action] ?? s.action
      lines.push(`  · ${action.toUpperCase()}`)
      if (s.before)   lines.push(`    Before:   ${summarizeStateJson(s.before)}`)
      if (s.proposed) lines.push(`    Proposed: ${summarizeStateJson(s.proposed)}`)
      if (s.reasoning) lines.push(`    Why: ${s.reasoning}`)
      if (s.est_sek_saving != null) lines.push(`    Saving: ${s.est_sek_saving >= 0 ? '+' : ''}${Math.round(s.est_sek_saving)} kr`)
      lines.push('')
    }
  }
  lines.push('—')
  lines.push('Source of truth: Personalkollen. CommandCenter doesn\'t write to PK — please apply manually using the list above. The next nightly sync will pick up your changes.')
  return lines.join('\n')
}

function primaryAiBtn(busy: boolean): React.CSSProperties {
  return {
    padding: '6px 14px', fontSize: 11, fontWeight: 600,
    background: UXP.lavMid, color: '#fff',
    border: 'none', borderRadius: 6,
    cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
    opacity: busy ? 0.6 : 1,
  }
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
