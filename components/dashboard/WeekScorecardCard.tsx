'use client'
// components/dashboard/WeekScorecardCard.tsx
//
// Per-week scorecard — "your team hit target 4 of 5 days this week."
// Nory's UX trick: reframes accuracy as accountability. Reading the
// dashboard's predicted-vs-actual chart from this angle keeps the
// operator's attention on outcomes (did this week go as planned?)
// rather than absolute numbers.
//
// Data: reuses aiSched.suggested (predictions per day) + dailyRows
// (actuals per day). No new API calls — both arrays are already on
// the dashboard. Days are bucketed into:
//
//   on_target  — abs(error) ≤ TARGET_BAND_PCT (default 15%)
//   high       — actual > predicted by more than band (good — busier than planned)
//   low        — actual < predicted by more than band (bad — fewer customers / closed early)
//   pending    — no actual yet (future or today-in-progress)
//   closed     — predicted = 0 AND actual = 0/null (business closed that day)

import { UX } from '@/lib/constants/tokens'

interface SuggestedDay {
  date:        string
  weekday:     string
  est_revenue: number
}
interface DailyRow {
  date:    string
  revenue: number
}
interface Props {
  aiSched:   { suggested?: SuggestedDay[] } | null
  dailyRows: DailyRow[]
  fmtKr:     (n: number) => string
}

const TARGET_BAND_PCT = 15   // ±15% = "on target". Tunable per-business in v2.

// Status per day
type Status = 'on_target' | 'high' | 'low' | 'pending' | 'closed'

const WEEKDAY_SHORT: Record<string, string> = {
  Sun: 'Sun', Mon: 'Mon', Tue: 'Tue', Wed: 'Wed', Thu: 'Thu', Fri: 'Fri', Sat: 'Sat',
}

const C = {
  ink:        UX.ink1,
  ink2:       UX.ink2,
  ink3:       UX.ink3,
  ink4:       UX.ink4,
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
}

export default function WeekScorecardCard({ aiSched, dailyRows, fmtKr }: Props) {
  if (!aiSched?.suggested?.length) return null

  const rows = aiSched.suggested.map(s => {
    const actual = dailyRows.find(d => d.date === s.date)
    const predicted = Number(s.est_revenue ?? 0)
    const actualKr  = actual ? Number(actual.revenue ?? 0) : null

    let status: Status
    let errPct: number | null = null
    if (predicted <= 0 && (actualKr == null || actualKr === 0)) {
      status = 'closed'
    } else if (actualKr == null || actualKr === 0) {
      status = 'pending'
    } else if (predicted <= 0) {
      // Edge: actual exists but prediction is zero. Treat as pending-style.
      status = 'pending'
    } else {
      errPct = ((actualKr - predicted) / predicted) * 100
      const abs = Math.abs(errPct)
      if (abs <= TARGET_BAND_PCT)       status = 'on_target'
      else if (errPct > 0)              status = 'high'
      else                              status = 'low'
    }

    return {
      date:      s.date,
      weekday:   s.weekday,
      predicted,
      actual:    actualKr,
      err_pct:   errPct,
      status,
    }
  })

  // Summary counts — only days with resolved status (not pending/closed)
  const resolved = rows.filter(r => r.status === 'on_target' || r.status === 'high' || r.status === 'low')
  const onTarget = resolved.filter(r => r.status === 'on_target').length
  const totalResolved = resolved.length
  const avgAbsErr = resolved.length
    ? (resolved.reduce((s, r) => s + Math.abs(r.err_pct ?? 0), 0) / resolved.length)
    : null

  if (totalResolved === 0) {
    // Whole week is pending/closed — no story to tell.
    return null
  }

  // Headline message — adapts to the ratio
  const headline = totalResolved === 0
    ? 'No resolved days yet this week.'
    : `${onTarget} of ${totalResolved} day${totalResolved === 1 ? '' : 's'} on target`

  const headlineTone: 'good' | 'warn' | 'bad' =
    totalResolved === 0 ? 'warn'
    : onTarget / totalResolved >= 0.7 ? 'good'
    : onTarget / totalResolved >= 0.4 ? 'warn'
    : 'bad'

  return (
    <div style={{
      background:   C.bgCard,
      border:       `1px solid ${C.border}`,
      borderRadius: 10,
      padding:      '14px 16px',
      marginTop:    8,
    }}>
      <div style={{
        display:        'flex',
        justifyContent: 'space-between',
        alignItems:     'baseline',
        marginBottom:   10,
      }}>
        <div>
          <h2 style={{ fontSize: 14, fontWeight: 600, color: C.ink, margin: 0 }}>
            This week's scorecard
          </h2>
          <div style={{ fontSize: 11, color: C.ink4, marginTop: 2 }}>
            Did the team hit target each day? Within {TARGET_BAND_PCT}% of predicted = on target.
          </div>
        </div>
        <div style={{
          fontSize:    13,
          fontWeight:  600,
          color:       headlineTone === 'good' ? C.green : headlineTone === 'warn' ? C.amber : C.red,
        }}>
          {headline}
          {avgAbsErr != null && (
            <span style={{ marginLeft: 8, fontSize: 11, color: C.ink4, fontWeight: 400 }}>
              · avg error {avgAbsErr.toFixed(1)}%
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gap: 4 }}>
        {rows.map(r => <DayRow key={r.date} row={r} fmtKr={fmtKr} />)}
      </div>
    </div>
  )
}

