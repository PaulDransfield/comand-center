'use client'
// @ts-nocheck
// app/admin/audit/page.tsx — admin action audit log viewer.
// Every mutation by an admin writes here via lib/admin/audit.ts.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AdminNav } from '@/components/admin/AdminNav'

const fmt = (s: string) => new Date(s).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })

const ACTION_COLOR: Record<string, string> = {
  hard_delete:            '#dc2626',
  impersonate:            '#6d28d9',
  integration_delete:     '#dc2626',
  integration_key_edit:   '#d97706',
  integration_add:        '#15803d',
  integration_test:       '#4f46e5',
  integration_sync:       '#4f46e5',
  discovery_run:          '#6d28d9',
  dept_setup:             '#15803d',
  agent_run:              '#4f46e5',
  agent_toggle:           '#d97706',
  master_sync:            '#4f46e5',
  extend_trial:           '#15803d',
  toggle_active:          '#d97706',
  note_add:               '#6b7280',
  set_feature_flag:       '#d97706',
  set_plan:               '#d97706',
  login:                  '#6b7280',
}

export default function AuditLogPage() {
  const router = useRouter()
  const [rows,         setRows]         = useState<any[]>([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')
  const [tableMissing, setTableMissing] = useState(false)
  const [tableHint,    setTableHint]    = useState('')
  const [filter,       setFilter]       = useState({ action: '', org: '' })

  useEffect(() => {
    const secret = sessionStorage.getItem('admin_auth') ?? ''
    if (!secret) { router.push('/admin/login?next=/admin/audit'); return }
    fetch('/api/admin/audit-log?limit=300', { headers: { 'x-admin-secret': secret } })
      .then(async r => {
        const body = await r.json().catch(() => ({}))
        if (r.ok) return body
        if (r.status === 401) throw 'Unauthorized'
        const msg = body?.error ? `${body.error}${body.code ? ` (${body.code})` : ''}` : `HTTP ${r.status}`
        throw msg
      })
      .then(d => {
        setRows(d.rows ?? [])
        if (d._table_missing) { setTableMissing(true); setTableHint(d._hint ?? '') }
      })
      .catch(e => setError(typeof e === 'string' ? e : (e?.message ?? 'Unknown error')))
      .finally(() => setLoading(false))
  }, [router])

  const filtered = rows.filter((r: any) => {
    if (filter.action && r.action !== filter.action) return false
    if (filter.org && !((r.org_name ?? '').toLowerCase().includes(filter.org.toLowerCase()))) return false
    return true
  })

  const actions = [...new Set(rows.map((r: any) => r.action))].sort()

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />

      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 32px' }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Audit log</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>
            Every admin action against customer data · last 300 · retained 2+ years for compliance
          </p>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' as const }}>
          <select
            value={filter.action}
            onChange={e => setFilter({ ...filter, action: e.target.value })}
            style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}
          >
            <option value="">All actions</option>
            {actions.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
          <input
            value={filter.org}
            onChange={e => setFilter({ ...filter, org: e.target.value })}
            placeholder="Filter by org name…"
            style={{ flex: 1, minWidth: 200, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
          />
          <div style={{ fontSize: 12, color: '#6b7280', alignSelf: 'center' as const, padding: '0 8px' }}>
            {filtered.length} of {rows.length}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div>
        ) : error ? (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', fontSize: 13, color: '#dc2626' }}>{error}</div>
        ) : tableMissing ? (
          <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 12, padding: '20px 22px', fontSize: 13, color: '#92400e' }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Audit log table not installed</div>
            <div style={{ marginBottom: 8 }}>{tableHint || 'Migration M010 hasn\'t been applied to this Supabase instance. Until then, no admin actions are being recorded — the audit log will be empty.'}</div>
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, background: 'white', border: '1px solid #fde68a', borderRadius: 6, padding: '8px 10px', color: '#374151' }}>
              Run: sql/M010-admin-audit-log.sql
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>
            No audit events match your filter.
          </div>
        ) : (
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{ overflowX: 'auto' as const }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#f9fafb' }}>
                    <th style={th('left')}>When</th>
                    <th style={th('left')}>Action</th>
                    <th style={th('left')}>Actor</th>
                    <th style={th('left')}>Org</th>
                    <th style={th('left')}>Target</th>
                    <th style={th('left')}>Payload</th>
                    <th style={th('left')}>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r: any) => {
                    const color = ACTION_COLOR[r.action] ?? '#6b7280'
                    return (
                      <tr key={r.id}
                          onClick={() => r.org_id && router.push(`/admin/customers/${r.org_id}`)}
                          style={{ borderTop: '1px solid #f3f4f6', cursor: r.org_id ? 'pointer' : 'default' }}>
                        <td style={{ ...td, color: '#6b7280', whiteSpace: 'nowrap' as const }}>{fmt(r.created_at)}</td>
                        <td style={td}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: 'white', color, border: `1px solid ${color}`, textTransform: 'uppercase' as const }}>
                            {r.action}
                          </span>
                        </td>
                        <td style={{ ...td, color: '#111' }}>{r.actor}</td>
                        <td style={{ ...td, color: '#111', fontWeight: 500 }}>{r.org_name ?? '—'}</td>
                        <td style={{ ...td, color: '#6b7280' }}>
                          {r.target_type ? `${r.target_type}${r.target_id ? `:${String(r.target_id).slice(0,8)}` : ''}` : '—'}
                        </td>
                        <td style={{ ...td, color: '#374151', fontFamily: 'ui-monospace, monospace', fontSize: 10, maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }} title={r.payload ? JSON.stringify(r.payload) : ''}>
                          {r.payload ? JSON.stringify(r.payload).slice(0, 80) : '—'}
                        </td>
                        <td style={{ ...td, color: '#9ca3af', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>{r.ip_address ?? '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const th = (align: 'left' | 'right' | 'center'): any => ({
  padding: '10px 14px', textAlign: align, fontSize: 10, fontWeight: 700, color: '#9ca3af',
  textTransform: 'uppercase', letterSpacing: '.05em',
})
const td: React.CSSProperties = { padding: '10px 14px', verticalAlign: 'top' as const }
