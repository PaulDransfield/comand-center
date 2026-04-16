'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const PROVIDERS = [
  { key: 'personalkollen', name: 'Personalkollen', authType: 'api_key' },
  { key: 'fortnox',        name: 'Fortnox',        authType: 'oauth2'  },
  { key: 'ancon',          name: 'Ancon',           authType: 'api_key' },
  { key: 'swess',          name: 'Swess',           authType: 'api_key' },
  { key: 'caspeco',        name: 'Caspeco',         authType: 'api_key' },
]

const fmtDate = (d: string) => d ? new Date(d).toLocaleString('sv-SE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Never'

const INZII_DEPTS = ['Bella', 'Brus', 'Carne', 'Chilango', 'Ölbaren', 'Rosalis Select']

export default function AdminPage() {
  const router = useRouter()
  const [authed,       setAuthed]       = useState(false)
  const [password,     setPassword]     = useState('')
  const [orgs,         setOrgs]         = useState<any[]>([])
  const [loading,      setLoading]      = useState(false)
  const [modal,        setModal]        = useState<any>(null)
  const [syncModal,    setSyncModal]    = useState<any>(null)
  const [inziiModal,   setInziiModal]   = useState<any>(null)
  const [syncLogs,     setSyncLogs]     = useState<any[]>([])
  const [triggering,   setTriggering]   = useState(false)
  const [triggerMsg,   setTriggerMsg]   = useState('')

  useEffect(() => {
    const saved = sessionStorage.getItem('admin_auth')
    if (saved === 'true') { setAuthed(true); loadOrgs(); loadSyncLogs() }
  }, [])

  async function login() {
    const res = await fetch('/api/admin/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    const data = await res.json()
    if (data.ok) {
      sessionStorage.setItem('admin_auth', 'true')
      setAuthed(true)
      loadOrgs()
      loadSyncLogs()
    } else {
      alert('Wrong password')
    }
  }

  async function loadOrgs() {
    setLoading(true)
    const res  = await fetch(`/api/admin/orgs?t=${Date.now()}`, { cache: 'no-store' })
    const data = await res.json()
    if (data.orgs) setOrgs(data.orgs)
    setLoading(false)
  }

  async function loadSyncLogs() {
    const res  = await fetch('/api/admin/sync-log')
    const data = await res.json()
    if (data.logs) setSyncLogs(data.logs)
  }

  async function triggerSync() {
    setTriggering(true)
    setTriggerMsg('Running sync...')
    const res  = await fetch('/api/admin/sync-log', { method: 'POST' })
    const data = await res.json()
    setTriggering(false)
    if (data.ok) {
      setTriggerMsg(`Done — ${data.synced ?? 0} integration(s) synced`)
      loadOrgs()
      loadSyncLogs()
    } else {
      setTriggerMsg(`Error: ${data.error ?? 'Unknown error'}`)
    }
    setTimeout(() => setTriggerMsg(''), 8000)
  }

  if (!authed) return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', borderRadius: 12, padding: 40, width: 320, boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
        <div style={{ fontSize: 18, fontWeight: 700, color: '#1a1f2e', marginBottom: 4 }}>CommandCenter</div>
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 24 }}>Admin Panel</div>
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && login()}
          placeholder="Admin password"
          style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const, marginBottom: 12 }}
        />
        <button onClick={login} style={{ width: '100%', padding: 11, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
          Login
        </button>
      </div>
    </div>
  )

  // Setup requests at top
  const setupRequests = orgs.filter(o => o.setup_requested && !o.has_connection)
  const connected     = orgs.filter(o => o.has_connection)
  const pending       = orgs.filter(o => !o.setup_requested && !o.has_connection)

  return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#1a1f2e' }}>Admin Panel</div>
            <div style={{ fontSize: 13, color: '#9ca3af' }}>{orgs.length} organisations</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' as const }}>
            {triggerMsg && (
              <span style={{ fontSize: 12, color: triggerMsg.startsWith('Error') ? '#dc2626' : '#15803d', fontWeight: 600 }}>
                {triggerMsg}
              </span>
            )}
            <button
              onClick={triggerSync}
              disabled={triggering}
              style={{ padding: '8px 16px', background: triggering ? '#e5e7eb' : '#6366f1', color: triggering ? '#9ca3af' : 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: triggering ? 'not-allowed' : 'pointer' }}
            >
              {triggering ? 'Syncing...' : 'Trigger sync now'}
            </button>
            <button onClick={() => { loadOrgs(); loadSyncLogs() }} style={{ padding: '8px 16px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
              Refresh
            </button>
            <a href="/admin/api-discoveries-enhanced" style={{ padding: '8px 16px', background: '#8b5cf6', color: 'white', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              Enhanced API Discovery
            </a>
            <a href="/dashboard" style={{ padding: '8px 16px', background: '#1a1f2e', color: 'white', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>
              Back to app
            </a>
            <button 
              onClick={() => {
                sessionStorage.removeItem('admin_auth');
                setAuthed(false);
              }}
              style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            >
              Logout
            </button>
          </div>
        </div>

        {loading && <div style={{ textAlign: 'center', padding: 40, color: '#9ca3af' }}>Loading...</div>}

        {/* Setup requests */}
        {setupRequests.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#d97706', marginBottom: 10 }}>
              Setup requests ({setupRequests.length})
            </div>
            {setupRequests.map(org => (
              <OrgCard key={org.id} org={org} onConnect={(biz: any) => setModal({ org, biz })} onSync={setSyncModal} onAddInzii={(biz: any) => setInziiModal({ org, biz })} highlight />
            ))}
          </div>
        )}

        {/* Connected */}
        {connected.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#15803d', marginBottom: 10 }}>
              Connected ({connected.length})
            </div>
            {connected.map(org => (
              <OrgCard key={org.id} org={org} onConnect={(biz: any) => setModal({ org, biz })} onSync={setSyncModal} onAddInzii={(biz: any) => setInziiModal({ org, biz })} />
            ))}
          </div>
        )}

        {/* Pending */}
        {pending.length > 0 && (
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9ca3af', marginBottom: 10 }}>
              No connections yet ({pending.length})
            </div>
            {pending.map(org => (
              <OrgCard key={org.id} org={org} onConnect={(biz: any) => setModal({ org, biz })} onSync={setSyncModal} onAddInzii={(biz: any) => setInziiModal({ org, biz })} />
            ))}
          </div>
        )}

        {/* Sync Log */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#374151', marginBottom: 10 }}>
            Sync log — last 50 runs
          </div>
          {syncLogs.length === 0 ? (
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '20px 24px', fontSize: 13, color: '#9ca3af' }}>
              No sync runs recorded yet. The cron runs daily at 05:00 UTC. You can also trigger it manually above.
            </div>
          ) : (
            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #f3f4f6', background: '#f9fafb' }}>
                    {['Time', 'Org', 'Provider', 'Status', 'Records', 'Duration', 'Error'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left' as const, fontWeight: 600, color: '#6b7280', letterSpacing: '.04em', textTransform: 'uppercase' as const }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {syncLogs.map((log: any) => (
                    <tr key={log.id} style={{ borderBottom: '0.5px solid #f3f4f6' }}>
                      <td style={{ padding: '8px 12px', color: '#374151', whiteSpace: 'nowrap' as const }}>
                        {fmtDate(log.created_at)}
                      </td>
                      <td style={{ padding: '8px 12px', color: '#374151', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {log.org_name}
                      </td>
                      <td style={{ padding: '8px 12px', color: '#374151' }}>{log.provider}</td>
                      <td style={{ padding: '8px 12px' }}>
                        <span style={{
                          padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 700,
                          background: log.status === 'success' ? '#dcfce7' : '#fee2e2',
                          color:      log.status === 'success' ? '#15803d' : '#dc2626',
                        }}>
                          {log.status}
                        </span>
                      </td>
                      <td style={{ padding: '8px 12px', color: '#374151' }}>{log.records_synced ?? 0}</td>
                      <td style={{ padding: '8px 12px', color: '#9ca3af' }}>
                        {log.duration_ms ? `${(log.duration_ms / 1000).toFixed(1)}s` : '—'}
                      </td>
                      <td style={{ padding: '8px 12px', color: '#dc2626', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                        {log.error_msg ?? ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>

      {/* Connection wizard modal */}
      {modal && (
        <ConnectWizard
          org={modal.org}
          biz={modal.biz}
          onClose={() => { setModal(null); loadOrgs() }}
        />
      )}

      {/* Inzii department modal */}
      {inziiModal && (
        <InziiDeptModal
          org={inziiModal.org}
          biz={inziiModal.biz}
          onRefresh={loadOrgs}
          onClose={() => { setInziiModal(null); loadOrgs() }}
        />
      )}

      {/* Sync modal */}
      {syncModal && (
        <SyncModal
          integration={syncModal}
          onClose={() => { setSyncModal(null); loadOrgs() }}
        />
      )}
    </div>
  )
}

function OrgCard({ org, onConnect, onSync, onAddInzii, highlight }: any) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div style={{ background: 'white', border: `1px solid ${highlight ? '#fde68a' : '#e5e7eb'}`, borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
      {/* Org header */}
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', background: highlight ? '#fffbeb' : 'white' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 36, height: 36, borderRadius: '50%', background: highlight ? '#fde68a' : '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#374151', flexShrink: 0 }}>
            {(org.name ?? 'O')[0].toUpperCase()}
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{org.name ?? 'Unknown org'}</div>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>
              {org.email} · {org.businesses?.length ?? 0} businesses
              {(() => {
                const n = (org.businesses ?? []).reduce((sum: number, b: any) =>
                  sum + (b.integrations ?? []).filter((i: any) => i.provider === 'inzii').length, 0)
                return n > 0 ? ` · ${n} Inzii dept${n !== 1 ? 's' : ''}` : ''
              })()}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {highlight && <span style={{ fontSize: 11, background: '#fef3c7', color: '#d97706', padding: '2px 8px', borderRadius: 4, fontWeight: 600 }}>Setup requested</span>}
          {org.setup_data && (
            <div style={{ fontSize: 11, color: '#6b7280' }}>
              Uses: {[org.setup_data.staffSystem, org.setup_data.accounting, org.setup_data.pos].filter(Boolean).join(' + ')}
            </div>
          )}
          <span style={{ color: '#9ca3af', fontSize: 12 }}>{expanded ? 'v' : '>'}</span>
        </div>
      </div>

      {/* Expanded: businesses + integrations */}
      {expanded && (
        <div style={{ borderTop: '1px solid #f3f4f6', padding: '12px 18px' }}>
          {(org.businesses ?? []).map((biz: any) => (
            <div key={biz.id} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
                {biz.name} <span style={{ fontWeight: 400, color: '#9ca3af' }}>({biz.city ?? 'no city'})</span>
              </div>

              {/* Standard integrations (non-Inzii) */}
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 10 }}>
                {PROVIDERS.map(p => {
                  const integ = (biz.integrations ?? []).find((i: any) => i.provider === p.key)
                  const connected = integ?.status === 'connected'
                  const hasError  = integ?.status === 'error'
                  return (
                    <div key={p.key} style={{ padding: '6px 12px', borderRadius: 8, border: `1px solid ${connected ? '#bbf7d0' : hasError ? '#fecaca' : '#e5e7eb'}`, background: connected ? '#f0fdf4' : hasError ? '#fef2f2' : '#fafafa', fontSize: 12 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: connected ? '#10b981' : hasError ? '#dc2626' : '#d1d5db', display: 'inline-block' }} />
                        <span style={{ fontWeight: 600, color: '#374151' }}>{p.name}</span>
                        {connected && integ?.last_sync_at && (
                          <span style={{ color: '#9ca3af' }}>· {fmtDate(integ.last_sync_at)}</span>
                        )}
                      </div>
                      {connected && (
                        <button onClick={() => onSync({ integrationId: integ.id, name: `${biz.name} - ${p.name}`, orgId: org.id })}
                          style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                          Sync now
                        </button>
                      )}
                      {!connected && (
                        <button onClick={() => onConnect({ ...biz, selectedProvider: p.key })}
                          style={{ marginTop: 4, fontSize: 11, padding: '2px 8px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                          Connect
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Inzii POS departments */}
              {(() => {
                const depts = (biz.integrations ?? []).filter((i: any) => i.provider === 'inzii')
                return (
                  <div style={{ borderTop: '0.5px solid #f3f4f6', paddingTop: 10 }}>
                    <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, fontFamily: 'monospace' }}>
                      DEBUG: {biz.integrations?.length ?? 0} total integrations | providers: [{(biz.integrations ?? []).map((i: any) => i.provider).join(', ')}]
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '.06em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
                      Inzii POS — {depts.length} department{depts.length !== 1 ? 's' : ''} connected
                    </div>
                    {depts.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, marginBottom: 8 }}>
                        {depts.map((integ: any) => (
                          <div key={integ.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderRadius: 6, background: '#f8fafc', border: '0.5px solid #e5e7eb', fontSize: 12 }}>
                            <span style={{ width: 6, height: 6, borderRadius: '50%', background: integ.status === 'connected' ? '#10b981' : '#d1d5db', flexShrink: 0 }} />
                            <span style={{ fontWeight: 600, color: '#374151', flex: 1 }}>{integ.department ?? '—'}</span>
                            {integ.last_sync_at
                              ? <span style={{ color: '#9ca3af', fontSize: 11 }}>{fmtDate(integ.last_sync_at)}</span>
                              : <span style={{ color: '#f59e0b', fontSize: 11 }}>Never synced</span>
                            }
                            <button
                              onClick={() => onSync({ integrationId: integ.id, name: `${biz.name} — ${integ.department}`, orgId: org.id })}
                              style={{ fontSize: 11, padding: '2px 8px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}
                            >
                              Sync
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <button
                      onClick={() => onAddInzii({ ...biz, _org: org })}
                      style={{ fontSize: 11, padding: '4px 12px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer', fontWeight: 600 }}
                    >
                      + Add department
                    </button>
                  </div>
                )
              })()}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ConnectWizard({ org, biz, onClose }: any) {
  const [step,      setStep]      = useState<'key'|'test'|'sync'|'done'>('key')
  const [provider,  setProvider]  = useState(biz.selectedProvider ?? 'personalkollen')
  const [apiKey,    setApiKey]    = useState('')
  const [testResult, setTestResult] = useState<any>(null)
  const [testing,   setTesting]   = useState(false)
  const [syncing,   setSyncing]   = useState(false)
  const [syncLog,   setSyncLog]   = useState<string[]>([])
  const [error,     setError]     = useState('')

  async function testConnection() {
    if (!apiKey.trim()) { setError('Enter an API key'); return }
    setTesting(true)
    setError('')
    try {
      const res  = await fetch('/api/admin/test-connection', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), org_id: org.id, business_id: biz.id }),
      })
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error ?? 'Connection failed')
      setTestResult(data)
      setStep('test')
    } catch (e: any) { setError(e.message) }
    setTesting(false)
  }

  async function connectAndSync() {
    setSyncing(true)
    setSyncLog(['Saving connection...'])
    try {
      // Save integration
      const saveRes = await fetch('/api/admin/connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), org_id: org.id, business_id: biz.id }),
      })
      const saveData = await saveRes.json()
      if (!saveRes.ok) throw new Error(saveData.error ?? 'Failed to save')

      setSyncLog(l => [...l, `Connected to ${testResult?.workplace_name ?? provider}`, `Starting import from ${testResult?.earliest_date ?? '2022-01-01'}...`])
      setStep('sync')

      // Trigger sync with auto-detected from date
      const syncRes = await fetch('/api/admin/sync', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          integration_id: saveData.integration_id,
          org_id:         org.id,
          from:           testResult?.earliest_date ?? '2022-01-01',
        }),
      })
      const syncData = await syncRes.json()
      setSyncLog(l => [...l,
        `Imported ${syncData.shifts ?? 0} shifts`,
        `${syncData.revenue_days ?? 0} revenue days`,
        `${syncData.staff_count ?? 0} staff members`,
        'Done!',
      ])
      setStep('done')
    } catch (e: any) {
      setSyncLog(l => [...l, `Error: ${e.message}`])
      setError(e.message)
    }
    setSyncing(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }}>
      <div style={{ background: 'white', borderRadius: 16, padding: 32, width: '100%', maxWidth: 480, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>

        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1f2e', marginBottom: 4 }}>Connect Integration</div>
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 24 }}>{org.name} — {biz.name}</div>

        {/* Step: Enter key */}
        {step === 'key' && (
          <div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>Provider</label>
              <select value={provider} onChange={e => setProvider(e.target.value)}
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const }}>
                {PROVIDERS.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>API Key</label>
              <input value={apiKey} onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && testConnection()}
                placeholder="Paste API key here"
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' as const }} />
            </div>
            {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={testConnection} disabled={testing}
                style={{ flex: 1, padding: 11, background: '#6366f1', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                {testing ? 'Testing...' : 'Test connection'}
              </button>
              <button onClick={onClose}
                style={{ padding: '11px 18px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', color: '#374151' }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Step: Test result */}
        {step === 'test' && testResult && (
          <div>
            <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '14px 16px', marginBottom: 20 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#15803d', marginBottom: 8 }}>Connection successful</div>
              <div style={{ fontSize: 13, color: '#374151', display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
                <div><span style={{ color: '#9ca3af' }}>Workplace:</span> {testResult.workplace_name}</div>
                <div><span style={{ color: '#9ca3af' }}>Data from:</span> {testResult.earliest_date} to today</div>
                <div><span style={{ color: '#9ca3af' }}>Est. records:</span> ~{testResult.estimated_records?.toLocaleString()} shifts</div>
              </div>
            </div>
            {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={connectAndSync}
                style={{ flex: 1, padding: 11, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Connect & Import all data
              </button>
              <button onClick={() => setStep('key')}
                style={{ padding: '11px 18px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', color: '#374151' }}>
                Back
              </button>
            </div>
          </div>
        )}

        {/* Step: Syncing */}
        {step === 'sync' && (
          <div>
            <div style={{ marginBottom: 16 }}>
              {syncLog.map((line, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', fontSize: 13, color: '#374151' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#6366f1', flexShrink: 0 }} />
                  {line}
                </div>
              ))}
              {syncing && <div style={{ fontSize: 13, color: '#9ca3af', marginTop: 8 }}>Running... this may take a minute.</div>}
            </div>
          </div>
        )}

        {/* Step: Done */}
        {step === 'done' && (
          <div style={{ textAlign: 'center' as const }}>
            <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#f0fdf4', border: '2px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px', fontSize: 24, color: '#15803d' }}>+</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 8 }}>All done!</div>
            <div style={{ marginBottom: 20 }}>
              {syncLog.map((line, i) => (
                <div key={i} style={{ fontSize: 13, color: '#6b7280', padding: '2px 0' }}>{line}</div>
              ))}
            </div>
            <button onClick={onClose}
              style={{ width: '100%', padding: 11, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Back to admin
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function InziiDeptModal({ org, biz, onRefresh, onClose }: any) {
  const [dept,    setDept]    = useState('')
  const [apiKey,  setApiKey]  = useState('')
  const [saving,  setSaving]  = useState(false)
  const [done,    setDone]    = useState(false)
  const [error,   setError]   = useState('')

  async function save() {
    if (!dept.trim()) { setError('Select or enter a department name'); return }
    if (!apiKey.trim()) { setError('Enter the API key for this department'); return }
    setSaving(true)
    setError('')
    try {
      const res = await fetch('/api/admin/connect', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider:    'inzii',
          api_key:     apiKey.trim(),
          org_id:      org.id,
          business_id: biz.id,
          department:  dept.trim(),
        }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error ?? 'Failed to save')
      setDone(true)
      onRefresh?.()
    } catch (e: any) { setError(e.message) }
    setSaving(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }}>
      <div style={{ background: 'white', borderRadius: 16, padding: 32, width: '100%', maxWidth: 440, boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }}>
        {!done ? (
          <>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1f2e', marginBottom: 4 }}>Add Inzii POS Department</div>
            <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 24 }}>{org.name} — {biz.name}</div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>
                Department
              </label>
              <input
                list="dept-suggestions"
                value={dept}
                onChange={e => setDept(e.target.value)}
                placeholder="e.g. Bella, Brus, Carne..."
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const }}
              />
              <datalist id="dept-suggestions">
                {INZII_DEPTS.map(d => <option key={d} value={d} />)}
              </datalist>
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '.05em' }}>
                Inzii API Key
              </label>
              <input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && save()}
                placeholder="Paste the API key for this department"
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, fontFamily: 'monospace', boxSizing: 'border-box' as const }}
              />
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
                Find the key in Personalkollen under Kassaleverantör for this workplace.
              </div>
            </div>

            {error && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={save} disabled={saving}
                style={{ flex: 1, padding: 11, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                {saving ? 'Saving...' : 'Save department'}
              </button>
              <button onClick={onClose}
                style={{ padding: '11px 18px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', color: '#374151' }}>
                Cancel
              </button>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center' as const }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>+</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 8 }}>{dept} saved</div>
            <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
              Key stored securely. The department will sync in the next daily run (05:00 UTC) or you can trigger a sync manually from the department row.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={() => { setDone(false); setDept(''); setApiKey('') }}
                style={{ flex: 1, padding: 11, background: '#6366f1', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Add another department
              </button>
              <button onClick={onClose}
                style={{ flex: 1, padding: 11, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function SyncModal({ integration, onClose }: any) {
  const [syncing,  setSyncing]  = useState(false)
  const [result,   setResult]   = useState<any>(null)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [fromDate, setFromDate] = useState(ninetyDaysAgo)

  async function runSync() {
    setSyncing(true)
    const res  = await fetch('/api/admin/sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ integration_id: integration.integrationId, org_id: integration.orgId, from: fromDate }),
    })
    const data = await res.json()
    setResult(data)
    setSyncing(false)
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 24 }}>
      <div style={{ background: 'white', borderRadius: 16, padding: 32, width: '100%', maxWidth: 420 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1f2e', marginBottom: 4 }}>Sync Data</div>
        <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 20 }}>{integration.name}</div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>Sync from date</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            style={{ width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const }} />
        </div>
        {result && (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 14px', marginBottom: 16, fontSize: 13 }}>
            <div style={{ fontWeight: 600, color: '#15803d', marginBottom: 4 }}>Sync complete</div>
            <div style={{ color: '#374151' }}>
              {result.shifts ?? 0} shifts · {result.revenue_days ?? 0} revenue days · {result.staff_count ?? 0} staff
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={runSync} disabled={syncing}
            style={{ flex: 1, padding: 11, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
            {syncing ? 'Syncing...' : 'Run sync'}
          </button>
          <button onClick={onClose}
            style={{ padding: '11px 18px', background: '#f3f4f6', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', color: '#374151' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
