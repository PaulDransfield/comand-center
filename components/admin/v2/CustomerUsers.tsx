'use client'
// components/admin/v2/CustomerUsers.tsx
// Users sub-tab — list + add + edit + remove for organisation_members.
// Concierge model: paul provisions; customer emails to request changes.

import { useEffect, useState } from 'react'
import { adminFetch } from '@/lib/admin/v2/api-client'

interface UserRow {
  user_id:           string
  role:              string
  business_ids:      string[] | null
  can_view_finances: boolean
  invited_at:        string | null
  last_active_at:    string | null
  joined_at:         string
  email:             string | null
  last_sign_in_at:   string | null
  created_at:        string | null
  confirmed:         boolean
}

interface UsersResponse {
  users: UserRow[]
  total: number
}

interface BusinessLite { id: string; name: string }

export function CustomerUsers({ orgId }: { orgId: string }) {
  const [data,       setData]       = useState<UsersResponse | null>(null)
  const [businesses, setBusinesses] = useState<BusinessLite[]>([])
  const [loading,    setLoading]    = useState<boolean>(true)
  const [error,      setError]      = useState<string | null>(null)
  const [editing,    setEditing]    = useState<UserRow | null>(null)
  const [showAdd,    setShowAdd]    = useState<boolean>(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const j = await adminFetch<UsersResponse>(`/api/admin/v2/customers/${orgId}/users`)
      setData(j)
      // Pull businesses for the scope-checkbox list.
      const snap = await adminFetch<any>(`/api/admin/v2/customers/${orgId}/snapshot`).catch(() => null)
      if (snap?.businesses) {
        setBusinesses(snap.businesses.map((b: any) => ({ id: b.id, name: b.name })))
      }
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [orgId])

  async function removeMember(userId: string) {
    if (!confirm('Remove this member? They lose access immediately.')) return
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/users/${userId}`, { method: 'DELETE' })
      load()
    } catch (e: any) {
      alert(e?.message ?? 'Failed to remove')
    }
  }

  if (loading && !data) return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading users…</div>

  return (
    <div>
      {error && (
        <div style={{ marginBottom: 12, padding: '8px 12px', background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 7, fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button
          onClick={() => setShowAdd(true)}
          style={{
            padding: '7px 14px', background: '#1a1f2e', color: 'white',
            border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + Add member
        </button>
      </div>

      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
          <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
            <tr>
              <Th>Email</Th><Th>Role</Th><Th>Scope</Th><Th>Finance</Th>
              <Th align="right">Last sign-in</Th><Th>Status</Th><Th align="right">{' '}</Th>
            </tr>
          </thead>
          <tbody>
            {(data?.users ?? []).map(u => {
              const lastMs = u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0
              const ageDays = lastMs > 0 ? Math.floor((Date.now() - lastMs) / 86_400_000) : null
              const stale = ageDays !== null && ageDays > 30
              const scopeLabel = u.business_ids
                ? `${u.business_ids.length} biz${u.business_ids.length === 1 ? '' : 'es'}`
                : 'all'
              return (
                <tr key={u.user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <Td>
                    <div style={{ fontWeight: 500, color: '#111' }}>{u.email ?? <span style={{ color: '#d1d5db' }}>—</span>}</div>
                    <code style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, display: 'block' }}>{u.user_id.slice(0, 14)}…</code>
                  </Td>
                  <Td>
                    <RolePill role={u.role} />
                  </Td>
                  <Td muted>{u.role === 'owner' ? 'all' : scopeLabel}</Td>
                  <Td muted>{u.role === 'owner' ? 'yes' : (u.can_view_finances ? <span style={{ color: '#15803d', fontWeight: 500 }}>yes</span> : 'no')}</Td>
                  <Td muted align="right">
                    {ageDays === null ? <span style={{ color: '#d1d5db' }}>never</span>
                      : ageDays === 0 ? 'today'
                      : ageDays === 1 ? 'yesterday'
                      : `${ageDays}d ago`}
                  </Td>
                  <Td>
                    {!u.confirmed && <Pill tone="warn">UNCONFIRMED</Pill>}
                    {u.confirmed && stale && <Pill tone="warn">STALE</Pill>}
                    {u.confirmed && !stale && <Pill tone="good">OK</Pill>}
                  </Td>
                  <Td align="right">
                    <button onClick={() => setEditing(u)} style={btnInline}>Edit</button>
                    {u.role !== 'owner' && (
                      <button onClick={() => removeMember(u.user_id)} style={{ ...btnInline, color: '#b91c1c', marginLeft: 6 }}>Remove</button>
                    )}
                  </Td>
                </tr>
              )
            })}
            {(data?.users ?? []).length === 0 && (
              <tr><td colSpan={7} style={{ padding: 30, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>No members yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditModal
          orgId={orgId}
          member={editing}
          businesses={businesses}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load() }}
        />
      )}
      {showAdd && (
        <AddModal
          orgId={orgId}
          businesses={businesses}
          onClose={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); load() }}
        />
      )}
    </div>
  )
}

// ── Add member modal ────────────────────────────────────────────────────────

function AddModal({ orgId, businesses, onClose, onAdded }: {
  orgId: string
  businesses: BusinessLite[]
  onClose: () => void
  onAdded: () => void
}) {
  const [email,            setEmail]            = useState('')
  const [role,             setRole]             = useState<'owner' | 'manager'>('manager')
  const [scopeAll,         setScopeAll]         = useState<boolean>(true)
  const [scopeIds,         setScopeIds]         = useState<string[]>([])
  const [canViewFinances,  setCanViewFinances]  = useState<boolean>(false)
  const [saving,           setSaving]           = useState(false)
  const [error,            setError]            = useState<string | null>(null)
  const [success,          setSuccess]          = useState<string | null>(null)

  function toggleScope(id: string) {
    setScopeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function submit() {
    setError(null)
    if (!email.trim() || !email.includes('@')) {
      setError('Valid email required')
      return
    }
    setSaving(true)
    try {
      const r = await adminFetch<any>(`/api/admin/v2/customers/${orgId}/users`, {
        method:  'POST',
        body:    JSON.stringify({
          email,
          role,
          business_ids:      role === 'owner' ? null : (scopeAll ? null : scopeIds),
          can_view_finances: role === 'owner' ? true : canViewFinances,
        }),
      })
      setSuccess(`Member added. Password-reset email ${r?.reset_email_sent ? 'sent' : 'NOT sent (check Supabase auth + SMTP)'}.`)
      setTimeout(onAdded, 1200)
    } catch (e: any) {
      setError(e?.message ?? 'Add failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title="Add member" onClose={onClose}>
      <Field label="Email">
        <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="manager@vero.se" style={inputStyle} autoFocus />
      </Field>
      <Field label="Role">
        <select value={role} onChange={e => setRole(e.target.value as any)} style={inputStyle}>
          <option value="manager">manager — operations only</option>
          <option value="owner">owner — full access</option>
        </select>
      </Field>
      {role === 'manager' && (
        <>
          <Field label="Business scope">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={scopeAll} onChange={e => setScopeAll(e.target.checked)} />
              All businesses in the org
            </label>
            {!scopeAll && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7 }}>
                {businesses.map(b => (
                  <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={scopeIds.includes(b.id)} onChange={() => toggleScope(b.id)} />
                    {b.name}
                  </label>
                ))}
                {businesses.length === 0 && <div style={{ fontSize: 11, color: '#9ca3af' }}>No businesses to choose from.</div>}
              </div>
            )}
          </Field>
          <Field label="Finance pages">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={canViewFinances} onChange={e => setCanViewFinances(e.target.checked)} />
              Allow access to /tracker, /budget, /forecast, /overheads
            </label>
          </Field>
        </>
      )}

      {error && <div style={{ padding: '8px 10px', background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, marginTop: 8 }}>{error}</div>}
      {success && <div style={{ padding: '8px 10px', background: '#dcfce7', color: '#15803d', border: '1px solid #bbf7d0', borderRadius: 7, fontSize: 12, marginTop: 8 }}>{success}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} disabled={saving} style={btnSecondary}>Cancel</button>
        <button onClick={submit} disabled={saving} style={btnPrimary}>{saving ? 'Adding…' : 'Add member'}</button>
      </div>
    </ModalShell>
  )
}

// ── Edit member modal ──────────────────────────────────────────────────────

function EditModal({ orgId, member, businesses, onClose, onSaved }: {
  orgId: string
  member: UserRow
  businesses: BusinessLite[]
  onClose: () => void
  onSaved: () => void
}) {
  const [role,             setRole]             = useState<string>(member.role)
  const [scopeAll,         setScopeAll]         = useState<boolean>(member.business_ids == null)
  const [scopeIds,         setScopeIds]         = useState<string[]>(member.business_ids ?? [])
  const [canViewFinances,  setCanViewFinances]  = useState<boolean>(member.can_view_finances)
  const [saving,           setSaving]           = useState(false)
  const [error,            setError]            = useState<string | null>(null)

  function toggleScope(id: string) {
    setScopeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function submit() {
    setError(null)
    setSaving(true)
    try {
      await adminFetch<any>(`/api/admin/v2/customers/${orgId}/users/${member.user_id}`, {
        method:  'PATCH',
        body:    JSON.stringify({
          role,
          business_ids:      role === 'owner' ? null : (scopeAll ? null : scopeIds),
          can_view_finances: role === 'owner' ? true : canViewFinances,
        }),
      })
      onSaved()
    } catch (e: any) {
      setError(e?.message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalShell title={`Edit ${member.email ?? 'member'}`} onClose={onClose}>
      <Field label="Role">
        <select value={role} onChange={e => setRole(e.target.value)} style={inputStyle}>
          <option value="manager">manager — operations only</option>
          <option value="owner">owner — full access</option>
        </select>
      </Field>
      {role === 'manager' && (
        <>
          <Field label="Business scope">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, marginBottom: 8 }}>
              <input type="checkbox" checked={scopeAll} onChange={e => setScopeAll(e.target.checked)} />
              All businesses in the org
            </label>
            {!scopeAll && (
              <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4, padding: '6px 10px', border: '1px solid #e5e7eb', borderRadius: 7 }}>
                {businesses.map(b => (
                  <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={scopeIds.includes(b.id)} onChange={() => toggleScope(b.id)} />
                    {b.name}
                  </label>
                ))}
              </div>
            )}
          </Field>
          <Field label="Finance pages">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={canViewFinances} onChange={e => setCanViewFinances(e.target.checked)} />
              Allow access to /tracker, /budget, /forecast, /overheads
            </label>
          </Field>
        </>
      )}

      {error && <div style={{ padding: '8px 10px', background: '#fef2f2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, marginTop: 8 }}>{error}</div>}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button onClick={onClose} disabled={saving} style={btnSecondary}>Cancel</button>
        <button onClick={submit} disabled={saving} style={btnPrimary}>{saving ? 'Saving…' : 'Save'}</button>
      </div>
    </ModalShell>
  )
}

// ── Reusable bits ──────────────────────────────────────────────────────────

function ModalShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
      style={{ position: 'fixed' as const, inset: 0, background: 'rgba(17, 24, 39, 0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20 }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: 22, width: 480, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' as const }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#111', margin: '0 0 16px 0' }}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>{label}</label>
      {children}
    </div>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 14px', textAlign: (align ?? 'left') as any, fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{children}</th>
}
function Td({ children, muted, align, style }: { children: React.ReactNode; muted?: boolean; align?: 'left' | 'right'; style?: React.CSSProperties }) {
  return <td style={{ padding: '10px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111', textAlign: (align ?? 'left') as any, ...style }}>{children}</td>
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'good' | 'warn' | 'bad' }) {
  const t = { good: { bg: '#dcfce7', fg: '#15803d' }, warn: { bg: '#fef3c7', fg: '#92400e' }, bad: { bg: '#fef2f2', fg: '#b91c1c' } }[tone]
  return <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: t.bg, color: t.fg }}>{children}</span>
}
function RolePill({ role }: { role: string }) {
  const tone = role === 'owner' ? 'good' : role === 'manager' ? 'warn' : 'bad'
  return <Pill tone={tone}>{role.toUpperCase()}</Pill>
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7, fontSize: 13, color: '#111', boxSizing: 'border-box' as const,
}
const btnPrimary: React.CSSProperties = {
  padding: '8px 16px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 500, cursor: 'pointer',
}
const btnSecondary: React.CSSProperties = {
  padding: '8px 16px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, fontSize: 12, fontWeight: 500, color: '#374151', cursor: 'pointer',
}
const btnInline: React.CSSProperties = {
  padding: '4px 10px', background: 'transparent', border: 'none', fontSize: 11, fontWeight: 500, color: '#374151', cursor: 'pointer',
}
