'use client'
// app/scheduling/grid/page.tsx
//
// Phase 6 — full rota grid vision page. Department-grouped employee
// rows × seven days, shift blocks in lavender, Otillgänglig markers,
// dashed open shifts, AI "Skapa schema" toast, Publicera menu.
//
// All data from lib/mock/schedule.ts so swapping to /api/scheduling/grid
// later is a single import change.

export const dynamic = 'force-dynamic'

import { useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import DemoDataBanner from '@/components/ux/DemoDataBanner'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import {
  MOCK_SCHEDULE,
  MOCK_SCHEDULE_DAY_LABELS,
  type MockDepartment,
  type MockEmployee,
  type MockShift,
} from '@/lib/mock/schedule'

export default function ScheduleGridPage() {
  const [toastVisible, setToastVisible] = useState(false)
  const [publicMenu,   setPublicMenu]   = useState(false)
  const [acceptedAi,   setAcceptedAi]   = useState(false)

  const totalScheduled = useMemo(() => {
    let h = 0
    for (const dep of MOCK_SCHEDULE.departments) {
      for (const emp of dep.employees) {
        for (const s of emp.shifts) {
          if (s.status === 'planned' || s.status === 'draft') h += s.hours
        }
      }
    }
    return Math.round(h)
  }, [])

  function runAi() {
    setToastVisible(true)
    setAcceptedAi(false)
  }
  function acceptAi() {
    setAcceptedAi(true)
    setToastVisible(false)
  }
  function undoAi() {
    setToastVisible(false)
    setAcceptedAi(false)
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1280 }}>
        <DemoDataBanner />

        {/* Header strip — Prognos / Mål / status */}
        <div style={{
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          gap:            12,
          flexWrap:       'wrap' as const,
          background:     UXP.cardBg,
          border:         `0.5px solid ${UXP.border}`,
          borderRadius:   UXP.r_lg,
          padding:        '14px 18px',
          marginBottom:   12,
        }}>
          <div>
            <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
              {MOCK_SCHEDULE.week_label}
            </div>
            <div style={{ fontSize: 16, fontWeight: 500, color: UXP.ink1, marginTop: 2, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              Rota
              <span style={{
                fontSize:      10,
                fontWeight:    600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase' as const,
                padding:       '3px 8px',
                background:    UXP.lavFill,
                color:         UXP.lavText,
                borderRadius:  999,
              }}>
                {MOCK_SCHEDULE.status_label}
              </span>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'baseline' }}>
            <Metric label="Prognos" value={fmtKr(MOCK_SCHEDULE.prognos_revenue)} sub="Intäkter" />
            <Metric label="Mål"     value={fmtKr(MOCK_SCHEDULE.mal_revenue)}     sub="Intäkter" />
            <Metric label="Timmar"  value={`${MOCK_SCHEDULE.current_hours}h`}     sub={`Mål ${MOCK_SCHEDULE.mal_hours}h`} />
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button type="button" onClick={runAi} style={primaryBtn}>
              ✦ Skapa schema
            </button>
            <div style={{ position: 'relative' as const }}>
              <button type="button" onClick={() => setPublicMenu(p => !p)} style={ghostBtn}>
                Publicera ▾
              </button>
              {publicMenu && (
                <div style={{
                  position:     'absolute' as const,
                  top:          'calc(100% + 6px)',
                  right:        0,
                  background:   UXP.cardBg,
                  border:       `0.5px solid ${UXP.border}`,
                  borderRadius: UXP.r_md,
                  padding:      4,
                  zIndex:       40,
                  boxShadow:    '0 8px 24px rgba(58,53,80,0.12)',
                  minWidth:     220,
                }}>
                  <MenuItem label="Skicka för godkännande" onClick={() => setPublicMenu(false)} />
                  <MenuItem label="Publicera direkt"        onClick={() => setPublicMenu(false)} />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* AI toast */}
        {toastVisible && !acceptedAi && (
          <div style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            gap:            12,
            background:     UXP.lavFill,
            color:          UXP.lavText,
            borderRadius:   UXP.r_lg,
            padding:        '12px 18px',
            marginBottom:   12,
            border:         `0.5px solid ${UXP.lavMid}`,
          }}>
            <div style={{ fontSize: 12, fontWeight: 500 }}>
              ✦ AI lade till {MOCK_SCHEDULE.ai_added_hours} timmar — fördelade efter prognos
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={acceptAi}
                style={{ ...primaryBtn, background: UXP.lavDeep }}>
                Acceptera
              </button>
              <button type="button" onClick={undoAi} style={ghostBtn}>
                Ångra
              </button>
            </div>
          </div>
        )}

        {/* Grid */}
        <div style={{
          background:   UXP.cardBg,
          border:       `0.5px solid ${UXP.border}`,
          borderRadius: UXP.r_lg,
          overflow:     'hidden' as const,
        }}>
          {/* Header row — day labels */}
          <div style={{
            display:             'grid',
            gridTemplateColumns: '220px repeat(7, 1fr)',
            borderBottom:        `0.5px solid ${UXP.border}`,
            background:          UXP.subtleBg,
          }}>
            <div style={{ padding: '10px 14px', fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
              Anställd
            </div>
            {MOCK_SCHEDULE_DAY_LABELS.map(d => (
              <div key={d} style={{ padding: '10px 14px', fontSize: 10, color: UXP.ink4, textAlign: 'center' as const, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
                {d}
              </div>
            ))}
          </div>

          {MOCK_SCHEDULE.departments.map(dep => (
            <DeptBlock key={dep.name} department={dep} />
          ))}

          {/* Totals footer */}
          <div style={{
            display:             'grid',
            gridTemplateColumns: '220px repeat(7, 1fr)',
            background:          '#f7f6fb',
            borderTop:           `0.5px solid ${UXP.border}`,
            padding:             '8px 0',
            fontSize:            10,
            color:               UXP.ink3,
          }}>
            <div style={{ padding: '4px 14px', fontWeight: 500 }}>Totalt schemalagt</div>
            <div style={{ gridColumn: 'span 6', padding: '4px 14px', textAlign: 'right' as const }} />
            <div style={{ padding: '4px 14px', textAlign: 'right' as const, fontWeight: 500, color: UXP.ink1 }}>
              {totalScheduled}h
            </div>
          </div>
        </div>
      </div>
    </AppShell>
  )
}

// ── Sub-components ─────────────────────────────────────────────────

function DeptBlock({ department }: { department: MockDepartment }) {
  return (
    <div>
      <div style={{
        padding:    '8px 14px',
        background: UXP.lavFill,
        color:      UXP.lavText,
        fontSize:   11,
        fontWeight: 500,
        borderTop:    `0.5px solid ${UXP.borderSoft}`,
        borderBottom: `0.5px solid ${UXP.borderSoft}`,
      }}>
        {department.name}
      </div>
      {department.employees.map(emp => (
        <EmployeeRow key={emp.id} employee={emp} />
      ))}
    </div>
  )
}

function EmployeeRow({ employee }: { employee: MockEmployee }) {
  const isOpenRow = employee.contracted_hours === 0
  const totalHours = employee.shifts.reduce((s, sh) => s + sh.hours, 0)

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: '220px repeat(7, 1fr)',
      borderTop:           `0.5px solid ${UXP.borderSoft}`,
      alignItems:          'stretch',
      minHeight:           54,
    }}>
      <div style={{ padding: '10px 14px', display: 'flex', flexDirection: 'column' as const, justifyContent: 'center' }}>
        <span style={{
          fontSize:   12,
          fontWeight: 500,
          color:      isOpenRow ? UXP.ink3 : UXP.ink1,
          fontStyle:  isOpenRow ? 'italic' as const : 'normal' as const,
        }}>
          {employee.name}
        </span>
        <span style={{ fontSize: 9, color: UXP.ink4, marginTop: 2 }}>
          {isOpenRow ? `${totalHours.toFixed(1)}h öppna` : `${totalHours.toFixed(1)}h / ${employee.contracted_hours}h`}
        </span>
      </div>

      {Array.from({ length: 7 }, (_, dayIdx) => {
        const shift = employee.shifts.find(s => s.day_idx === dayIdx)
        return (
          <div key={dayIdx} style={{
            padding:    '6px 6px',
            borderLeft: `0.5px solid ${UXP.borderSoft}`,
            display:    'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            {shift ? <ShiftPill shift={shift} /> : null}
          </div>
        )
      })}
    </div>
  )
}

function ShiftPill({ shift }: { shift: MockShift }) {
  if (shift.status === 'unavailable') {
    return (
      <span style={{
        fontSize:    10,
        color:       UXP.ink4,
        letterSpacing: '0.02em',
        fontStyle:   'italic' as const,
      }}>
        Otillgänglig
      </span>
    )
  }
  if (shift.status === 'open') {
    return (
      <span style={{
        fontSize:     10,
        color:        UXP.lavText,
        background:   UXP.cardBg,
        border:       `1px dashed ${UXP.lav}`,
        padding:      '4px 8px',
        borderRadius: 6,
        textAlign:    'center' as const,
        width:        '100%',
        fontVariantNumeric: 'tabular-nums' as const,
      }}>
        {shift.start}–{shift.end}
      </span>
    )
  }
  return (
    <span style={{
      fontSize:     10,
      color:        UXP.lavText,
      background:   UXP.lavFill,
      border:       `0.5px solid ${UXP.lavMid}`,
      padding:      '4px 8px',
      borderRadius: 6,
      textAlign:    'center' as const,
      width:        '100%',
      fontVariantNumeric: 'tabular-nums' as const,
    }}>
      {shift.start}–{shift.end}
      {shift.role && (
        <span style={{ display: 'block', fontSize: 8, color: UXP.ink4, marginTop: 1 }}>
          {shift.role}
        </span>
      )}
    </span>
  )
}

// ── Atoms ──────────────────────────────────────────────────────────

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 500, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const, marginTop: 2 }}>{value}</div>
      {sub && <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1 }}>{sub}</div>}
    </div>
  )
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display:      'block',
        width:        '100%',
        textAlign:    'left' as const,
        padding:      '7px 9px',
        background:   'transparent',
        color:        UXP.ink1,
        border:       'none',
        borderRadius: UXP.r_sm,
        cursor:       'pointer',
        fontSize:     11,
        fontFamily:   'inherit',
      }}
    >
      {label}
    </button>
  )
}

const primaryBtn: React.CSSProperties = {
  padding:      '6px 12px',
  background:   UXP.lav,
  color:        '#fff',
  border:       'none',
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  fontFamily:   'inherit',
  cursor:       'pointer',
}

const ghostBtn: React.CSSProperties = {
  padding:      '5px 12px',
  background:   UXP.cardBg,
  color:        UXP.ink2,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 999,
  fontSize:     11,
  fontWeight:   500,
  fontFamily:   'inherit',
  cursor:       'pointer',
}
