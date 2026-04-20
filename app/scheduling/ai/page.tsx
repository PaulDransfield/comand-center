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

      {/* Summary — cuts-only: "Net impact" only ever shows a saving or zero. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
        <KPI label="Scheduled hours" value={`${data.summary.current_hours}h`} sub="in PK now" />
        <KPI
          label="AI-suggested"
          value={`${data.summary.suggested_hours}h`}
          sub={data.summary.suggested_hours < data.summary.current_hours ? 'trim' : 'hold'}
        />
        <KPI
          label="Weekly saving"
          value={data.summary.saving_kr > 0 ? `−${fmt(data.summary.saving_kr)} kr` : '—'}
          sub={data.summary.saving_kr > 0 ? 'if cuts applied' : 'no cuts suggested'}
          colour={data.summary.saving_kr > 0 ? '#059669' : '#6b7280'}
        />
      </div>
      {data.summary.under_staffed_days > 0 && (
        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, color: '#1e3a5f' }}>
          <strong>{data.summary.under_staffed_days}</strong> day{data.summary.under_staffed_days > 1 ? 's' : ''} look lighter than your 12-week pattern. We don't recommend adding hours — it's a judgment call based on booking outlook you have and we don't. See "Why" in the day row.
        </div>
      )}

      {/* Weather forecast strip */}
      {data.suggested.some((s: any) => s.weather) && (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '10px 14px', marginBottom: 16, display: 'flex', gap: 12, overflowX: 'auto' }}>
          {data.suggested.map((s: any) => s.weather ? (
            <div key={s.date} style={{ minWidth: 90, textAlign: 'center', fontSize: 12 }}>
              <div style={{ fontWeight: 600 }}>{s.weekday}</div>
              <div style={{ color: '#6b7280', fontSize: 11 }}>{s.weather.summary}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {s.weather.temp_min != null ? `${Math.round(s.weather.temp_min)}–${Math.round(s.weather.temp_max)}°` : '—'}
              </div>
              {Number(s.weather.precip_mm) > 0.5 && (
                <div style={{ fontSize: 10, color: '#3b82f6' }}>{s.weather.precip_mm}mm</div>
              )}
              {s.bucket_days_seen >= 3 && (
                <div style={{ fontSize: 9, color: '#059669', marginTop: 2 }}>✓ {s.bucket_days_seen} matches</div>
              )}
            </div>
          ) : null)}
        </div>
      )}

      <div style={{ background: '#fefce8', border: '1px solid #fde68a', borderRadius: 8, padding: 14, marginBottom: 16, fontSize: 13, color: '#78350f' }}>
        <strong>Method.</strong> {data.summary.rationale}
      </div>

      {data.pk_shifts_found === 0 && (
        <div style={{ background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 8, padding: 14, marginBottom: 24, fontSize: 13, color: '#7f1d1d' }}>
          <strong>No PK schedule yet for next week.</strong>{' '}
          {data.pk_fetch_error
            ? `PK fetch failed: ${data.pk_fetch_error}`
            : 'Personalkollen returned zero WorkPeriods for ' + data.week_from + ' → ' + data.week_to + '. Either nothing\'s been scheduled yet or the integration needs attention. AI suggestion shown below uses historical averages only.'}
        </div>
      )}

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
              // Days the model would have added are informational only — render
              // deltas as "—" to avoid implying a recommendation.
              const isNote = s.under_staffed_note
              return (
                <tr key={c.date} style={isNote ? { background: '#f8fafc' } : undefined}>
                  <td style={td}>
                    <strong>{c.weekday}</strong> · {c.date.slice(5)}
                    {isNote && <span style={{ display: 'inline-block', marginLeft: 6, fontSize: 10, color: '#1e3a5f', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 4, padding: '1px 6px', fontWeight: 600 }}>note</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{c.hours}h ({c.shifts} shifts)</td>
                  <td style={{ ...td, textAlign: 'right' }}>{isNote ? '—' : `${s.hours}h`}</td>
                  <td style={{ ...td, textAlign: 'right', color: deltaHrsColor(s.delta_hours), fontWeight: 600 }}>
                    {isNote ? '—' : `${s.delta_hours}h`}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: deltaHrsColor(s.delta_hours), fontWeight: 600 }}>
                    {isNote ? '—' : `${fmt(s.delta_cost)} kr`}
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
