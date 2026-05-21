'use client'
// @ts-nocheck
// app/scheduling/page.tsx — full rebuild on the new system
//
// Same treatment as the other rebuilds. Drops the deep-legacy SVG
// components (AiHoursReductionMap / WeekGridView / RotaDay / the
// retired AiSchedulePanel) entirely in favour of a single clean UXP
// day list. Logic preserved: same /api/scheduling/ai-suggestion +
// /api/scheduling/accept-day + /accept-all + /day-details endpoints,
// same range model (this/next week, 2w, 4w, next month), same accept
// + undo batch behaviour.
//
// Visual contract:
//   • UXP tokens only
//   • Spline Sans body / Fraunces display
//   • 0.5px hairlines, tabular-nums numbers
//   • labourTier() the single source for labour-cost colour decisions

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useMemo, useState } from 'react'
import dynamicImport from 'next/dynamic'

const AskAI = dynamicImport(() => import('@/components/AskAI'), { ssr: false, loading: () => null })

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtPct, fmtHrs as fmtH } from '@/lib/format'

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAYS     = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun']

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

type RangeKey = 'this_week' | 'next_week' | '2w' | '4w' | 'next_month'

const RANGE_LABELS: Record<RangeKey, string> = {
  this_week:  'This week',
  next_week:  'Next week',
  '2w':       'Next 2 weeks',
  '4w':       'Next 4 weeks',
  next_month: 'Next month',
}

function weatherIcon(code?: number): string {
  if (code == null) return ''
  if (code === 0)              return '☀️'
  if (code <= 3)               return '⛅'
  if (code === 45 || code === 48) return '🌫️'
  if (code >= 51 && code <= 57)   return '🌦️'
  if (code >= 61 && code <= 67)   return '🌧️'
  if (code >= 71 && code <= 77)   return '❄️'
  if (code >= 80 && code <= 82)   return '🌦️'
  if (code >= 85 && code <= 86)   return '🌨️'
  if (code >= 95)                 return '⛈️'
  return ''
}

