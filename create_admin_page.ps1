$content = @'
// app/admin/page.tsx
// Developer admin panel - protected by ADMIN_SECRET cookie
'use client'
export const dynamic = 'force-dynamic'

import { useEffect, useState, useCallback } from 'react'

interface OrgRow {
  id: string; name: string; is_active: boolean
  created_at: string; billing_email: string | null
}
interface Alert {
  id: string; org_id: string; severity: string; title: string
  description: string; is_read: boolean; created_at: string
}
interface Integration {
  org_id: string; provider: string; status: string
  last_sync_at: string | null; last_error: string | null
}

const SEVERITY_COLOR: Record<string, string> = {
  critical: '#dc2626', high: '#ea580c', medium: '#d97706', low: '#0284c7'
}

export default function AdminPage() {
  const [secret,    setSecret]    = useState('')
  const [authed,    setAuthed]    = useState(false)
  const [dashboard, setDashboard] = useState<any>(null)
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null)
  const [orgDetail,   setOrgDetail]   = useState<any>(null)
  const [loading,     setLoading]     = useState(false)
  const [note,        setNote]        = useState('')
  const [actionMsg,   setActionMsg]   = useState('')
  const [tab,         setTab]         = useState<'orgs'|'alerts'|'integrations'|'logs'>('orgs')
  const [logs,        setLogs]        = useState<any[]>([])

  async function login() {
    const res = await fetch(`/api/admin?action=dashboard`, {
      headers: { 'x-admin-secret': secret }
    })
    if (res.ok) {
      const data = await res.json()
      setDashboard(data)
      setAuthed(true)
      document.cookie = `admin_secret=${secret};path=/;max-age=86400`
    } else {
      alert('Invalid secret')
    }
  }

  async function loadOrg(orgId: string) {
    setSelectedOrg(orgId)
    setLoading(true)
    const res  = await fetch(`/api/admin?action=org&org_id=${orgId}`, { headers: { 'x-admin-secret': secret } })
    const data = await res.json()
    setOrgDetail(data)
    setLoading(false)
  }

  async function loadLogs() {
    const res = await fetch('/api/admin?action=logs', { headers: { 'x-admin-secret': secret } })
    const data = await res.json()
    setLogs(Array.isArray(data) ? data : [])
  }

  async function doAction(action: string, extra: Record<string, any> = {}) {
    setActionMsg('')
    const res = await fetch('/api/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({ action, org_id: selectedOrg, admin_email: 'paul@comandcenter.se', ...extra }),
    })
    const data = await res.json()
    setActionMsg(data.ok ? 'Done!' : (data.error ?? 'Failed'))
    if (data.ok && selectedOrg) await loadOrg(selectedOrg)
  }

  const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('en-SE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--'

  if (!authed) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
      <div style={{ background: '#1e293b', borderRadius: 12, padding: 32, width: 360, boxShadow: '0 20px 60px rgba(0,0,0,.5)' }}>
        <div style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: 'white', marginBottom: 6 }}>CommandCenter</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 24 }}>Admin Panel</div>
        <input
          type="password" placeholder="Admin secret"
          value={secret} onChange={e => setSecret(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
          style={{ width: '100%', padding: '10px 14px', background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: 'white', fontSize: 14, marginBottom: 12, boxSizing: 'border-box' as const }}
        />
        <button onClick={login}
          style={{ width: '100%', padding: '10px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Login
        </button>
      </div>
    </div>
  )

  const s = dashboard?.stats

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', fontFamily: '-apple-system,sans-serif' }}>

      {/* Top nav */}
      <div style={{ background: '#1e293b', padding: '0 24px', height: 52, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #334155' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontFamily: 'Georgia,serif', color: 'white', fontWeight: 700 }}>CC Admin</span>
          {['orgs','alerts','integrations','logs'].map(t => (
            <button key={t} onClick={() => { setTab(t as any); if (t === 'logs') loadLogs() }}
              style={{ padding: '4px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '.05em',
                background: tab === t ? '#3b82f6' : 'transparent', color: tab === t ? 'white' : '#64748b' }}>
              {t}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 12, color: '#64748b' }}>paul@comandcenter.se</div>
      </div>

      <div style={{ display: 'flex', height: 'calc(100vh - 52px)' }}>

        {/* Left panel */}
        <div style={{ width: 320, borderRight: '1px solid #334155', overflowY: 'auto' as const, flexShrink: 0 }}>

          {/* Stats */}
          {s && (
            <div style={{ padding: 16, borderBottom: '1px solid #334155' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { label: 'Total Orgs',    value: s.total_orgs },
                  { label: 'Active',        value: s.active_orgs },
                  { label: 'Users',         value: s.total_users },
                  { label: 'Fortnox',       value: s.connected_fortnox },
                  { label: 'Unread Alerts', value: s.unread_alerts, red: s.unread_alerts > 0 },
                  { label: 'Critical',      value: s.critical_alerts, red: s.critical_alerts > 0 },
                ].map(kpi => (
                  <div key={kpi.label} style={{ background: '#0f172a', borderRadius: 8, padding: '10px 12px' }}>
                    <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.06em', marginBottom: 4 }}>{kpi.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 700, color: (kpi as any).red ? '#ef4444' : '#f1f5f9' }}>{kpi.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Org list */}
          {tab === 'orgs' && (
            <div>
              {dashboard?.orgs?.map((org: OrgRow) => (
                <div key={org.id} onClick={() => loadOrg(org.id)}
                  style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b', cursor: 'pointer',
                    background: selectedOrg === org.id ? '#1e3a5f' : 'transparent' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{org.name}</div>
                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4,
                      background: org.is_active ? '#14532d' : '#450a0a',
                      color: org.is_active ? '#86efac' : '#fca5a5' }}>
                      {org.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>{org.billing_email ?? '--'}</div>
                  <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>Joined {fmtDate(org.created_at)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Alerts list */}
          {tab === 'alerts' && (
            <div>
              {dashboard?.recent_alerts?.map((alert: Alert) => (
                <div key={alert.id} style={{ padding: '12px 16px', borderBottom: '1px solid #1e293b' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: SEVERITY_COLOR[alert.severity], display: 'inline-block' }} />
                    <span style={{ fontSize: 10, fontWeight: 700, color: SEVERITY_COLOR[alert.severity], textTransform: 'uppercase' as const }}>{alert.severity}</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{alert.title}</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>{fmtDate(alert.created_at)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Integrations list */}
          {tab === 'integrations' && (
            <div>
              {dashboard?.integrations?.map((integ: Integration, i: number) => (
                <div key={i} style={{ padding: '10px 16px', borderBottom: '1px solid #1e293b' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontSize: 12, fontWeight: 600 }}>{integ.provider}</span>
                    <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4,
                      background: integ.status === 'connected' ? '#14532d' : '#450a0a',
                      color: integ.status === 'connected' ? '#86efac' : '#fca5a5' }}>
                      {integ.status}
                    </span>
                  </div>
                  {integ.last_error && <div style={{ fontSize: 10, color: '#ef4444', marginTop: 3 }}>{integ.last_error}</div>}
                  <div style={{ fontSize: 10, color: '#475569', marginTop: 2 }}>Last sync: {fmtDate(integ.last_sync_at)}</div>
                </div>
              ))}
            </div>
          )}

          {/* Logs */}
          {tab === 'logs' && (
            <div>
              {logs.map((log: any) => (
                <div key={log.id} style={{ padding: '10px 16px', borderBottom: '1px solid #1e293b' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#93c5fd' }}>{log.action}</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>{log.admin_email} · {fmtDate(log.created_at)}</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Right panel — org detail */}
        <div style={{ flex: 1, overflowY: 'auto' as const, padding: 24 }}>
          {!selectedOrg ? (
            <div style={{ color: '#475569', paddingTop: 60, textAlign: 'center' as const }}>
              Select an organisation to view details
            </div>
          ) : loading ? (
            <div style={{ color: '#475569', paddingTop: 60, textAlign: 'center' as const }}>Loading...</div>
          ) : orgDetail && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
                <div>
                  <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 22, color: 'white', margin: '0 0 4px' }}>{orgDetail.org?.name}</h1>
                  <div style={{ fontSize: 12, color: '#64748b' }}>{orgDetail.org?.billing_email} · ID: {selectedOrg}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
                  <button onClick={() => doAction('extend_trial', { days: 14 })}
                    style={{ padding: '7px 12px', background: '#1d4ed8', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    +14 days trial
                  </button>
                  <button onClick={() => doAction('toggle_active')}
                    style={{ padding: '7px 12px', background: orgDetail.org?.is_active ? '#7f1d1d' : '#14532d', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    {orgDetail.org?.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button onClick={() => doAction('trigger_fortnox_sync')}
                    style={{ padding: '7px 12px', background: '#0f766e', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    Sync Fortnox
                  </button>
                  <button onClick={() => doAction('trigger_digest')}
                    style={{ padding: '7px 12px', background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    Send Digest
                  </button>
                  <button onClick={() => doAction('trigger_anomaly_check')}
                    style={{ padding: '7px 12px', background: '#b45309', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    Run Anomaly Check
                  </button>
                </div>
              </div>

              {actionMsg && <div style={{ background: '#1e293b', borderRadius: 8, padding: '10px 16px', fontSize: 13, color: '#86efac', marginBottom: 16 }}>{actionMsg}</div>}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>

                {/* Members */}
                <div style={{ background: '#1e293b', borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Members ({orgDetail.members?.length})</div>
                  {orgDetail.members?.map((m: any) => (
                    <div key={m.user_id} style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{m.email ?? m.user_id}</div>
                      <div style={{ fontSize: 11, color: '#64748b' }}>{m.role} · Last login: {fmtDate(m.last_sign_in)}</div>
                    </div>
                  ))}
                </div>

                {/* Businesses */}
                <div style={{ background: '#1e293b', borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Restaurants ({orgDetail.businesses?.length})</div>
                  {orgDetail.businesses?.map((b: any) => (
                    <div key={b.id} style={{ marginBottom: 6, fontSize: 13 }}>
                      {b.name} {b.city ? `(${b.city})` : ''} — <span style={{ color: b.is_active ? '#86efac' : '#fca5a5' }}>{b.is_active ? 'active' : 'inactive'}</span>
                    </div>
                  ))}
                </div>

                {/* Integrations */}
                <div style={{ background: '#1e293b', borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Integrations</div>
                  {orgDetail.integrations?.length === 0 && <div style={{ fontSize: 12, color: '#475569' }}>None connected</div>}
                  {orgDetail.integrations?.map((integ: any) => (
                    <div key={integ.id} style={{ marginBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                        <span style={{ fontWeight: 600 }}>{integ.provider}</span>
                        <span style={{ color: integ.status === 'connected' ? '#86efac' : '#fca5a5' }}>{integ.status}</span>
                      </div>
                      {integ.last_error && <div style={{ fontSize: 11, color: '#ef4444' }}>{integ.last_error}</div>}
                      <div style={{ fontSize: 10, color: '#475569' }}>Last sync: {fmtDate(integ.last_sync_at)}</div>
                    </div>
                  ))}
                </div>

                {/* Recent tracker data */}
                <div style={{ background: '#1e293b', borderRadius: 10, padding: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Recent P&L Data</div>
                  {orgDetail.tracker_data?.length === 0 && <div style={{ fontSize: 12, color: '#475569' }}>No data yet</div>}
                  {orgDetail.tracker_data?.slice(0, 6).map((t: any) => (
                    <div key={`${t.period_year}-${t.period_month}`} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                      <span style={{ color: '#94a3b8' }}>{t.period_year}-{String(t.period_month).padStart(2,'0')}</span>
                      <span>{Math.round(t.revenue ?? 0).toLocaleString()} kr</span>
                      <span style={{ color: t.margin_pct >= 0 ? '#86efac' : '#fca5a5' }}>{t.margin_pct?.toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Alerts */}
              {orgDetail.alerts?.length > 0 && (
                <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Active Alerts</div>
                  {orgDetail.alerts.map((a: any) => (
                    <div key={a.id} style={{ marginBottom: 8, padding: '8px 12px', background: '#0f172a', borderRadius: 6 }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: SEVERITY_COLOR[a.severity] }}>{a.title}</div>
                      <div style={{ fontSize: 11, color: '#64748b' }}>{a.description}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Support notes */}
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Support Notes</div>
                {orgDetail.support_notes?.map((n: any) => (
                  <div key={n.id} style={{ marginBottom: 8, padding: '8px 12px', background: '#0f172a', borderRadius: 6 }}>
                    <div style={{ fontSize: 12 }}>{n.note}</div>
                    <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>{n.author} · {fmtDate(n.created_at)}</div>
                  </div>
                ))}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <input value={note} onChange={e => setNote(e.target.value)}
                    placeholder="Add a support note..."
                    style={{ flex: 1, padding: '8px 12px', background: '#0f172a', border: '1px solid #334155', borderRadius: 6, color: 'white', fontSize: 12 }} />
                  <button onClick={() => { doAction('add_note', { note }); setNote('') }}
                    style={{ padding: '8px 14px', background: '#3b82f6', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    Add
                  </button>
                </div>
              </div>

              {/* Plan control */}
              <div style={{ background: '#1e293b', borderRadius: 10, padding: 16, marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#64748b', marginBottom: 10 }}>Plan Control</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {['free', 'starter', 'pro', 'enterprise'].map(plan => (
                    <button key={plan} onClick={() => doAction('set_plan', { plan })}
                      style={{ padding: '7px 14px', borderRadius: 6, border: `1px solid ${orgDetail.org?.plan === plan ? '#3b82f6' : '#334155'}`,
                        background: orgDetail.org?.plan === plan ? '#1d4ed8' : 'transparent',
                        color: 'white', fontSize: 12, cursor: 'pointer', textTransform: 'capitalize' as const }}>
                      {plan}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

'@
$dir = Split-Path -Parent (Join-Path (Get-Location) "app\admin\page.tsx")
New-Item -ItemType Directory -Force -Path $dir | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) "app\admin\page.tsx"),
  $content,
  [System.Text.UTF8Encoding]::new($false)
)
Write-Host "create_admin_page.ps1 written"
