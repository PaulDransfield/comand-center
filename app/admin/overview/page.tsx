'use client'
// @ts-nocheck
// app/admin/overview/page.tsx — admin landing dashboard.
// Single pane: KPI strip + recent signups + setup requests + critical alerts + cron status.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminNav } from '@/components/admin/AdminNav'

const fmt     = (s: string | null) => s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const daysAgo = (s: string | null) => s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : null

export default function AdminOverview() {
  const router = useRouter()
  const [data, setData]       = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')

  const secret = typeof window !== 'undefined' ? (sessionStorage.getItem('admin_auth') ?? '') : ''

  useEffect(() => {
    if (!secret) { router.push('/admin/login?next=/admin/overview'); return }
    load()
  }, [router])

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/admin/overview', { headers: { 'x-admin-secret': secret } })
      if (!r.ok) throw new Error(r.status === 401 ? 'Unauthorized — log in again' : `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }

  async function triggerMasterSync() {
    setSyncing(true); setSyncMsg('')
    try {
      const r = await fetch('/api/admin/sync-log', {
        method: 'POST', headers: { 'x-admin-secret': secret },
      })
      const j = await r.json()
      setSyncMsg(r.ok ? `✓ Master sync triggered · ${JSON.stringify(j).slice(0, 120)}` : `✗ ${j.error ?? 'Failed'}`)
    } catch (e: any) { setSyncMsg('✗ ' + e.message) }
    setSyncing(false)
    setTimeout(() => setSyncMsg(''), 8000)
  }

  if (loading) return <div><AdminNav /><div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div></div>
  if (error)   return <div><AdminNav /><div style={{ padding: 24 }}><div style={S.bannerErr}>{error}</div></div></div>
  if (!data)   return null

  const { kpis, recent_signups, recent_setup_requests, critical_alerts, cron_status, ai_at_risk = [] } = data

  const signupDelta = kpis.signups_last_week > 0
    ? Math.round(((kpis.signups_this_week - kpis.signups_last_week) / kpis.signups_last_week) * 100)
    : null

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 32px' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: 20, gap: 10, flexWrap: 'wrap' as const }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Overview</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Business snapshot · last refreshed just now</p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {syncMsg && <span style={{ fontSize: 12, color: syncMsg.startsWith('✓') ? '#15803d' : '#dc2626', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{syncMsg}</span>}
            <button
              onClick={triggerMasterSync}
              disabled={syncing}
              style={{ padding: '8px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: syncing ? 'not-allowed' : 'pointer' }}
            >
              {syncing ? 'Syncing all…' : '↻ Sync all now'}
            </button>
            <button
              onClick={load}
              style={{ padding: '8px 14px', background: 'white', border: '1px solid #e5e7eb', color: '#374151', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              Refresh
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
          <Kpi label="MRR (SEK)" value={`${kpis.mrr_sek.toLocaleString('en-GB')} kr`} sub={`excl. trial · ${kpis.trialing} on trial`} tone="primary" />
          <Kpi label="Customers"       value={kpis.total_customers} sub={`${kpis.active_customers} active · ${kpis.at_risk} at risk`} />
          <Kpi label="Signups this week" value={kpis.signups_this_week} sub={signupDelta !== null ? `${signupDelta >= 0 ? '+' : ''}${signupDelta}% vs last week` : 'no prior data'} tone={signupDelta !== null ? (signupDelta >= 0 ? 'good' : 'bad') : 'default'} />
          <Kpi label="In setup"          value={kpis.in_setup} sub="connected, no sync yet" />
          <Kpi label="AI queries / mo"   value={kpis.ai_queries_month.toLocaleString('en-GB')} sub={`~$${kpis.ai_cost_usd_month.toFixed(2)} est.`} />
          <Kpi label="Churned"           value={kpis.churned} sub="deactivated" tone={kpis.churned > 0 ? 'bad' : 'default'} />
        </div>

        {/* Two-column activity */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>

          {/* Recent signups */}
          <div style={S.card}>
            <div style={S.cardHead}>
              <div>Recent signups</div>
              <a href="/admin/customers?filter=new" style={S.link}>All →</a>
            </div>
            {recent_signups.length === 0 ? (
              <div style={S.empty}>No signups yet.</div>
            ) : (
              <table style={S.table}>
                <tbody>
                  {recent_signups.map((s: any) => (
                    <tr key={s.id} onClick={() => router.push(`/admin/customers/${s.id}`)} style={{ cursor: 'pointer', borderTop: '1px solid #f3f4f6' }}>
                      <td style={S.td}>
                        <div style={{ fontWeight: 600, color: '#111' }}>{s.name || 'Unnamed'}</div>
                        <div style={{ fontSize: 11, color: '#9ca3af' }}>{s.id}</div>
                      </td>
                      <td style={{ ...S.td, textAlign: 'right' }}>
                        <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#f3f4f6', color: '#374151', textTransform: 'uppercase' as const }}>
                          {s.plan || 'trial'}
                        </span>
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#6b7280', fontSize: 11 }}>{fmt(s.created_at)}</td>
                      <td style={{ ...S.td, textAlign: 'center', color: '#9ca3af' }}>›</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Setup requests waiting */}
          <div style={S.card}>
            <div style={S.cardHead}>
              <div>Setup requests awaiting help</div>
              <a href="/admin/customers" style={S.link}>All →</a>
            </div>
            {recent_setup_requests.length === 0 ? (
              <div style={S.empty}>No setup requests pending.</div>
            ) : (
              <div>
                {recent_setup_requests.map((r: any) => (
                  <div key={r.org_id} onClick={() => router.push(`/admin/customers/${r.org_id}`)} style={{ cursor: 'pointer', padding: '10px 4px', borderTop: '1px solid #f3f4f6' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ fontWeight: 600, color: '#111', fontSize: 13 }}>{r.restaurant || r.org_name || 'Unknown'}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{fmt(r.requested_at)}</div>
                    </div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                      {[r.city, r.staff, r.accounting, r.pos].filter(Boolean).join(' · ') || 'No details'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* AI at-risk — orgs ≥70% of monthly cost ceiling */}
        {ai_at_risk.length > 0 && (
          <div style={{ ...S.card, background: '#fffbeb', border: '1px solid #fde68a', marginBottom: 20 }}>
            <div style={{ ...S.cardHead, color: '#b45309' }}>
              <div>AI spend at risk ({ai_at_risk.length})</div>
              <span style={{ fontSize: 11, color: '#92400e' }}>≥70% of monthly ceiling — reach out before they hit the block</span>
            </div>
            {ai_at_risk.map((o: any) => (
              <div key={o.id} style={{ padding: '8px 4px', borderTop: '1px solid #fde68a', fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ color: '#111', fontWeight: 500 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: 'white', color: o.percent >= 90 ? '#dc2626' : '#b45309', marginRight: 6 }}>{o.percent}%</span>
                  {o.name} — <span style={{ color: '#6b7280' }}>{o.plan}</span>
                </div>
                <div style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' as const }}>
                  {Math.round(o.used_sek)} / {Math.round(o.ceiling_sek)} SEK
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Critical alerts */}
        {critical_alerts.length > 0 && (
          <div style={{ ...S.card, background: '#fef2f2', border: '1px solid #fecaca', marginBottom: 20 }}>
            <div style={{ ...S.cardHead, color: '#dc2626' }}>
              <div>Unresolved critical / high alerts ({critical_alerts.length})</div>
            </div>
            {critical_alerts.map((a: any, i: number) => (
              <div key={i} style={{ padding: '8px 4px', borderTop: '1px solid #fecaca', fontSize: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ color: '#111', fontWeight: 500 }}>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 3, background: 'white', color: '#dc2626', marginRight: 6 }}>{a.severity}</span>
                    {a.title} — <span style={{ color: '#6b7280' }}>{a.org_name}</span>
                  </div>
                  <div style={{ color: '#9ca3af', fontSize: 11, whiteSpace: 'nowrap' as const }}>{fmt(a.created_at)}</div>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Cron status strip */}
        <div style={S.card}>
          <div style={S.cardHead}>
            <div>Cron jobs</div>
            <a href="/admin/health" style={S.link}>Detail →</a>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {cron_status.map((c: any) => {
              const ago = daysAgo(c.last_run)
              const stale = ago !== null && ago > 7
              return (
                <div key={c.path} style={{ padding: '10px 12px', background: '#fafbff', border: '1px solid #f3f4f6', borderRadius: 8, fontSize: 12 }}>
                  <div style={{ fontWeight: 600, color: '#111' }}>{c.name}</div>
                  <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>{c.schedule}</div>
                  <div style={{ marginTop: 6, fontSize: 11, color: stale ? '#dc2626' : c.last_run ? '#15803d' : '#9ca3af' }}>
                    {c.last_run ? (ago === 0 ? 'Ran today' : ago === 1 ? 'Ran 1d ago' : `Ran ${ago}d ago`) : 'No run logged'}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

      </div>
    </div>
  )
}

function Kpi({ label, value, sub, tone = 'default' }: { label: string; value: React.ReactNode; sub?: string; tone?: 'default' | 'primary' | 'good' | 'bad' }) {
  const color = tone === 'primary' ? '#6366f1' : tone === 'good' ? '#15803d' : tone === 'bad' ? '#dc2626' : '#111'
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9ca3af', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color, letterSpacing: '-0.02em' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 3 }}>{sub}</div>}
    </div>
  )
}

const S: any = {
  card:      { background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 20px' },
  cardHead:  { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, fontSize: 12, fontWeight: 700, color: '#111', textTransform: 'uppercase' as const, letterSpacing: '.06em' },
  link:      { fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 },
  table:     { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  td:        { padding: '8px 4px' },
  empty:     { fontSize: 13, color: '#9ca3af', padding: '12px 0' },
  bannerErr: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626' },
}
