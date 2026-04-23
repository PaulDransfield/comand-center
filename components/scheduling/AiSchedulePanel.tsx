// components/scheduling/AiSchedulePanel.tsx
//
// Before-and-after comparison panel for the AI-suggested schedule. Replaces
// the old diff table. Shows labour %-of-revenue (operator's first metric)
// alongside kroner saved.
//
// Layout per SCHEDULE-AI-PROMPT.md:
//   §3.1  Two side-by-side stat cards (YOUR PLAN · arrow · WITH AI APPLIED)
//   §3.2  Green saving strip with two CTAs (Review / Apply all)
//   §3.3  Why strip (indigo info callout explaining the 30–35% target range)
//   §4    Day-by-day rows with tier pills and per-row Accept
//   §5    Summary footer strip
//
// Accept state is persisted via /api/scheduling/accept-day + /accept-all;
// the panel reads it from `acceptances` prop (map of date → row).

'use client'

import { useMemo, useState, useEffect, useRef } from 'react'
import { UX } from '@/lib/constants/tokens'
import {
  labourTier,
  labourTierStyle,
  tierDelta,
  DEFAULT_TIER_CONFIG,
  type LabourTierConfig,
} from '@/lib/utils/labourTier'

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
  data:          any
  recommendation: any
  rangeLabel:    string
  // Persisted acceptances loaded from server — map of YYYY-MM-DD → stored row.
  acceptances:   Record<string, any>
  // 10-second undo window after Apply all.
  lastBatch:     { batch_id: string; at: number } | null
  onAcceptDay:   (row: AcceptRow) => Promise<void>
  onUndoDay:     (date: string) => Promise<void>
  onAcceptAll:   (rows: AcceptRow[]) => Promise<void>
  onUndoBatch:   () => Promise<void>
  fmt:           (n: number) => string
  fmtHrs:        (h: number) => string
  // Hardcoded defaults for this ship; future PR wires these from
  // businesses.labour_target_min / max / watch_ceiling via settings.
  tierConfig?:   LabourTierConfig
}

