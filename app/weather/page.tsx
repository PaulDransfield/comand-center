'use client'
// @ts-nocheck
// app/weather/page.tsx — sales by weather bucket + per-weekday breakdown.

import { useEffect, useState } from 'react'

export const dynamic = 'force-dynamic'

const BUCKET_LABEL: Record<string, string> = {
  clear:    'Clear',
  mild:     'Mild / overcast',
  cold_dry: 'Cold & dry (<5°C)',
  wet:      'Wet (≥5mm rain)',
  snow:     'Snow',
  freezing: 'Freezing (<0°C)',
  hot:      'Hot (≥20°C)',
  thunder:  'Thunderstorm',
}
const BUCKET_COLOUR: Record<string, string> = {
  clear: '#fbbf24', mild: '#94a3b8', cold_dry: '#60a5fa', wet: '#3b82f6',
  snow: '#cbd5e1', freezing: '#a78bfa', hot: '#f97316', thunder: '#7c3aed',
}

export default function WeatherPage() {
  const [bizId,   setBizId]   = useState('')
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    const sync = () => setBizId(localStorage.getItem('cc_selected_biz') ?? '')
    sync(); window.addEventListener('storage', sync); return () => window.removeEventListener('storage', sync)
  }, [])

  useEffect(() => {
    if (!bizId) return
    setLoading(true); setError('')
    fetch(`/api/weather/correlation?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setData(j) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [bizId])

  if (!bizId)  return <div style={wrap}><p>Select a business in the sidebar.</p></div>
  if (loading) return <div style={wrap}><p>Loading…</p></div>
  if (error)   return <div style={wrap}><p style={{ color: '#dc2626' }}>{error}</p></div>
  if (!data)   return null

  if (data.days_analyzed === 0) {
    return (
      <div style={wrap}>
        <h1 style={h1}>Weather × Sales</h1>
        <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 8, padding: 16, fontSize: 13, color: '#78350f' }}>
          <strong>No correlation data yet.</strong> Run the historical weather backfill once so we can pair every sales day with its weather:<br /><br />
          <code style={{ background: '#fff', padding: '4px 8px', borderRadius: 4, display: 'inline-block' }}>
            POST /api/admin/weather/backfill?secret=YOUR_ADMIN_SECRET
          </code>
        </div>
      </div>
    )
  }

  const fmt = (n: number) => Math.round(n).toLocaleString('en-GB')
  const deltaColour = (d: number) => d > 5 ? '#059669' : d < -5 ? '#b91c1c' : '#6b7280'

  return (
    <div style={wrap}>
      <h1 style={h1}>Weather × Sales</h1>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        {data.business_name} · {data.days_analyzed} trading days analysed · overall avg revenue {fmt(data.overall_avg_rev)} kr · overall labour {data.overall_avg_labour}%
      </div>

      <h2 style={h2}>By weather type</h2>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        How much each weather pattern moves revenue and labour % vs your overall average.
      </div>
      <table style={table}>
        <thead><tr>
          <th style={th}>Weather</th>
          <th style={{ ...th, textAlign: 'right' }}>Days</th>
          <th style={{ ...th, textAlign: 'right' }}>Avg revenue</th>
          <th style={{ ...th, textAlign: 'right' }}>vs avg</th>
          <th style={{ ...th, textAlign: 'right' }}>Avg labour %</th>
          <th style={{ ...th, textAlign: 'right' }}>Δ pts</th>
        </tr></thead>
        <tbody>
          {data.buckets.map((b: any) => (
            <tr key={b.bucket}>
              <td style={td}>
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: BUCKET_COLOUR[b.bucket], marginRight: 8 }} />
                {BUCKET_LABEL[b.bucket] ?? b.bucket}
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{b.days}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(b.avg_revenue)} kr</td>
              <td style={{ ...td, textAlign: 'right', color: deltaColour(b.rev_delta_pct), fontWeight: 600 }}>
                {b.rev_delta_pct > 0 ? '+' : ''}{b.rev_delta_pct}%
              </td>
              <td style={{ ...td, textAlign: 'right' }}>{b.avg_labour_pct != null ? `${b.avg_labour_pct}%` : '—'}</td>
              <td style={{ ...td, textAlign: 'right', color: b.labour_delta_pts != null ? (b.labour_delta_pts > 0 ? '#b91c1c' : '#059669') : '#6b7280' }}>
                {b.labour_delta_pts != null ? `${b.labour_delta_pts > 0 ? '+' : ''}${b.labour_delta_pts} pts` : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ ...h2, marginTop: 32 }}>Weekday × weather</h2>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        Average revenue for each weekday split by weather. Empty cells = no days of that combination yet.
      </div>
      <table style={table}>
        <thead><tr>
          <th style={th}>Day</th>
          {Object.keys(BUCKET_LABEL).map(b => (
            <th key={b} style={{ ...th, textAlign: 'right' }}>
              <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: BUCKET_COLOUR[b], marginRight: 4 }} />
              {BUCKET_LABEL[b]}
            </th>
          ))}
        </tr></thead>
        <tbody>
          {data.weekdayBreakdown.map((row: any) => (
            <tr key={row.weekday}>
              <td style={{ ...td, fontWeight: 600 }}>{row.weekday}</td>
              {Object.keys(BUCKET_LABEL).map(b => {
                const c = row.cells.find((x: any) => x.bucket === b)
                if (!c) return <td key={b} style={{ ...td, textAlign: 'right', color: '#d1d5db' }}>—</td>
                return (
                  <td key={b} style={{ ...td, textAlign: 'right' }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{fmt(c.avg_rev)}</div>
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>{c.days}d {c.avg_labour != null ? `· ${c.avg_labour}%` : ''}</div>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ ...h2, marginTop: 32 }}>Last 14 matched days</h2>
      <table style={table}>
        <thead><tr>
          <th style={th}>Date</th>
          <th style={th}>Weather</th>
          <th style={{ ...th, textAlign: 'right' }}>Revenue</th>
          <th style={{ ...th, textAlign: 'right' }}>Labour %</th>
        </tr></thead>
        <tbody>
          {data.samples.map((s: any) => (
            <tr key={s.date}>
              <td style={td}><strong>{s.weekday}</strong> · {s.date}</td>
              <td style={td}>
                <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: BUCKET_COLOUR[s.bucket], marginRight: 6 }} />
                {s.weather.summary}, {s.weather.temp_avg}°C{s.weather.precip_mm > 0.5 ? `, ${s.weather.precip_mm}mm` : ''}
              </td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{fmt(s.revenue)} kr</td>
              <td style={{ ...td, textAlign: 'right' }}>{s.labour_pct != null ? `${s.labour_pct}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const wrap:  any = { maxWidth: 1200, margin: '0 auto', padding: '24px 24px 80px', fontFamily: '-apple-system, "Segoe UI", sans-serif' }
const h1:    any = { fontSize: 24, fontWeight: 500, margin: '0 0 4px', fontFamily: 'Georgia, serif' }
const h2:    any = { fontSize: 15, fontWeight: 700, margin: '20px 0 8px', color: '#1a1f2e' }
const table: any = { width: '100%', borderCollapse: 'collapse', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden', fontSize: 13 }
const th:    any = { padding: '10px 12px', textAlign: 'left', fontSize: 11, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.05em', background: '#f9fafb', borderBottom: '1px solid #e5e7eb', fontWeight: 600 }
const td:    any = { padding: '10px 12px', color: '#1a1f2e', borderBottom: '1px solid #f3f4f6' }
