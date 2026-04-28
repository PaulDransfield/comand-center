'use client'
// components/scheduling/AiHoursReductionMap.tsx
//
// Hours-first AI scheduling visualization. Replaces the dense AiSchedulePanel
// table-style layout with a confidence-grouped day list — each day gets a
// color-coded left border (green / amber / gray) and a Now/AI horizontal
// bar pair so the "trim X hours" question is answerable at a glance.
//
// Driven by the SAME `/api/scheduling/ai-suggestion` payload + acceptances
// map as AiSchedulePanel — no new data fields, no new endpoints. Status
// classification is client-side from the existing `delta_hours` and
// `under_staffed_note` fields:
//
//   green  — clear cut: delta_hours ≤ -2
//   amber  — split decision: under_staffed_note=true (model wanted to add,
//            asymmetric rule blocked it; manager call required)
//   gray   — closed (current.hours = 0) OR no change (|delta_hours| < 2)
//
// Apply / Decide CTAs route through the same onAcceptDay / onAcceptAll
// callbacks the parent already provides. The Decide modal is stubbed —
// just an alert for now (kept out of scope per the design prompt).
//
// Lives at /scheduling/v2 as a parallel preview route. The original
// AiSchedulePanel on /scheduling stays live until Paul decides to swap.

import { useMemo, useState } from 'react'
import { UX } from '@/lib/constants/tokens'

interface AcceptRow {
  date:            string
  ai_hours:        number
  ai_cost_kr:      number
  current_hours:   number
  current_cost_kr: number
  est_revenue_kr:  number | null
}

interface Props {
  loading:       boolean
  error:         string
  data:          any              // /api/scheduling/ai-suggestion response
  rangeLabel:    string           // "This week" / "Next week" etc.
  acceptances:   Record<string, any>
  onAcceptAll:   (rows: AcceptRow[]) => Promise<void>
  onAcceptDay?:  (row: AcceptRow) => Promise<void>
  fmt:           (n: number) => string
  fmtHrs:        (h: number) => string
}

// FIXES §0qq: switched from the design-prompt's custom palette to the
// existing UX semantic tokens (lib/constants/tokens.ts) so this component
// matches the rest of the app. Status colours map to greenInk / amberInk /
// ink5; surfaces use pageBg / cardBg / borderSoft.
const C = {
  green:   UX.greenInk,
  greenBg: UX.greenBg,
  amber:   UX.amberInk,
  amberBg: UX.amberBg,
  amberBorder: UX.amberBorder,
  gray:    UX.ink5,                     // separators / disabled tone — closes / no-change rows
  ink:     UX.ink1,
  ink2:    UX.ink2,
  ink3:    UX.ink3,
  ink4:    UX.ink4,
  bgPage:  UX.pageBg,                   // matches body bg in app/layout.tsx
  bgCard:  UX.cardBg,
  bgBar:   UX.borderSoft,               // bar track — same neutral used elsewhere as separator surface
  border:  UX.border,
}

const WEEKDAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function dayLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  const wd = (d.getUTCDay() + 6) % 7
  return `${WEEKDAYS[wd]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`
}

type Status = 'green' | 'amber' | 'gray-closed' | 'gray-nochange'