export default function AiSchedulePanel(props: Props) {
  // ── Hooks FIRST, before any early return, to satisfy Rule of Hooks. ───
  // Previous bug: useRef + the keyboard-shortcut useEffect were declared
  // AFTER the loading/error/!data early-return branches, so the first
  // render (loading=true) called fewer hooks than subsequent renders
  // (data loaded). React crash #310. Everything stays inside this single
  // component — just must be ordered above the first `return`.
  const cfg = props.tierConfig ?? DEFAULT_TIER_CONFIG

  const [obsOpen, setObsOpen] = useState(false)
  const [bookingsFor, setBookingsFor] = useState<any | null>(null)
  const [undoCountdown, setUndoCountdown] = useState<number>(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Compute rowsAnnotated at the top so the keyboard-shortcut useEffect
  // (which closes over it) has a value regardless of which return we hit.
  const pkShiftsFound = Number(props?.data?.pk_shifts_found ?? 0)
  const current       = (props?.data?.current as any[] | undefined) ?? []
  const suggested     = (props?.data?.suggested as any[] | undefined) ?? []
  const hasUsableData = !!props.data && pkShiftsFound > 0

  const rowsAnnotated = hasUsableData ? current.map((c: any, i: number) => {
    const s          = suggested[i] ?? {}
    const predRev    = Number(s.est_revenue ?? 0)
    const pctCurrent = predRev > 0 ? (Number(c.est_cost) / predRev) * 100 : null
    const pctAi      = predRev > 0 ? (Number(s.est_cost) / predRev) * 100 : null
    const hoursDelta = Number(c.hours ?? 0) - Number(s.hours ?? 0)
    const isJudgment = !!s.under_staffed_note
    const isCut      = !isJudgment && hoursDelta > 0.05
    const noChange   = !isJudgment && Math.abs(hoursDelta) < 0.05
    const accepted   = !!props.acceptances?.[c.date]
    const actionType: 'cut'|'no_change'|'judgment_call'|'accepted' =
      accepted     ? 'accepted'
      : isJudgment ? 'judgment_call'
      : isCut      ? 'cut'
      :              'no_change'
    return { ...c, s, predRev, pctCurrent, pctAi, hoursDelta, isJudgment, isCut, noChange, accepted, actionType }
  }) : []

  // Tick the Undo all countdown so the button reads "Undo (Ns)".
  useEffect(() => {
    if (!props.lastBatch) { setUndoCountdown(0); return }
    const tick = () => {
      const elapsed = (Date.now() - props.lastBatch!.at) / 1000
      const left    = Math.max(0, 10 - Math.floor(elapsed))
      setUndoCountdown(left)
    }
    tick()
    const id = setInterval(tick, 500)
    return () => clearInterval(id)
  }, [props.lastBatch])

  // Keyboard shortcuts — A accepts focused row, B opens bookings, Shift+A applies all.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!containerRef.current?.contains(document.activeElement)) return
      if (e.shiftKey && (e.key === 'A' || e.key === 'a')) {
        e.preventDefault(); handleApplyAll(); return
      }
      const rowDate = (document.activeElement as HTMLElement)?.dataset?.rowDate
      if (!e.shiftKey && (e.key === 'a' || e.key === 'A') && rowDate) {
        e.preventDefault()
        const row = rowsAnnotated.find((r: any) => r.date === rowDate)
        if (row && row.isCut && !row.accepted) acceptRow(row)
      }
      if ((e.key === 'b' || e.key === 'B') && rowDate) {
        const row = rowsAnnotated.find((r: any) => r.date === rowDate)
        if (row?.isJudgment) { e.preventDefault(); setBookingsFor(row) }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rowsAnnotated])

  const cardStyle = {
    background:    'white',
    border:        `0.5px solid ${UX.border}`,
    borderRadius:  14,
    padding:       '20px 24px',
    marginBottom:  16,
    scrollMarginTop: 16,
  }

  if (props.loading) {
    return <div id="ai-schedule" style={cardStyle}>
      <div style={{ color: UX.ink4, fontSize: 13 }}>
        Loading AI suggestion for {props.rangeLabel ? props.rangeLabel.toLowerCase() : 'next week'}…
      </div>
    </div>
  }
  if (props.error) {
    return <div id="ai-schedule" style={cardStyle}>
      <div style={{ color: UX.redInk, fontSize: 13 }}>AI suggestion: {props.error}</div>
    </div>
  }
  if (!props.data) return null

  // `current` and `suggested` are already extracted at the top for the
  // keyboard-shortcut closure; re-extract the rest.
  const { summary, week_from, week_to, pk_shifts_found, pk_fetch_error, diag, business_name } = props.data

  // ── PK empty fallback (preserved from previous design) ────────────────
  if (pk_shifts_found === 0) {
    let reason: string
    let fix: string | null = null
    if (pk_fetch_error) {
      reason = `Couldn't reach Personalkollen (${pk_fetch_error})`
      fix    = 'Check the integration — the API token may have been revoked or rotated.'
    } else if (diag?.integration_status && diag.integration_status !== 'connected') {
      reason = `PK integration status: ${diag.integration_status}`
      fix    = 'Open Admin → Customers → your business and check the integration row.'
    } else {
      reason = 'Personalkollen has no published schedule for this range yet.'
      fix    = 'Publish the schedule in PK and reload this page — AI advice will appear automatically.'
    }
    return (
      <div id="ai-schedule" style={cardStyle}>
        <HeaderRow onObs={() => setObsOpen(true)} recommendation={props.recommendation} rationale={summary.rationale} business_name={business_name} rangeLabel={props.rangeLabel} week_from={week_from} week_to={week_to} pk_shifts_found={pk_shifts_found} />
        <div style={{ fontSize: 13, color: UX.ink2, background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: '12px 14px' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>No AI advice available — {reason}</div>
          {fix && <div style={{ fontSize: 12, color: UX.ink4 }}>{fix}</div>}
        </div>
      </div>
    )
  }

  // rowsAnnotated is computed at the top of the component (above hooks).

  // ── Hero totals — show what's been applied so far. Zero accepted ──────
  // means "full potential"; accepting individual rows narrows it. See §4.5.
  const cuttableRows  = rowsAnnotated.filter((r: any) => r.isCut)
  const acceptedRows  = rowsAnnotated.filter((r: any) => r.accepted)
  const M             = cuttableRows.length
  const N             = acceptedRows.length
  const noAcceptsYet  = N === 0

  const totals = rowsAnnotated.reduce((acc: any, r: any) => {
    // applyAi = true means "use AI numbers in the aggregate". At N=0 we
    // assume all cuttable rows will be applied (full potential). Otherwise
    // we use what the user's actually accepted.
    const applyAi = noAcceptsYet ? r.isCut : r.accepted
    acc.hoursCurrent += Number(r.hours ?? 0)
    acc.hoursAi      += applyAi ? Number(r.s.hours ?? 0) : Number(r.hours ?? 0)
    acc.costCurrent  += Number(r.est_cost ?? 0)
    acc.costAi       += applyAi ? Number(r.s.est_cost ?? 0) : Number(r.est_cost ?? 0)
    acc.revenue      += Number(r.s.est_revenue ?? 0)
    return acc
  }, { hoursCurrent: 0, hoursAi: 0, costCurrent: 0, costAi: 0, revenue: 0 })

  const pctCurrentWeek = totals.revenue > 0 ? (totals.costCurrent / totals.revenue) * 100 : null
  const pctAiWeek      = totals.revenue > 0 ? (totals.costAi      / totals.revenue) * 100 : null
  const marginCurrent  = totals.revenue > 0 ? ((totals.revenue - totals.costCurrent) / totals.revenue) * 100 : null
  const marginAi       = totals.revenue > 0 ? ((totals.revenue - totals.costAi)      / totals.revenue) * 100 : null
  const savingKr       = Math.max(0, totals.costCurrent - totals.costAi)
  const hoursDeltaWeek = totals.hoursCurrent - totals.hoursAi
  const keepDays       = rowsAnnotated.filter((r: any) => r.noChange).length
  const judgmentDays   = rowsAnnotated.filter((r: any) => r.isJudgment).length

  const heroLabel =
    noAcceptsYet          ? 'WITH AI APPLIED'
    : N >= M && M > 0     ? `ALL ${M} APPLIED`
    :                       `WITH ${N} OF ${M} APPLIED`

  // Keyboard effect lives at the top of the component (above early returns).

  function acceptRow(r: any) {
    props.onAcceptDay({
      date:            r.date,
      ai_hours:        Number(r.s.hours ?? 0),
      ai_cost_kr:      Number(r.s.est_cost ?? 0),
      current_hours:   Number(r.hours ?? 0),
      current_cost_kr: Number(r.est_cost ?? 0),
      est_revenue_kr:  r.predRev > 0 ? r.predRev : null,
    })
  }

  function handleApplyAll() {
    const rows: AcceptRow[] = cuttableRows
      .filter((r: any) => !r.accepted)
      .map((r: any) => ({
        date:            r.date,
        ai_hours:        Number(r.s.hours ?? 0),
        ai_cost_kr:      Number(r.s.est_cost ?? 0),
        current_hours:   Number(r.hours ?? 0),
        current_cost_kr: Number(r.est_cost ?? 0),
        est_revenue_kr:  r.predRev > 0 ? r.predRev : null,
      }))
    if (rows.length === 0) return
    props.onAcceptAll(rows)
  }

  function scrollToDays() {
    const el = document.getElementById('ai-schedule-days')
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const tierLegend = [
    { t: 'low' as const,       range: `<${cfg.targetMin}%`,  label: 'below' },
    { t: 'on-target' as const, range: `${cfg.targetMin}\u2013${cfg.targetMax}%`, label: 'on target' },
    { t: 'watch' as const,     range: `${cfg.targetMax}\u2013${cfg.watchCeiling}%`, label: 'watch' },
    { t: 'over' as const,      range: `>${cfg.watchCeiling}%`, label: 'over' },
  ]

  return (
    <div id="ai-schedule" style={cardStyle} ref={containerRef}>
      <HeaderRow onObs={() => setObsOpen(true)} recommendation={props.recommendation} rationale={summary.rationale} business_name={business_name} rangeLabel={props.rangeLabel} week_from={week_from} week_to={week_to} pk_shifts_found={pk_shifts_found} />

      {/* ── §3.1 Two stat cards with arrow ────────────────────────── */}
      <section aria-labelledby="plan-your" style={{ display: 'grid', gridTemplateColumns: '1fr 52px 1fr', gap: 0, alignItems: 'stretch', marginBottom: 12 }}>
        {/* YOUR PLAN */}
        <StatCard
          id="plan-your"
          eyebrow="YOUR PLAN"
          tone="neutral"
          stats={[
            {
              label: 'Scheduled hours',
              value: `${(totals.hoursCurrent).toFixed(1)} h`,
              sub:   `${current.reduce((s: number, c: any) => s + (c.shifts ?? 0), 0)} shifts across ${current.length} days`,
            },
            {
              label:    'Staff cost',
              value:    props.fmt(totals.costCurrent),
              pillPct:  pctCurrentWeek,
              cfg,
              sub:      pctCurrentWeek == null
                ? 'no predicted sales on record'
                : (() => {
                    const d = tierDelta(pctCurrentWeek, cfg)
                    if (d.kind === 'within') return 'within target range'
                    if (d.kind === 'above')  return `${d.pp}pp over target`
                    if (d.kind === 'below')  return `${d.pp}pp under target`
                    return ''
                  })(),
            },
            {
              label:  'Projected margin',
              value:  marginCurrent == null ? '—' : `${marginCurrent.toFixed(1)}%`,
              sub:    totals.revenue > 0 ? `on ${props.fmt(totals.revenue)} predicted sales` : '',
            },
          ]}
        />

        <Arrow active={savingKr > 0} />

        {/* WITH AI APPLIED */}
        <StatCard
          id="plan-ai"
          eyebrow={heroLabel}
          tone="ai"
          stats={[
            {
              label: 'Scheduled hours',
              value: `${(totals.hoursAi).toFixed(1)} h`,
              chip:  hoursDeltaWeek > 0.05 ? { sym: '↓', text: `${hoursDeltaWeek.toFixed(1)} h` } : undefined,
              sub:   `${cuttableRows.length} day${cuttableRows.length === 1 ? '' : 's'} trimmed · ${keepDays} kept as-is${judgmentDays ? ` · ${judgmentDays} judgment` : ''}`,
            },
            {
              label:   'Staff cost',
              value:   props.fmt(totals.costAi),
              pillPct: pctAiWeek,
              cfg,
              sub:     (() => {
                if (savingKr <= 0 || pctAiWeek == null || pctCurrentWeek == null) return 'no change'
                const delta = pctCurrentWeek - pctAiWeek
                return `${props.fmt(-savingKr)} · ${delta >= 0 ? '\u2193' : '\u2191'} ${Math.abs(delta).toFixed(1)}pp toward target`
              })(),
            },
            {
              label:  'Projected margin',
              value:  marginAi == null ? '—' : `${marginAi.toFixed(1)}%`,
              chip:   (marginAi != null && marginCurrent != null && marginAi - marginCurrent > 0.05)
                ? { sym: '↑', text: `${(marginAi - marginCurrent).toFixed(1)}pp` } : undefined,
              sub:    'same predicted sales',
            },
          ]}
        />
      </section>

      {/* ── §3.2 Saving strip ──────────────────────────────────────── */}
      <div style={{
        background: UX.greenInk,
        color:      'white',
        borderRadius: 10,
        padding:      '14px 18px',
        display:      'grid',
        gridTemplateColumns: '1fr auto',
        gap:          14,
        alignItems:   'center',
        marginBottom: 14,
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 500, letterSpacing: '-.01em' }}>
            {savingKr > 0 && pctCurrentWeek != null && pctAiWeek != null
              ? <>−{props.fmt(savingKr)} · labour {pctCurrentWeek.toFixed(1)}% → {pctAiWeek.toFixed(1)}%</>
              : <>Schedule already matches AI — no cuts to apply.</>}
          </div>
          {savingKr > 0 && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,.82)', marginTop: 4 }}>
              saved this {props.rangeLabel?.toLowerCase().includes('month') ? 'month' : props.rangeLabel?.toLowerCase().includes('2') || props.rangeLabel?.toLowerCase().includes('4') ? 'period' : 'week'} · margin {marginAi != null && marginCurrent != null ? `up ${(marginAi - marginCurrent).toFixed(1)}pp` : 'unchanged'} · 100% of predicted revenue preserved
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
          {props.lastBatch && undoCountdown > 0 ? (
            <button
              onClick={props.onUndoBatch}
              style={btnPrimary}
            >
              Undo all ({undoCountdown}s)
            </button>
          ) : (
            <>
              <button onClick={scrollToDays} style={btnSecondary}>Review day-by-day</button>
              <button onClick={handleApplyAll} style={btnPrimary} disabled={cuttableRows.every((r: any) => r.accepted) || cuttableRows.length === 0}>
                {N === 0 ? 'Apply all changes →' : N >= M ? 'All applied ✓' : `Apply remaining ${M - N} →`}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── §3.3 Why strip ─────────────────────────────────────────── */}
      <div style={{
        background: UX.subtleBg,
        border:     `0.5px solid ${UX.border}`,
        borderRadius: 10,
        padding:    '11px 14px',
        marginBottom: 18,
        display:    'flex',
        gap:        10,
        alignItems: 'flex-start',
        fontSize:   12,
        color:      UX.ink2,
        lineHeight: 1.55,
      }}>
        <span style={{ color: '#4338ca', fontSize: 14, lineHeight: 1, marginTop: 1 }}>ⓘ</span>
        <div>
          <strong>Why these cuts.</strong>{' '}
          {summary.rationale
            ? summary.rationale
            : <>
                {cuttableRows.length} day{cuttableRows.length === 1 ? '' : 's'} in this period match ≥3 past days with the same weather and booking pattern that averaged higher revenue per scheduled hour than you're staffing for. Target labour {cfg.targetMin}–{cfg.targetMax}% of revenue — AI trims toward the target range, never past it, and never adds hours.
              </>}
        </div>
      </div>

      {/* ── §4 Day-by-day breakdown header ─────────────────────────── */}
      <div id="ai-schedule-days" style={{
        fontSize: 11, fontWeight: 700, letterSpacing: '.08em',
        textTransform: 'uppercase' as const, color: UX.ink4,
        marginBottom: 8,
      }}>
        Day-by-day breakdown
      </div>

      {/* ── §4.1 Legend ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' as const, alignItems: 'center', marginBottom: 12, fontSize: 10, color: UX.ink3 }}>
        <span>Labour % tier —</span>
        {tierLegend.map(({ t, range, label }) => {
          const st = labourTierStyle(t)
          return (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{
                display: 'inline-block',
                padding: '1px 7px',
                borderRadius: 10,
                background: st.bg,
                color: st.ink,
                fontWeight: 700,
                fontSize: 10,
              }}>{range}</span>
              <span>{label}</span>
            </span>
          )
        })}
      </div>

      {/* ── §4.2 Day rows ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexDirection: 'column' as const }}>
        {rowsAnnotated.map((r: any) => (
          <DayRow
            key={r.date}
            r={r}
            cfg={cfg}
            fmt={props.fmt}
            onAccept={() => acceptRow(r)}
            onUndo={() => props.onUndoDay(r.date)}
            onOpenBookings={() => setBookingsFor(r)}
          />
        ))}
      </div>

      {/* ── §5 Footer strip ────────────────────────────────────────── */}
      <div style={{
        marginTop: 14,
        background: UX.subtleBg,
        border:     `0.5px solid ${UX.border}`,
        borderRadius: 8,
        padding:    '10px 14px',
        fontSize:   11,
        display:    'flex',
        justifyContent: 'space-between',
        gap:        10,
        flexWrap:   'wrap' as const,
      }}>
        <div style={{ color: UX.ink3 }}>
          {cuttableRows.length} days with cuts · {keepDays} days unchanged
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' as const, justifyContent: 'flex-end' }}>
          {pctCurrentWeek != null && pctAiWeek != null && (
            <span style={{ color: UX.ink3 }}>
              labour{' '}
              <span style={{ fontWeight: 500, color: labourTierStyle(labourTier(pctCurrentWeek, cfg)).ink }}>
                {pctCurrentWeek.toFixed(1)}%
              </span>
              {' → '}
              <span style={{ fontWeight: 500, color: labourTierStyle(labourTier(pctAiWeek, cfg)).ink }}>
                {pctAiWeek.toFixed(1)}%
              </span>
            </span>
          )}
          <span style={{ color: savingKr > 0 ? UX.greenInk : UX.ink3, fontWeight: 500 }}>
            {savingKr > 0 ? `total saving −${props.fmt(savingKr)}` : 'no savings available'}
          </span>
        </div>
      </div>

      {/* ── Bookings modal for judgment rows ─────────────────────── */}
      {bookingsFor && (
        <BookingsModal row={bookingsFor} onClose={() => setBookingsFor(null)} fmt={props.fmt} cfg={cfg} />
      )}

      {/* ── Obs modal (unchanged from previous design) ────────────── */}
      {obsOpen && props.recommendation && (
        <ObsModal recommendation={props.recommendation} onClose={() => setObsOpen(false)} fmt={props.fmt} />
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────

function HeaderRow({ onObs, recommendation, rationale, business_name, rangeLabel, week_from, week_to, pk_shifts_found }: any) {
  const shortRange = week_from && week_to
    ? `${week_from.slice(8)}–${week_to.slice(8)} ${new Date(week_from).toLocaleDateString('en-GB', { month: 'short' })}`
    : ''
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12, flexWrap: 'wrap' as const }}>
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: UX.ink1 }}>AI-suggested schedule</span>
          <span style={{ fontSize: 10, background: '#ede9fe', color: '#6d28d9', padding: '2px 7px', borderRadius: 4, fontWeight: 600, letterSpacing: '.03em' }}>AI</span>
          {rationale && (
            <span
              title={rationale}
              aria-label="How the suggestion is built"
              style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 16, height: 16, borderRadius: '50%', background: '#f3f4f6', color: UX.ink4, fontSize: 10, fontWeight: 700, cursor: 'help' }}
            >?</span>
          )}
          {recommendation && (
            <button
              onClick={onObs}
              title="Weekly AI observations from the last 90 days"
              aria-label="Open weekly AI observations"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', marginLeft: 2, borderRadius: 999, background: '#ede9fe', color: '#6d28d9', border: 'none', fontSize: 10, fontWeight: 600, letterSpacing: '.03em', cursor: 'pointer' }}
            >
              <span style={{ fontSize: 11, lineHeight: 1 }}>ⓘ</span> Observations
            </button>
          )}
        </div>
        <div style={{ fontSize: 11, color: UX.ink4 }}>
          {rangeLabel ?? 'Next week'}{shortRange ? ` · ${shortRange}` : ''}{pk_shifts_found > 0 ? ` · ${pk_shifts_found} shifts in PK` : ' · no PK schedule yet'}
        </div>
      </div>
    </div>
  )
}

interface Stat { label: string; value: string; sub?: string; pillPct?: number | null; cfg?: LabourTierConfig; chip?: { sym: string; text: string } }
function StatCard({ id, eyebrow, tone, stats }: { id: string; eyebrow: string; tone: 'neutral' | 'ai'; stats: Stat[] }) {
  const isAi = tone === 'ai'
  return (
    <div
      style={{
        background: isAi ? '#f0fdf4' : UX.subtleBg,
        border:     `0.5px solid ${isAi ? UX.greenBorder : UX.border}`,
        borderRadius: 12,
        padding:    '14px 16px',
      }}
    >
      <div id={id} style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: isAi ? UX.greenInk : UX.ink4, marginBottom: 10 }}>
        {eyebrow}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
        {stats.map((s, i) => (
          <div key={i}>
            <div style={{ fontSize: 10, color: UX.ink4, fontWeight: 600, letterSpacing: '.05em', textTransform: 'uppercase' as const, marginBottom: 2 }}>
              {s.label}
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const }}>
              <span style={{ fontSize: 17, fontWeight: 500, color: UX.ink1, letterSpacing: '-.01em' }}>{s.value}</span>
              {s.pillPct != null && s.cfg && (
                <TierPill pct={s.pillPct} cfg={s.cfg} />
              )}
              {s.chip && (
                <span style={{ fontSize: 11, fontWeight: 600, color: UX.greenInk, background: '#dcfce7', padding: '1px 7px', borderRadius: 10 }}>
                  {s.chip.sym} {s.chip.text}
                </span>
              )}
            </div>
            {s.sub && (
              <div style={{ fontSize: 11, color: UX.ink4, marginTop: 2 }}>{s.sub}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function Arrow({ active }: { active: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke={active ? UX.greenInk : UX.ink5} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12h14M12 5l7 7-7 7"/>
      </svg>
    </div>
  )
}

function TierPill({ pct, cfg }: { pct: number; cfg: LabourTierConfig }) {
  const tier = labourTier(pct, cfg)
  const st   = labourTierStyle(tier)
  return (
    <span
      aria-label={`Labour ${pct.toFixed(1)} percent, ${st.label} tier`}
      style={{
        display:      'inline-block',
        padding:      '2px 9px',
        borderRadius: 12,
        fontSize:     11,
        fontWeight:   700,
        background:   st.bg,
        color:        st.ink,
      }}
    >
      {pct.toFixed(1)}%
    </span>
  )
}

function DayRow({ r, cfg, fmt, onAccept, onUndo, onOpenBookings }: any) {
  const acceptedStyle = {
    border:      `1px solid ${UX.greenBorder}`,
    background:  '#f7fcf5',
  }
  const baseStyle: any = {
    display:       'grid',
    gridTemplateColumns: '110px 1fr 190px',
    gap:           12,
    padding:       '12px 14px',
    borderTop:     `0.5px solid ${UX.border}`,
    borderLeft:    r.isJudgment ? `2.5px solid #4338ca` : undefined,
    opacity:       r.noChange ? 0.65 : 1,
    ...(r.accepted ? acceptedStyle : {}),
    alignItems:    'center',
  }
  const w = r.s?.weather

  // Tier of the AI-side pct — used for the "low staffing after cut" warning.
  const aiTier = labourTier(r.pctAi ?? null, cfg)
  const showLowWarn = r.isCut && aiTier === 'low'

  return (
    <div
      tabIndex={r.isCut || r.isJudgment ? 0 : -1}
      data-row-date={r.date}
      style={baseStyle}
      title={r.s?.reasoning || undefined}
    >
      {/* Left zone — day + weather */}
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: UX.ink1, whiteSpace: 'nowrap' as const }}>
          {r.weekday} {r.date.slice(8)} {new Date(r.date + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short' })}
        </div>
        {w && (
          <div style={{ fontSize: 10, color: UX.ink4, marginTop: 2 }}>
            {String(w.summary || '').toLowerCase()} {w.temp_min != null ? `${Math.round(w.temp_min)}\u2013${Math.round(w.temp_max)}°C` : ''}
          </div>
        )}
        {r.isJudgment && (
          <span style={{ display: 'inline-block', marginTop: 4, fontSize: 9, fontWeight: 700, color: '#4338ca', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 4, padding: '1px 5px', letterSpacing: '.04em' }}>
            BOOKINGS
          </span>
        )}
      </div>

      {/* Middle zone — your plan · arrow · AI suggests */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 24px 1fr', gap: 8, alignItems: 'center' }}>
        {/* Your plan */}
        <div>
          <div style={{ fontSize: 9, color: UX.ink4, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>YOUR PLAN</div>
          <div style={{ fontSize: 13, fontWeight: 500, color: UX.ink1 }}>{r.hours?.toFixed(1) ?? '—'} h</div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
            <span style={{ fontSize: 10, color: UX.ink3 }}>{fmt(r.est_cost ?? 0)}</span>
            {r.pctCurrent != null && <TierPill pct={r.pctCurrent} cfg={cfg} />}
          </div>
        </div>

        {/* Arrow */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={r.isCut || r.accepted ? UX.greenInk : UX.ink5} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12h14M12 5l7 7-7 7"/>
          </svg>
        </div>

        {/* AI suggests */}
        <div>
          <div style={{ fontSize: 9, color: UX.ink4, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase' as const }}>AI SUGGESTS</div>
          {r.isJudgment ? (
            <div style={{ fontSize: 12, color: '#4338ca', fontWeight: 600 }}>review bookings</div>
          ) : r.noChange ? (
            <div style={{ fontSize: 12, color: UX.ink4 }}>keep as-is</div>
          ) : (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, color: UX.greenInk }}>{r.s?.hours?.toFixed(1) ?? '—'} h</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                <span style={{ fontSize: 10, color: UX.ink3 }}>{fmt(r.s?.est_cost ?? 0)}</span>
                {r.pctAi != null && <TierPill pct={r.pctAi} cfg={cfg} />}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Right zone — saving + accept */}
      <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-end', gap: 6 }}>
        {r.isJudgment ? (
          <>
            <div style={{ fontSize: 11, color: UX.ink4 }}>judgment call</div>
            <button onClick={onOpenBookings} style={rowBtnGhost}>Open bookings →</button>
          </>
        ) : r.noChange ? (
          <div style={{ fontSize: 11, color: UX.ink4 }}>—</div>
        ) : (
          <>
            <div style={{ fontSize: 15, fontWeight: 500, color: UX.greenInk }}>
              {fmt(Math.max(0, (r.est_cost ?? 0) - (r.s?.est_cost ?? 0)))}
            </div>
            {r.pctCurrent != null && r.pctAi != null && (
              <div style={{ fontSize: 10, color: UX.ink3 }}>
                labour <span style={{ fontWeight: 700, color: labourTierStyle(labourTier(r.pctAi, cfg)).ink }}>{r.pctAi.toFixed(1)}%</span> was {r.pctCurrent.toFixed(1)}%
              </div>
            )}
            {showLowWarn && (
              <div style={{ fontSize: 10, color: '#4338ca' }}>low staffing — verify service</div>
            )}
            {r.accepted ? (
              <button onClick={onUndo} style={rowBtnFilled}>Accepted ✓</button>
            ) : (
              <button onClick={onAccept} style={rowBtnGhost}>Accept</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Bookings modal — shows historical avg + same-weekday prior-year revenue ──
function BookingsModal({ row, onClose, fmt, cfg }: any) {
  const predRev = row.predRev ?? 0
  return (
    <div onClick={onClose} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 520, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }}>
        <div style={{ padding: '18px 24px', borderBottom: `1px solid ${UX.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: UX.ink1 }}>Bookings check — {row.weekday} {row.date}</div>
            <div style={{ fontSize: 11, color: UX.ink4 }}>Your schedule looks lean vs. the 12-week pattern for this weekday + weather.</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: UX.ink4, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ padding: '16px 24px', fontSize: 13, color: UX.ink2, lineHeight: 1.65 }}>
          <p style={{ margin: 0 }}>
            Your <strong>{row.weekday}s</strong> averaged <strong>{fmt(predRev)}</strong> in the last 12 weeks
            {row.s?.bucket_days_seen >= 3 && <> (with {row.s.bucket_days_seen} matching-weather days)</>}.
            You have <strong>{row.hours?.toFixed(1)} h</strong> scheduled, which is lighter than the pattern.
          </p>
          <p style={{ marginTop: 12, marginBottom: 0, color: UX.ink3 }}>
            Open PK or your bookings app and confirm the reservation count. If bookings are unusually light, keep the lean schedule. If they match or exceed your 12-week average, consider topping up staff before the shift.
          </p>
          <div style={{ marginTop: 16, padding: 12, background: UX.subtleBg, borderRadius: 8, border: `0.5px solid ${UX.border}` }}>
            <div style={{ fontSize: 10, color: UX.ink4, letterSpacing: '.06em', textTransform: 'uppercase' as const, fontWeight: 700, marginBottom: 6 }}>What we see</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, fontSize: 12 }}>
              <div><div style={{ color: UX.ink4, fontSize: 10 }}>Pattern avg rev</div><div style={{ fontWeight: 500 }}>{fmt(predRev)}</div></div>
              <div><div style={{ color: UX.ink4, fontSize: 10 }}>Your hours</div><div style={{ fontWeight: 500 }}>{row.hours?.toFixed(1)} h</div></div>
            </div>
          </div>
        </div>
        <div style={{ padding: '14px 24px', borderTop: `1px solid ${UX.border}`, display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btnPrimary}>Got it</button>
        </div>
      </div>
    </div>
  )
}

function ObsModal({ recommendation, onClose, fmt }: any) {
  return (
    <div onClick={onClose} style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 560, maxHeight: '90vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' as const }}>
        <div style={{ padding: '18px 24px', borderBottom: `1px solid ${UX.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: UX.ink1 }}>Weekly AI observations</span>
              <span style={{ fontSize: 10, background: '#ede9fe', color: '#6d28d9', padding: '2px 7px', borderRadius: 4, fontWeight: 600, letterSpacing: '.03em' }}>AI</span>
            </div>
            <div style={{ fontSize: 11, color: UX.ink4 }}>
              Generated {new Date(recommendation.generated_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
              {recommendation.analysis_period && ` · based on ${recommendation.analysis_period}`}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 22, color: UX.ink4, lineHeight: 1 }}>×</button>
        </div>
        <div style={{ overflowY: 'auto' as const, flex: 1, padding: '16px 24px' }}>
          <div style={{ fontSize: 13, color: UX.ink2, lineHeight: 1.7, whiteSpace: 'pre-wrap' as const, background: '#fafbff', borderRadius: 10, padding: '14px 16px', borderLeft: '3px solid #6366f1' }}>
            {recommendation.recommendations}
          </div>
          {recommendation.metadata && (
            <div style={{ marginTop: 12, display: 'flex', gap: 20, fontSize: 11, color: UX.ink4, flexWrap: 'wrap' as const }}>
              {recommendation.metadata.staff_shifts && <span>Shifts analysed: <strong style={{ color: UX.ink2 }}>{recommendation.metadata.staff_shifts}</strong></span>}
              {recommendation.metadata.total_hours  && <span>Hours: <strong style={{ color: UX.ink2 }}>{Math.round(recommendation.metadata.total_hours)}h</strong></span>}
              {recommendation.metadata.labor_cost   && <span>Labour cost: <strong style={{ color: UX.ink2 }}>{fmt(recommendation.metadata.labor_cost)}</strong></span>}
              {recommendation.metadata.late_shifts  && <span>Late shifts: <strong style={{ color: UX.ink2 }}>{recommendation.metadata.late_shifts}</strong></span>}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Shared styles ──────────────────────────────────────────────────────
const btnPrimary: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: 12,
  fontWeight: 600,
  color: UX.greenInk,
  background: 'white',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
}
const btnSecondary: React.CSSProperties = {
  padding: '8px 14px',
  fontSize: 12,
  fontWeight: 500,
  color: 'white',
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.55)',
  borderRadius: 8,
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
}
const rowBtnGhost: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: UX.greenInk,
  background: 'white',
  border: `1px solid ${UX.greenBorder}`,
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
}
const rowBtnFilled: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 11,
  fontWeight: 600,
  color: 'white',
  background: UX.greenInk,
  border: `1px solid ${UX.greenInk}`,
  borderRadius: 6,
  cursor: 'pointer',
  whiteSpace: 'nowrap' as const,
}
