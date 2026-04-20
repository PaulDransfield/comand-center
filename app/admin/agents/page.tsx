'use client'
// @ts-nocheck
// app/admin/agents/page.tsx — cross-customer agent dashboard.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminNav } from '@/components/admin/AdminNav'

const fmt = (s: string | null) => s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
const daysAgo = (s: string | null) => s ? Math.floor((Date.now() - new Date(s).getTime()) / 86400000) : null

export default function AgentsDashboard() {
  const router = useRouter()
  const [data, setData]       = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [running, setRunning] = useState<string | null>(null)
  const [runResult, setRunResult] = useState<any>(null)

  const secret = typeof window !== 'undefined' ? (sessionStorage.getItem('admin_auth') ?? '') : ''

  useEffect(() => {
    if (!secret) { router.push('/admin/login?next=/admin/agents'); return }
    load()
  }, [])

  async function load() {
    setLoading(true); setError('')
    try {
      const r = await fetch('/api/admin/agents', { headers: { 'x-admin-secret': secret } })
      if (!r.ok) throw new Error(r.status === 401 ? 'Unauthorized' : `HTTP ${r.status}`)
      setData(await r.json())
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }

  async function runAgent(agent: string) {
    setRunning(agent); setRunResult(null)
    try {
      const res = await fetch('/api/admin/agents', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ agent }),
      })
      const json = await res.json()
      setRunResult({ agent, ok: res.ok, ...json })
    } catch (e: any) {
      setRunResult({ agent, ok: false, error: e.message })
    }
    setRunning(null)
    setTimeout(load, 3000)
  }

  if (loading) return <div><AdminNav /><div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div></div>
  if (error)   return <div><AdminNav /><div style={{ padding: 24 }}><div style={S.bannerErr}>{error}</div></div></div>
  if (!data)   return null

  const agents = data.agents ?? []

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 32px' }}>

        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Agents</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>AI agents running across all customers · last 10 runs each · manual bulk trigger</p>
        </div>

        {runResult && (
          <div style={{
            background: runResult.ok ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${runResult.ok ? '#bbf7d0' : '#fecaca'}`,
            borderRadius: 10, padding: '10px 14px', marginBottom: 16, fontSize: 12,
            color: runResult.ok ? '#15803d' : '#dc2626',
          }}>
            <strong>{runResult.ok ? '✓ ' : '✗ '}</strong>
            Ran {runResult.agent} · status {runResult.status}
            {runResult.error && ` · ${runResult.error}`}
            {runResult.response && <div style={{ marginTop: 4, fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#374151' }}>{runResult.response}</div>}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))', gap: 14 }}>
          {agents.map((a: any) => {
            const last = daysAgo(a.last_run)
            const stale = last !== null && last > 14
            return (
              <div key={a.key} style={{ ...S.card, opacity: a.blocked ? 0.6 : 1 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10, gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>{a.name}</div>
                    <div style={{ fontSize: 10, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', marginTop: 2 }}>{a.cron}</div>
                  </div>
                  <button
                    onClick={() => runAgent(a.key)}
                    disabled={running === a.key || a.blocked}
                    style={{
                      padding: '6px 12px', background: a.blocked ? '#e5e7eb' : '#1a1f2e', color: a.blocked ? '#9ca3af' : 'white',
                      border: 'none', borderRadius: 7, fontSize: 11, fontWeight: 700, cursor: a.blocked ? 'not-allowed' : 'pointer',
                      whiteSpace: 'nowrap' as const,
                    }}
                  >
                    {running === a.key ? '…' : a.blocked ? 'Blocked' : 'Run now'}
                  </button>
                </div>

                {/* Stats strip */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12, padding: '8px 10px', background: '#fafbff', borderRadius: 7 }}>
                  <MiniStat label="Runs 7d"   value={a.runs_7d} />
                  <MiniStat label="Total"     value={a.total_runs} />
                  <MiniStat label="Last run"  value={last === null ? '—' : last === 0 ? 'today' : `${last}d`} tone={stale ? 'bad' : 'default'} />
                  <MiniStat label="Disabled for" value={a.disabled_for} tone={a.disabled_for > 0 ? 'warn' : 'default'} />
                </div>

                {/* Feedback strip — only rendered for Monday briefing */}
                {a.feedback && (a.feedback.up + a.feedback.down > 0) && (
                  <div style={{ marginBottom: 12, padding: '8px 10px', background: '#fdfcf6', border: '1px solid #f0eddf', borderRadius: 7, fontSize: 12, color: '#4b5563' }}>
                    <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                      <span style={{ color: '#059669', fontWeight: 700 }}>👍 {a.feedback.up}</span>
                      <span style={{ color: '#dc2626', fontWeight: 700 }}>👎 {a.feedback.down}</span>
                      <span style={{ fontSize: 10, color: '#9ca3af', letterSpacing: '.06em', textTransform: 'uppercase' as const }}>last 30d</span>
                    </div>
                    {a.feedback.last_comment && (
                      <div style={{ marginTop: 6, fontSize: 12, color: '#374151', fontStyle: 'italic' as const, borderLeft: '2px solid #d4d4d0', paddingLeft: 8 }}>
                        &ldquo;{a.feedback.last_comment.slice(0, 200)}{a.feedback.last_comment.length > 200 ? '…' : ''}&rdquo;
                      </div>
                    )}
                  </div>
                )}

                {/* Recent runs */}
                {a.recent_runs.length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>
                    {a.error ? `Error: ${a.error}` : 'No runs yet'}
                  </div>
                ) : (
                  <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid #f3f4f6', borderRadius: 6 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                      <tbody>
                        {a.recent_runs.map((r: any, i: number) => (
                          <tr key={i}
                              onClick={() => r.org_id && router.push(`/admin/customers/${r.org_id}`)}
                              style={{ borderTop: i === 0 ? 'none' : '1px solid #f3f4f6', cursor: r.org_id ? 'pointer' : 'default' }}>
                            <td style={{ padding: '7px 10px', color: '#111', fontWeight: 500 }}>{r.org_name}</td>
                            <td style={{ padding: '7px 10px', color: '#6b7280' }}>{r.label}</td>
                            <td style={{ padding: '7px 10px', textAlign: 'right' as const, color: '#9ca3af', whiteSpace: 'nowrap' as const, fontSize: 11 }}>{fmt(r.at)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>

      </div>
    </div>
  )
}

function MiniStat({ label, value, tone = 'default' }: any) {
  const color = tone === 'bad' ? '#dc2626' : tone === 'warn' ? '#d97706' : '#111'
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', color: '#9ca3af' }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
    </div>
  )
}

const S: any = {
  card:      { background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '16px 18px' },
  bannerErr: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626' },
}
