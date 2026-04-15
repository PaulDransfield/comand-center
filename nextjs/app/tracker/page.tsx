// @ts-nocheck
// app/tracker/page.tsx
//
// THE LIVE FINANCIAL TRACKER
// Shows monthly P&L data for the selected business, with:
//   - KPI cards (revenue, costs, margin) with traffic-light colours
//   - Cost category breakdown vs targets
//   - Month-over-month trend (last 6 months)
//   - Sync button to pull fresh data from Fortnox

'use client'

import { useState, useEffect } from 'react'
import { useBiz }              from '@/context/BizContext'
import { createClient }        from '@/lib/supabase/client'
import KPICard                 from '@/components/dashboard/KPICard'
import { track }               from '@/lib/analytics/posthog'

interface MonthlyData {
  period_year:   number
  period_month:  number
  revenue:       number
  staff_cost:    number
  food_cost:     number
  rent_cost:     number
  other_cost:    number
  net_profit:    number
  margin_pct:    number
  source:        string
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export default function TrackerPage() {
  const biz = useBiz()

  const [history,  setHistory]  = useState<MonthlyData[]>([])
  const [loading,  setLoading]  = useState(true)
  const [syncing,  setSyncing]  = useState(false)
  const [syncMsg,  setSyncMsg]  = useState('')

  const current = biz.current
  const now     = new Date()
  const year    = now.getFullYear()
  const month   = now.getMonth() + 1

  useEffect(() => {
    if (!current?.id) return
    fetchHistory(current.id)
  }, [current?.id])

  async function fetchHistory(businessId: string) {
    setLoading(true)
    const supabase = createClient()

    const { data } = await supabase
      .from('tracker_data')
      .select('period_year,period_month,revenue,staff_cost,food_cost,rent_cost,other_cost,net_profit,margin_pct,source')
      .eq('business_id', businessId)
      .order('period_year', { ascending: false })
      .order('period_month', { ascending: false })
      .limit(12)

    setHistory((data ?? []) as MonthlyData[])
    setLoading(false)
  }

  async function syncFortnox() {
    setSyncing(true)
    setSyncMsg('Connecting to Fortnoxâ€¦')
    track('integration_sync' as any, { provider: 'fortnox' })

    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    try {
      const res = await fetch('/api/integrations/fortnox', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ action: 'sync' }),
      })

      const data = await res.json()

