'use client'
// @ts-nocheck
// app/financials/cash/page.tsx — A2.2
//
// Cash position + 30-day forward projection. Reads from two endpoints
// that already exist:
//   GET /api/finance/bank-position           — current absolute balance,
//                                              monthly net changes,
//                                              per-account split,
//                                              bookkeeping-lag signal
//   GET /api/finance/cash-flow-projection    — 30-day day-by-day
//                                              projection with supplier
//                                              invoices, customer
//                                              invoices, salary, F-skatt,
//                                              VAT events
//
// Visual contract: UXP tokens, 0.5px hairlines, tabular numerals,
// no emojis. Mobile-first; primary chart and event table both stack
// on narrow screens.

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface ProjectionDay {
  date:    string
  balance: number
  events:  Array<{
    type:   'supplier_due' | 'customer_due' | 'salary' | 'fskatt' | 'vat'
    amount: number
    label:  string
  }>
}

interface Projection {
  business_id:      string
  currency:         string
  horizon_days:     number
  starting_balance: number | null
  starting_balance_source: string
  summary: {
    cash_trough_date:   string
    cash_trough_amount: number
    ending_balance:     number | null
    total_outflows_30d: number
    total_inflows_30d:  number
    net_30d:            number
  }
  projection:         ProjectionDay[]
  supplier_invoices:  Array<any>
  customer_invoices:  Array<any>
  sources: any
}

interface BankPos {
  summary: {
    absolute_balance:   number | null
    this_month_change:  number | null
    current_position_since_tracking: number
    current_balance_by_account: Record<string, { description: string; current: number; opening: number }> | null
    fiscal_year_from:   string | null
    fiscal_year_to:     string | null
  }
  bookkeeping_lag: any
}

