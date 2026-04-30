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
import { useTranslations } from 'next-intl'
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

const MONTHS_SHORT_FALLBACK = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAYS_FALLBACK     = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

// dayLabel is now built per-render with the locale's weekday + month arrays
// (passed in by the caller) so e.g. Swedish renders "Mån 4 Maj".
function makeDayLabel(weekdays: string[], monthsShort: string[]) {
  return (iso: string): string => {
    const d = new Date(iso + 'T00:00:00Z')
    const wd = (d.getUTCDay() + 6) % 7
    return `${weekdays[wd]} ${d.getUTCDate()} ${monthsShort[d.getUTCMonth()]}`
  }
}

type Status = 'green' | 'amber' | 'gray-closed' | 'gray-nochange'

export default function AiHoursReductionMap(props: Props) {
  const { loading, error, data, rangeLabel, acceptances, onAcceptAll, fmt, fmtHrs } = props
  const t        = useTranslations('scheduling.aiMap')
  const tCommon  = useTranslations('common')
  const weekdays = (t.raw('weekDays') as string[]) ?? WEEKDAYS_FALLBACK
  const months   = (tCommon.raw('time.monthsShort') as string[]) ?? MONTHS_SHORT_FALLBACK
  const dayLabel = makeDayLabel(weekdays, months)

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

  // ── Weekly labour-% shift (the "pop out" metric) ─────────────────────────
  // Sum across ALL days that have a forecasted revenue — not just green —
  // so the headline shows the genuine end-state if the user applies the
  // green recs (amber/no-change/closed days stay at their current cost).
  // Cost denominator: sum of curCost (no change) + greenRows.aiCost (cuts).
  // Revenue denominator: sum of estRev across all days that had one.
  const weekRev = rows.reduce((s, r) => s + (r.estRev || 0), 0)
  const weekCurCost = rows.reduce((s, r) => s + r.curCost, 0)
  const weekAiCost  = rows.reduce((s, r) => s + (r.status === 'green' && !r.isAccepted ? r.aiCost : r.curCost), 0)
  const weekCurPct = weekRev > 0 ? (weekCurCost / weekRev) * 100 : null
  const weekAiPct  = weekRev > 0 ? (weekAiCost  / weekRev) * 100 : null
  const weekDeltaPct = (weekCurPct != null && weekAiPct != null) ? weekCurPct - weekAiPct : null
  const weekSavingsKr = weekCurCost - weekAiCost

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
    alert(t('drillStub', { date }))
  }

  // ── Render ───────────────────────────────────────────────────────────────
  if (loading) return <Loading text={t('loading')} />
  if (error)   return <ErrorBox text={t('errorPrefix', { message: error })} />
  if (!data || pkShifts === 0) return <EmptyBox title={t('emptyTitle')} body={t('emptyBody')} />

  return (
    <div style={{ background: C.bgPage, padding: 24, borderRadius: UX.r_lg, maxWidth: 960 }}>

      {/* ─── Hero results card — the "pop out" weekly bottom line ──────── */}
      {/* This is the headline result: applying the green recs shifts the
          week's labour ratio from X% to Y% of revenue. Sized large + boxed
          so the customer sees the impact immediately, before scrolling
          through the per-day details. */}
      <div style={{
        background:   C.bgCard,
        border:       `1px solid ${C.border}`,
        borderLeft:   weekDeltaPct != null && weekDeltaPct > 0.1 ? `4px solid ${C.green}` : `1px solid ${C.border}`,
        borderRadius: UX.r_lg,
        padding:      '20px 24px',
        marginBottom: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' as const }}>
          {/* Left: the headline labour-shift */}
          <div style={{ flex: '1 1 360px', minWidth: 0 }}>
            <div style={eyebrow}>{t('hero.eyebrow', { range: rangeLabel.toUpperCase() })}</div>
            {weekCurPct != null && weekAiPct != null ? (
              <>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 8, flexWrap: 'wrap' as const }}>
                  <span style={{ fontSize: 32, fontWeight: 500, color: C.ink2, letterSpacing: '-0.02em' }}>
                    {Math.round(weekCurPct)}%
                  </span>
                  <span style={{ fontSize: 22, color: C.ink4 }}>→</span>
                  <span style={{ fontSize: 32, fontWeight: 500, color: weekDeltaPct! > 0.1 ? C.green : C.ink2, letterSpacing: '-0.02em' }}>
                    {Math.round(weekAiPct)}%
                  </span>
                  <span style={{ fontSize: 13, color: C.ink3, marginLeft: 4 }}>
                    {t('hero.ofRevenue')}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: C.ink3, marginTop: 6 }}>
                  {t('hero.currentAfter', { count: greenRows.length })}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 14, color: C.ink3, marginTop: 8 }}>
                {t('hero.noForecast')}
              </div>
            )}
          </div>

          {/* Right: the supporting stats */}
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' as const, alignItems: 'flex-start' }}>
            <HeroStat
              label={t('hero.saves')}
              value={weekSavingsKr > 0 ? fmt(weekSavingsKr) : '—'}
              accent={weekSavingsKr > 0 ? C.green : C.ink3}
            />
            <HeroStat
              label={t('hero.hoursCut')}
              value={totalSavedH > 0.5 ? `−${fmtHrs(totalSavedH)}` : '—'}
              accent={totalSavedH > 0.5 ? C.green : C.ink3}
            />
            <HeroStat
              label={t('hero.days')}
              value={amberRows.length
                ? t('hero.daysReadyAmber', { ready: greenRows.length, amber: amberRows.length })
                : t('hero.daysReady',      { count: greenRows.length })}
              accent={C.ink2}
              small
            />
          </div>
        </div>
      </div>

      {/* ─── Action card — "implement now" CTA ─────────────────────────── */}
      {/* Only renders when there are real changes to apply. Bridges the
          gap between "AI says cut X" and "actually edit the roster in PK"
          — clicking opens Personalkollen in a new tab. The "Apply N ready
          days" button at the bottom is for AFTER you've made the changes
          in PK and want to record them as accepted in CommandCenter. */}
      {greenRows.length > 0 && (
        <div style={{
          background:    C.bgCard,
          border:        `1px solid ${C.border}`,
          borderLeft:    `4px solid ${C.green}`,
          borderRadius:  UX.r_lg,
          padding:       '18px 24px',
          marginBottom:  16,
          display:       'flex',
          gap:           20,
          alignItems:    'center',
          justifyContent:'space-between',
          flexWrap:      'wrap' as const,
        }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <div style={eyebrow}>{t('ready.eyebrow')}</div>
            <div style={{ fontSize: 16, fontWeight: 500, color: C.ink, marginTop: 6, letterSpacing: '-0.01em' }}>
              {t('ready.title', { count: greenRows.length })} ·{' '}
              <span style={{ color: C.green }}>{t('ready.savePrefix', { amount: fmt(weekSavingsKr) })}</span>
            </div>
            <div style={{ fontSize: 12, color: C.ink3, marginTop: 4 }}>
              {greenRows.map(r => `${dayLabel(r.date).split(' ')[0]} −${fmtHrs(r.deltaH)}`).join(' · ')}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <a
              href="https://personalkollen.se/"
              target="_blank"
              rel="noopener noreferrer"
              style={{
                background:     C.green,
                color:          'white',
                border:         'none',
                borderRadius:   UX.r_md,
                padding:        '12px 22px',
                fontSize:       14,
                fontWeight:     500,
                cursor:         'pointer',
                textDecoration: 'none',
                display:        'inline-flex',
                alignItems:     'center',
                gap:            8,
                whiteSpace:     'nowrap' as const,
              }}
              title={t('ready.openBtnTitle')}
            >
              {t('ready.openBtn')}
              <span aria-hidden style={{ fontSize: 16, marginTop: -2 }}>↗</span>
            </a>
          </div>
        </div>
      )}

      {/* ─── Section eyebrow above the day list ────────────────────────── */}
      <div style={{ ...eyebrow, marginBottom: 8 }}>
        {t('section.eyebrow', { range: rangeLabel.toUpperCase() })}
      </div>

      {/* ─── Legend ────────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' as const, marginBottom: 16, fontSize: 12, color: C.ink3 }}>
        <LegendItem dot={C.green} text={t('legend.ready',     { count: greenRows.length })} />
        <LegendItem dot={C.amber} text={t('legend.needsCall', { count: amberRows.length })} />
        <LegendItem dot={C.gray}  text={t('legend.unchanged', { unchanged: nochange.length, closed: closedRows.length })} />
      </div>

      {/* ─── Day rows ──────────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6, marginBottom: 18 }}>
        {rows.map(r => (
          <DayRow key={r.date} row={r} fmt={fmt} fmtHrs={fmtHrs} onDecide={handleDecide} t={t} dayLabel={dayLabel} />
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
          {applying
            ? t('actions.applying')
            : greenRows.length > 0
              ? t('actions.apply', { count: greenRows.length })
              : t('actions.nothingReady')}
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
            {t('actions.decideOn', { day: dayLabel(amberRows[0].date).split(' ')[0] })}
          </button>
        )}
        <div style={{ marginLeft: 'auto', fontSize: 12, color: C.ink4 }}>
          {totalSavedH > 0.5 && (
            <>
              {t('actions.totalSummary', {
                hours:  fmtHrs(totalSavedH + amberPotentialH),
                amount: fmt(totalSavedKr + amberPotentialKr),
              })}
              <span style={{ marginLeft: 8 }}>·</span>
              <span style={{ marginLeft: 8 }}>{t('actions.greenOnly', { amount: fmt(totalSavedKr) })}</span>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Day row ────────────────────────────────────────────────────────────────

function DayRow({ row, fmt, fmtHrs, onDecide, t, dayLabel }: {
  row: any
  fmt: (n: number) => string
  fmtHrs: (h: number) => string
  onDecide: (date: string) => void
  t: any
  dayLabel: (iso: string) => string
}) {
  const borderColor = row.status === 'green' ? C.green : row.status === 'amber' ? C.amber : C.gray
  const opacity = row.status === 'gray-closed' ? 0.5 : row.isAccepted ? 0.7 : (row.status === 'gray-nochange' ? 0.65 : 1)

  // Sub-label
  let subLabel = ''
  if (row.status === 'gray-closed')        subLabel = t('row.subClosed')
  else if (row.status === 'gray-nochange') subLabel = t('row.subNoChange',  { hours: fmtHrs(row.curH) })
  else                                     subLabel = t('row.subCurrently', { hours: fmtHrs(row.curH) })

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
            <BarPair labelTop={t('labels.now')} labelBot={t('labels.ai')} topVal={row.curH} botVal={row.aiH} fmtHrs={fmtHrs} botColor={C.green}
              note={row.reasoning || t('row.noteTrim', { hours: fmtHrs(row.deltaH) })} noteColor={C.ink3} accepted={row.isAccepted} />
            <LabourLine curPct={row.curPct} aiPct={row.aiPct} curCost={row.curCost} aiCost={row.aiCost} fmt={fmt} accepted={row.isAccepted} tone="green" t={t} />
          </>
        )}
        {row.status === 'amber' && (
          <>
            <BarPair labelTop={t('labels.ifPattern')} labelBot={t('labels.ifBookings')} topVal={row.aiH} botVal={row.curH} fmtHrs={fmtHrs} botColor={C.amber} topColor={C.amber}
              note={row.reasoning || t('row.amberDefault')} noteColor={C.amber} labelWidth={70} />
            <LabourLine curPct={row.curPct} aiPct={row.aiPct} curCost={row.curCost} aiCost={row.aiCost} fmt={fmt} tone="amber" t={t} />
          </>
        )}
        {row.status === 'gray-closed' && (
          <div style={{ fontSize: 12, color: C.ink4, fontStyle: 'italic' as const }}>{t('row.closedBody')}</div>
        )}
        {row.status === 'gray-nochange' && (
          <>
            <div style={{ fontSize: 12, color: C.ink3 }}>{row.reasoning || t('row.alignedBody')}</div>
            {row.curPct != null && (
              <div style={{ fontSize: 11, color: C.ink4, marginTop: 4 }}>
                {t('row.labourOnTarget', { pct: Math.round(row.curPct) })}
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
              {t('row.altText', { cut: `−${fmtHrs(Math.max(0, row.deltaH))}` })}
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
            ? <span style={{ fontSize: 11, color: C.green, fontWeight: 500 }}>{t('row.applied')}</span>
            : <span style={{ fontSize: 11, color: C.ink3 }}>{t('row.autoApply')}</span>
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
            {t('row.decide')}
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
function LabourLine({ curPct, aiPct, curCost, aiCost, fmt, accepted, tone, t }: {
  curPct: number | null
  aiPct:  number | null
  curCost: number
  aiCost:  number
  fmt: (n: number) => string
  accepted?: boolean
  tone: 'green' | 'amber'
  t: any
}) {
  if (curPct == null || aiPct == null) return null
  const arrow = '→'
  const accent = tone === 'green' ? C.green : C.amber
  const verb   = tone === 'green' ? t('labour.saves') : t('labour.shift')
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
        {t('labour.labour')}
      </span>
      <span style={{ color: C.ink2, fontWeight: 500 }}>
        {Math.round(curPct)}%
      </span>
      <span style={{ color: C.ink4 }}>{arrow}</span>
      <span style={{ color: accent, fontWeight: 500 }}>
        {Math.round(aiPct)}%
      </span>
      <span style={{ color: C.ink4 }}>{t('labour.ofRevenue')}</span>
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

function HeroStat({ label, value, accent, small }: { label: string; value: string; accent: string; small?: boolean }) {
  return (
    <div style={{ minWidth: small ? 110 : 90 }}>
      <div style={eyebrow}>{label}</div>
      <div style={{
        fontSize:      small ? 14 : 22,
        fontWeight:    500,
        color:         accent,
        letterSpacing: '-0.01em',
        marginTop:     6,
        whiteSpace:    'nowrap' as const,
      }}>
        {value}
      </div>
    </div>
  )
}

function LegendItem({ dot, text }: { dot: string; text: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot, display: 'inline-block' }} />
      {text}
    </span>
  )
}

function Loading({ text }: { text: string }) {
  return <div style={{ padding: 60, textAlign: 'center' as const, color: C.ink4, fontSize: 13 }}>{text}</div>
}

function ErrorBox({ text }: { text: string }) {
  return (
    <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: UX.r_lg, color: '#b91c1c', fontSize: 13 }}>
      {text}
    </div>
  )
}

function EmptyBox({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ padding: 40, textAlign: 'center' as const, color: C.ink3, fontSize: 13, background: C.bgCard, borderRadius: UX.r_lg, border: `1px solid ${C.border}` }}>
      <div style={{ fontWeight: 500, marginBottom: 6, color: C.ink }}>{title}</div>
      <div>{body}</div>
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
