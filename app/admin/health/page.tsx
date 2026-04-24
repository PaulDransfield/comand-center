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
  const [aiGlobal, setAiGlobal] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMsg,  setSyncMsg]  = useState('')

  async function runSyncAll() {
    setSyncBusy(true); setSyncMsg('')
    try {
      const secret = sessionStorage.getItem('admin_auth') ?? ''
      const res = await fetch('/api/admin/sync-all', {
        method: 'POST',
        headers: { 'x-admin-secret': secret },
      })
      const j = await res.json()
      if (!res.ok) { setSyncMsg('Error: ' + (j.error ?? res.status)); return }
      setSyncMsg(`Done — ${j.synced} integration${j.synced === 1 ? '' : 's'} synced, ${j.errors} error${j.errors === 1 ? '' : 's'}`)
    } catch (e: any) {
      setSyncMsg('Error: ' + e.message)
    } finally {
      setSyncBusy(false)
    }
  }
  // Scope for the AI learning panel — null = all orgs, otherwise a
  // specific business_id. Toggled from the selector; re-fetches the
  // /api/admin/health endpoint with ?business_id= query param.
  const [scopeBusinessId, setScopeBusinessId] = useState<string | null>(null)

  useEffect(() => {
    const secret = sessionStorage.getItem('admin_auth') ?? ''
    if (!secret) { router.push('/admin/login?next=/admin/health'); return }
    const h = { 'x-admin-secret': secret }
    const url = scopeBusinessId
      ? `/api/admin/health?business_id=${encodeURIComponent(scopeBusinessId)}`
      : '/api/admin/health'
    Promise.all([
      fetch(url,                    { headers: h }).then(r => r.ok ? r.json() : Promise.reject(r.status === 401 ? 'Unauthorized' : `HTTP ${r.status}`)),
      fetch('/api/admin/sync-log',  { headers: h }).then(r => r.ok ? r.json() : { logs: [] }),
      fetch('/api/admin/ai-usage',  { headers: h }).then(r => r.ok ? r.json() : null),
    ])
      .then(([h, s, ai]) => { setData(h); setSyncLogs(s.logs ?? []); setAiGlobal(ai) })
      .catch(e => setError(typeof e === 'string' ? e : e.message))
      .finally(() => setLoading(false))
  }, [router, scopeBusinessId])

  if (loading) return <div><AdminNav /><div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div></div>
  if (error)   return <div><AdminNav /><div style={{ padding: 24 }}><div style={S.bannerErr}>{error}</div></div></div>
  if (!data)   return null

  const { crons, ai, sync_by_provider, error_feed, extraction_queue, stripe_dedup, rate_limit_hits, ai_learning, businesses } = data

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 32px' }}>

        <div style={{ marginBottom: 20, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' as const }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>System health</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Cron status · AI spend · error feed · last 7 days of sync data</p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {syncMsg && <span style={{ fontSize: 12, color: syncMsg.startsWith('Error') ? '#dc2626' : '#15803d' }}>{syncMsg}</span>}
            <button
              onClick={runSyncAll}
              disabled={syncBusy}
              style={{ padding: '8px 16px', background: syncBusy ? '#e5e7eb' : '#1a1f2e', color: syncBusy ? '#9ca3af' : 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: syncBusy ? 'not-allowed' : 'pointer' }}
            >
              {syncBusy ? 'Syncing…' : 'Sync all now'}
            </button>
          </div>
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

        {/* Extraction queue + webhook health */}
        {extraction_queue && (
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
            <div style={S.card}>
              <div style={S.head}>Extraction queue (Fortnox PDFs)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
                <QStat label="Pending"      value={extraction_queue.pending}      tone={extraction_queue.pending > 10 ? 'warn' : 'neutral'} />
                <QStat label="Processing"   value={extraction_queue.processing}   tone="neutral" />
                <QStat label="Completed 1d" value={extraction_queue.completed_1d} tone="good" />
                <QStat label="Dead"         value={extraction_queue.dead}         tone={extraction_queue.dead > 0 ? 'bad' : 'neutral'} />
                <QStat label="Stale (>10m)" value={extraction_queue.stale}        tone={extraction_queue.stale > 0 ? 'warn' : 'neutral'} />
              </div>
              <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
                Sweeper runs every 2 min and retries dead/stale jobs. "Dead" {'>'} 0 = investigate.
              </div>
            </div>

            <div style={S.card}>
              <div style={S.head}>Stripe webhooks (24h)</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: '#111', letterSpacing: '-0.03em' }}>
                {stripe_dedup?.processed_1d ?? 0}
              </div>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                unique events processed (duplicates skipped via event-id dedup)
              </div>
            </div>
          </div>
        )}

        {/* AI feedback loop — suggestions captured + owner reactions +
            directional bias. Watching this fill up shows whether the
            feedback loop is actually moving. Once 'resolved' grows past
            ~15 rows, the next AI generation starts seeing real bias. */}
        {ai_learning && (
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div style={S.head}>
                AI feedback loop
                {scopeBusinessId && businesses && (
                  <span style={{ fontSize: 11, fontWeight: 500, color: '#6366f1', marginLeft: 10, textTransform: 'none' as const, letterSpacing: 'normal' as const }}>
                    — scope: {businesses.find((b: any) => b.id === scopeBusinessId)?.name ?? 'unknown'}
                  </span>
                )}
              </div>
              <select
                value={scopeBusinessId ?? ''}
                onChange={e => setScopeBusinessId(e.target.value || null)}
                style={{
                  padding: '4px 8px',
                  fontSize: 12,
                  border: '1px solid #e5e7eb',
                  borderRadius: 6,
                  background: 'white',
                  color: '#111',
                  cursor: 'pointer',
                }}
              >
                <option value="">All orgs · aggregate</option>
                {(businesses ?? []).map((b: any) => (
                  <option key={b.id} value={b.id}>
                    {b.org_name ? `${b.org_name} · ${b.name}` : b.name}{b.is_active ? '' : ' (inactive)'}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10, marginBottom: 14 }}>
              <QStat label="Suggestions"  value={ai_learning.total_suggestions}    tone="neutral" />
              <QStat label="Resolved"     value={ai_learning.resolved_suggestions} tone={ai_learning.resolved_suggestions > 0 ? 'good' : 'neutral'} />
              <QStat label="Pending"      value={ai_learning.pending_resolution}   tone="neutral" />
              <QStat label="👍 just_right" value={ai_learning.reactions.just_right} tone="good" />
              <QStat label="↕ too-off"     value={ai_learning.reactions.too_high + ai_learning.reactions.too_low + ai_learning.reactions.wrong_shape} tone={(ai_learning.reactions.too_high + ai_learning.reactions.too_low + ai_learning.reactions.wrong_shape) > 0 ? 'warn' : 'neutral'} />
            </div>
            {ai_learning.directional_bias && (
              <div style={{ padding: '10px 12px', background: '#fafbff', borderRadius: 8, marginBottom: 10, fontSize: 12, color: '#374151' }}>
                <strong style={{ color: '#111' }}>Directional bias:</strong> {ai_learning.directional_bias.mean_error_pct > 0
                  ? `AI tends to UNDER-predict by ~${ai_learning.directional_bias.mean_error_pct}% on average`
                  : `AI tends to OVER-predict by ~${Math.abs(ai_learning.directional_bias.mean_error_pct)}% on average`} (across {ai_learning.directional_bias.sample_size} resolved rows)
              </div>
            )}
            {ai_learning.recent_rows?.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                <thead>
                  <tr>
                    <th style={th('left')}>Business</th>
                    <th style={th('left')}>Surface</th>
                    <th style={th('left')}>Period</th>
                    <th style={th('right')}>Suggested</th>
                    <th style={th('right')}>Actual</th>
                    <th style={th('right')}>Err %</th>
                    <th style={th('left')}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {ai_learning.recent_rows.slice(0, 12).map((r: any, i: number) => (
                    <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ ...S.td, fontSize: 11, color: '#111', fontWeight: 500 }}>{r.business_name ?? r.business_id?.slice(0, 8)}</td>
                      <td style={{ ...S.td, fontSize: 11, color: '#6b7280' }}>{r.surface}</td>
                      <td style={{ ...S.td, fontSize: 11 }}>{r.period_year}{r.period_month ? `-${String(r.period_month).padStart(2,'0')}` : ''}</td>
                      <td style={{ ...S.td, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{r.suggested_revenue ? Math.round(r.suggested_revenue).toLocaleString('en-GB') : '—'}</td>
                      <td style={{ ...S.td, textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: r.actual_revenue ? '#111' : '#9ca3af' }}>{r.actual_revenue ? Math.round(r.actual_revenue).toLocaleString('en-GB') : 'pending'}</td>
                      <td style={{ ...S.td, textAlign: 'right', fontFamily: 'ui-monospace, monospace', color: r.revenue_direction === 'accurate' ? '#15803d' : r.revenue_direction === 'over' ? '#dc2626' : r.revenue_direction === 'under' ? '#d97706' : '#9ca3af' }}>{r.revenue_error_pct != null ? `${r.revenue_error_pct > 0 ? '+' : ''}${r.revenue_error_pct}%` : '—'}</td>
                      <td style={{ ...S.td, fontSize: 11 }}>{r.owner_reaction ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {ai_learning.total_suggestions === 0 && (
              <div style={{ padding: 16, textAlign: 'center' as const, fontSize: 12, color: '#9ca3af' }}>
                No AI suggestions captured yet. Click "✦ Generate with AI" on /budget to start the loop.
              </div>
            )}
          </div>
        )}

        {/* Rate-limit hits — surfaces compromised sessions / abusive clients */}
        {rate_limit_hits && rate_limit_hits.length > 0 && (
          <div style={{ ...S.card, marginBottom: 14, borderLeft: '3px solid #d97706' }}>
            <div style={S.head}>Rate-limit hits (last 24h)</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
              <thead>
                <tr><th style={th('left')}>Org</th><th style={th('left')}>Bucket</th><th style={th('right')}>Count</th><th style={th('right')}>Window start</th></tr>
              </thead>
              <tbody>
                {rate_limit_hits.map((h: any, i: number) => (
                  <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                    <td style={{ ...S.td, fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{h.org_id.slice(0, 8)}…</td>
                    <td style={S.td}>{h.bucket}</td>
                    <td style={{ ...S.td, textAlign: 'right', fontWeight: 700 }}>{h.count}</td>
                    <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{fmt(h.window_start)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

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

        {/* Global AI spend — detailed cross-customer view */}
        {aiGlobal && (
          <div style={{ ...S.card, marginBottom: 14 }}>
            <div style={S.head}>AI spend — cross-customer (detailed)</div>

            {/* Totals strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 14 }}>
              <div style={{ padding: '10px 12px', background: '#fafbff', borderRadius: 8 }}>
                <div style={S.statLabel}>Today</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#111' }}>{(aiGlobal.today?.cost_sek ?? 0).toFixed(2)} kr</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{aiGlobal.today?.queries ?? 0} queries · ${(aiGlobal.today?.cost_usd ?? 0).toFixed(3)}</div>
              </div>
              <div style={{ padding: '10px 12px', background: '#fafbff', borderRadius: 8 }}>
                <div style={S.statLabel}>7 days</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#111' }}>{(aiGlobal.week?.cost_sek ?? 0).toFixed(2)} kr</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{aiGlobal.week?.queries ?? 0} queries</div>
              </div>
              <div style={{ padding: '10px 12px', background: '#fafbff', borderRadius: 8 }}>
                <div style={S.statLabel}>Month</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#111' }}>{(aiGlobal.month?.cost_sek ?? 0).toFixed(2)} kr</div>
                <div style={{ fontSize: 11, color: '#6b7280' }}>{aiGlobal.month?.queries ?? 0} queries · ${(aiGlobal.month?.cost_usd ?? 0).toFixed(2)}</div>
              </div>
              <div style={{ padding: '10px 12px', background: '#f0fdf4', borderRadius: 8 }}>
                <div style={{ ...S.statLabel, color: '#15803d' }}>Booster revenue (active)</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#15803d' }}>{aiGlobal.booster_revenue_sek ?? 0} kr</div>
                <div style={{ fontSize: 11, color: '#15803d' }}>{(aiGlobal.active_boosters ?? []).length} active</div>
              </div>
            </div>

            {/* Global kill-switch status — today's spend vs $50 cap */}
            {(() => {
              const cap = 50
              const spent = aiGlobal.today?.cost_usd ?? 0
              const pct = Math.min(100, Math.round((spent / cap) * 100))
              const color = pct >= 100 ? '#dc2626' : pct >= 80 ? '#d97706' : '#6366f1'
              return (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6b7280', marginBottom: 4 }}>
                    <span>Global kill-switch — 24h rolling spend</span>
                    <span style={{ color, fontFamily: 'ui-monospace, monospace', fontWeight: 700 }}>
                      ${spent.toFixed(3)} / ${cap} ({pct}%)
                    </span>
                  </div>
                  <div style={{ width: '100%', height: 6, background: '#f3f4f6', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .3s' }} />
                  </div>
                </div>
              )
            })()}

            {/* Top spenders + model mix side-by-side */}
            <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 14 }}>
              <div>
                <div style={S.statLabel}>Top spenders (this month)</div>
                {(aiGlobal.top_spenders ?? []).length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>No AI usage yet.</div>
                ) : (
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb' }}>
                        <th style={th('left')}>Org</th>
                        <th style={th('left')}>Plan</th>
                        <th style={th('right')}>Queries</th>
                        <th style={th('right')}>Cost (kr)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aiGlobal.top_spenders.slice(0, 10).map((o: any) => (
                        <tr key={o.org_id} onClick={() => router.push(`/admin/customers/${o.org_id}`)} style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer' }}>
                          <td style={{ ...S.td, color: '#111', fontWeight: 500 }}>{o.org_name}</td>
                          <td style={{ ...S.td, color: '#6b7280', textTransform: 'uppercase' as const, fontSize: 10 }}>{o.plan}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#374151' }}>{o.queries}</td>
                          <td style={{ ...S.td, textAlign: 'right', color: '#111', fontFamily: 'ui-monospace, monospace' }}>{o.cost_sek.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div>
                <div style={S.statLabel}>Model mix</div>
                {(aiGlobal.model_mix ?? []).length === 0 ? (
                  <div style={{ fontSize: 12, color: '#9ca3af', padding: '8px 0' }}>No calls yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                    {aiGlobal.model_mix.slice(0, 6).map((m: any) => {
                      const [model, tier] = m.key.split('|')
                      return (
                        <div key={m.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: '#fafbff', borderRadius: 6, fontSize: 11 }}>
                          <span style={{ color: '#374151', fontFamily: 'ui-monospace, monospace' }}>{model}{tier !== '-' ? ` · ${tier}` : ''}</span>
                          <span style={{ color: '#6b7280', fontWeight: 600 }}>{m.count}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

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

// Small-stat tile used in the extraction-queue strip.
function QStat({ label, value, tone }: { label: string; value: number; tone: 'good' | 'warn' | 'bad' | 'neutral' }) {
  const colour = tone === 'good' ? '#15803d' : tone === 'warn' ? '#d97706' : tone === 'bad' ? '#dc2626' : '#111'
  return (
    <div style={{ padding: '10px 12px', background: '#fafbff', borderRadius: 8 }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: colour, letterSpacing: '-0.02em' }}>{value}</div>
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
