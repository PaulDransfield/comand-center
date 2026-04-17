'use client'
// @ts-nocheck
// app/admin/customers/[orgId]/page.tsx — customer god-page.
// One URL that answers every "what's up with this customer" question.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import { AdminNav } from '@/components/admin/AdminNav'
import { groupedProviders, getProvider, supportedCount, plannedCount } from '@/lib/integrations/providers'

const STAGE_META: Record<string, { label: string; color: string; bg: string; border: string }> = {
  new:     { label: 'New',        color: '#6d28d9', bg: '#ede9fe', border: '#ddd6fe' },
  setup:   { label: 'In Setup',   color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
  active:  { label: 'Active',     color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
  at_risk: { label: 'At Risk',    color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
  churned: { label: 'Churned',    color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb' },
}

const fmt = (s: string | null) => s ? new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'
const daysAgo = (s: string | null) => {
  if (!s) return null
  return Math.floor((Date.now() - new Date(s).getTime()) / 86400000)
}

export default function CustomerDetail() {
  const router = useRouter()
  const params = useParams()
  const orgId  = params?.orgId as string

  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [savingNote, setSavingNote] = useState(false)
  const [noteDraft,  setNoteDraft]  = useState('')
  const [actionLoading, setActionLoading] = useState<string | null>(null)
  const [agents, setAgents] = useState<any[]>([])
  const [runResult, setRunResult] = useState<any>(null)
  const [impersonate, setImpersonate] = useState<any>(null)
  const [copied, setCopied] = useState(false)
  const [timeline, setTimeline] = useState<any[]>([])
  const [integRowAction, setIntegRowAction] = useState<{id: string; action: string} | null>(null)
  const [editingKey, setEditingKey] = useState<any>(null)       // { id, provider, department, business_id }
  const [addIntegModal, setAddIntegModal] = useState<any>(null) // { business_id, business_name }
  const [discoveryResult, setDiscoveryResult] = useState<any>(null)
  const [deptSetupResult, setDeptSetupResult] = useState<any>(null)

  // /admin stores the password in sessionStorage — same value as ADMIN_SECRET env var.
  const secret = typeof window !== 'undefined' ? (sessionStorage.getItem('admin_auth') ?? '') : ''

  useEffect(() => {
    if (!secret) { router.push('/admin/login'); return }
    load()
  }, [orgId])

  async function load() {
    setLoading(true); setError('')
    try {
      const [r1, r2, r3] = await Promise.all([
        fetch(`/api/admin/customers/${orgId}`, { headers: { 'x-admin-secret': secret } }),
        fetch(`/api/admin/customers/${orgId}/agents`, { headers: { 'x-admin-secret': secret } }),
        fetch(`/api/admin/customers/${orgId}/timeline`, { headers: { 'x-admin-secret': secret } }),
      ])
      if (!r1.ok) throw new Error(r1.status === 401 ? 'Unauthorized' : `HTTP ${r1.status}`)
      setData(await r1.json())
      if (r2.ok) setAgents((await r2.json()).agents ?? [])
      if (r3.ok) setTimeline((await r3.json()).events ?? [])
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }

  async function toggleAgent(agent: string, enabled: boolean) {
    setActionLoading('toggle_' + agent)
    await fetch(`/api/admin/customers/${orgId}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({ action: 'toggle', agent, enabled }),
    })
    await load()
    setActionLoading(null)
  }

  async function startImpersonate() {
    setActionLoading('impersonate')
    setCopied(false)
    try {
      const res = await fetch(`/api/admin/customers/${orgId}/impersonate`, {
        method: 'POST',
        headers: { 'x-admin-secret': secret },
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? 'Impersonate failed')
      setImpersonate(json)
    } catch (e: any) {
      setError(e.message)
    }
    setActionLoading(null)
  }

  async function runAgent(agent: string) {
    setActionLoading('run_' + agent)
    setRunResult(null)
    const res = await fetch(`/api/admin/customers/${orgId}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
      body: JSON.stringify({ action: 'run', agent }),
    })
    const json = await res.json()
    setRunResult({ agent, ok: res.ok, ...json })
    setActionLoading(null)
    // Reload agent state in a few seconds so last_run refreshes once writes land
    setTimeout(() => load(), 2500)
  }

  async function runAction(action: string, body: any = {}) {
    setActionLoading(action)
    try {
      await fetch('/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ action, org_id: orgId, ...body }),
      })
      await load()
    } catch (e: any) { setError(e.message) }
    setActionLoading(null)
  }

  async function addNote() {
    if (!noteDraft.trim()) return
    await runAction('add_note', { note: noteDraft.trim() })
    setNoteDraft('')
  }

  async function triggerSync(integId: string) {
    setActionLoading('sync_' + integId)
    try {
      await fetch(`/api/admin/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ integration_id: integId }),
      })
      await load()
    } catch (e: any) { setError(e.message) }
    setActionLoading(null)
  }

  async function deleteIntegration(integId: string, provider: string) {
    if (!confirm(`Delete the ${provider} integration? This drops cached discoveries too. Cannot be undone.`)) return
    setActionLoading('delete_' + integId)
    try {
      const r = await fetch(`/api/admin/customers/${orgId}/integrations/${integId}`, {
        method: 'DELETE', headers: { 'x-admin-secret': secret },
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Delete failed')
      await load()
    } catch (e: any) { setError(e.message) }
    setActionLoading(null)
  }

  async function setupDepartments(businessId: string, businessName: string) {
    setActionLoading('setup_depts_' + businessId)
    setDeptSetupResult(null)
    try {
      const r = await fetch('/api/admin/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ org_id: orgId, business_id: businessId, action: 'auto' }),
      })
      const json = await r.json()
      if (!r.ok || !json.ok) throw new Error(json.error ?? 'Setup failed')
      setDeptSetupResult({ ok: true, businessName, departments: json.departments ?? [] })
    } catch (e: any) {
      setDeptSetupResult({ ok: false, businessName, error: e.message })
    }
    setActionLoading(null)
  }

  async function runDiscovery(integId: string, provider: string) {
    setActionLoading('discover_' + integId)
    setDiscoveryResult(null)
    try {
      const r = await fetch(`/api/admin/customers/${orgId}/integrations/${integId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ action: 'run_discovery' }),
      })
      const json = await r.json()
      setDiscoveryResult({ integId, provider, ok: r.ok, ...json })
      await load()
    } catch (e: any) { setError(e.message) }
    setActionLoading(null)
  }

  async function saveKey(integId: string, newKey: string, provider: string, department?: string, businessId?: string) {
    setActionLoading('save_' + integId)
    try {
      const r = await fetch('/api/admin/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({
          org_id: orgId,
          business_id: businessId,
          provider,
          api_key: newKey,
          department,
        }),
      })
      if (!r.ok) throw new Error((await r.json()).error ?? 'Save failed')
      setEditingKey(null)
      setAddIntegModal(null)
      await load()
    } catch (e: any) { setError(e.message) }
    setActionLoading(null)
  }

  if (loading) return <div><AdminNav /><div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div></div>
  if (error) return <div><AdminNav /><div style={{ padding: 24 }}><div style={S.bannerErr}>{error}</div></div></div>
  if (!data) return null

  const { org, members, businesses, integrations, onboarding, support_notes, recent_alerts, ai_usage, data_health } = data

  // Derive stage like pipeline API
  const connected = integrations.filter((i: any) => i.status === 'connected')
  const lastSyncTs = integrations.map((i: any) => i.last_sync_at ? new Date(i.last_sync_at).getTime() : 0).reduce((a: number, b: number) => Math.max(a, b), 0)
  const lastSyncDays = lastSyncTs > 0 ? Math.floor((Date.now() - lastSyncTs) / 86400000) : null
  let stage: keyof typeof STAGE_META
  if (!org.is_active) stage = 'churned'
  else if (connected.length === 0) stage = 'new'
  else if (lastSyncTs === 0) stage = 'setup'
  else if (lastSyncDays !== null && lastSyncDays > 14) stage = 'at_risk'
  else stage = 'active'
  const stageMeta = STAGE_META[stage]

  const daysOnPlatform = Math.floor((Date.now() - new Date(org.created_at).getTime()) / 86400000)
  const trialDaysLeft = org.trial_end ? Math.floor((new Date(org.trial_end).getTime() - Date.now()) / 86400000) : null

  const setupRequested = onboarding?.step === 'setup_requested'
  const setupMeta = onboarding?.metadata ?? null

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />
      <div style={{ padding: '20px 32px', maxWidth: 1200, margin: '0 auto' }}>

      {/* Back link */}
      <div style={{ marginBottom: 12 }}>
        <a href="/admin/customers" style={{ fontSize: 13, color: '#6366f1', textDecoration: 'none' }}>← All customers</a>
      </div>

      {/* ═══════════════════════════════════════════════════════
          HEADER — name, plan, stage, quick actions
      ═══════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' as const }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' as const }}>
              <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>{org.name || 'Unnamed'}</h1>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 4, background: '#f3f4f6', color: '#374151', textTransform: 'uppercase' as const }}>{org.plan || 'trial'}</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 4, background: stageMeta.bg, color: stageMeta.color, border: `1px solid ${stageMeta.border}`, textTransform: 'uppercase' as const }}>
                {stageMeta.label}
              </span>
              {setupRequested && <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 4, background: '#fef3c7', color: '#d97706' }}>Setup requested</span>}
            </div>
            <div style={{ fontSize: 12, color: '#9ca3af' }}>
              {org.id} · Signed up {fmtDate(org.created_at)} · {daysOnPlatform}d on platform
              {trialDaysLeft !== null && (
                <> · Trial {trialDaysLeft > 0 ? `${trialDaysLeft}d left` : 'expired'}</>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
            <button onClick={startImpersonate} disabled={actionLoading === 'impersonate'} style={{ ...S.btnSec, background: '#ede9fe', color: '#6d28d9', borderColor: '#ddd6fe' }}>
              {actionLoading === 'impersonate' ? '…' : '✦ Impersonate'}
            </button>
            <button onClick={() => runAction('extend_trial', { days: 14 })} disabled={actionLoading === 'extend_trial'} style={S.btnSec}>
              {actionLoading === 'extend_trial' ? '…' : '+14d trial'}
            </button>
            <button onClick={() => runAction('toggle_active')} disabled={actionLoading === 'toggle_active'} style={{ ...S.btnSec, color: org.is_active ? '#dc2626' : '#15803d' }}>
              {actionLoading === 'toggle_active' ? '…' : org.is_active ? 'Deactivate' : 'Reactivate'}
            </button>
            {org.stripe_customer_id && (
              <a href={`https://dashboard.stripe.com/customers/${org.stripe_customer_id}`} target="_blank" rel="noreferrer" style={S.btnSec}>
                Stripe →
              </a>
            )}
          </div>
        </div>

        {/* Top-line stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginTop: 20 }}>
          <Stat label="Businesses" value={`${data_health.businesses_active} / ${data_health.businesses_total}`} />
          <Stat label="Integrations" value={`${connected.length} / ${integrations.length}`} />
          <Stat label="Last sync" value={lastSyncTs === 0 ? '—' : lastSyncDays === 0 ? 'today' : `${lastSyncDays}d ago`} />
          <Stat label="Staff shifts" value={data_health.staff_logs_total.toLocaleString('en-GB')} />
          <Stat label="Revenue rows" value={data_health.revenue_logs_total.toLocaleString('en-GB')} />
          <Stat label="AI today" value={ai_usage.today} />
          <Stat label="AI this month" value={ai_usage.month.toLocaleString('en-GB')} />
        </div>
      </div>

      {/* ═══════════════════════════════════════════════════════
          SETUP REQUEST (if present)
      ═══════════════════════════════════════════════════════ */}
      {setupMeta && (
        <div style={{ ...S.card, background: '#fffbeb', border: '1px solid #fde68a' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#d97706', marginBottom: 10 }}>
            Setup request {onboarding?.completed_at ? `· submitted ${fmt(onboarding.completed_at)}` : ''}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
            {[
              ['Restaurant',     setupMeta.restaurantName],
              ['City',           setupMeta.city],
              ['Staff system',   setupMeta.staffSystem],
              ['Accounting',     setupMeta.accounting],
              ['POS',            setupMeta.pos],
              ['Contact time',   setupMeta.contactTime],
              ['Phone',          setupMeta.phone],
              ['Customer email', setupMeta.userEmail],
            ].filter(([_, v]) => v).map(([k, v]) => (
              <div key={k as string}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 2 }}>{k}</div>
                <div style={{ fontSize: 13, color: '#111' }}>{v as string}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          TEAM MEMBERS
      ═══════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.sectionHead}>Team ({members.length})</div>
        {members.length === 0 ? (
          <div style={S.empty}>No members yet.</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr><th style={S.th('left')}>Email</th><th style={S.th('left')}>Role</th><th style={S.th('right')}>Joined</th><th style={S.th('right')}>Last sign-in</th><th style={S.th('right')}>Confirmed</th></tr>
            </thead>
            <tbody>
              {members.map((m: any, i: number) => (
                <tr key={i} style={{ borderTop: '1px solid #f3f4f6' }}>
                  <td style={S.td}>{m.email || '—'}</td>
                  <td style={S.td}>{m.role}</td>
                  <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{fmtDate(m.member_since)}</td>
                  <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>{m.last_sign_in ? fmt(m.last_sign_in) : '—'}</td>
                  <td style={{ ...S.td, textAlign: 'right' }}>{m.email_confirmed_at ? '✓' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════
          INTEGRATIONS
      ═══════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' as const, gap: 10 }}>
          <div style={S.sectionHead}>Integrations ({integrations.length})</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
            {businesses.map((b: any) => {
              const hasInzii = integrations.some((i: any) => i.business_id === b.id && (i.provider?.startsWith('inzii') || i.provider === 'swess'))
              return (
                <div key={b.id} style={{ display: 'inline-flex', gap: 4 }}>
                  <button onClick={() => setAddIntegModal({ business_id: b.id, business_name: b.name })} style={{ ...S.btnTiny, background: '#eef2ff', color: '#4f46e5', fontWeight: 700 }}>
                    + {b.name}
                  </button>
                  {hasInzii && (
                    <button onClick={() => setupDepartments(b.id, b.name)} disabled={actionLoading === 'setup_depts_' + b.id} style={{ ...S.btnTiny, background: '#f0fdf4', color: '#15803d', fontWeight: 700 }} title={`Auto-create department records for ${b.name} from its Inzii integrations`}>
                      {actionLoading === 'setup_depts_' + b.id ? '…' : `⚙ Setup depts · ${b.name}`}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Dept setup result banner */}
        {deptSetupResult && (
          <div style={{
            background: deptSetupResult.ok ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${deptSetupResult.ok ? '#bbf7d0' : '#fecaca'}`,
            borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12,
            color: deptSetupResult.ok ? '#15803d' : '#dc2626',
            display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>
                {deptSetupResult.ok ? '✓ ' : '✗ '} Setup departments · {deptSetupResult.businessName}
              </div>
              {deptSetupResult.ok ? (
                deptSetupResult.departments.length === 0 ? (
                  <div style={{ color: '#374151' }}>No Inzii departments found on this business — add them via + {deptSetupResult.businessName} first.</div>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 6 }}>
                    {deptSetupResult.departments.map((d: any) => (
                      <span key={d.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 9px', background: 'white', borderRadius: 4, border: '1px solid #e5e7eb', fontSize: 11, color: '#374151' }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.color || '#6b7280' }} /> {d.name}
                      </span>
                    ))}
                  </div>
                )
              ) : (
                <div style={{ color: '#dc2626', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{deptSetupResult.error}</div>
              )}
            </div>
            <button onClick={() => setDeptSetupResult(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#6b7280' }}>×</button>
          </div>
        )}

        {/* Discovery result banner */}
        {discoveryResult && (
          <div style={{
            background: discoveryResult.ok ? '#f0fdf4' : '#fef2f2',
            border: `1px solid ${discoveryResult.ok ? '#bbf7d0' : '#fecaca'}`,
            borderRadius: 8, padding: '10px 12px', marginBottom: 12, fontSize: 12,
            color: discoveryResult.ok ? '#15803d' : '#dc2626',
            display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, marginBottom: 3 }}>
                {discoveryResult.ok ? '✓ ' : '✗ '} Discovery · {discoveryResult.provider}
              </div>
              <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#374151', whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>
                {discoveryResult.response}
              </div>
            </div>
            <button onClick={() => setDiscoveryResult(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16, color: '#6b7280' }}>×</button>
          </div>
        )}

        {integrations.length === 0 ? (
          <div style={S.empty}>No integrations connected yet. Click a business name above to add one.</div>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th('left')}>Provider</th>
                <th style={S.th('left')}>Department</th>
                <th style={S.th('left')}>Business</th>
                <th style={S.th('left')}>Status</th>
                <th style={S.th('right')}>Last sync</th>
                <th style={S.th('left')}>Last error</th>
                <th style={S.th('right')}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {integrations.map((i: any) => {
                const biz = businesses.find((b: any) => b.id === i.business_id)
                const syncAgo = daysAgo(i.last_sync_at)
                const isEditing = editingKey?.id === i.id
                return (
                  <>
                    <tr key={i.id} style={{ borderTop: '1px solid #f3f4f6' }}>
                      <td style={{ ...S.td, fontWeight: 600, color: '#111' }}>{i.provider}</td>
                      <td style={S.td}>{i.department || '—'}</td>
                      <td style={{ ...S.td, color: '#6b7280' }}>{biz?.name || '—'}</td>
                      <td style={S.td}>
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                          background: i.status === 'connected' ? '#f0fdf4' : i.status === 'error' ? '#fef2f2' : '#f3f4f6',
                          color:      i.status === 'connected' ? '#15803d' : i.status === 'error' ? '#dc2626' : '#6b7280' }}>
                          {i.status}
                        </span>
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', color: '#6b7280' }}>
                        {syncAgo === null ? 'never' : syncAgo === 0 ? 'today' : `${syncAgo}d ago`}
                      </td>
                      <td style={{ ...S.td, color: '#dc2626', fontSize: 12, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={i.last_error || ''}>
                        {i.last_error ? i.last_error.slice(0, 50) : '—'}
                      </td>
                      <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' as const }}>
                        <div style={{ display: 'inline-flex', gap: 4 }}>
                          <button onClick={() => triggerSync(i.id)} disabled={actionLoading === 'sync_' + i.id} style={S.btnTiny} title="Trigger sync">
                            {actionLoading === 'sync_' + i.id ? '…' : 'Sync'}
                          </button>
                          <button onClick={() => setEditingKey({ id: i.id, provider: i.provider, department: i.department, business_id: i.business_id })} style={S.btnTiny} title="Update API key">
                            Edit
                          </button>
                          <button onClick={() => runDiscovery(i.id, i.provider)} disabled={actionLoading === 'discover_' + i.id} style={{ ...S.btnTiny, background: '#ede9fe', color: '#6d28d9', fontWeight: 700 }} title="Run Enhanced API Discovery">
                            {actionLoading === 'discover_' + i.id ? '…' : '✦ Discover'}
                          </button>
                          <button onClick={() => deleteIntegration(i.id, i.provider)} disabled={actionLoading === 'delete_' + i.id} style={{ ...S.btnTiny, background: '#fef2f2', color: '#dc2626' }} title="Delete integration">
                            {actionLoading === 'delete_' + i.id ? '…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {isEditing && (
                      <tr key={i.id + '-edit'} style={{ background: '#fafbff' }}>
                        <td colSpan={7} style={{ padding: '12px 14px' }}>
                          <KeyEditor
                            provider={i.provider}
                            department={i.department}
                            onSave={(newKey: string) => saveKey(i.id, newKey, i.provider, i.department, i.business_id)}
                            onCancel={() => setEditingKey(null)}
                            saving={actionLoading === 'save_' + i.id}
                          />
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
            </tbody>
          </table>
        )}

        {/* Link out to detailed discovery results page */}
        {integrations.length > 0 && (
          <div style={{ marginTop: 12, textAlign: 'right' as const }}>
            <a href="/admin/api-discoveries-enhanced" target="_blank" rel="noreferrer" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none', fontWeight: 600 }}>
              View all discovery results →
            </a>
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════
          RECENT ALERTS
      ═══════════════════════════════════════════════════════ */}
      {recent_alerts.length > 0 && (
        <div style={S.card}>
          <div style={S.sectionHead}>Recent alerts ({recent_alerts.length})</div>
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
            {recent_alerts.slice(0, 5).map((a: any, i: number) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, padding: '8px 10px', borderRadius: 6,
                background: a.severity === 'critical' ? '#fef2f2' : a.severity === 'warning' ? '#fffbeb' : '#f9fafb' }}>
                <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: 'white',
                  color: a.severity === 'critical' ? '#dc2626' : a.severity === 'warning' ? '#d97706' : '#6b7280',
                  textTransform: 'uppercase' as const }}>
                  {a.severity}
                </span>
                <span style={{ flex: 1, color: '#111' }}>{a.title}</span>
                <span style={{ color: '#9ca3af', fontSize: 11 }}>{fmt(a.created_at)}</span>
                {a.is_dismissed && <span style={{ color: '#9ca3af', fontSize: 11 }}>dismissed</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════
          AGENTS — toggle + run now
      ═══════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={S.sectionHead}>Agents</div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>Toggle to disable for this customer · "Run now" fires the cron immediately</div>
        </div>

        {/* Run result banner */}
        {runResult && (
          <div style={{
            background: runResult.ok ? '#f0fdf4' : '#fef2f2',
            border:    `1px solid ${runResult.ok ? '#bbf7d0' : '#fecaca'}`,
            borderRadius: 10, padding: '10px 14px', marginBottom: 12,
            fontSize: 12, color: runResult.ok ? '#15803d' : '#dc2626',
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10,
          }}>
            <div>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                {runResult.ok ? '✓ ' : '✗ '}
                Ran {runResult.agent}{runResult.scope ? ` · scope: ${runResult.scope}` : ''}
              </div>
              {runResult.note && <div style={{ color: '#6b7280' }}>{runResult.note}</div>}
              {runResult.error && <div>{runResult.error}</div>}
              {runResult.response && <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, marginTop: 4, color: '#374151' }}>{runResult.response}</div>}
            </div>
            <button onClick={() => setRunResult(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#6b7280' }}>×</button>
          </div>
        )}

        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th('left')}>Agent</th>
              <th style={S.th('left')}>Last run for this org</th>
              <th style={S.th('left')}>Scope</th>
              <th style={S.th('center')}>Enabled</th>
              <th style={S.th('right')}></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a: any) => (
              <tr key={a.key} style={{ borderTop: '1px solid #f3f4f6', opacity: a.blocked ? 0.55 : 1 }}>
                <td style={S.td}>
                  <div style={{ fontWeight: 600, color: '#111' }}>{a.name}</div>
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>{a.desc}</div>
                </td>
                <td style={{ ...S.td, color: '#6b7280' }}>{a.last_run ? fmt(a.last_run) : a.blocked ? '—' : 'never'}</td>
                <td style={S.td}>
                  <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                    background: a.scope === 'per-org' ? '#f0fdf4' : '#fffbeb',
                    color:      a.scope === 'per-org' ? '#15803d' : '#d97706' }}>
                    {a.scope === 'per-org' ? 'per-org' : 'global'}
                  </span>
                </td>
                <td style={{ ...S.td, textAlign: 'center' }}>
                  <button
                    onClick={() => toggleAgent(a.key, !a.enabled)}
                    disabled={actionLoading === 'toggle_' + a.key}
                    style={{
                      width: 38, height: 22, borderRadius: 11, border: 'none',
                      background: a.enabled ? '#15803d' : '#e5e7eb',
                      cursor: 'pointer', padding: 0, position: 'relative',
                      transition: 'background .15s',
                    }}
                    title={a.enabled ? 'Click to disable' : 'Click to enable'}
                  >
                    <span style={{
                      position: 'absolute', top: 2, left: a.enabled ? 18 : 2,
                      width: 18, height: 18, borderRadius: '50%', background: 'white',
                      boxShadow: '0 1px 2px rgba(0,0,0,0.2)', transition: 'left .15s',
                    }} />
                  </button>
                </td>
                <td style={{ ...S.td, textAlign: 'right' }}>
                  <button
                    onClick={() => runAgent(a.key)}
                    disabled={actionLoading === 'run_' + a.key || a.blocked}
                    style={{ ...S.btnTiny, opacity: a.blocked ? 0.5 : 1, cursor: a.blocked ? 'not-allowed' : 'pointer' }}
                  >
                    {actionLoading === 'run_' + a.key ? '…' : a.blocked ? 'Blocked' : 'Run now'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ═══════════════════════════════════════════════════════
          TIMELINE — unified event feed
      ═══════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={S.sectionHead}>Timeline</div>
          <div style={{ fontSize: 11, color: '#9ca3af' }}>{timeline.length} events · newest first</div>
        </div>
        {timeline.length === 0 ? (
          <div style={S.empty}>No events yet.</div>
        ) : (
          <div style={{ position: 'relative', paddingLeft: 20 }}>
            {/* Vertical spine */}
            <div style={{ position: 'absolute', left: 7, top: 4, bottom: 4, width: 1, background: '#e5e7eb' }} />

            {timeline.map((e: any, i: number) => (
              <div key={i} style={{ display: 'flex', gap: 12, marginBottom: 14, alignItems: 'flex-start', position: 'relative' }}>
                {/* Dot */}
                <div style={{
                  position: 'absolute', left: -20, top: 3,
                  width: 14, height: 14, borderRadius: '50%',
                  background: 'white', border: `2px solid ${e.color}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 8, fontWeight: 700, color: e.color,
                }} title={e.type}>
                  {e.icon}
                </div>

                {/* Content */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' as const }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{e.title}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', whiteSpace: 'nowrap' as const }}>{fmt(e.at)}</div>
                  </div>
                  {e.body && (
                    <div style={{ fontSize: 12, color: '#6b7280', marginTop: 3, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const }}>{e.body}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════
          SUPPORT NOTES (admin-only, internal)
      ═══════════════════════════════════════════════════════ */}
      <div style={S.card}>
        <div style={S.sectionHead}>Internal notes ({support_notes.length})</div>

        {/* Add new */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            value={noteDraft}
            onChange={e => setNoteDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !savingNote && addNote()}
            placeholder="Add a private note about this customer…"
            style={{ flex: 1, padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
          />
          <button onClick={addNote} disabled={!noteDraft.trim() || actionLoading === 'add_note'} style={S.btnPri}>
            {actionLoading === 'add_note' ? 'Adding…' : 'Add note'}
          </button>
        </div>

        {/* List */}
        {support_notes.length === 0 ? (
          <div style={S.empty}>No notes yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
            {support_notes.map((n: any) => (
              <div key={n.id} style={{ padding: '10px 12px', borderLeft: '3px solid #6366f1', background: '#fafbff', borderRadius: '0 6px 6px 0' }}>
                <div style={{ fontSize: 13, color: '#111', marginBottom: 3, whiteSpace: 'pre-wrap' as const }}>{n.note}</div>
                <div style={{ fontSize: 11, color: '#9ca3af' }}>{n.author || 'admin'} · {fmt(n.created_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════
          ADD INTEGRATION MODAL
      ═══════════════════════════════════════════════════════ */}
      {addIntegModal && (
        <AddIntegrationModal
          secret={secret}
          businessId={addIntegModal.business_id}
          businessName={addIntegModal.business_name}
          onClose={() => setAddIntegModal(null)}
          orgId={orgId}
          onSave={(provider: string, apiKey: string, department?: string) => saveKey('new', apiKey, provider, department, addIntegModal.business_id)}
          saving={actionLoading === 'save_new'}
        />
      )}

      {/* ═══════════════════════════════════════════════════════
          IMPERSONATE MODAL
      ═══════════════════════════════════════════════════════ */}
      {impersonate && (
        <div onClick={() => setImpersonate(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 560, padding: 0, overflow: 'hidden' }}>

            {/* Header */}
            <div style={{ padding: '18px 24px', background: 'linear-gradient(135deg, #6d28d9 0%, #8b5cf6 100%)', color: 'white' }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', opacity: 0.85 }}>Impersonate</div>
              <div style={{ fontSize: 17, fontWeight: 700, marginTop: 2 }}>Sign in as {impersonate.user_email}</div>
              <div style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>Role: {impersonate.role} · Expires in {impersonate.expires_in}</div>
            </div>

            {/* Body */}
            <div style={{ padding: '18px 24px' }}>

              <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: '10px 12px', fontSize: 12, color: '#78350f', marginBottom: 16, lineHeight: 1.5 }}>
                <strong>Use an incognito / private window.</strong> Opening this link in a regular window will overwrite your admin session cookie — you'll have to log back into admin afterwards. Incognito keeps admin and customer sessions separate.
              </div>

              {/* Primary: copy link */}
              <button
                onClick={() => {
                  navigator.clipboard.writeText(impersonate.action_link)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2500)
                }}
                style={{
                  width: '100%', padding: '12px', background: '#1a1f2e', color: 'white',
                  border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                  marginBottom: 10,
                }}
              >
                {copied ? '✓ Copied — now paste in an incognito window' : '1. Copy link'}
              </button>

              {/* Secondary: open in this tab (destructive to admin session) */}
              <a
                href={impersonate.action_link}
                target="_blank"
                rel="noreferrer"
                onClick={() => setImpersonate(null)}
                style={{
                  display: 'block', width: '100%', padding: '11px', background: '#f9fafb',
                  color: '#374151', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 12,
                  fontWeight: 600, cursor: 'pointer', textAlign: 'center', textDecoration: 'none',
                  marginBottom: 16,
                }}
              >
                Or: open in new tab (will replace your admin session)
              </a>

              {/* Raw link for manual copy */}
              <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>Magic link</div>
              <textarea
                readOnly
                value={impersonate.action_link}
                style={{ width: '100%', minHeight: 62, padding: '8px 10px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 11, fontFamily: 'ui-monospace, monospace', color: '#374151', resize: 'none' }}
                onFocus={e => e.currentTarget.select()}
              />
            </div>

            {/* Footer */}
            <div style={{ padding: '12px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => setImpersonate(null)} style={{ padding: '8px 16px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      </div>
    </div>
  )
}

// Modal for adding a new integration to a specific business.
function AddIntegrationModal({ secret, orgId, businessId, businessName, onClose, onSave, saving }: any) {
  const groups = groupedProviders()
  const [provider, setProvider] = useState('personalkollen')
  const [department, setDepartment] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)

  const selected = getProvider(provider)
  const isMultiDept = selected?.supports_multi_department ?? false
  const canTest = !!selected?.supported && apiKey.trim().length > 0
  const canSave = !!selected?.supported && apiKey.trim().length > 0 && (!isMultiDept || department.trim().length > 0)

  async function testConnection() {
    setTesting(true); setTestResult(null)
    try {
      const r = await fetch('/api/admin/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-secret': secret },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), org_id: orgId, business_id: businessId }),
      })
      const json = await r.json()
      setTestResult({ ok: r.ok && !json.error, ...json })
    } catch (e: any) {
      setTestResult({ ok: false, error: e.message })
    }
    setTesting(false)
  }

  // Clear stale test result when the key/provider changes
  function onKeyChange(v: string) { setApiKey(v); if (testResult) setTestResult(null) }
  function onProviderChange(v: string) { setProvider(v); if (testResult) setTestResult(null) }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 14, width: '100%', maxWidth: 480, padding: 0, overflow: 'hidden', maxHeight: '90vh', display: 'flex', flexDirection: 'column' as const }}>
        <div style={{ padding: '18px 24px', borderBottom: '1px solid #f3f4f6', flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase' as const, color: '#9ca3af' }}>Add integration</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginTop: 2 }}>{businessName}</div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
            {supportedCount()} built · {plannedCount()} on the roadmap
          </div>
        </div>

        <div style={{ padding: '18px 24px', overflowY: 'auto', flex: 1 }}>
          <div style={{ marginBottom: 14 }}>
            <label style={labelStyle}>Provider</label>
            <select value={provider} onChange={e => onProviderChange(e.target.value)} style={inputStyle}>
              {groups.map(g => (
                <optgroup key={g.category} label={g.label}>
                  {g.providers.map(p => (
                    <option key={p.key} value={p.key} disabled={!p.supported}>
                      {p.name}{!p.supported ? ' — coming soon' : ''}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {selected?.note && (
              <div style={{ fontSize: 11, color: '#d97706', marginTop: 4 }}>Note: {selected.note}</div>
            )}
            {selected && !selected.supported && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
                Adapter not built yet. Pick a different provider or <a href="mailto:paul@laweka.com?subject=Integration request" style={{ color: '#6366f1' }}>request this one</a>.
              </div>
            )}
          </div>

          {isMultiDept && (
            <div style={{ marginBottom: 14 }}>
              <label style={labelStyle}>Department</label>
              <input
                list="inzii-depts"
                value={department}
                onChange={e => setDepartment(e.target.value)}
                placeholder="e.g. Bella, Brus, Carne"
                style={inputStyle}
              />
              <datalist id="inzii-depts">
                {['Bella','Brus','Carne','Chilango','Ölbaren','Rosalis Select'].map(d => <option key={d} value={d} />)}
              </datalist>
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>Each department gets its own integration row.</div>
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <label style={labelStyle}>
              {selected?.auth_type === 'oauth2' ? 'OAuth token / access key' : 'API key'}
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={e => onKeyChange(e.target.value)}
              placeholder={selected?.supported ? 'Paste the key' : 'Select a supported provider first'}
              disabled={!selected?.supported}
              style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace', opacity: selected?.supported ? 1 : 0.5 }}
            />
          </div>

          {testResult && (
            <div style={{
              background: testResult.ok ? '#f0fdf4' : '#fef2f2',
              border: `1px solid ${testResult.ok ? '#bbf7d0' : '#fecaca'}`,
              borderRadius: 8, padding: '10px 12px', marginBottom: 16, fontSize: 12,
              color: testResult.ok ? '#15803d' : '#dc2626',
            }}>
              <div style={{ fontWeight: 700, marginBottom: testResult.ok ? 4 : 0 }}>
                {testResult.ok ? '✓ Connection successful' : `✗ ${testResult.error || 'Connection failed'}`}
              </div>
              {testResult.ok && (
                <div style={{ color: '#374151', fontSize: 11, display: 'flex', flexDirection: 'column' as const, gap: 2 }}>
                  {testResult.workplace_name && <div><span style={{ color: '#9ca3af' }}>Workplace:</span> {testResult.workplace_name}</div>}
                  {testResult.earliest_date && <div><span style={{ color: '#9ca3af' }}>Data from:</span> {testResult.earliest_date}</div>}
                  {typeof testResult.total_records === 'number' && <div><span style={{ color: '#9ca3af' }}>Records:</span> {testResult.total_records.toLocaleString('en-GB')}</div>}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ padding: '12px 24px', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 8, flexShrink: 0 }}>
          <button
            onClick={testConnection}
            disabled={!canTest || testing || saving}
            style={{ padding: '11px 14px', background: canTest ? '#eef2ff' : '#f3f4f6', color: canTest ? '#4f46e5' : '#9ca3af', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: canTest && !testing ? 'pointer' : 'not-allowed', whiteSpace: 'nowrap' as const }}
            title="Verify the API key works before saving"
          >
            {testing ? 'Testing…' : 'Test'}
          </button>
          <button
            onClick={() => onSave(provider, apiKey.trim(), isMultiDept ? department.trim() : undefined)}
            disabled={!canSave || saving}
            style={{ flex: 1, padding: 11, background: canSave ? '#1a1f2e' : '#e5e7eb', color: canSave ? 'white' : '#9ca3af', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: canSave && !saving ? 'pointer' : 'not-allowed' }}
          >
            {saving ? 'Saving…' : 'Save integration'}
          </button>
          <button onClick={onClose} style={{ padding: '11px 18px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', color: '#374151', marginBottom: 5 }
const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' }

// Inline key-replacement row shown below the integration when "Edit" is clicked.
function KeyEditor({ provider, department, onSave, onCancel, saving }: any) {
  const [key, setKey] = useState('')
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: '#6b7280' }}>
        New API key for {provider}{department ? ` · ${department}` : ''}:
      </span>
      <input
        type="password"
        value={key}
        onChange={e => setKey(e.target.value)}
        placeholder="Paste new key"
        style={{ flex: 1, minWidth: 220, padding: '7px 10px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, fontFamily: 'ui-monospace, monospace' }}
      />
      <button onClick={() => onSave(key)} disabled={!key.trim() || saving}
        style={{ padding: '7px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
        {saving ? '…' : 'Save'}
      </button>
      <button onClick={onCancel} style={{ padding: '7px 12px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
        Cancel
      </button>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: '#111' }}>{value}</div>
    </div>
  )
}

const S: Record<string, any> = {
  card:      { background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: '20px 24px', marginBottom: 14 },
  bannerErr: { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626' },
  sectionHead: { fontSize: 13, fontWeight: 700, color: '#111', marginBottom: 12 },
  empty:     { fontSize: 13, color: '#9ca3af', padding: '12px 0' },
  table:     { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th:        (align: 'left' | 'right' | 'center') => ({ padding: '8px 10px', textAlign: align, fontSize: 10, fontWeight: 700, color: '#9ca3af', textTransform: 'uppercase' as const, letterSpacing: '.05em', background: '#f9fafb' }),
  td:        { padding: '10px 10px', fontSize: 13 },
  btnSec:    { padding: '7px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', color: '#374151', textDecoration: 'none' },
  btnPri:    { padding: '9px 14px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer' },
  btnTiny:   { padding: '4px 10px', background: '#f3f4f6', color: '#374151', border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: 'pointer' },
}
