'use client'
// @ts-nocheck
// app/admin/health/page.tsx — system health dashboard.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminNav } from '@/components/admin/AdminNav'

const fmt = (s: string | null) => s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const daysAgo = (s: string | null) => s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : null

export default function HealthDashboard() {
  const router = useRouter()
  const [data, setData]       = useState<any>(null)
  const [syncLogs, setSyncLogs] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  useEffect(() => {
    const secret = sessionStorage.getItem('admin_auth') ?? ''
    if (!secret) { router.push('/admin/login?next=/admin/health'); return }
    const h = { 'x-admin-secret': secret }
    Promise.all([
      fetch('/api/admin/health',   { headers: h }).then(r => r.ok ? r.json() : Promise.reject(r.status === 401 ? 'Unauthorized' : `HTTP ${r.status}`)),
      fetch('/api/admin/sync-log', { headers: h }).then(r => r.ok ? r.json() : { logs: [] }),
    ])
      .then(([h, s]) => { setData(h); setSyncLogs(s.logs ?? []) })
      .catch(e => setError(typeof e === 'string' ? e : e.message))
      .finally(() => setLoading(false))
  }, [router])

  if (loading) return <div><AdminNav /><div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div></div>
  if (error)   return <div><AdminNav /><div style={{ padding: 24 }}><div style={S.bannerErr}>{error}</div></div></div>
  if (!data)   return null

  const { crons, ai, sync_by_provider, error_feed } = data

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 32px' }}>

        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>System health</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Cron status · AI spend · error feed · last 7 days of sync data</p>
        </div>

        {/* Cron status */}
        <div style={{ ...S.card, marginBottom: 14 }}>
          <div style={S.head}>Cron jobs</div>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={th('left')}>Name</th>
                  <th style={th('left')}>Path</th>
                  <th style={th('left')}>Schedule</th>
                  <th style={th('right')}>Last run (inferred)</th>
                  <th style={th('right')}>Runs (7d)</th>
                  <th style={th('right')}>Status</th>
                </tr>
              </thead>
              <tbody>
                {crons.map((c: any) => {
                  const ago = daysAgo(c.last_run)
                  const expectedDaily = c.schedule?.includes('* *') && !c.schedule?.match(/\d \* \*$/)
                  const stale = ago !== null && ago > (expectedDaily ? 2 : 8)
                  const colour = c.error ? '#dc2626' : stale ? '#d97706' : c.last_run ? '#15803d' : '#6b7280'
                  return (
                    <tr key={c.path} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={S.td}><span style={{ fontWeight: 600, color: '#111' }}>{c.name}</span></td>
                      <td style={{ ...S.td, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>{c.path}</td>
                      <td style={{ ...S.td, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#6b7280' }}>{c.schedule}</td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{fmt(c.last_run)}</td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{c.total_7d}</td>
                      <td style={{ ...S.td, textAlign: 'right' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: 'white', color: colour, border: `1px solid ${colour}` }}>
                          {c.error ? 'NO TABLE' : stale ? 'STALE' : c.last_run ? 'OK' : 'NEVER'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, fontSize: 11, color: '#9ca3af' }}>
            "Last run" is inferred from the latest row in the cron's output table — not an exact execution log. For true execution status, check Vercel cron logs.
          </div>
        </div>

        {/* AI spend + sync rates side-by-side */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>

          <div style={S.card}>
            <div style={S.head}>AI spend this month</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <div style={S.statLabel}>Queries</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#111', letterSpacing: '-0.03em' }}>
                  {ai.queries_month.toLocaleString('en-GB')}
                </div>
              </div>
              <div>
                <div style={S.statLabel}>Estimated cost (USD)</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#6366f1', letterSpacing: '-0.03em' }}>
                  ${ai.cost_usd_month.toFixed(2)}
                </div>
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: '#9ca3af', lineHeight: 1.6 }}>
              Rough estimate at Haiku 4.5 rates: ~$0.00125 per query (avg 500 input + 150 output tokens).
              Does not include per-customer AI Booster revenue.
            </div>
          </div>

          <div style={S.card}>
            <div style={S.head}>Sync success rate (last 7d)</div>
            {sync_by_provider.length === 0 ? (
              <div style={{ fontSize: 13, color: '#9ca3af', padding: '12px 0' }}>No sync activity in the last 7 days.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
                <thead>
                  <tr>
                    <th style={th('left')}>Provider</th>
                    <th style={th('right')}>Success</th>
                    <th style={th('right')}>Fail</th>
                    <th style={th('right')}>Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {sync_by_provider.map((s: any) => {
                    const colour = s.rate === null ? '#6b7280' : s.rate >= 95 ? '#15803d' : s.rate >= 80 ? '#d97706' : '#dc2626'
                    return (
                      <tr key={s.provider} style={{ borderTop: '1px solid #f3f4f6' }}>
                        <td style={S.td}><strong style={{ color: '#111' }}>{s.provider}</strong></td>
                        <td style={{ ...S.td, textAlign: 'right', color: '#15803d' }}>{s.success}</td>
                        <td style={{ ...S.td, textAlign: 'right', color: s.fail > 0 ? '#dc2626' : '#9ca3af' }}>{s.fail}</td>
                        <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: colour }}>{s.rate === null ? '—' : s.rate + '%'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Recent sync runs */}
        <div style={{ ...S.card, marginBottom: 14 }}>
          <div style={S.head}>Recent sync runs (last 50)</div>
          {syncLogs.length === 0 ? (
            <div style={{ fontSize: 13, color: '#9ca3af', padding: '12px 0' }}>No sync runs recorded.</div>
          ) : (
            <div style={{ maxHeight: 420, overflowY: 'auto' as const }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                <thead style={{ position: 'sticky' as const, top: 0, background: '#f9fafb' }}>
                  <tr>
                    <th style={th('left')}>When</th>
                    <th style={th('left')}>Org</th>
                    <th style={th('left')}>Provider</th>
                    <th style={th('right')}>Records</th>
                    <th style={th('right')}>Duration</th>
                    <th style={th('left')}>Range</th>
                    <th style={th('right')}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {syncLogs.map((l: any) => {
                    const ok = l.status === 'success'
                    const colour = ok ? '#15803d' : l.status === 'partial' ? '#d97706' : '#dc2626'
                    return (
                      <tr key={l.id}
                          onClick={() => router.push(`/admin/customers/${l.org_id}`)}
                          style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer' }}>
                        <td style={{ ...S.td, color: '#6b7280', whiteSpace: 'nowrap' as const }}>{fmt(l.created_at)}</td>
                        <td style={{ ...S.td, color: '#111', fontWeight: 500 }}>{l.org_name}</td>
                        <td style={{ ...S.td, color: '#374151' }}>{l.provider}</td>
                        <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{l.records_synced ?? '—'}</td>
                        <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{l.duration_ms != null ? `${(l.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                        <td style={{ ...S.td, color: '#9ca3af', fontSize: 11 }}>{l.date_from && l.date_to ? `${l.date_from} → ${l.date_to}` : '—'}</td>
                        <td style={{ ...S.td, textAlign: 'right' }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: 'white', color: colour, border: `1px solid ${colour}`, textTransform: 'uppercase' as const }}>
                            {l.status}
                          </span>
                          {l.error_msg && (
                            <div style={{ fontSize: 10, color: '#dc2626', marginTop: 3, fontFamily: 'ui-monospace, monospace', textAlign: 'left' as const, maxWidth: 260, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }} title={l.error_msg}>
                              {l.error_msg}
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Error feed */}
        <div style={S.card}>
          <div style={S.head}>Integrations currently in error state ({error_feed.length})</div>
          {error_feed.length === 0 ? (
            <div style={{ fontSize: 13, color: '#15803d', padding: '12px 0' }}>✓ No integration errors.</div>
          ) : (
            <div style={{ maxHeight: 360, overflowY: 'auto' as const }}>
              {error_feed.map((e: any, i: number) => (
                <div key={i} onClick={() => router.push(`/admin/customers/${e.org_id}`)}
                     style={{ padding: '10px 12px', borderTop: i === 0 ? 'none' : '1px solid #f3f4f6', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' as const }}>
                    <div style={{ fontSize: 13, color: '#111', fontWeight: 500 }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 3, background: '#fef2f2', color: '#dc2626', marginRight: 8 }}>{e.provider}</span>
                      {e.org_name}
                    </div>
                    <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' as const }}>Last sync {fmt(e.last_sync_at)}</div>
                  </div>
                  <div style={{ fontSize: 12, color: '#dc2626', marginTop: 3, fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
                    {e.last_error}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>
    </div>
  )
}

const th = (align: 'left' | 'right' | 'center'): any => ({
  padding: '9px 12px', textAlign: align, fontSize: 10, fontWeight: 700, color: '#9ca3af',
  textTransform: 'uppercase', letterSpacing: '.05em',
})

const S: any = {
  card:      { background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' },
  head:      { fontSize: 12, fontWeight: 700, color: '#111', textTransform: 'uppercase' as const, letterSpacing: '.06em', marginBottom: 12 },
  td:        { padding: '10px 12px' },
  statLabel: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 },
  bannerErr: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626' },
}