export default function AiHoursReductionMap(props: Props) {
  const { loading, error, data, rangeLabel, acceptances, onAcceptAll, fmt, fmtHrs } = props

  const current   = (data?.current   as any[] | undefined) ?? []
  const suggested = (data?.suggested as any[] | undefined) ?? []
  const pkShifts  = Number(data?.pk_shifts_found ?? 0)

  // ── Per-day rows with status classification ──────────────────────────────
  const rows = useMemo(() => {
    return current.map((c: any, i: number) => {
      const s        = suggested[i] ?? {}
      const curH     = Number(c.hours ?? 0)
      const aiH      = Number(s.hours ?? 0)
      const deltaH   = curH - aiH                     // positive = cut
      const curCost  = Number(c.est_cost ?? 0)
      const aiCost   = Number(s.est_cost ?? 0)
      const savingKr = curCost - aiCost               // positive = saving
      const estRev   = Number(s.est_revenue ?? 0)     // AI-predicted revenue for the day
      // Labour % = staff cost / revenue. Null when revenue is 0 (closed
      // day, or AI couldn't form a forecast). Restaurant operators read
      // labour % as the primary metric — kr alone doesn't tell them
      // whether they're on target (typically 30–35 %).
      const curPct   = estRev > 0 ? (curCost / estRev) * 100 : null
      const aiPct    = estRev > 0 ? (aiCost  / estRev) * 100 : null
      const isAccepted   = !!acceptances?.[c.date]
      const isJudgment   = !!s.under_staffed_note     // amber: model wanted to add
      let status: Status
      if (curH < 0.05)                  status = 'gray-closed'
      else if (isJudgment)              status = 'amber'
      else if (deltaH < 2)              status = 'gray-nochange'
      else                              status = 'green'
      return {
        date: c.date as string,
        weekday: c.weekday,
        curH, aiH, deltaH, curCost, aiCost, savingKr,
        estRev, curPct, aiPct,
        reasoning: String(s.reasoning ?? ''),
        status,
        isAccepted,
      }
    })
  }, [current, suggested, acceptances])

  // ── Totals across days ───────────────────────────────────────────────────
  const greenRows  = rows.filter(r => r.status === 'green' && !r.isAccepted)
  const amberRows  = rows.filter(r => r.status === 'amber')
  const closedRows = rows.filter(r => r.status === 'gray-closed')
  const nochange   = rows.filter(r => r.status === 'gray-nochange')

  const totalSavedH  = greenRows.reduce((s, r) => s + r.deltaH, 0)
  const totalSavedKr = greenRows.reduce((s, r) => s + r.savingKr, 0)
  // Amber range — if user resolves all amber as "accept the trim",
  // this is the additional saving on top of the green ready-to-apply set.
  const amberPotentialKr = amberRows.reduce((s, r) => s + Math.max(r.savingKr, 0), 0)
  const amberPotentialH  = amberRows.reduce((s, r) => s + Math.max(r.deltaH, 0), 0)

  // ── Apply handler — flips green rows to accepted via existing endpoint ──
  const [applying, setApplying] = useState(false)
  async function handleApplyAll() {
    if (!greenRows.length) return
    setApplying(true)
    try {
      await onAcceptAll(greenRows.map(r => ({
        date:            r.date,
        ai_hours:        r.aiH,
        ai_cost_kr:      Math.round(r.aiCost),
        current_hours:   r.curH,
        current_cost_kr: Math.round(r.curCost),
        est_revenue_kr:  Number(suggested.find((s: any) => s.date === r.date)?.est_revenue ?? 0) || null,
      })))
    } finally {
      setApplying(false)
    }
  }

  function handleDecide(date: string) {
    // Stub per design prompt — opens a placeholder for the booking-vs-pattern
    // drilldown modal. Real modal is out of scope for this build.
    alert(`Decision drilldown for ${date} — booking-vs-pattern view coming next.`)
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) return <Loading />
  if (error)   return <ErrorBox text={error} />
  if (!data || pkShifts === 0) return <EmptyBox />

  return (
    <div style={{ background: C.bgPage, padding: 24, borderRadius: UX.r_lg, maxWidth: 960 }}>

      {/* ─── Top bar ────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={eyebrow}>HOUR REDUCTIONS · {rangeLabel.toUpperCase()}</div>
          <div style={{ fontSize: 22, fontWeight: 500, color: C.ink, letterSpacing: '-0.01em', marginTop: 4 }}>
            Trim where the data agrees
          </div>
        </div>
        <div style={{ textAlign: 'right' as const }}>
          <div style={{ fontSize: 24, fontWeight: 500, color: C.ink, letterSpacing: '-0.01em' }}>
            {totalSavedH > 0.5 ? `−${fmtHrs(totalSavedH)}` : '—'}
          </div>
          <div style={{ ...eyebrow, marginTop: 4 }}>{rangeLabel.toUpperCase()}'S REDUCTION</div>
        </div>
      </div>

      {/* hairline */}
      <div style={{ height: 1, background: C.border, marginBottom: 14 }} />

      {/* ─── Legend ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const, marginBottom: 16, fontSize: 12, color: C.ink3 }}>
        <LegendItem dot={C.green} text={`${greenRows.length} day${greenRows.length === 1 ? '' : 's'} · ready to apply`} />
        <LegendItem dot={C.amber} text={`${amberRows.length} day${amberRows.length === 1 ? '' : 's'} · needs your call`} />
        <LegendItem dot={C.gray}  text={`${nochange.length} unchanged · ${closedRows.length} closed`} />
      </div>

      {/* ─── Day rows ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 18 }}>
        {rows.map(r => (
          <DayRow key={r.date} row={r} fmt={fmt} fmtHrs={fmtHrs} onDecide={handleDecide} />
        ))}
      </div>

      {/* ─── Bottom action bar ─────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 14, borderTop: `0.5px solid ${C.border}` }}>
        <button
          onClick={handleApplyAll}
          disabled={applying || greenRows.length === 0}
          style={{
            background:   greenRows.length === 0 ? '#cccccc' : C.green,
            color:        'white',
            border:       'none',
            borderRadius: UX.r_md,
            padding:      '12px 22px',
            fontSize:     15,
            fontWeight:   500,
            cursor:       (applying || greenRows.length === 0) ? 'not-allowed' : 'pointer',
            opacity:      applying ? 0.65 : 1,
          }}
        >
          {applying ? 'Applying…' : greenRows.length > 0 ? `Apply ${greenRows.length} ready day${greenRows.length === 1 ? '' : 's'}` : 'Nothing ready to apply'}
        </button>
        {amberRows.length > 0 && (
          <button
            onClick={() => handleDecide(amberRows[0].date)}
            style={{
              background:   'transparent',
              color:        C.ink,
              border:       `0.5px solid ${C.border}`,
              borderRadius: UX.r_md,
              padding:      '12px 22px',
              fontSize:     15,
              fontWeight:   500,
              cursor:       'pointer',
            }}
          >
            Decide on {dayLabel(amberRows[0].date).split(' ')[0]}
          </button>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: C.ink4 }}>
          {totalSavedH > 0.5 && (
            <>
              −{fmtHrs(totalSavedH + amberPotentialH)} · {fmt(totalSavedKr + amberPotentialKr)} if all amber accepted
              <span style={{ marginLeft: 8 }}>·</span>
              <span style={{ marginLeft: 8 }}>{fmt(totalSavedKr)} green only</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Day row ────────────────────────────────────────────────────────────────

function DayRow({ row, fmt, fmtHrs, onDecide }: {
  row: any
  fmt: (n: number) => string
  fmtHrs: (h: number) => string
  onDecide: (date: string) => void
}) {
  const borderColor = row.status === 'green' ? C.green : row.status === 'amber' ? C.amber : C.gray
  const opacity = row.status === 'gray-closed' ? 0.5 : row.isAccepted ? 0.7 : (row.status === 'gray-nochange' ? 0.65 : 1)

  // Sub-label
  let subLabel = ''
  if (row.status === 'gray-closed')        subLabel = 'CLOSED'
  else if (row.status === 'gray-nochange') subLabel = `${fmtHrs(row.curH)} · NO CHANGE`
  else                                     subLabel = `CURRENTLY ${fmtHrs(row.curH)}`

  return (
    <div style={{
      display:        'grid',
      gridTemplateColumns: '110px 1fr 110px 90px',
      gap:            14,
      alignItems:     'center',
      background:     C.bgCard,
      borderTop:      `0.5px solid ${C.border}`,
      borderRight:    `0.5px solid ${C.border}`,
      borderBottom:   `0.5px solid ${C.border}`,
      borderLeft:     `3px solid ${borderColor}`,
      padding:        '14px 14px 14px 12px',
      opacity,
    }}>
      {/* Col 1 — Day label */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 500, color: C.ink, textDecoration: row.isAccepted ? 'line-through' : 'none' }}>
          {dayLabel(row.date)}
        </div>
        <div style={{ ...eyebrow, marginTop: 4 }}>{subLabel}</div>
      </div>

      {/* Col 2 — Bars / message + labour % shift */}
      <div>
        {row.status === 'green' && (
          <>
            <BarPair labelTop="NOW" labelBot="AI" topVal={row.curH} botVal={row.aiH} fmtHrs={fmtHrs} botColor={C.green}
              note={row.reasoning || `Trim ${fmtHrs(row.deltaH)} from the day`} noteColor={C.ink3} accepted={row.isAccepted} />
            <LabourLine curPct={row.curPct} aiPct={row.aiPct} curCost={row.curCost} aiCost={row.aiCost} fmt={fmt} accepted={row.isAccepted} tone="green" />
          </>
        )}
        {row.status === 'amber' && (
          <>
            <BarPair labelTop="IF PATTERN" labelBot="IF BOOKINGS" topVal={row.aiH} botVal={row.curH} fmtHrs={fmtHrs} botColor={C.amber} topColor={C.amber}
              note={row.reasoning || 'Pattern says lighter, but you may know more — your call.'} noteColor={C.amber} labelWidth={70} />
            <LabourLine curPct={row.curPct} aiPct={row.aiPct} curCost={row.curCost} aiCost={row.aiCost} fmt={fmt} tone="amber" />
          </>
        )}
        {row.status === 'gray-closed' && (
          <div style={{ fontSize: 12, color: C.ink4, fontStyle: 'italic' as const }}>No shifts posted — restaurant closed.</div>
        )}
        {row.status === 'gray-nochange' && (
          <>
            <div style={{ fontSize: 12, color: C.ink3 }}>{row.reasoning || 'Schedule already aligned with the pattern.'}</div>
            {row.curPct != null && (
              <div style={{ fontSize: 11, color: C.ink4, marginTop: 4 }}>
                Labour {Math.round(row.curPct)}% of revenue — on target.
              </div>
            )}
          </>
        )}
      </div>

      {/* Col 3 — Savings */}
      <div style={{ textAlign: 'right' as const }}>
        {row.status === 'green' && (
          <>
            <div style={{ fontSize: 15, fontWeight: 500, color: C.green }}>
              −{fmt(row.savingKr)}
            </div>
            <div style={{ fontSize: 11, color: C.ink4, marginTop: 2 }}>
              −{fmtHrs(row.deltaH)}
            </div>
          </>
        )}
        {row.status === 'amber' && (
          <>
            <div style={{ fontSize: 15, fontWeight: 500, color: C.amber }}>
              ±{fmt(Math.abs(row.savingKr))}
            </div>
            <div style={{ fontSize: 11, color: C.ink4, marginTop: 2 }}>
              −{fmtHrs(Math.max(0, row.deltaH))} or 0 h
            </div>
          </>
        )}
        {(row.status === 'gray-closed' || row.status === 'gray-nochange') && (
          <div style={{ fontSize: 14, color: C.gray }}>—</div>
        )}
      </div>

      {/* Col 4 — Action */}
      <div style={{ textAlign: 'right' as const }}>
        {row.status === 'green' && (
          row.isAccepted
            ? <span style={{ fontSize: 11, color: C.green, fontWeight: 500 }}>✓ Applied</span>
            : <span style={{ fontSize: 11, color: C.ink3 }}>Auto-apply</span>
        )}
        {row.status === 'amber' && (
          <button
            onClick={() => onDecide(row.date)}
            style={{
              background:   C.amberBg,
              color:        C.amber,
              border:       `0.5px solid ${C.amber}`,
              borderRadius: UX.r_md,
              padding:      '6px 12px',
              fontSize:     12,
              fontWeight:   500,
              cursor:       'pointer',
            }}
          >
            Decide
          </button>
        )}
        {(row.status === 'gray-closed' || row.status === 'gray-nochange') && (
          <span style={{ fontSize: 14, color: C.gray }}>—</span>
        )}
      </div>
    </div>
  )
}