export default function CashPage() {
  const [bizId, setBizId]   = useState<string | null>(null)
  const [bankPos, setBank]  = useState<BankPos | null>(null)
  const [proj, setProj]     = useState<Projection | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr]       = useState<string | null>(null)

  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    setErr(null)
    Promise.all([
      fetch(`/api/finance/bank-position?business_id=${bizId}&months=12`, { cache: 'no-store' }).then(r => r.json()),
      fetch(`/api/finance/cash-flow-projection?business_id=${bizId}&days=30`, { cache: 'no-store' }).then(r => r.json()),
    ])
      .then(([bp, p]) => {
        if (bp?.error) setErr(bp.error)
        else           setBank(bp)
        if (!p?.error) setProj(p)
      })
      .catch(e => setErr(String(e?.message ?? e)))
      .finally(() => setLoading(false))
  }, [bizId])

  const current   = bankPos?.summary?.absolute_balance
                 ?? bankPos?.summary?.current_position_since_tracking
                 ?? null
  const endBal    = proj?.summary?.ending_balance ?? null
  const troughDate = proj?.summary?.cash_trough_date
  const troughAmt  = proj?.summary?.cash_trough_amount

  // Trough alert: any day in the projection drops below a payroll-floor.
  // The "floor" is the estimated monthly salary — proxy for "do I have
  // enough cash to cover payroll this month".
  const payrollFloor = Number(proj?.sources?.salary_estimate?.monthly_amount ?? 0)
  const troughBelowFloor = troughAmt != null && payrollFloor > 0 && troughAmt < payrollFloor

  return (
    <AppShell>
      <PageContainer>
        <div style={{ display: 'grid', gap: 14, marginTop: 4 }}>

          {/* Header */}
          <div>
            <div style={{ fontSize: 11, color: UXP.ink4, letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
              Cash
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.02em', marginBottom: 4 }}>
              Cash position &amp; 30-day projection
            </div>
            <div style={{ fontSize: 13, color: UXP.ink3, lineHeight: 1.5, maxWidth: 640 }}>
              Where the cash is today + what&apos;s booked to come in and out over the next 30 days. Reads Fortnox bank accounts plus unpaid supplier and customer invoices, with estimates for salary, F-skatt and VAT.
            </div>
          </div>

          {/* Headline numbers */}
          <div style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap:                 12,
          }}>
            <HeadlineCard
              label="Current cash"
              value={current != null ? fmtKr(current) : '—'}
              hint={bankPos?.summary?.absolute_balance != null
                ? `Sum of Fortnox accounts 1900–1989 at latest booked voucher`
                : 'Net change since tracking began (no opening balance)'}
              tone={current == null ? 'neutral' : current >= 0 ? 'good' : 'bad'}
              loading={loading}
            />
            <HeadlineCard
              label="In 30 days"
              value={endBal != null ? fmtKr(endBal) : '—'}
              hint={proj
                ? `Net ${proj.summary.net_30d >= 0 ? '+' : ''}${fmtKr(proj.summary.net_30d)} over 30 days`
                : ''}
              tone={endBal == null ? 'neutral' : endBal >= 0 ? 'good' : 'bad'}
              loading={loading}
            />
            <HeadlineCard
              label="Inflows"
              value={proj ? fmtKr(proj.summary.total_inflows_30d) : '—'}
              hint="Unpaid customer invoices due"
              tone="good"
              loading={loading}
            />
            <HeadlineCard
              label="Outflows"
              value={proj ? fmtKr(proj.summary.total_outflows_30d) : '—'}
              hint="Suppliers + salary + F-skatt + VAT"
              tone="bad"
              loading={loading}
            />
          </div>

          {/* Trough alert */}
          {troughBelowFloor && troughDate && (
            <div style={{
              background:    UXP.roseFill,
              border:        `0.5px solid ${UXP.rose}33`,
              borderRadius:  UXP.r_lg,
              padding:       '14px 16px',
              display:       'flex',
              alignItems:    'flex-start',
              gap:           12,
            }}>
              <div style={{
                width:        4,
                height:       38,
                background:   UXP.rose,
                borderRadius: 2,
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: UXP.rose, marginBottom: 3 }}>
                  Cash dips below estimated payroll
                </div>
                <div style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.5 }}>
                  Projected low of <strong style={{ fontVariantNumeric: 'tabular-nums' as const }}>{fmtKr(troughAmt)}</strong> on <strong>{troughDate}</strong>, below the {fmtKr(payrollFloor)} estimated monthly salary. Consider delaying a supplier payment or chasing an open customer invoice.
                </div>
              </div>
            </div>
          )}

          {/* Bookkeeping lag warning */}
          {bankPos?.bookkeeping_lag?.has_lag && (
            <div style={{
              background:    UXP.lavFill,
              border:        `0.5px solid ${UXP.coral}33`,
              borderRadius:  UXP.r_lg,
              padding:       '14px 16px',
              display:       'flex',
              alignItems:    'flex-start',
              gap:           12,
            }}>
              <div style={{
                width:        4,
                height:       38,
                background:   UXP.coral,
                borderRadius: 2,
              }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: UXP.coral, marginBottom: 3 }}>
                  Bookkeeping may be behind
                </div>
                <div style={{ fontSize: 11, color: UXP.ink2, lineHeight: 1.5 }}>
                  {bankPos.bookkeeping_lag.summary ?? 'Recent bank activity does not match expected revenue posting — the figure above may lag the real bank balance.'}
                </div>
              </div>
            </div>
          )}

          {/* Day-by-day chart */}
          <Card title="30-day projection" subtitle="Day-by-day running balance">
            {proj && proj.projection.length > 0 ? (
              <ProjectionChart days={proj.projection} floor={payrollFloor} />
            ) : (
              <div style={{ fontSize: 11, color: UXP.ink4, padding: '24px 0', textAlign: 'center' as const }}>
                {loading ? 'Loading…' : 'No projection available yet.'}
              </div>
            )}
          </Card>

          {/* Upcoming events table */}
          <Card title="Upcoming events" subtitle="Booked and estimated">
            {proj ? (
              <UpcomingEvents projection={proj} />
            ) : (
              <div style={{ fontSize: 11, color: UXP.ink4, padding: '24px 0', textAlign: 'center' as const }}>—</div>
            )}
          </Card>

          {/* Per-account breakdown */}
          {bankPos?.summary?.current_balance_by_account && (
            <Card title="Accounts" subtitle="Per Fortnox bank account">
              <AccountsTable balances={bankPos.summary.current_balance_by_account} />
            </Card>
          )}

          {/* Footer note */}
          <div style={{ fontSize: 10, color: UXP.ink4, lineHeight: 1.5, marginTop: 8, maxWidth: 720 }}>
            Honesty: starting balance is Fortnox&apos;s BOOKED bank position, not necessarily the live bank balance. POS revenue inflows are not projected — they aren&apos;t reliably booked into Fortnox until your accountant reconciles. Salary and F-skatt are based on the last 3 months of staff cost; VAT is a rough estimate from quarterly revenue and cost figures.
          </div>

          {err && (
            <div style={{ fontSize: 11, color: UXP.rose }}>Error: {err}</div>
          )}

        </div>
      </PageContainer>
    </AppShell>
  )
}

// ── Sub-components ────────────────────────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '16px 18px',
      boxShadow:     UXP.shadowCard,
      minWidth:      0,
    }}>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

