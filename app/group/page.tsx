// @ts-nocheck
'use client'
// app/group/page.tsx
//
// Group-level overview — one row per business, AI insight paragraph at top
// comparing them and proposing a cross-business action. Closes the competitor
// "Compare workplaces / Draw lessons between workplaces" bullets with a
// differentiator they can't match: the AI actually prescribes the action.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import AskAI from '@/components/AskAI'

const fmtKr  = (n: number) => Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
const fmtPct = (n: number | null) => n == null ? '—' : n.toFixed(1) + '%'
const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function getMonthBounds(offset = 0) {
  const now  = new Date()
  const d    = new Date(now.getFullYear(), now.getMonth() + offset, 1)
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0)
  return {
    from:  localDate(d),
    to:    localDate(last),
    label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
  }
}

export default function GroupPage() {
  const router = useRouter()
  const [monthOffset, setMonthOffset] = useState(0)
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const period = getMonthBounds(monthOffset)

  useEffect(() => {
    setLoading(true); setError('')
    fetch(`/api/group/overview?from=${period.from}&to=${period.to}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.error) setError(j.error); else setData(j) })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthOffset])

  function openBusiness(id: string) {
    localStorage.setItem('cc_selected_biz', id)
    // Broadcast to other tabs / components that react to storage
    window.dispatchEvent(new Event('storage'))
    router.push('/dashboard')
  }

  const businesses = data?.businesses ?? []
  const summary    = data?.summary ?? null
  const narrative  = data?.narrative ?? null

  // Rank helpers for the table — mark best / worst in each metric
  const revVals    = businesses.map(b => b.revenue)
  const labVals    = businesses.map(b => b.labour_pct).filter(x => x != null)
  const marVals    = businesses.map(b => b.margin_pct).filter(x => x != null)
  const best = {
    revenue: businesses.find(b => b.revenue === Math.max(...revVals, 0))?.id,
    labour:  businesses.find(b => b.labour_pct === Math.min(...labVals))?.id,
    margin:  businesses.find(b => b.margin_pct === Math.max(...marVals))?.id,
  }

  return (
    <AppShell>
      <div className="page-wrap" style={{ maxWidth: 1100 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' as const }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Group Overview</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
              Side-by-side across all your locations · AI identifies the outlier and suggests one cross-location action.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button onClick={() => setMonthOffset(o => o - 1)} style={navBtn}>‹</button>
            <div style={{ minWidth: 140, textAlign: 'center' as const }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>{period.label}</div>
            </div>
            <button onClick={() => setMonthOffset(o => Math.min(o + 1, 0))} disabled={monthOffset === 0} style={{ ...navBtn, color: monthOffset === 0 ? '#d1d5db' : '#374151', cursor: monthOffset === 0 ? 'not-allowed' : 'pointer' }}>›</button>
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 80, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>Loading group data…</div>
        ) : error ? (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626' }}>{error}</div>
        ) : businesses.length === 0 ? (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' as const }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>No businesses yet</div>
            <div style={{ fontSize: 13, color: '#9ca3af' }}>Add businesses from Settings — the group view lights up as soon as you have two or more.</div>
          </div>
        ) : businesses.length === 1 ? (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' as const }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 8 }}>Only one business</div>
            <div style={{ fontSize: 13, color: '#9ca3af', maxWidth: 440, margin: '0 auto' }}>
              The group view is for comparing multiple locations. You have one — use <a href="/dashboard" style={{ color: '#6366f1' }}>Dashboard</a> for single-business detail.
            </div>
          </div>
        ) : (
          <>
            {/* AI narrative panel — the headline differentiator */}
            {narrative && (
              <div style={{ background: 'linear-gradient(135deg, #1e1b4b, #312e81)', borderRadius: 14, padding: '24px 28px', marginBottom: 16, color: 'white', position: 'relative' as const }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                  <div style={{ width: 26, height: 26, background: 'rgba(99,102,241,0.35)', borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13 }}>✦</div>
                  <span style={{ fontSize: 10, background: 'rgba(99,102,241,0.35)', color: 'white', padding: '2px 8px', borderRadius: 4, fontWeight: 700, letterSpacing: '.05em' }}>AI GROUP MANAGER</span>
                </div>
                <div style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.65, fontFamily: 'Georgia, serif', whiteSpace: 'pre-wrap' as const }}>
                  {narrative}
                </div>
                <div style={{ fontSize: 10, color: 'rgba(199,210,254,0.7)', marginTop: 12, letterSpacing: '.04em', textTransform: 'uppercase' as const }}>
                  Based on {businesses.length} locations · {period.label} · Claude Haiku
                </div>
              </div>
            )}

            {/* Summary row */}
            {summary && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12, marginBottom: 16 }}>
                <Kpi label="Revenue"       value={fmtKr(summary.total_revenue)}    sub={`${summary.total_covers || 0} covers`} />
                <Kpi label="Labour cost"   value={fmtKr(summary.total_staff_cost)} sub={`${summary.total_hours}h total`} />
                <Kpi label="Labour %"      value={fmtPct(summary.group_labour_pct)} sub="group average" />
                <Kpi label="Margin %"      value={fmtPct(summary.group_margin_pct)} sub="after labour" />
              </div>
            )}

            {/* Per-business table */}
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' as const }}>
              <div style={{ padding: '12px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#111' }}>Per location</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>Click a row to open its dashboard</div>
              </div>
              <div style={{ overflowX: 'auto' as const }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    {['Location', 'Revenue', 'Δ vs prev', 'Labour cost', 'Labour %', 'Margin %', 'Rev/hour', 'Covers'].map((h, i) => (
                      <th key={h} style={{ padding: '9px 14px', textAlign: i === 0 ? 'left' as const : 'right' as const, fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {businesses.map((b: any) => {
                    const isBestRev = b.id === best.revenue
                    const isBestLab = b.id === best.labour
                    const isBestMar = b.id === best.margin
                    const labColour = b.labour_pct == null ? '#d1d5db'
                                    : b.labour_pct <= b.target_staff_pct ? '#15803d' : '#dc2626'
                    const marColour = b.margin_pct == null ? '#d1d5db'
                                    : b.margin_pct >= 60 ? '#15803d' : b.margin_pct >= 45 ? '#d97706' : '#dc2626'
                    return (
                      <tr
                        key={b.id}
                        onClick={() => openBusiness(b.id)}
                        style={{ borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f9fafb')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td style={{ padding: '12px 14px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: b.colour ?? '#9ca3af', flexShrink: 0 }} />
                            <div>
                              <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{b.name}</div>
                              {b.city && <div style={{ fontSize: 11, color: '#9ca3af' }}>{b.city}</div>}
                            </div>
                          </div>
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const, color: '#111', fontWeight: 600 }}>
                          {b.revenue > 0 ? fmtKr(b.revenue) : '—'}
                          {isBestRev && <Leader />}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const }}>
                          {b.revenue_delta_pct == null ? <span style={{ color: '#d1d5db' }}>—</span> : (
                            <span style={{ fontSize: 12, fontWeight: 700, color: b.revenue_delta_pct >= 0 ? '#15803d' : '#dc2626' }}>
                              {b.revenue_delta_pct >= 0 ? '↑' : '↓'} {Math.abs(b.revenue_delta_pct)}%
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const, color: '#374151' }}>
                          {b.staff_cost > 0 ? fmtKr(b.staff_cost) : '—'}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const }}>
                          <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: labColour === '#15803d' ? '#dcfce7' : labColour === '#dc2626' ? '#fee2e2' : '#f3f4f6', color: labColour }}>
                            {fmtPct(b.labour_pct)}
                          </span>
                          {isBestLab && <Leader />}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const, fontWeight: 600, color: marColour }}>
                          {fmtPct(b.margin_pct)}
                          {isBestMar && <Leader />}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const, color: '#6b7280' }}>
                          {b.rev_per_hour ? fmtKr(b.rev_per_hour) : '—'}
                        </td>
                        <td style={{ padding: '12px 14px', textAlign: 'right' as const, color: '#6b7280' }}>
                          {b.covers > 0 ? b.covers.toLocaleString('en-GB') : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
              {/* Legend */}
              <div style={{ padding: '10px 20px', fontSize: 11, color: '#9ca3af', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 18, flexWrap: 'wrap' as const }}>
                <span><Leader inline /> = best in group</span>
                <span>Targets are per-location and set in Settings</span>
              </div>
            </div>
          </>
        )}
      </div>

      <AskAI
        page="group"
        context={summary ? [
          `Period: ${period.label} (${period.from} to ${period.to})`,
          `${summary.business_count} locations · revenue ${fmtKr(summary.total_revenue)} · labour ${fmtKr(summary.total_staff_cost)} (${fmtPct(summary.group_labour_pct)}) · margin ${fmtPct(summary.group_margin_pct)}`,
          businesses.map((b: any) => `${b.name}: ${fmtKr(b.revenue)} rev · ${fmtPct(b.labour_pct)} labour · ${fmtPct(b.margin_pct)} margin · ${b.hours}h`).join('\n'),
        ].join('\n') : 'No data yet'}
      />
    </AppShell>
  )
}

function Kpi({ label, value, sub }: any) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 18px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function Leader({ inline }: any) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      marginLeft: 6, width: inline ? 14 : 16, height: inline ? 14 : 16,
      background: '#fef3c7', color: '#b45309', borderRadius: '50%',
      fontSize: 9, fontWeight: 700, verticalAlign: 'middle' as const,
    }} title="Best in group">★</span>
  )
}

const navBtn = {
  width: 32, height: 32, borderRadius: 8, border: '1px solid #e5e7eb',
  background: 'white', cursor: 'pointer', fontSize: 16,
  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#374151',
} as const
