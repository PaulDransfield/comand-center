'use client'
// @ts-nocheck
// app/scheduling/ai/page.tsx
//
// Side-by-side: PK current schedule vs AI-suggested schedule for next week.
// No write-back to PK — owner reads, decides, adjusts in PK manually if they agree.

import { useEffect, useState } from 'react'
import Link from 'next/link'

export const dynamic = 'force-dynamic'

export default function ScheduleAIComparison() {
  const [bizId,  setBizId]  = useState('')
  const [data,   setData]   = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,  setError]  = useState('')
  const [tab,    setTab]    = useState<'current' | 'suggested' | 'diff'>('diff')

  useEffect(() => {
    const sync = () => setBizId(localStorage.getItem('cc_selected_biz') ?? '')
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true); setError('')
    fetch(`/api/scheduling/ai-suggestion?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setData(j) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [bizId])

  if (!bizId)   return <div style={wrap}><p>Select a business in the sidebar.</p></div>
  if (loading)  return <div style={wrap}><p>Crunching 8 weeks of data…</p></div>
  if (error)    return <div style={wrap}><p style={{ color: '#dc2626' }}>{error}</p></div>
  if (!data)    return null

  const fmt = (n: number) => Math.round(n).toLocaleString('en-GB')
  const deltaHrsColor = (d: number) => d < -0.5 ? '#059669' : d > 0.5 ? '#b91c1c' : '#6b7280'

  return (
    <div style={wrap}>
      <div style={{ marginBottom: 8 }}>
        <Link href="/scheduling" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>← Back to scheduling</Link>
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 500, margin: '0 0 4px', fontFamily: 'Georgia, serif' }}>
        Schedule · AI comparison
      </h1>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
        {data.business_name} · Week of {data.week_from} to {data.week_to}
      </div>

      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 24 }}>
        <KPI label="Scheduled hours" value={`${data.summary.current_hours}h`} sub="in PK now" />
        <KPI label="AI-suggested" value={`${data.summary.suggested_hours}h`} sub={data.summary.suggested_hours < data.summary.current_hours ? 'trim' : 'add'} />
        <KPI
          label="Net weekly impact"
          value={`${data.summary.net_saving_kr > 0 ? '−' : '+'}${fmt(Math.abs(data.summary.net_saving_kr))} kr`}
          sub={data.summary.net_saving_kr > 0 ? 'saved' : 'extra cost'}
          colour={data.summary.net_saving_kr > 0 ? '#059669' : '#b91c1c'}
        />
      </div>

      <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: 14, marginBottom: 24, fontSize: 13, color: '#78350f' }}>
        <strong>Method.</strong> {data.summary.rationale}
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid #e5e7eb', marginBottom: 16 }}>
        {[
          { key: 'diff',      label: 'Side by side' },
          { key: 'current',   label: 'Current (PK)' },
          { key: 'suggested', label: 'AI suggested' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as any)} style={{
            padding: '8px 14px', background: 'transparent',
            border: 'none', borderBottom: tab === t.key ? '2px solid #1e3a5f' : '2px solid transparent',
            fontSize: 13, fontWeight: tab === t.key ? 700 : 500,
            color: tab === t.key ? '#1e3a5f' : '#6b7280', cursor: 'pointer',
          }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'diff' && (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Day</th>
              <th style={{ ...th, textAlign: 'right' }}>Current h</th>
              <th style={{ ...th, textAlign: 'right' }}>Suggested h</th>
              <th style={{ ...th, textAlign: 'right' }}>Δ hours</th>
              <th style={{ ...th, textAlign: 'right' }}>Δ cost</th>
              <th style={th}>Why</th>
            </tr>
          </thead>
          <tbody>
            {data.current.map((c: any, i: number) => {
              const s = data.suggested[i]
              return (
                <tr key={c.date}>
                  <td style={td}><strong>{c.weekday}</strong> · {c.date.slice(5)}</td>
                  <td style={{ ...td, textAlign: 'right' }}>{c.hours}h ({c.shifts} shifts)</td>
                  <td style={{ ...td, textAlign: 'right' }}>{s.hours}h</td>
                  <td style={{ ...td, textAlign: 'right', color: deltaHrsColor(s.delta_hours), fontWeight: 600 }}>
                    {s.delta_hours > 0 ? '+' : ''}{s.delta_hours}h
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: deltaHrsColor(s.delta_hours), fontWeight: 600 }}>
                    {s.delta_cost > 0 ? '+' : ''}{fmt(s.delta_cost)} kr
                  </td>
                  <td style={{ ...td, fontSize: 12, color: '#4b5563', maxWidth: 380 }}>{s.reasoning}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {tab === 'current' && (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Day</th>
              <th style={{ ...th, textAlign: 'right' }}>Shifts</th>
              <th style={{ ...th, textAlign: 'right' }}>Hours</th>
              <th style={{ ...th, textAlign: 'right' }}>Est. cost</th>
              <th style={th}>Departments</th>
            </tr>
          </thead>
          <tbody>
            {data.current.map((c: any) => (
              <tr key={c.date}>
                <td style={td}><strong>{c.weekday}</strong> · {c.date.slice(5)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{c.shifts}</td>
                <td style={{ ...td, textAlign: 'right' }}>{c.hours}h</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(c.est_cost)} kr</td>
                <td style={{ ...td, fontSize: 12, color: '#4b5563' }}>
                  {Object.entries(c.dept_breakdown).map(([dept, v]: any) => `${dept} ${v.hours}h`).join(' · ') || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {tab === 'suggested' && (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Day</th>
              <th style={{ ...th, textAlign: 'right' }}>Suggested hours</th>
              <th style={{ ...th, textAlign: 'right' }}>Est. cost</th>
              <th style={{ ...th, textAlign: 'right' }}>Est. revenue</th>
              <th style={{ ...th, textAlign: 'right' }}>Target kr/h</th>
              <th style={th}>Reasoning</th>
            </tr>
          </thead>
          <tbody>
            {data.suggested.map((s: any) => (
              <tr key={s.date}>
                <td style={td}><strong>{s.weekday}</strong> · {s.date.slice(5)}</td>
                <td style={{ ...td, textAlign: 'right' }}>{s.hours}h</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(s.est_cost)} kr</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(s.est_revenue)} kr</td>
                <td style={{ ...td, textAlign: 'right' }}>{fmt(s.rev_per_hour)} kr/h</td>
                <td style={{ ...td, fontSize: 12, color: '#4b5563', maxWidth: 380 }}>{s.reasoning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function KPI({ label, value, sub, colour }: any) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
      <div style={{ fontSize: 11, color: '#6b7280', letterSpacing: '0.05em', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: colour ?? '#1a1f2e', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

const wrap:  any = { maxWidth: 1100, margin: '0 auto', padding: '24px 24px 80px', fontFamily: '-apple-system, "Segoe UI", sans-serif' }
const tableStyle: any = { width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }
const th:     any = { padding: '10px 14px', textAlign: 'left', fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }
const td:     any = { padding: '10px 14px', fontSize: 13, color: '#1a1f2e', borderBottom: '1px solid #f3f4f6' }
