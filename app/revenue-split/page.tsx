'use client'
// @ts-nocheck
// app/revenue-split/page.tsx — Food vs Beverage revenue split

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'

export default function RevenueSplitPage() {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [bizId,   setBizId]   = useState<string | null>(null)

  const now  = new Date()
  const [from, setFrom] = useState(new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10))
  const [to,   setTo]   = useState(now.toISOString().slice(0, 10))

  useEffect(() => {
    const stored = sessionStorage.getItem('cc_selected_biz')
    if (stored) setBizId(stored)
  }, [])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ from, to })
    if (bizId) params.append('business_id', bizId)
    fetch(`/api/revenue-split?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [from, to, bizId])

  const fmt = (n: number) => Math.round(n).toLocaleString('sv-SE')
  const pct = (n: number, total: number) => total > 0 ? Math.round(n / total * 100) : 0

  return (
    <AppShell>
      <div className="page-wrap">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>Food / Beverage Split</h1>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>Revenue breakdown between food and beverage categories</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
            <input type="date" value={to}   onChange={e => setTo(e.target.value)}   style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }} />
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
        ) : !data || data.error ? (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 40, textAlign: 'center', color: '#6b7280' }}>
            No revenue split data available for this period.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {/* Summary */}
            <div className="grid-3">
              {[
                { label: 'Total Revenue',  value: `${fmt(data.total ?? 0)} kr`,    color: '#111827' },
                { label: 'Food Revenue',   value: `${fmt(data.food ?? 0)} kr`,     color: '#10b981', sub: `${pct(data.food, data.total)}%` },
                { label: 'Beverage Revenue', value: `${fmt(data.beverage ?? 0)} kr`, color: '#6366f1', sub: `${pct(data.beverage, data.total)}%` },
              ].map(c => (
                <div key={c.label} style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9ca3af', marginBottom: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
                  {c.sub && <div style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>{c.sub} of total</div>}
                </div>
              ))}
            </div>

            {/* Visual split bar */}
            {(data.food > 0 || data.beverage > 0) && (
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Revenue split</div>
                <div style={{ height: 20, borderRadius: 10, overflow: 'hidden', background: '#f3f4f6', display: 'flex' }}>
                  <div style={{ width: `${pct(data.food, data.total)}%`, background: '#10b981', transition: 'width 0.5s' }} />
                  <div style={{ width: `${pct(data.beverage, data.total)}%`, background: '#6366f1', transition: 'width 0.5s' }} />
                </div>
                <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: '#10b981' }} />
                    <span style={{ color: '#6b7280' }}>Food {pct(data.food, data.total)}%</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{ width: 10, height: 10, borderRadius: 2, background: '#6366f1' }} />
                    <span style={{ color: '#6b7280' }}>Beverage {pct(data.beverage, data.total)}%</span>
                  </div>
                </div>
              </div>
            )}

            {/* Daily breakdown */}
            {data.daily?.length > 0 && (
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6', fontWeight: 600, fontSize: 14, color: '#374151' }}>Daily breakdown</div>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        <th style={{ padding: '10px 16px', textAlign: 'left',  fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Date</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Food</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Beverage</th>
                        <th style={{ padding: '10px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.daily.map((row: any) => (
                        <tr key={row.date} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '10px 16px', fontSize: 13, color: '#374151' }}>{row.date}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13, color: '#10b981' }}>{fmt(row.food ?? 0)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13, color: '#6366f1' }}>{fmt(row.beverage ?? 0)}</td>
                          <td style={{ padding: '10px 16px', textAlign: 'right', fontSize: 13, fontWeight: 600, color: '#111827' }}>{fmt((row.food ?? 0) + (row.beverage ?? 0))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  )
}