// ─── Bar pair (Now/AI or pattern/bookings) ─────────────────────────────────

function BarPair({ labelTop, labelBot, topVal, botVal, fmtHrs, botColor, topColor, note, noteColor, labelWidth = 24, accepted }: {
  labelTop: string; labelBot: string
  topVal: number; botVal: number
  fmtHrs: (n: number) => string
  botColor: string
  topColor?: string
  note?: string
  noteColor?: string
  labelWidth?: number
  accepted?: boolean
}) {
  // Top bar always renders at 100% of its track (the "current" reference).
  // Bottom bar's width is botVal/topVal — never exceeds 100% because we
  // never recommend ADDING hours (asymmetric rule).
  const botPct = topVal > 0 ? Math.min(100, (botVal / topVal) * 100) : 0
  const trackMax = 260
  const trackWidth = trackMax
  return (
    <div style={{ maxWidth: trackMax }}>
      <BarRow label={labelTop} value={topVal} pct={100} color={topColor ?? C.gray} fmtHrs={fmtHrs} labelWidth={labelWidth} trackWidth={trackWidth} />
      <div style={{ height: 4 }} />
      <BarRow label={labelBot} value={botVal} pct={botPct} color={botColor} fmtHrs={fmtHrs} labelWidth={labelWidth} trackWidth={trackWidth} />
      {note && (
        <div style={{ fontSize: 11, color: noteColor ?? C.ink4, marginTop: 8, lineHeight: 1.4, textDecoration: accepted ? 'line-through' : 'none' }}>
          {note}
        </div>
      )}
    </div>
  )
}

