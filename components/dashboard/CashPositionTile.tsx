// components/dashboard/CashPositionTile.tsx
//
// Phase 5 cash visibility — shows bank/cash movement for this business
// derived from BAS 1910-1979 voucher activity. NOT an absolute balance
// (we don't have the opening balance) — shows the period's net change
// + a 12-month running figure. Labels are explicit about what the number
// represents so the owner doesn't confuse "net change since tracking
// began" with "cash on hand right now".
//
// Fetches /api/finance/bank-position?business_id=X. Soft-fails to a
// "Connect Fortnox to see cash position" affordance when:
//   - No bank data exists (Fortnox not connected, or not bank-linked)
//   - The API returns an error
//
// Cost-of-presence: one extra HTTP fetch on dashboard load. Cached for
// 30s on the server side. Negligible.

'use client'

import { useEffect, useState } from 'react'

interface BankPositionResponse {
  business_id: string
  currency:    string
  monthly: Array<{
    year:           number
    month:          number
    net_change:     number
    cumulative:     number
    is_provisional: boolean
  }>
  summary: {
    current_position_since_tracking: number
    this_month_change: number | null
    last_month_change: number | null
    last_12m_change:   number | null
    months_with_data:  number
    absolute_balance:           number | null
    opening_balance_by_account: Record<string, number> | null
    current_balance_by_account: Record<string, { description: string; current: number; opening: number }> | null
    fiscal_year_from:           string | null
    fiscal_year_to:             string | null
  }
  coverage: {
    earliest_period: string | null
    latest_period:   string | null
    is_provisional_latest: boolean
  }
  bookkeeping_lag: {
    detected:              boolean
    severity:              'none' | 'low' | 'high'
    last_inflow_period:    string | null
    outflow_only_months:   number
    message:               string
  } | null
}

interface Props {
  businessId: string
}

function fmtKr(n: number | null | undefined, currency: string = 'SEK'): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const sign = n >= 0 ? '+' : ''
  return `${sign}${Math.round(n).toLocaleString('sv-SE')} ${currency.toLowerCase() === 'sek' ? 'kr' : currency}`
}

