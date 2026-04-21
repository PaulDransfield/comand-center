'use client'
// @ts-nocheck
// app/cashflow/page.tsx — 90-day cash runway projection
//
// Shows the next 90 days of inflows (projected revenue from
// seasonality + forecast) minus outflows (staff on 25th, rent on 1st,
// recurring overheads, VAT due, supplier invoices). Chart + day-by-day
// table + a clear "first day you go below threshold" callout.

export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'
import PageHero from '@/components/ui/PageHero'
import SupportingStats from '@/components/ui/SupportingStats'
import AttentionPanel from '@/components/ui/AttentionPanel'
import TopBar from '@/components/ui/TopBar'
import { UX } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Business { id: string; name: string }

export default function CashflowPage() {
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [startBal,   setStartBal]   = useState<string>('0')
  const [data,       setData]       = useState<any>(null)
  const [loading,    setLoading]    = useState(true)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((arr: any[]) => {
      if (!Array.isArray(arr) || !arr.length) return
      setBusinesses(arr)
      const saved = localStorage.getItem('cc_selected_biz')
      const id = (saved && arr.find(b => b.id === saved)) ? saved : arr[0].id
      setBizId(id)
    }).catch(() => {})
    const onStorage = () => {
      const s = localStorage.getItem('cc_selected_biz')
      if (s) setBizId(s)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  // Persist starting-balance per biz so the owner doesn't re-enter every visit
  useEffect(() => {
    if (!bizId) return
    const saved = localStorage.getItem(`cc_cash_start_${bizId}`)
    if (saved) setStartBal(saved)
  }, [bizId])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    try {
      const r = await fetch(`/api/cashflow/projection?business_id=${bizId}&starting_balance=${Number(startBal) || 0}`, { cache: 'no-store' })
      const j = await r.json()
      setData(j)
    } catch {}
    setLoading(false)
  }, [bizId, startBal])

  useEffect(() => { if (bizId) load() }, [bizId, load])

  function saveStart(v: string) {
    setStartBal(v)
    if (bizId) localStorage.setItem(`cc_cash_start_${bizId}`, v)
  }

  const selectedBiz = businesses.find(b => b.id === bizId) ?? null
  const days        = Array.isArray(data?.days) ? data.days : []
  const firstLow    = data?.first_low_day ?? null
  const endBalance  = days.length ? days[days.length - 1].balance : Number(startBal) || 0
  const minBalance  = days.length ? Math.min(...days.map((d: any) => d.balance)) : null

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>
        <TopBar
          crumbs={[{ label: 'Financials' }, { label: 'Cashflow', active: true }]}
          rightSlot={
            <>
              <label style={{ fontSize: UX.fsMicro, color: UX.ink3, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                Starting balance
                <input
                  type="number"
                  value={startBal}
                  onChange={e => saveStart(e.target.value)}
                  placeholder="0"
                  style={{ width: 110, padding: '5px 8px', border: `0.5px solid ${UX.border}`, borderRadius: UX.r_md, fontSize: UX.fsBody, background: UX.cardBg, color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}
                />
                kr
              </label>
              {selectedBiz && (
                <span style={{ fontSize: UX.fsMicro, color: UX.ink3 }}>
                  for <span style={{ color: UX.ink1, fontWeight: UX.fwMedium }}>{selectedBiz.name}</span>
                </span>
              )}
            </>
          }
        />

        <PageHero
          eyebrow={`CASHFLOW — NEXT 90 DAYS${selectedBiz ? ` · ${selectedBiz.name.toUpperCase()}` : ''}`}
          headline={
            loading ? <>Projecting…</> :
            !days.length ? <>Not enough data yet — connect POS + Fortnox first.</> :
            firstLow ? (
              <>
                Projected to dip below <span style={{ fontWeight: UX.fwMedium }}>{fmtKr(data.threshold_kr)}</span> on
                {' '}<span style={{ color: UX.redInk, fontWeight: UX.fwMedium }}>{firstLow.date}</span> — balance {fmtKr(firstLow.balance)}.
              </>
            ) : (
              <>
                Cash stays above the <span style={{ fontWeight: UX.fwMedium }}>{fmtKr(data.threshold_kr)}</span> safety line
                across the whole 90-day window.
              </>
            )
          }
          context={days.length
            ? `${data.assumptions?.recurring_labels ?? 0} recurring overheads modelled · ${data.assumptions?.invoices_loaded ?? 0} invoices scheduled · ${data.assumptions?.forecasts_loaded ?? 0} forecast months`
            : undefined
          }
          right={days.length ? (
            <SupportingStats
              items={[
                { label: 'Projected end', value: fmtKr(endBalance), sub: '90 days ahead' },
                { label: 'Lowest point',  value: minBalance != null ? fmtKr(minBalance) : '—', sub: firstLow ? firstLow.date : 'never below threshold' },
                { label: 'Starting',      value: fmtKr(Number(startBal) || 0), sub: 'set above' },
              ]}
            />
          ) : undefined}
        />

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: UX.ink4, fontSize: UX.fsBody }}>Projecting…</div>
        ) : !days.length ? (
          <AttentionPanel
            title="Not enough signal yet"
            items={[
              { tone: 'warning', entity: 'Revenue',   message: 'connect your POS so we have at least 30 days of daily sales to build a pattern from.' },
              { tone: 'warning', entity: 'Overheads', message: 'upload 3+ months of Fortnox P&L PDFs so we can detect recurring outflows (rent, staff, software).' },
              { tone: 'warning', entity: 'Invoices',  message: 'log supplier invoices with due dates so we can time them into the runway.' },
            ]}
          />
        ) : (
          <>
            <CashflowChart days={days} threshold={data.threshold_kr} />
            <CashflowTable days={days} />
          </>
        )}

        <div style={{ marginTop: 10, fontSize: UX.fsMicro, color: UX.ink4 }}>
          Projection only — real cash depends on timing nobody can predict perfectly. Use as a 90-day steering aid, not a bank reconciliation.
        </div>
      </div>

      <AskAI
        page="cashflow"
        context={days.length
          ? `Starting balance ${fmtKr(Number(startBal) || 0)}. 90-day end: ${fmtKr(endBalance)}. Lowest point: ${minBalance != null ? fmtKr(minBalance) : '—'}${firstLow ? ` on ${firstLow.date}` : ''}.`
          : 'No projection yet.'
        }
      />
    </AppShell>
  )
}