function BarRow({ label, value, pct, color, fmtHrs, labelWidth, trackWidth }: {
  label: string; value: number; pct: number; color: string
  fmtHrs: (n: number) => string; labelWidth: number; trackWidth: number
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: labelWidth, fontSize: 10, color: C.ink4, letterSpacing: '0.06em', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, height: 10, background: C.bgBar, borderRadius: 2, overflow: 'hidden' as const, maxWidth: trackWidth - labelWidth - 60 }}>
        <div style={{ width: `${pct}%`, height: '100%', background: color }} />
      </div>
      <div style={{ width: 56, textAlign: 'right' as const, fontSize: 12, color: C.ink2, fontWeight: 500 }}>
        {fmtHrs(value)}
      </div>
    </div>
  )
}

// ─── Labour-% before/after line ────────────────────────────────────────────
// Shows the actual decision metric — labour cost as a percent of revenue
// (operators read 30–35 % as on-target). Renders kr in muted grey beside
// the percent so the cost picture is also visible without dominating.
function LabourLine({ curPct, aiPct, curCost, aiCost, fmt, accepted, tone }: {
  curPct: number | null
  aiPct:  number | null
  curCost: number
  aiCost:  number
  fmt: (n: number) => string
  accepted?: boolean
  tone: 'green' | 'amber'
}) {
  if (curPct == null || aiPct == null) return null
  const arrow = '→'
  const accent = tone === 'green' ? C.green : C.amber
  const verb   = tone === 'green' ? 'saves' : 'shift'
  const delta  = curCost - aiCost
  const sign   = delta > 0 ? '−' : delta < 0 ? '+' : ''
  return (
    <div style={{
      fontSize:    11,
      color:       C.ink3,
      marginTop:   8,
      paddingTop:  6,
      borderTop:   `1px dashed ${C.bgBar}`,
      display:     'flex',
      alignItems:  'center',
      gap:         6,
      flexWrap:    'wrap' as const,
      textDecoration: accented(accepted),
    }}>
      <span style={{ color: C.ink4, textTransform: 'uppercase' as const, letterSpacing: '0.06em', fontSize: 10 }}>
        Labour
      </span>
      <span style={{ color: C.ink2, fontWeight: 500 }}>
        {Math.round(curPct)}%
      </span>
      <span style={{ color: C.ink4 }}>{arrow}</span>
      <span style={{ color: accent, fontWeight: 500 }}>
        {Math.round(aiPct)}%
      </span>
      <span style={{ color: C.ink4 }}>· of revenue</span>
      <span style={{ color: C.ink4 }}>·</span>
      <span style={{ color: C.ink3 }}>
        {verb} <span style={{ color: accent, fontWeight: 500 }}>{sign}{fmt(Math.abs(delta))}</span>
      </span>
      <span style={{ color: C.ink4 }}>
        ({fmt(curCost)} {arrow} {fmt(aiCost)})
      </span>
    </div>
  )
}

function accented(accepted?: boolean): 'line-through' | 'none' {
  return accepted ? 'line-through' : 'none'
}

// ─── Atoms ──────────────────────────────────────────────────────────────────

function LegendItem({ dot, text }: { dot: string; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      {text}
    </span>
  )
}

function Loading() {
  return <div style={{ padding: 60, textAlign: 'center' as const, color: C.ink4, fontSize: 13 }}>Loading the AI hours map…</div>
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: UX.r_lg, color: '#b91c1c', fontSize: 13 }}>
      Couldn't load the AI suggestion: {text}
    </div>
  )
}

function EmptyBox() {
  return (
    <div style={{ padding: 40, textAlign: 'center' as const, color: C.ink3, fontSize: 13, background: C.bgCard, borderRadius: UX.r_lg, border: `1px solid ${C.border}` }}>
      <div style={{ fontWeight: 500, marginBottom: 6, color: C.ink }}>No PK shifts found for this window</div>
      <div>Either the schedule isn't published yet in Personalkollen, or the integration needs reconnecting.</div>
    </div>
  )
}

const eyebrow = {
  fontSize:      10,
  fontWeight:    500,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  color:         C.ink4,
}