export default function SchedulingPage() {
  const [bizId,        setBizId]        = useState<string | null>(null)
  const [aiRange,      setAiRange]      = useState<RangeKey>('next_week')
  const [aiSched,      setAiSched]      = useState<any>(null)
  const [aiLoading,    setAiLoading]    = useState(true)
  const [aiError,      setAiError]      = useState<string>('')
  const [acceptances,  setAcceptances]  = useState<Record<string, any>>({})
  const [lastBatch,    setLastBatch]    = useState<{ batch_id: string; at: number } | null>(null)

  // Sync to BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  // ── Compute the forward range bounds ─────────────────────────────
  // 'this_week' anchors on the CURRENT ISO Monday so the operator can
  // see today + the rest of this week against the 12-week pattern.
  // Other forward ranges anchor on NEXT Monday.
  const aiBounds = useMemo(() => {
    const now = new Date()
    const dow = now.getDay() === 0 ? 7 : now.getDay()
    const thisMon = new Date(now); thisMon.setDate(now.getDate() - (dow - 1)); thisMon.setHours(0, 0, 0, 0)
    const thisSun = new Date(thisMon); thisSun.setDate(thisMon.getDate() + 6)
    const nextMon = new Date(thisMon); nextMon.setDate(thisMon.getDate() + 7)

    if (aiRange === 'this_week') {
      return { from: localDate(thisMon), to: localDate(thisSun), label: 'This week' }
    }
    if (aiRange === 'next_month') {
      const y = nextMon.getFullYear(), m = nextMon.getMonth() + 1
      const start = new Date(y, m, 1)
      const end   = new Date(y, m + 1, 0)
      return { from: localDate(start), to: localDate(end), label: 'Next month' }
    }
    const days = aiRange === '2w' ? 13 : aiRange === '4w' ? 27 : 6
    const end  = new Date(nextMon); end.setDate(nextMon.getDate() + days)
    return { from: localDate(nextMon), to: localDate(end), label: RANGE_LABELS[aiRange] }
  }, [aiRange])

  // ── AI suggestion fetch ──────────────────────────────────────────
  useEffect(() => {
    if (!bizId) return
    let cancelled = false
    setAiLoading(true); setAiError('')
    fetch(`/api/scheduling/ai-suggestion?business_id=${bizId}&from=${aiBounds.from}&to=${aiBounds.to}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (!cancelled) { if (j.error) setAiError(j.error); else setAiSched(j) } })
      .catch(e => { if (!cancelled) setAiError(e.message) })
      .finally(() => { if (!cancelled) setAiLoading(false) })
    return () => { cancelled = true }
  }, [bizId, aiBounds.from, aiBounds.to])

  // ── Acceptances ──────────────────────────────────────────────────
  const loadAcceptances = useCallback(async () => {
    if (!bizId) return
    try {
      const r = await fetch(`/api/scheduling/acceptances?business_id=${bizId}&from=${aiBounds.from}&to=${aiBounds.to}`, { cache: 'no-store' })
      const j = await r.json()
      if (r.ok) {
        const map: Record<string, any> = {}
        for (const row of (j.rows ?? [])) map[row.date] = row
        setAcceptances(map)
      }
    } catch {}
  }, [bizId, aiBounds.from, aiBounds.to])
  useEffect(() => { loadAcceptances() }, [loadAcceptances])

  async function acceptDay(row: any) {
    setAcceptances(prev => ({ ...prev, [row.date]: { ...row, decided_at: new Date().toISOString() } }))
    try {
      const r = await fetch('/api/scheduling/accept-day', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, ...row }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'accept failed')
    } catch (e: any) {
      // Revert
      setAcceptances(prev => { const next = { ...prev }; delete next[row.date]; return next })
      alert(`Couldn't accept: ${e.message}`)
    }
  }

  async function rejectDay(date: string) {
    setAcceptances(prev => { const next = { ...prev }; delete next[date]; return next })
    try {
      await fetch(`/api/scheduling/accept-day?business_id=${bizId}&date=${date}`, { method: 'DELETE' })
    } catch {}
  }

  async function acceptAll(rows: Array<any>) {
    const payload = rows.map(r => ({
      date:            r.date,
      ai_hours:        r.ai_hours,
      ai_cost_kr:      r.ai_cost_kr,
      current_hours:   r.current_hours,
      current_cost_kr: r.current_cost_kr,
      est_revenue_kr:  r.est_revenue_kr,
    }))
    const optimistic: Record<string, any> = { ...acceptances }
    for (const r of rows) optimistic[r.date] = { ...r, decided_at: new Date().toISOString() }
    setAcceptances(optimistic)

    try {
      const r = await fetch('/api/scheduling/accept-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, rows: payload }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? 'accept-all failed')
      setLastBatch({ batch_id: j.batch_id, at: Date.now() })
      setTimeout(() => setLastBatch(curr => (curr && Date.now() - curr.at >= 10_000) ? null : curr), 10_500)
    } catch (e: any) {
      setAcceptances(acceptances)
      alert(`Couldn't apply all: ${e.message}`)
    }
  }

  async function undoBatch() {
    if (!lastBatch) return
    const batchId = lastBatch.batch_id
    setLastBatch(null)
    try {
      await fetch(`/api/scheduling/accept-all?business_id=${bizId}&batch_id=${batchId}`, { method: 'DELETE' })
    } finally {
      loadAcceptances()
    }
  }

  // ── Derive rows + summary ────────────────────────────────────────
  const days = useMemo(() => buildDayRows(aiSched, acceptances), [aiSched, acceptances])
  const pendingActionable = days.filter(d => d.has_recommendation && !d.accepted)
  const totalSaving       = pendingActionable.reduce((s, d) => s + Math.max(0, d.delta_cost ?? 0), 0)
  const summary           = aiSched?.summary ?? null

  return (
    <AppShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {/* Range picker */}
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <RangePicker value={aiRange} onChange={setAiRange} label={aiBounds.label} />
        </div>

        {/* KPI strip — Hours · Cost · Saving · Days flagged */}
        <KpiStrip summary={summary} days={days} totalSaving={totalSaving} rangeLabel={aiBounds.label} />

        {/* Error */}
        {aiError && (
          <Banner tone="bad" text={aiError} />
        )}

        {/* Apply-all banner */}
        {pendingActionable.length > 0 && (
          <ApplyAllBanner
            count={pendingActionable.length}
            saving={totalSaving}
            onApply={() => acceptAll(pendingActionable)}
          />
        )}

        {/* Undo window */}
        {lastBatch && (
          <UndoBanner onUndo={undoBatch} />
        )}

        {/* Day list */}
        {aiLoading && (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
            Loading AI schedule…
          </div>
        )}
        {!aiLoading && !aiError && days.length === 0 && (
          <Empty>
            No AI schedule available for {aiBounds.label.toLowerCase()}.
            Personalkollen needs at least one connected business + 4 weeks of history.
          </Empty>
        )}
        {!aiLoading && days.length > 0 && (
          <DayList
            days={days}
            onAccept={acceptDay}
            onReject={rejectDay}
          />
        )}

        {/* Open Personalkollen CTA */}
        <PkActionCard />

        {/* Rationale footer */}
        <RationaleFooter />
      </div>

      <AskAI
        page="scheduling"
        context={summary ? [
          `Range: ${aiBounds.label} (${aiBounds.from} → ${aiBounds.to})`,
          `Current hours ${summary.current_hours ?? 0}h · AI hours ${summary.suggested_hours ?? 0}h · Saving ${fmtKr(summary.saving_kr ?? 0)}`,
          pendingActionable.length > 0 ? `${pendingActionable.length} days pending review.` : 'All recommendations accepted or no flags.',
        ].join('\n') : 'No AI schedule yet'}
      />
    </AppShell>
  )
}

// ════════════════════════════════════════════════════════════════════
// Data shaping
// ════════════════════════════════════════════════════════════════════

function buildDayRows(aiSched: any, acceptances: Record<string, any>) {
  if (!aiSched) return [] as any[]
  const cur  = (aiSched.current   as any[] | undefined) ?? []
  const sug  = (aiSched.suggested as any[] | undefined) ?? []
  return cur.map((c: any, i: number) => {
    const s = sug[i] ?? {}
    const dayCost   = Number(c.est_cost ?? 0)
    const dayHours  = Number(c.est_hours ?? 0)
    const aiCost    = Number(s.est_cost  ?? dayCost)
    const aiHours   = Number(s.est_hours ?? dayHours)
    const date      = String(c.date ?? s.date ?? '')
    const accepted  = !!acceptances[date]
    const deltaH    = dayHours - aiHours
    const deltaCost = dayCost - aiCost
    const hasRec    = Math.abs(deltaH) >= 2 || Math.abs(deltaCost) >= 200
    return {
      date,
      weekday:         WEEKDAYS[(new Date(date + 'T12:00:00Z').getUTCDay() + 6) % 7],
      current_hours:   dayHours,
      current_cost_kr: dayCost,
      ai_hours:        aiHours,
      ai_cost_kr:      aiCost,
      delta_hours:     deltaH,
      delta_cost:      deltaCost,
      est_revenue_kr:  Number(s.est_revenue ?? c.est_revenue ?? 0) || null,
      weather:         s.weather ?? c.weather ?? null,
      under_staffed_note: s.under_staffed_note ?? null,
      has_recommendation: hasRec,
      accepted,
    }
  })
}

// ════════════════════════════════════════════════════════════════════
// Sub-components — all UXP
// ════════════════════════════════════════════════════════════════════

function RangePicker({ value, onChange, label }: { value: RangeKey; onChange: (v: RangeKey) => void; label: string }) {
  const opts: Array<{ k: RangeKey; lab: string }> = [
    { k: 'this_week',  lab: 'This week'  },
    { k: 'next_week',  lab: 'Next week'  },
    { k: '2w',         lab: '2 weeks'    },
    { k: '4w',         lab: '4 weeks'    },
    { k: 'next_month', lab: 'Next month' },
  ]
  return (
    <div style={{
      display:      'inline-flex',
      gap:          2,
      background:   UXP.cardBg,
      border:       `0.5px solid ${UXP.border}`,
      borderRadius: 7,
      padding:      2,
    }}>
      {opts.map(o => (
        <button
          key={o.k}
          type="button"
          onClick={() => onChange(o.k)}
          style={{
            padding:       '4px 12px',
            background:    value === o.k ? UXP.lavFill : 'transparent',
            color:         value === o.k ? UXP.lavText : UXP.ink3,
            border:        'none',
            borderRadius:  5,
            fontSize:      10,
            fontWeight:    500,
            fontFamily:    'inherit',
            cursor:        'pointer',
            letterSpacing: '0.04em',
            textTransform: 'uppercase' as const,
          }}
        >{o.lab}</button>
      ))}
    </div>
  )
}

function KpiStrip({ summary, days, totalSaving, rangeLabel }: any) {
  const currentHours = days.reduce((s: number, d: any) => s + d.current_hours, 0)
  const aiHours      = days.reduce((s: number, d: any) => s + d.ai_hours, 0)
  const cutHours     = currentHours - aiHours
  const revTotal     = days.reduce((s: number, d: any) => s + (d.est_revenue_kr ?? 0), 0)
  const flaggedDays  = days.filter((d: any) => d.has_recommendation && !d.accepted).length
  const acceptedDays = days.filter((d: any) => d.accepted).length
  const aiLabPct     = revTotal > 0 ? (days.reduce((s: number, d: any) => s + d.ai_cost_kr, 0) / revTotal) * 100 : null

  return (
    <div style={{
      display:             'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
      gap:                 12,
    }}>
      <KpiCardUX
        title="Hours"
        value={`${Math.round(aiHours).toLocaleString('sv-SE')}h`}
        microLabel={cutHours > 0 ? `Cut ${Math.round(cutHours)}h from current` : cutHours < 0 ? `Add ${Math.round(-cutHours)}h` : 'No change'}
        delta={cutHours > 0 ? `−${Math.round(cutHours)}h` : null}
        deltaGood
      />
      <KpiCardUX
        title="Cost"
        value={fmtKr(days.reduce((s: number, d: any) => s + d.ai_cost_kr, 0))}
        microLabel={aiLabPct != null ? `${aiLabPct.toFixed(1)}% of forecast revenue` : 'No revenue forecast'}
      />
      <KpiCardUX
        title="Saving"
        value={fmtKr(totalSaving)}
        deltaGood
        delta={totalSaving > 0 ? '+ pending' : null}
        microLabel={rangeLabel}
      />
      <KpiCardUX
        title="Days flagged"
        value={`${flaggedDays}`}
        deltaGood={false}
        delta={flaggedDays > 0 ? `${acceptedDays} accepted` : null}
        microLabel={flaggedDays === 0 ? 'No action needed' : 'Review below'}
      />
    </div>
  )
}

function DayList({ days, onAccept, onReject }: { days: any[]; onAccept: (r: any) => void; onReject: (date: string) => void }) {
  return (
    <BreakdownTable
      columns={[
        { key: 'day', header: 'Day', align: 'left', render: (r: any) => (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {r.weather?.code != null && (
              <span aria-hidden style={{ fontSize: 13 }}>{weatherIcon(r.weather.code)}</span>
            )}
            <span>
              <span style={{ color: UXP.ink1, fontWeight: 500 }}>{r.weekday}</span>
              <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>
                {r.date}
              </span>
            </span>
            {r.accepted && <Status tone="good">Accepted</Status>}
          </span>
        ) },
        { key: 'current', header: 'Current', align: 'right', render: (r: any) => (
          <span>
            <span style={{ color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{fmtH(r.current_hours)}</span>
            <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>
              {fmtKr(r.current_cost_kr)}
            </span>
          </span>
        ) },
        { key: 'ai', header: 'AI suggested', align: 'right', render: (r: any) => (
          <span>
            <span style={{
              color: r.has_recommendation ? UXP.lavText : UXP.ink2,
              fontWeight: r.has_recommendation ? 500 : 400,
              fontVariantNumeric: 'tabular-nums' as const,
            }}>
              {fmtH(r.ai_hours)}
            </span>
            <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1, fontVariantNumeric: 'tabular-nums' as const }}>
              {fmtKr(r.ai_cost_kr)}
            </span>
          </span>
        ) },
        { key: 'delta', header: 'Δ', align: 'right', render: (r: any) => {
          if (!r.has_recommendation) {
            return <span style={{ fontSize: 9, color: UXP.ink4 }}>—</span>
          }
          const isCut = r.delta_hours > 0
          return (
            <DeltaChip
              value={`${isCut ? '−' : '+'}${Math.abs(Math.round(r.delta_hours))}h · ${fmtKr(Math.abs(r.delta_cost))}`}
              positiveIsGood={false}
            />
          )
        } },
        { key: 'rev', header: 'Forecast rev', align: 'right', render: (r: any) =>
          r.est_revenue_kr ? fmtKr(r.est_revenue_kr) : <span style={{ color: UXP.ink4 }}>—</span>
        },
        { key: 'action', header: '', align: 'right', render: (r: any) => {
          if (!r.has_recommendation) return null
          if (r.accepted) {
            return (
              <button
                type="button"
                onClick={() => onReject(r.date)}
                style={ghostBtn}
              >Undo</button>
            )
          }
          return (
            <button
              type="button"
              onClick={() => onAccept(r)}
              style={primaryBtn}
            >Accept</button>
          )
        } },
      ]}
      sections={[{ rows: days }]}
      rowKey={(row: any) => row.date}
    />
  )
}

function Status({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'lav' | 'neutral' }) {
  const palette = {
    good:    { bg: UXP.greenFill, fg: UXP.greenDeep },
    bad:     { bg: UXP.roseFill,  fg: UXP.roseText  },
    lav:     { bg: UXP.lavFill,   fg: UXP.lavText   },
    neutral: { bg: UXP.subtleBg,  fg: UXP.ink4      },
  }[tone]
  return (
    <span style={{
      display:        'inline-block',
      fontSize:       8,
      padding:        '1px 6px',
      borderRadius:   6,
      background:     palette.bg,
      color:          palette.fg,
      fontWeight:     500,
      letterSpacing:  '0.04em',
      textTransform:  'uppercase' as const,
    }}>{children}</span>
  )
}

// ── Apply-all CTA ───────────────────────────────────────────────────
function ApplyAllBanner({ count, saving, onApply }: { count: number; saving: number; onApply: () => void }) {
  return (
    <div style={{
      background:     UXP.lavFill,
      border:         `0.5px solid ${UXP.lavMid}`,
      borderRadius:   UXP.r_lg,
      padding:        '14px 18px',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      gap:            12,
      flexWrap:       'wrap' as const,
    }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 500, color: UXP.lavText }}>
          {count} day{count === 1 ? '' : 's'} flagged · save up to {fmtKr(saving)}
        </div>
        <div style={{ fontSize: 10, color: UXP.lavText, opacity: 0.85, marginTop: 2 }}>
          Apply all keeps you safely above the under-staffing floor. You can undo for 10 seconds.
        </div>
      </div>
      <button type="button" onClick={onApply} style={{ ...primaryBtn, padding: '6px 16px' }}>
        Apply all
      </button>
    </div>
  )
}

function UndoBanner({ onUndo }: { onUndo: () => void }) {
  return (
    <div style={{
      background:     UXP.greenFill,
      border:         `0.5px solid ${UXP.green}`,
      borderRadius:   UXP.r_md,
      padding:        '10px 14px',
      display:        'flex',
      alignItems:     'center',
      justifyContent: 'space-between',
      fontSize:       11,
      color:          UXP.greenDeep,
      gap:            12,
    }}>
      <span>Applied. You can undo for 10 seconds.</span>
      <button type="button" onClick={onUndo} style={{ ...ghostBtn, padding: '4px 12px' }}>
        Undo
      </button>
    </div>
  )
}

// ── Open Personalkollen card ────────────────────────────────────────
function PkActionCard() {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
      display:       'flex',
      alignItems:    'center',
      justifyContent: 'space-between',
      gap:           12,
      flexWrap:      'wrap' as const,
    }}>
      <div>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>
          Apply in Personalkollen
        </div>
        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
          Accepted recommendations are tracked here; the shifts themselves still get cut in PK.
        </div>
      </div>
      <a
        href="https://app.personalkollen.se"
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...ghostBtn, padding: '6px 14px', textDecoration: 'none' }}
      >
        Open Personalkollen ↗
      </a>
    </div>
  )
}