export default function CashPositionTile({ businessId }: Props) {
  const [data,    setData]    = useState<BankPositionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!businessId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/finance/bank-position?business_id=${businessId}&months=12`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const body = await r.json().catch(() => ({}))
          throw new Error(body?.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then(j => { if (!cancelled) setData(j) })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [businessId])

  // Inline mini-sparkline of the last 12 months
  function Sparkline({ values }: { values: number[] }) {
    if (values.length < 2) return null
    const W = 120, H = 32, PAD = 2
    let min = Math.min(...values), max = Math.max(...values)
    if (min === max) { min -= 1; max += 1 }
    const stepX = (W - PAD * 2) / (values.length - 1)
    const path = values.map((v, i) => {
      const x = PAD + i * stepX
      const y = H - PAD - ((v - min) / (max - min)) * (H - PAD * 2)
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    }).join(' ')
    return (
      <svg width={W} height={H} style={{ display: 'block' }}>
        <path d={path} fill="none" stroke="#1a3f6b" strokeWidth="1.5" />
        <line x1={PAD} y1={H - PAD - ((0 - min) / (max - min)) * (H - PAD * 2)}
              x2={W - PAD} y2={H - PAD - ((0 - min) / (max - min)) * (H - PAD * 2)}
              stroke="#d1d5db" strokeDasharray="2,2" strokeWidth="0.7" />
      </svg>
    )
  }

  if (loading) {
    return (
      <div style={tileStyle}>
        <div style={labelStyle}>Cash position</div>
        <div style={{ height: 28, marginTop: 8, background: '#f3f4f6', borderRadius: 4 }} />
      </div>
    )
  }

  if (error || !data || data.summary.months_with_data === 0) {
    return (
      <div style={{ ...tileStyle, opacity: 0.7 }}>
        <div style={labelStyle}>Cash position</div>
        <div style={{ fontSize: 13, color: '#6b7280', marginTop: 8, lineHeight: 1.5 }}>
          Connect Fortnox with bank-linked vouchers to see your cash movement here.
        </div>
        {error && (
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
            ({error})
          </div>
        )}
      </div>
    )
  }

  const { summary, monthly, currency } = data
  const thisMonth = summary.this_month_change
  const last12    = summary.last_12m_change
  const provisional = data.coverage.is_provisional_latest
  const sparkValues = monthly.map(m => m.cumulative)
  const absoluteBalance = summary.absolute_balance

  // Two display modes:
  //   - When we have absolute_balance from Fortnox's /3/accounts call →
  //     show it as the headline. Honest absolute figure.
  //   - Otherwise → fall back to 12-month net change with the "not an
  //     absolute balance" footnote (Phase 1 behaviour).
  const showAbsolute = absoluteBalance != null

  // Format fmtKr without leading + for positive balances (we want
  // "187,450 kr" not "+187,450 kr" when it's an absolute number).
  const fmtAbs = (n: number | null | undefined): string => {
    if (n == null || !Number.isFinite(n)) return '—'
    return `${Math.round(n).toLocaleString('sv-SE')} ${currency.toLowerCase() === 'sek' ? 'kr' : currency}`
  }

  return (
    <div style={tileStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div style={labelStyle}>Cash position</div>
        <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          {showAbsolute ? `as of ${data.coverage.latest_period ?? '—'}` : 'last 12 months'}
        </div>
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 6,
                    color: showAbsolute
                      ? (absoluteBalance >= 0 ? '#1a1f2e' : '#b91c1c')
                      : (last12 != null && last12 >= 0 ? '#15803d' : '#b91c1c') }}>
        {showAbsolute ? fmtAbs(absoluteBalance) : fmtKr(last12, currency)}
      </div>
      <div style={{ marginTop: 10 }}>
        <Sparkline values={sparkValues} />
      </div>
      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 8, lineHeight: 1.5 }}>
        This month: <strong style={{ color: '#1a1f2e' }}>{fmtKr(thisMonth, currency)}</strong>
        {provisional && <span style={{ color: '#d97706' }}> (in progress)</span>}
        {' · '}
        Last month: <strong style={{ color: '#1a1f2e' }}>{fmtKr(summary.last_month_change, currency)}</strong>
      </div>
      {/* Lag chip — only when bookkeeping is detectably behind. Honest
          warning that the headline number lags real bank reality. */}
      {data.bookkeeping_lag?.detected && (
        <div style={{
          marginTop: 10,
          padding: '8px 10px',
          background: data.bookkeeping_lag.severity === 'high' ? '#fee2e2' : '#fef3c7',
          borderLeft: `3px solid ${data.bookkeeping_lag.severity === 'high' ? '#dc2626' : '#d97706'}`,
          borderRadius: 4,
          fontSize: 11,
          color: data.bookkeeping_lag.severity === 'high' ? '#7f1d1d' : '#78350f',
          lineHeight: 1.5,
        }}>
          <strong>{data.bookkeeping_lag.message}</strong>
          {data.bookkeeping_lag.outflow_only_months > 0 && (
            <> Your real bank balance is likely higher than the figure above. Ask your accountant to enter the most recent deposits.</>
          )}
        </div>
      )}

      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 6, lineHeight: 1.4 }}>
        {showAbsolute
          ? `As booked in Fortnox (sum of BAS 1910-1979). May lag real bank balance if bookkeeping is behind.`
          : 'Net bank movement (BAS 1910-1979). Not an absolute balance — opening balance unknown.'}
      </div>

      {/* Per-account breakdown when available — helps the owner see which
          account is in deficit. Only renders if we got the absolute path. */}
      {showAbsolute && summary.current_balance_by_account && Object.keys(summary.current_balance_by_account).length > 1 && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #f3f4f6', fontSize: 11, color: '#374151' }}>
          {Object.entries(summary.current_balance_by_account)
            .sort((a, b) => b[1].current - a[1].current)
            .map(([acc, info]) => (
              <div key={acc} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                <span style={{ color: '#6b7280' }}>{acc} · {info.description}</span>
                <span style={{ color: info.current >= 0 ? '#1a1f2e' : '#b91c1c', fontVariantNumeric: 'tabular-nums' }}>
                  {info.current.toLocaleString('sv-SE')}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  )
}

const tileStyle: React.CSSProperties = {
  background:    '#ffffff',
  border:        '1px solid #e5e7eb',
  borderRadius:  12,
  padding:       '16px 18px',
  borderLeft:    '3px solid #1a3f6b',
}
const labelStyle: React.CSSProperties = {
  fontSize:       11,
  fontWeight:     700,
  textTransform:  'uppercase',
  letterSpacing:  '.07em',
  color:          '#6b7280',
}
