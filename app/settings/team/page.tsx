'use client'
// app/settings/team/page.tsx
//
// Owner-facing team management. Lists current members of the org and
// lets the owner invite a manager or revisor by email. Removes the
// "Paul-provisions-via-admin" friction we hit when first wiring the
// revisor view.
//
// Auth: owner only via /api/settings/team. Manager/revisor opening this
// page get 401 from the API and we render the "no access" empty state.

import { useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import { UXP } from '@/lib/constants/tokens'

interface Member {
  user_id:           string
  email:             string | null
  full_name:         string | null
  role:              'owner' | 'manager' | 'revisor' | 'viewer'
  business_ids:      string[] | null
  business_names:    string[] | null
  can_view_finances: boolean
  invited_at:        string | null
  last_active_at:    string | null
  joined_at:         string | null
  is_self:           boolean
}

interface BusinessLite { id: string; name: string }

export default function TeamPage() {
  const [members,     setMembers]     = useState<Member[]>([])
  const [businesses,  setBusinesses]  = useState<BusinessLite[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState('')
  const [showInvite,  setShowInvite]  = useState(false)
  const [inviteRole,  setInviteRole]  = useState<'manager' | 'revisor'>('revisor')

  async function loadAll() {
    setLoading(true)
    try {
      const [r1, r2] = await Promise.all([
        fetch('/api/settings/team',  { cache: 'no-store' }),
        fetch('/api/businesses?all=true', { cache: 'no-store' }),
      ])
      if (!r1.ok) {
        const j = await r1.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${r1.status}`)
      }
      const j1 = await r1.json()
      const j2 = await r2.json().catch(() => [])
      setMembers(j1.members ?? [])
      setBusinesses(Array.isArray(j2) ? j2 : [])
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadAll() }, [])

  async function remove(memberId: string) {
    if (!confirm('Remove this member? They\'ll lose access immediately.')) return
    try {
      const r = await fetch(`/api/settings/team/${memberId}`, { method: 'DELETE' })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${r.status}`)
      }
      await loadAll()
    } catch (e: any) {
      setError(e.message)
    }
  }

  return (
    <AppShell>
      <PageContainer maxWidth={900}>
        <div style={{ marginBottom: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 600, color: UXP.ink1, margin: 0 }}>
              Team & access
            </h1>
            <p style={{ fontSize: 13, color: UXP.ink3, marginTop: 4, lineHeight: 1.5 }}>
              Invite managers (operations access) or your revisor (read-only month-end view).
              Each invite sends a branded email; the recipient sets their own password.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => { setInviteRole('manager'); setShowInvite(true) }}
              style={btnStyle('secondary')}
            >
              + Invite manager
            </button>
            <button
              onClick={() => { setInviteRole('revisor'); setShowInvite(true) }}
              style={btnStyle('primary')}
            >
              + Invite revisor
            </button>
          </div>
        </div>

        {error   && <Banner tone="bad" text={error} onClose={() => setError('')} />}
        {loading && <Empty text="Loading team…" />}

        {!loading && members.length > 0 && (
          <MembersTable members={members} onRemove={remove} />
        )}

        {showInvite && (
          <InviteModal
            initialRole={inviteRole}
            businesses={businesses}
            onClose={() => setShowInvite(false)}
            onInvited={() => { setShowInvite(false); loadAll() }}
          />
        )}
      </PageContainer>
    </AppShell>
  )
}

// ─── Members table ───────────────────────────────────────────────────