// ─── Chart — SVG line for balance with markers on outflow days ─────────
function CashflowChart({ days, threshold }: { days: any[]; threshold: number }) {
  const W = 1000, H = 220, PL = 50, PR = 14, PT = 14, PB = 30
  const plotW = W - PL - PR
  const plotH = H - PT - PB

  const max = Math.max(threshold * 1.5, ...days.map(d => d.balance), 10_000)
  const min = Math.min(0, threshold * 0.5, ...days.map(d => d.balance))
  const yAt = (v: number) => PT + plotH * (max - v) / Math.max(1, max - min)
  const xAt = (i: number) => PL + plotW * (i / Math.max(1, days.length - 1))

  const path = days.map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i)},${yAt(d.balance)}`).join(' ')
  const thresholdY = yAt(threshold)

  return (
    <div style={{ background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_lg, padding: '14px 18px', marginBottom: 12 }}>
      <div style={{ fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1, marginBottom: 8 }}>90-day balance projection</div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" width="100%" height={220} style={{ display: 'block' as const }}>
        <line x1={PL} x2={W - PR} y1={thresholdY} y2={thresholdY} stroke={UX.amberInk} strokeWidth={1} strokeDasharray="4 3" />
        <text x={PL + 4} y={thresholdY - 3} fontSize={10} fill={UX.amberInk}>Safety line: {fmtKr(threshold)}</text>
        <path d={path} stroke={UX.navy} strokeWidth={2} fill="none" strokeLinejoin="round" />
        {days.filter((_, i) => i % 7 === 0 || i === days.length - 1).map((d, i) => (
          <text key={d.date} x={xAt(days.indexOf(d))} y={H - PB + 14} textAnchor="middle" fontSize={9} fill={UX.ink4}>{d.date.slice(5)}</text>
        ))}
        {/* Mark low-threshold crossings in red */}
        {days.filter(d => d.balance < threshold).map(d => {
          const idx = days.indexOf(d)
          return <circle key={d.date} cx={xAt(idx)} cy={yAt(d.balance)} r={2.2} fill={UX.redInk} />
        })}
      </svg>
    </div>
  )
}

// ─── Day table — only days with outflows or balance moves worth noting ─
function CashflowTable({ days }: { days: any[] }) {
  const notable = days.filter(d => d.outflow > 0 || d.inflow === 0)
  return (
    <div style={{ background: UX.cardBg, border: `0.5px solid ${UX.border}`, borderRadius: UX.r_lg, overflow: 'hidden' as const }}>
      <div style={{ padding: '12px 16px', borderBottom: `0.5px solid ${UX.borderSoft}`, fontSize: UX.fsSection, fontWeight: UX.fwMedium, color: UX.ink1 }}>
        Notable days ({notable.length})
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: UX.fsBody }}>
        <thead>
          <tr style={{ background: UX.subtleBg, borderBottom: `0.5px solid ${UX.borderSoft}` }}>
            <th style={thStyle}>Date</th>
            <th style={thStyle}>Outflows</th>
            <th style={{ ...thStyle, textAlign: 'right' as const }}>In</th>
            <th style={{ ...thStyle, textAlign: 'right' as const }}>Out</th>
            <th style={{ ...thStyle, textAlign: 'right' as const }}>Balance</th>
          </tr>
        </thead>
        <tbody>
          {notable.map(d => (
            <tr key={d.date} style={{ borderBottom: `0.5px solid ${UX.borderSoft}` }}>
              <td style={{ padding: '7px 14px', color: UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{d.date}</td>
              <td style={{ padding: '7px 14px', color: UX.ink3, fontSize: UX.fsMicro }}>
                {d.outflowItems?.length ? d.outflowItems.map((x: any) => x.label).join(', ') : '—'}
              </td>
              <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: UX.greenInk, fontVariantNumeric: 'tabular-nums' as const }}>
                {d.inflow > 0 ? fmtKr(d.inflow) : '—'}
              </td>
              <td style={{ padding: '7px 14px', textAlign: 'right' as const, color: UX.redInk, fontVariantNumeric: 'tabular-nums' as const }}>
                {d.outflow > 0 ? fmtKr(d.outflow) : '—'}
              </td>
              <td style={{ padding: '7px 14px', textAlign: 'right' as const, fontWeight: UX.fwMedium, color: d.balance < 0 ? UX.redInk : UX.ink1, fontVariantNumeric: 'tabular-nums' as const }}>
                {fmtKr(d.balance)}
              </td>
            </tr>
          ))}
          {!notable.length && (
            <tr><td colSpan={5} style={{ padding: 30, textAlign: 'center' as const, color: UX.ink4 }}>No scheduled outflows in the window.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

const thStyle = {
  padding:       '8px 14px',
  textAlign:     'left' as const,
  fontSize:      UX.fsNano,
  fontWeight:    UX.fwMedium,
  color:         UX.ink4,
  letterSpacing: '.06em',
  textTransform: 'uppercase' as const,
}