function HeadlineCard({
  label, value, hint, tone, loading,
}: {
  label: string
  value: string
  hint: string
  tone: 'good' | 'bad' | 'neutral'
  loading: boolean
}) {
  const color =
    tone === 'good' ? UXP.green
    : tone === 'bad' ? UXP.rose
    :                  UXP.ink1
  return (
    <div style={{
      background:    UXP.cardBg,
      border:        `0.5px solid ${UXP.border}`,
      borderRadius:  UXP.r_lg,
      padding:       '14px 16px',
      boxShadow:     UXP.shadowCard,
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{
        fontSize:           20,
        fontWeight:         600,
        color,
        letterSpacing:      '-0.02em',
        fontVariantNumeric: 'tabular-nums' as const,
        lineHeight:         1.1,
      }}>
        {loading ? '…' : value}
      </div>
      <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 5, lineHeight: 1.4 }}>
        {hint}
      </div>
    </div>
  )
}

function ProjectionChart({ days, floor }: { days: ProjectionDay[]; floor: number }) {
  const W = 720
  const H = 180
  const PAD_L = 50
  const PAD_R = 12
  const PAD_T = 12
  const PAD_B = 24
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const balances = days.map(d => d.balance)
  const min = Math.min(...balances, 0, floor)
  const max = Math.max(...balances, floor)
  const range = max - min || 1
  const x = (i: number) => PAD_L + (i / Math.max(1, days.length - 1)) * innerW
  const y = (v: number) => PAD_T + (1 - (v - min) / range) * innerH
  const path = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(d.balance)}`).join(' ')
  const zeroY = y(0)
  const floorY = floor > 0 ? y(floor) : null

  return (
    <div style={{ overflowX: 'auto' as const, WebkitOverflowScrolling: 'touch' as const }}>
      <svg width={W} height={H} style={{ display: 'block' }}>
        {/* Floor line (estimated payroll) */}
        {floorY != null && (
          <>
            <line x1={PAD_L} x2={PAD_L + innerW} y1={floorY} y2={floorY}
                  stroke={UXP.coral} strokeWidth={0.5} strokeDasharray="3 3" opacity={0.6} />
            <text x={PAD_L + innerW - 4} y={floorY - 4} fontSize="9" fill={UXP.coral} textAnchor="end">
              payroll floor
            </text>
          </>
        )}
        {/* Zero line */}
        <line x1={PAD_L} x2={PAD_L + innerW} y1={zeroY} y2={zeroY}
              stroke={UXP.border} strokeWidth={0.5} />
        {/* Balance line */}
        <path d={path} stroke={UXP.lav} strokeWidth={1.5} fill="none" />
        {/* Event dots */}
        {days.map((d, i) => d.events.length > 0 ? (
          <circle key={d.date} cx={x(i)} cy={y(d.balance)} r={2.5}
                  fill={d.events.some(e => e.amount > 0) ? UXP.green : UXP.rose} />
        ) : null)}
        {/* Y-axis labels */}
        <text x={PAD_L - 8} y={PAD_T + 4} fontSize="9" fill={UXP.ink4} textAnchor="end">
          {fmtKr(max)}
        </text>
        <text x={PAD_L - 8} y={PAD_T + innerH + 4} fontSize="9" fill={UXP.ink4} textAnchor="end">
          {fmtKr(min)}
        </text>
        {/* X-axis labels (first, middle, last) */}
        <text x={x(0)} y={H - 8} fontSize="9" fill={UXP.ink4} textAnchor="start">
          {days[0]?.date.slice(5)}
        </text>
        <text x={x(Math.floor(days.length / 2))} y={H - 8} fontSize="9" fill={UXP.ink4} textAnchor="middle">
          {days[Math.floor(days.length / 2)]?.date.slice(5)}
        </text>
        <text x={x(days.length - 1)} y={H - 8} fontSize="9" fill={UXP.ink4} textAnchor="end">
          {days[days.length - 1]?.date.slice(5)}
        </text>
      </svg>
    </div>
  )
}

function UpcomingEvents({ projection }: { projection: Projection }) {
  // Flatten all events with their date + type into one list, sorted.
  const events = useMemo(() => {
    const out: Array<{ date: string; type: string; amount: number; label: string }> = []
    for (const d of projection.projection) {
      for (const e of d.events) {
        out.push({ date: d.date, ...e })
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date))
  }, [projection])

  if (events.length === 0) {
    return (
      <div style={{ fontSize: 11, color: UXP.ink4, padding: '16px 0', textAlign: 'center' as const }}>
        No booked or estimated events in the next 30 days.
      </div>
    )
  }

  return (
    <div style={{ display: 'grid', gap: 0 }}>
      {events.map((e, idx) => {
        const isOutflow = e.amount < 0
        const typeLabel = TYPE_LABELS[e.type] ?? e.type
        const typeColor = TYPE_COLORS[e.type] ?? UXP.ink3
        return (
          <div key={`${e.date}-${idx}`} style={{
            display:             'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap:                 12,
            padding:             '10px 0',
            borderBottom:        idx < events.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
            alignItems:          'center',
          }}>
            <div style={{
              fontSize: 10,
              color: UXP.ink4,
              fontVariantNumeric: 'tabular-nums' as const,
              minWidth: 64,
            }}>
              {e.date.slice(5)}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {e.label}
              </div>
              <div style={{ fontSize: 9, color: typeColor, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginTop: 2 }}>
                {typeLabel}
              </div>
            </div>
            <div style={{
              fontSize:           12,
              fontWeight:         500,
              color:              isOutflow ? UXP.rose : UXP.green,
              fontVariantNumeric: 'tabular-nums' as const,
              whiteSpace:         'nowrap' as const,
            }}>
              {isOutflow ? '−' : '+'}{fmtKr(Math.abs(e.amount))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function AccountsTable({ balances }: { balances: Record<string, { description: string; current: number; opening: number }> }) {
  const rows = Object.entries(balances)
    .map(([acc, v]) => ({ acc: Number(acc), ...v, change: v.current - v.opening }))
    .sort((a, b) => b.current - a.current)
  const totalCurrent = rows.reduce((s, r) => s + r.current, 0)
  const totalOpening = rows.reduce((s, r) => s + r.opening, 0)
  const totalChange  = totalCurrent - totalOpening

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 12, padding: '6px 0', borderBottom: `0.5px solid ${UXP.border}`, fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
        <div>Account</div>
        <div style={{ textAlign: 'right' as const, minWidth: 80 }}>Opening</div>
        <div style={{ textAlign: 'right' as const, minWidth: 80 }}>Current</div>
        <div style={{ textAlign: 'right' as const, minWidth: 80 }}>Change</div>
      </div>
      {rows.map((r, idx) => (
        <div key={r.acc} style={{
          display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 12,
          padding: '8px 0',
          borderBottom: idx < rows.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
          alignItems: 'baseline',
        }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: UXP.ink1 }}>{r.acc}</div>
            <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 2, overflow: 'hidden' as const, textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{r.description}</div>
          </div>
          <div style={{ fontSize: 11, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, minWidth: 80 }}>
            {fmtKr(r.opening)}
          </div>
          <div style={{ fontSize: 11, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, fontWeight: 500, minWidth: 80 }}>
            {fmtKr(r.current)}
          </div>
          <div style={{
            fontSize:           11,
            color:              r.change >= 0 ? UXP.green : UXP.rose,
            fontVariantNumeric: 'tabular-nums' as const,
            textAlign:          'right' as const,
            minWidth:           80,
          }}>
            {r.change >= 0 ? '+' : ''}{fmtKr(r.change)}
          </div>
        </div>
      ))}
      {/* Totals row */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 12,
        padding: '10px 0 4px',
        borderTop: `0.5px solid ${UXP.border}`,
        marginTop: 4,
        alignItems: 'baseline',
      }}>
        <div style={{ fontSize: 10, color: UXP.ink2, fontWeight: 500 }}>Total</div>
        <div style={{ fontSize: 11, color: UXP.ink3, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, minWidth: 80 }}>
          {fmtKr(totalOpening)}
        </div>
        <div style={{ fontSize: 11, color: UXP.ink1, fontVariantNumeric: 'tabular-nums' as const, textAlign: 'right' as const, fontWeight: 600, minWidth: 80 }}>
          {fmtKr(totalCurrent)}
        </div>
        <div style={{
          fontSize:           11,
          color:              totalChange >= 0 ? UXP.green : UXP.rose,
          fontVariantNumeric: 'tabular-nums' as const,
          textAlign:          'right' as const,
          fontWeight:         600,
          minWidth:           80,
        }}>
          {totalChange >= 0 ? '+' : ''}{fmtKr(totalChange)}
        </div>
      </div>
    </div>
  )
}

const TYPE_LABELS: Record<string, string> = {
  supplier_due:  'Supplier invoice',
  customer_due:  'Customer invoice',
  salary:        'Salary',
  fskatt:        'F-skatt',
  vat:           'VAT settlement',
}

const TYPE_COLORS: Record<string, string> = {
  supplier_due:  '#a67c52',
  customer_due:  '#4a8a6a',
  salary:        '#6b5b8e',
  fskatt:        '#a67c52',
  vat:           '#7a6da1',
}
