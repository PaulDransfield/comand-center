'use client'
// components/admin/v2/CustomerUsers.tsx
// Users sub-tab: organisation_members + auth.users data.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface UserRow {
  user_id: string
  role: string
  joined_at: string
  email: string | null
  last_sign_in_at: string | null
  created_at: string | null
  confirmed: boolean
}

interface UsersResponse {
  users: UserRow[]
  total: number
}

export function CustomerUsers({ orgId }: { orgId: string }) {
  const { data, loading, error } = useAdminData<UsersResponse>(`/api/admin/v2/customers/${orgId}/users`)

  if (loading) return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading users…</div>
  if (error)   return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {error}</div>
  if (!data || data.users.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>No users in this organisation.</div>
  }

  const now = Date.now()

  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
        <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
          <tr>
            <Th>Email</Th><Th>Role</Th><Th align="right">Last sign-in</Th><Th align="right">Joined</Th><Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {data.users.map(u => {
            const lastMs = u.last_sign_in_at ? new Date(u.last_sign_in_at).getTime() : 0
            const ageDays = lastMs > 0 ? Math.floor((now - lastMs) / 86_400_000) : null
            const stale = ageDays !== null && ageDays > 30
            return (
              <tr key={u.user_id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <Td>
                  <div style={{ fontWeight: 500, color: '#111' }}>{u.email ?? <span style={{ color: '#d1d5db' }}>—</span>}</div>
                  <code style={{ fontSize: 10, color: '#9ca3af', marginTop: 2, display: 'block' }}>{u.user_id.slice(0, 14)}…</code>
                </Td>
                <Td muted style={{ textTransform: 'uppercase' as const, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em' }}>{u.role}</Td>
                <Td muted align="right">
                  {ageDays === null ? <span style={{ color: '#d1d5db' }}>never</span>
                    : ageDays === 0 ? 'today'
                    : ageDays === 1 ? 'yesterday'
                    : `${ageDays}d ago`}
                </Td>
                <Td muted align="right">{fmtDate(u.joined_at)}</Td>
                <Td>
                  {!u.confirmed && <Pill tone="warn">UNCONFIRMED</Pill>}
                  {u.confirmed && stale && <Pill tone="warn">STALE</Pill>}
                  {u.confirmed && !stale && <Pill tone="good">OK</Pill>}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
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
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`
}