// ─── Day row ─────────────────────────────────────────────────────────

function DayRow({ row, fmtKr }: { row: any; fmtKr: (n: number) => string }) {
  const STATUS_LABELS: Record<Status, { text: string; color: string; bg: string }> = {
    on_target: { text: '✓ on target',           color: C.green, bg: C.greenBg },
    high:      { text: '↑ busier than planned', color: C.amber, bg: C.amberBg },
    low:       { text: '↓ below plan',           color: C.red,   bg: C.redBg },
    pending:   { text: '— pending',              color: C.ink4,  bg: 'transparent' },
    closed:    { text: '— closed',               color: C.ink4,  bg: 'transparent' },
  }
  const s = STATUS_LABELS[row.status as Status]
  return (
    <div style={{
      display:        'grid',
      gridTemplateColumns: '70px 1fr 1fr 70px 130px',
      gap:            10,
      alignItems:     'center',
      padding:        '7px 10px',
      background:     C.bgPage,
      border:         `0.5px solid ${C.border}`,
      borderRadius:   6,
      fontSize:       12,
    }}>
      <div style={{ color: C.ink2, fontWeight: 500 }}>
        {WEEKDAY_SHORT[row.weekday] ?? row.weekday}{' '}
        <span style={{ color: C.ink4, fontWeight: 400 }}>{formatDate(row.date)}</span>
      </div>

      <div style={{ color: C.ink3 }}>
        predicted <span style={{ color: C.ink2, fontWeight: 500 }}>{row.predicted > 0 ? fmtKr(row.predicted) : '—'}</span>
      </div>

      <div style={{ color: C.ink3 }}>
        actual <span style={{ color: C.ink2, fontWeight: 500 }}>{row.actual != null ? fmtKr(row.actual) : '—'}</span>
      </div>

      <div style={{
        color:      row.err_pct == null ? C.ink4 : Math.abs(row.err_pct) <= TARGET_BAND_PCT ? C.green : row.err_pct > 0 ? C.amber : C.red,
        fontWeight: 500,
        textAlign:  'right' as const,
      }}>
        {row.err_pct == null ? '—' : (row.err_pct > 0 ? '+' : '') + row.err_pct.toFixed(1) + '%'}
      </div>

      <div style={{
        display:      'inline-flex',
        alignItems:   'center',
        justifyContent: 'center',
        padding:      '3px 8px',
        background:   s.bg,
        color:        s.color,
        borderRadius: 999,
        fontSize:     11,
        fontWeight:   500,
        border:       s.bg === 'transparent' ? `0.5px solid ${C.border}` : 'none',
      }}>
        {s.text}
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso + 'T12:00:00Z')
    const day = d.getUTCDate()
    const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()]
    return `${day} ${month}`
  } catch {
    return iso
  }
}