function MembersTable({ members, onRemove }: { members: Member[]; onRemove: (id: string) => void }) {
  return (
    <div style={{
      background:   UXP.cardBg,
      border:       `1px solid ${UXP.border}`,
      borderRadius: 10,
      overflow:     'hidden' as const,
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
        <thead>
          <tr style={{ background: UXP.pageBg, color: UXP.ink3 }}>
            <th style={th()}>Email</th>
            <th style={th()}>Role</th>
            <th style={th()}>Scope</th>
            <th style={th()}>Joined</th>
            <th style={th()}></th>
          </tr>
        </thead>
        <tbody>
          {members.map(m => (
            <tr key={m.user_id} style={{ borderTop: `0.5px solid ${UXP.border}` }}>
              <td style={td()}>
                <div style={{ fontWeight: 500, color: UXP.ink1 }}>{m.email ?? <em style={{ color: UXP.ink4 }}>no email</em>}</div>
                {m.full_name && <div style={{ fontSize: 11, color: UXP.ink4 }}>{m.full_name}</div>}
                {m.is_self  && <div style={{ fontSize: 10, color: UXP.ink4, fontStyle: 'italic' }}>that's you</div>}
              </td>
              <td style={td()}><RolePill role={m.role} /></td>
              <td style={td()}>
                {m.role === 'owner' ? <span style={{ color: UXP.ink3 }}>All</span>
                 : m.business_names && m.business_names.length > 0
                   ? <span style={{ color: UXP.ink2 }}>{m.business_names.join(', ')}</span>
                   : <span style={{ color: UXP.ink3 }}>All</span>}
              </td>
              <td style={{ ...td(), color: UXP.ink3, fontSize: 12 }}>
                {m.joined_at ? formatDate(m.joined_at) : '—'}
              </td>
              <td style={{ ...td(), textAlign: 'right' as const }}>
                {!m.is_self && m.role !== 'owner' && (
                  <button
                    onClick={() => onRemove(m.user_id)}
                    style={{
                      padding: '4px 10px', fontSize: 11, fontWeight: 500,
                      background: 'white', color: UXP.roseText,
                      border: `1px solid ${UXP.rose}`, borderRadius: 6,
                      cursor: 'pointer',
                    }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ─── Invite modal ────────────────────────────────────────────────────

function InviteModal({
  initialRole, businesses, onClose, onInvited,
}: {
  initialRole: 'manager' | 'revisor'
  businesses:  BusinessLite[]
  onClose:     () => void
  onInvited:   () => void
}) {
  const [email,    setEmail]    = useState('')
  const [role,     setRole]     = useState<'manager' | 'revisor'>(initialRole)
  const [scopeIds, setScopeIds] = useState<string[]>([])
  const [scopeAll, setScopeAll] = useState<boolean>(false)
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState<string | null>(null)
  const [success,  setSuccess]  = useState<string | null>(null)

  function toggleScope(id: string) {
    setScopeIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id])
  }

  async function submit() {
    setError(null); setSuccess(null)
    if (!email.trim() || !email.includes('@')) {
      setError('Valid email required.')
      return
    }
    if (role === 'revisor' && scopeIds.length === 0) {
      setError('Revisor invites must be scoped to at least one business.')
      return
    }
    setSaving(true)
    try {
      const r = await fetch('/api/settings/team', {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email,
          role,
          business_ids: role === 'manager' && scopeAll ? null : scopeIds,
        }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${r.status}`)
      }
      const j = await r.json()
      setSuccess(j.email_sent
        ? `Invite sent to ${email}.`
        : `Member added but invite email failed: ${j.email_error}. They can still set a password via /reset-password.`)
      setTimeout(() => onInvited(), 1500)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{
      position:     'fixed' as const,
      inset:        0,
      background:   'rgba(15, 23, 42, 0.55)',
      display:      'flex',
      alignItems:   'center',
      justifyContent: 'center',
      zIndex:       1000,
      padding:      20,
    }}>
      <div style={{
        background:   'white',
        borderRadius: 12,
        padding:      24,
        width:        '100%',
        maxWidth:     480,
        boxShadow:    '0 20px 40px rgba(0,0,0,0.2)',
      }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: UXP.ink1, margin: 0, marginBottom: 16 }}>
          Invite a team member
        </h2>

        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="namn@firma.se"
            autoFocus
            style={inputStyle}
          />
        </Field>

        <Field label="Role">
          <select value={role} onChange={e => setRole(e.target.value as any)} style={inputStyle}>
            <option value="revisor">Revisor — read-only month-end view</option>
            <option value="manager">Manager — operations access (no finance/settings)</option>
          </select>
        </Field>

        {role === 'manager' && (
          <Field label="Scope">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={scopeAll}
                onChange={e => setScopeAll(e.target.checked)}
              />
              All businesses in this org
            </label>
            {!scopeAll && (
              <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
                {businesses.map(b => (
                  <label key={b.id} style={chipStyle(scopeIds.includes(b.id))}>
                    <input
                      type="checkbox"
                      checked={scopeIds.includes(b.id)}
                      onChange={() => toggleScope(b.id)}
                      style={{ marginRight: 6 }}
                    />
                    {b.name}
                  </label>
                ))}
              </div>
            )}
          </Field>
        )}

        {role === 'revisor' && (
          <Field label="Which businesses can they see?">
            <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
              {businesses.map(b => (
                <label key={b.id} style={chipStyle(scopeIds.includes(b.id))}>
                  <input
                    type="checkbox"
                    checked={scopeIds.includes(b.id)}
                    onChange={() => toggleScope(b.id)}
                    style={{ marginRight: 6 }}
                  />
                  {b.name}
                </label>
              ))}
            </div>
            <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 6 }}>
              Revisor invites require at least one business in scope.
            </div>
          </Field>
        )}

        {error   && <Banner tone="bad"  text={error} />}
        {success && <Banner tone="good" text={success} />}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
          <button onClick={onClose} disabled={saving} style={btnStyle('secondary')}>Cancel</button>
          <button onClick={submit}  disabled={saving} style={btnStyle('primary')}>
            {saving ? 'Inviting…' : 'Send invite'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Atoms ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

function RolePill({ role }: { role: string }) {
  const TONE: Record<string, { bg: string; color: string }> = {
    owner:   { bg: UXP.lavFill, color: UXP.lavText },
    manager: { bg: UXP.lavFill, color: UXP.coral },
    revisor: { bg: UXP.lavFill, color: UXP.lavDeep },
    viewer:  { bg: UXP.subtleBg, color: UXP.ink2 },
  }
  const t = TONE[role] ?? TONE.viewer
  return (
    <span style={{
      display:      'inline-block',
      padding:      '2px 8px',
      fontSize:     10,
      fontWeight:   700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase' as const,
      background:   t.bg,
      color:        t.color,
      borderRadius: 3,
    }}>
      {role}
    </span>
  )
}

function Banner({ tone, text, onClose }: { tone: 'good' | 'warn' | 'bad'; text: string; onClose?: () => void }) {
  const T = {
    good: { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep },
    warn: { bg: UXP.lavFill, border: UXP.lavMid, fg: UXP.coral },
    bad:  { bg: UXP.roseFill, border: UXP.rose, fg: UXP.roseText },
  }[tone]
  return (
    <div style={{
      margin: '10px 0', padding: '10px 14px',
      background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8,
      fontSize: 12, color: T.fg,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span>{text}</span>
      {onClose && (
        <button onClick={onClose} style={{ background: 'none', border: 'none', color: T.fg, cursor: 'pointer', fontSize: 14 }}>×</button>
      )}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: 40, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>{text}</div>
}

function th(): React.CSSProperties {
  return { padding: '10px 12px', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, textAlign: 'left' as const }
}
function td(): React.CSSProperties {
  return { padding: '10px 12px', verticalAlign: 'middle' as const }
}

const inputStyle: React.CSSProperties = {
  width:        '100%',
  padding:      '8px 12px',
  fontSize:     13,
  border:       `1px solid ${UXP.border}`,
  borderRadius: 7,
  background:   UXP.cardBg,
  color:        UXP.ink1,
  boxSizing:    'border-box' as const,
}

function btnStyle(variant: 'primary' | 'secondary'): React.CSSProperties {
  if (variant === 'primary') {
    return {
      padding: '6px 14px', fontSize: 12, fontWeight: 600,
      background: UXP.ink1, color: 'white',
      border: 'none', borderRadius: 7,
      cursor: 'pointer',
    }
  }
  return {
    padding: '6px 14px', fontSize: 12, fontWeight: 500,
    background: 'white', color: UXP.ink2,
    border: `1px solid ${UXP.border}`, borderRadius: 7,
    cursor: 'pointer',
  }
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    display:      'inline-flex',
    alignItems:   'center',
    padding:      '5px 10px',
    fontSize:     12,
    background:   active ? UXP.lavFill : 'white',
    color:        active ? UXP.lavDeep : UXP.ink2,
    border:       `1px solid ${active ? UXP.lavDeep : UXP.border}`,
    borderRadius: 6,
    cursor:       'pointer',
  }
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  } catch { return iso }
}