      if (!res.ok) {
        setSyncMsg(`âš  ${data.error ?? 'Sync failed'}`)
      } else {
        setSyncMsg(`âœ“ Synced â€” ${data.invoices?.supplier ?? 0} supplier, ${data.invoices?.sales ?? 0} sales invoices`)
        // Refresh business data
        biz.refresh()
        if (current?.id) fetchHistory(current.id)
      }
    } catch {
      setSyncMsg('âš  Network error â€” check your connection')
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncMsg(''), 5000)
    }
  }

  // This month's data (from BizContext â€” already fetched)
  const thisMonth = current

  if (biz.loading || !current) {
    return (
      <div style={S.centred}>
        <span className="spin" style={{ fontSize: 24, color: 'var(--ink-4)' }}>âŸ³</span>
      </div>
    )
  }

  const fmt    = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
  const fmtPct = (n: number) => n.toFixed(1) + '%'
  const monthLabel = now.toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' })

  return (
    <div style={S.page}>

      {/* Header */}
      <div style={S.header}>
        <div>
          <h1 style={S.title}>
            <span style={{ ...S.dot, background: current.colour }} />
            {current.name}
          </h1>
          <p style={S.subtitle}>Financial tracker Â· {monthLabel}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {syncMsg && (
            <span style={{ fontSize: 12, color: syncMsg.startsWith('âœ“') ? 'var(--green)' : 'var(--amber)' }}>
              {syncMsg}
            </span>
          )}
          <button
            className="btn btn-sm"
            onClick={syncFortnox}
            disabled={syncing}
            style={{ display: 'flex', alignItems: 'center', gap: 5 }}
          >
            {syncing ? <><span className="spin">âŸ³</span> Syncingâ€¦</> : 'âŸ³ Sync Fortnox'}
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => window.location.href = '/notebook'}>
            Ask AI â†’
          </button>
        </div>
      </div>

      {/* This month KPIs */}
      <div className="kpi-grid" style={S.kpiGrid}>
        <KPICard
          label="Revenue"
          value={fmt(current.revenue)}
          overIsGood
          accent={current.colour}
          sub={current.revenue === 0 ? 'No data yet â€” sync Fortnox or add manually' : undefined}
        />
        <KPICard
          label="Net Profit"
          value={fmt(current.net_profit)}
          overIsGood
          target={current.target_margin_pct}
          actual={current.margin}
          sub={`${fmtPct(current.margin)} margin Â· target ${fmtPct(current.target_margin_pct)}`}
        />
        <KPICard
          label="Staff Cost"
          value={fmt(current.staff_cost)}
          target={current.target_staff_pct}
          actual={current.staffPct}
          sub={`${fmtPct(current.staffPct)} of revenue Â· target ${fmtPct(current.target_staff_pct)}`}
        />
        <KPICard
          label="Food Cost"
          value={fmt(current.food_cost)}
          target={current.target_food_pct}
          actual={current.foodPct}
          sub={`${fmtPct(current.foodPct)} of revenue Â· target ${fmtPct(current.target_food_pct)}`}
        />
        <KPICard
          label="Rent"
          value={fmt(current.rent_cost)}
          target={current.target_rent_pct}
          actual={current.rentPct}
          sub={`${fmtPct(current.rentPct)} of revenue Â· target ${fmtPct(current.target_rent_pct)}`}
        />
        <KPICard
          label="Other Costs"
          value={fmt(current.other_cost)}
          sub="Admin, marketing, utilities"
        />
      </div>

      {/* Cost breakdown bar */}
      {current.revenue > 0 && (
        <div style={S.card}>
          <div style={S.cardHeader}>
            <span style={S.cardTitle}>Cost structure</span>
            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>% of revenue</span>
          </div>
          <div style={{ padding: '16px 18px' }}>
            {[
              { label: 'Staff',  pct: current.staffPct, target: current.target_staff_pct,  colour: '#1E2761' },
              { label: 'Food',   pct: current.foodPct,  target: current.target_food_pct,   colour: '#2D6A35' },
              { label: 'Rent',   pct: current.rentPct,  target: current.target_rent_pct,   colour: '#7A4800' },
              { label: 'Other',  pct: current.revenue > 0 ? Math.round(current.other_cost / current.revenue * 100) : 0, target: 6, colour: '#4A4844' },
              { label: 'Profit', pct: current.margin, target: current.target_margin_pct, colour: '#0F6E70' },
            ].map(item => (
              <div key={item.label} style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-2)' }}>{item.label}</span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: Math.abs(item.pct - item.target) > 2 ? (item.label === 'Profit' && item.pct < item.target ? 'var(--red)' : item.label !== 'Profit' && item.pct > item.target ? 'var(--red)' : 'var(--ink)') : 'var(--ink)' }}>
                    {fmtPct(item.pct)}
                    <span style={{ color: 'var(--ink-4)', marginLeft: 6 }}>target {fmtPct(item.target)}</span>
                  </span>
                </div>
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ height: '100%', borderRadius: 3, background: item.colour, width: `${Math.min(100, item.pct)}%`, transition: 'width .6s ease' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historical trend */}
      {history.length > 1 && (
        <div style={S.card}>
          <div style={S.cardHeader}>
            <span style={S.cardTitle}>Month-over-month</span>
            <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Last {history.length} months</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr>
                  {['Month', 'Revenue', 'Staff %', 'Food %', 'Margin', 'Source'].map(h => (
                    <th key={h} style={{ background: 'var(--parchment)', padding: '8px 14px', textAlign: 'left', borderBottom: '1px solid var(--border)', color: 'var(--ink-4)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...history].reverse().map(row => {
                  const staffPct = row.revenue > 0 ? Math.round(row.staff_cost / row.revenue * 100) : 0
                  const foodPct  = row.revenue > 0 ? Math.round(row.food_cost  / row.revenue * 100) : 0
                  const isCurrent = row.period_year === year && row.period_month === month
                  return (
                    <tr key={`${row.period_year}-${row.period_month}`}
                        style={isCurrent ? { background: 'var(--blue-lt)' } : {}}>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', fontWeight: isCurrent ? 600 : 400, color: isCurrent ? 'var(--blue)' : 'var(--ink)' }}>
                        {MONTHS_SHORT[row.period_month - 1]} {row.period_year}
                        {isCurrent && <span style={{ fontSize: 9, fontWeight: 700, marginLeft: 6, background: 'var(--blue)', color: 'white', padding: '1px 5px', borderRadius: 5 }}>NOW</span>}
                      </td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', fontFamily: 'var(--mono)' }}>{fmt(row.revenue)}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', color: staffPct > current.target_staff_pct ? 'var(--red)' : 'var(--green)', fontFamily: 'var(--mono)' }}>{fmtPct(staffPct)}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', color: foodPct > current.target_food_pct ? 'var(--red)' : 'var(--green)', fontFamily: 'var(--mono)' }}>{fmtPct(foodPct)}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', color: row.margin_pct < current.target_margin_pct ? 'var(--amber)' : 'var(--green)', fontFamily: 'var(--mono)', fontWeight: 600 }}>{fmtPct(row.margin_pct)}</td>
                      <td style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)', color: 'var(--ink-4)', textTransform: 'capitalize' }}>{row.source}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && history.length === 0 && current.revenue === 0 && (
        <div style={S.emptyCard}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>ðŸ“Š</div>
          <h3 style={{ fontFamily: 'var(--display)', fontSize: 18, fontStyle: 'italic', color: 'var(--navy)', marginBottom: 6 }}>No data yet</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-3)', maxWidth: 300, textAlign: 'center', lineHeight: 1.6 }}>
            Connect Fortnox and sync to populate this tracker automatically, or upload invoices in the Notebook.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={syncFortnox} disabled={syncing}>Sync Fortnox</button>
            <button className="btn" onClick={() => window.location.href = '/notebook'}>Upload documents</button>
          </div>
        </div>
      )}

    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:     { padding: '24px', maxWidth: 960 },
  centred:  { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh' },
  header:   { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24, gap: 16 },
  title:    { fontFamily: 'var(--display)', fontSize: 24, fontWeight: 400, fontStyle: 'italic', color: 'var(--navy)', display: 'flex', alignItems: 'center', gap: 10 },
  dot:      { width: 12, height: 12, borderRadius: '50%', display: 'inline-block', flexShrink: 0 },
  subtitle: { fontSize: 12, color: 'var(--ink-4)', marginTop: 4 },
  kpiGrid:  { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 },
  card:     { background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 16, overflow: 'hidden' },
  cardHeader:{ padding: '14px 18px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--ink)' },
  emptyCard: { background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 12, padding: '40px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center' },
}