// ── Footer rationale ────────────────────────────────────────────────
function RationaleFooter() {
  return (
    <div style={{ fontSize: 10, color: UXP.ink4, lineHeight: 1.6, padding: '4px 0' }}>
      AI recommendations are <b>cuts only</b> — they never propose adding hours. The
      forecast uses last-12-weeks weekday patterns plus the 7-day weather × revenue
      correlation for this business. Closed days and days inside the under-staffing
      floor are skipped automatically.
    </div>
  )
}

function Banner({ tone, text }: { tone: 'bad' | 'good'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: UXP.roseFill,  border: UXP.rose,  fg: UXP.roseText  }
    : { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep }
  return (
    <div style={{
      background:    palette.bg,
      border:        `0.5px solid ${palette.border}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         palette.fg,
    }}>{text}</div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding:       40,
      textAlign:     'center' as const,
      color:         UXP.ink4,
      fontSize:      12,
      background:    UXP.cardBg,
      borderRadius:  UXP.r_lg,
      border:        `0.5px solid ${UXP.border}`,
      maxWidth:      560,
      margin:        '0 auto',
    }}>{children}</div>
  )
}

// ── Button styles ───────────────────────────────────────────────────
const primaryBtn: React.CSSProperties = {
  padding:      '5px 12px',
  background:   UXP.lavDeep,
  color:        '#fff',
  border:       'none',
  borderRadius: 999,
  fontSize:     10,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}

const ghostBtn: React.CSSProperties = {
  padding:      '5px 12px',
  background:   UXP.cardBg,
  color:        UXP.ink2,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 999,
  fontSize:     10,
  fontWeight:   500,
  cursor:       'pointer',
  fontFamily:   'inherit',
}
