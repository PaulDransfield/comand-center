'use client'
// @ts-nocheck
// app/vat/page.tsx — VAT breakdown per business and period

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'

export default function VATPage() {
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [bizId,   setBizId]   = useState<string | null>(null)

  const now   = new Date()
  const [year,  setYear]  = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)

  useEffect(() => {
    const stored = sessionStorage.getItem('cc_selected_biz')
    if (stored) setBizId(stored)
  }, [])

  useEffect(() => {
    setLoading(true)
    const params = new URLSearchParams({ year: String(year), month: String(month) })
    if (bizId) params.append('business_id', bizId)
    fetch(`/api/vat?${params}`)
      .then(r => r.json())
      .then(d => { setData(d); setLoading(false) })
      .catch(() => setLoading(false))
  }, [year, month, bizId])

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  return (
    <AppShell>
      <div className="page-wrap">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>VAT Overview</h1>
            <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>Estimated VAT breakdown by rate (25% / 12% / 6%)</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={month} onChange={e => setMonth(Number(e.target.value))} style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={e => setYear(Number(e.target.value))} style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {[2023, 2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 60, color: '#9ca3af' }}>Loading…</div>
        ) : !data || data.error ? (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 40, textAlign: 'center', color: '#6b7280' }}>
            No VAT data available for this period.
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            {/* Summary cards */}
            <div className="grid-3">
              {[
                { label: 'Total Revenue (excl. VAT)', value: `${Math.round(data.total_revenue_ex_vat ?? 0).toLocaleString('sv-SE')} kr` },
                { label: 'Estimated VAT Collected',   value: `${Math.round(data.total_vat ?? 0).toLocaleString('sv-SE')} kr`, accent: true },
                { label: 'Revenue Incl. VAT',         value: `${Math.round(data.total_revenue_incl_vat ?? 0).toLocaleString('sv-SE')} kr` },
              ].map(c => (
                <div key={c.label} style={{ background: 'white', border: c.accent ? '2px solid #6366f1' : '1px solid #e5e7eb', borderRadius: 12, padding: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#9ca3af', marginBottom: 8 }}>{c.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700, color: c.accent ? '#6366f1' : '#111827' }}>{c.value}</div>
                </div>
              ))}
            </div>

            {/* Per-rate breakdown */}
            {data.breakdown && (
              <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                      <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Category</th>
                      <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>VAT Rate</th>
                      <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>Revenue (ex. VAT)</th>
                      <th style={{ padding: '12px 16px', textAlign: 'right', fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase' }}>VAT Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.breakdown.map((row: any, i: number) => (
                      <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                        <td style={{ padding: '12px 16px', fontSize: 14, color: '#111827' }}>{row.category}</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 14, color: '#6b7280' }}>{row.rate}%</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 14, color: '#111827' }}>{Math.round(row.revenue_ex_vat ?? 0).toLocaleString('sv-SE')} kr</td>
                        <td style={{ padding: '12px 16px', textAlign: 'right', fontSize: 14, fontWeight: 600, color: '#374151' }}>{Math.round(row.vat_amount ?? 0).toLocaleString('sv-SE')} kr</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </AppShell>
  )
}
