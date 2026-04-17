'use client'
// @ts-nocheck
// app/admin/customers/page.tsx — customer pipeline view.
// Replaces the flat org list in /admin. Shows lifecycle stages with filter tabs.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

const STAGE_META: Record<string, { label: string; color: string; bg: string; border: string; hint: string }> = {
  new:     { label: 'New',        color: '#6d28d9', bg: '#ede9fe', border: '#ddd6fe', hint: 'Signed up, no integration connected yet' },
  setup:   { label: 'In Setup',   color: '#d97706', bg: '#fffbeb', border: '#fde68a', hint: 'Integration connected, first sync pending' },
  active:  { label: 'Active',     color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0', hint: 'Synced in the last 14 days' },
  at_risk: { label: 'At Risk',    color: '#dc2626', bg: '#fef2f2', border: '#fecaca', hint: 'No sync in 14+ days, or payment failed' },
  churned: { label: 'Churned',    color: '#6b7280', bg: '#f9fafb', border: '#e5e7eb', hint: 'Deactivated / cancelled' },
}

const TABS = ['all','new','setup','active','at_risk','churned'] as const

export default function CustomersPipeline() {
  const router = useRouter()
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')
  const [filter,  setFilter]  = useState<string>('all')
  const [query,   setQuery]   = useState('')

  useEffect(() => {
    // /admin stores the password in sessionStorage after a successful POST /api/admin/auth.
    // That same password is the ADMIN_SECRET value used by our x-admin-secret header check.
    const secret = sessionStorage.getItem('admin_auth') ?? ''
    if (!secret) {
      router.push('/admin')
      return
    }
    fetch('/api/admin/customers', { headers: { 'x-admin-secret': secret } })
      .then(async r => {
        if (!r.ok) throw new Error(r.status === 401 ? 'Unauthorized — log in via /admin' : `HTTP ${r.status}`)
        return r.json()
      })
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [router])

  const customers = data?.customers ?? []
  const counts = data?.counts ?? { total: 0, new: 0, setup: 0, active: 0, at_risk: 0, churned: 0 }

  const filtered = customers.filter((c: any) => {
    if (filter !== 'all' && c.stage !== filter) return false
    if (query) {
      const q = query.toLowerCase()
      if (!c.name?.toLowerCase().includes(q) && !c.email?.toLowerCase().includes(q)) return false
    }
    return true
  })

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1400, margin: '0 auto' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24, gap: 16, flexWrap: 'wrap' as const }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Customers</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Pipeline view · every org grouped by lifecycle stage</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <a href="/admin" style={{ padding: '8px 14px', background: '#f3f4f6', color: '#374151', borderRadius: 8, fontSize: 13, fontWeight: 600, textDecoration: 'none' }}>← Legacy admin</a>
        </div>
      </div>

      {/* Stage counts as filter tabs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' as const }}>
        {TABS.map(tab => {
          const count = tab === 'all' ? counts.total : counts[tab as keyof typeof counts]
          const meta = tab === 'all' ? { label: 'All', color: '#111', bg: 'white', border: '#e5e7eb' } : STAGE_META[tab]
          const isActive = filter === tab
          return (
            <button
              key={tab}
              onClick={() => setFilter(tab)}
              style={{
                padding: '8px 14px', borderRadius: 8,
                background: isActive ? meta.bg : 'white',
                border: `1px solid ${isActive ? meta.border : '#e5e7eb'}`,
                color: meta.color, fontSize: 13, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6,
              }}
            >
              {meta.label}
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 10, background: isActive ? 'white' : '#f3f4f6', color: meta.color }}>
                {count}
              </span>
            </button>
          )
        })}

        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search name or email…"
          style={{ flex: 1, minWidth: 200, padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13 }}
        />
      </div>

      {loading ? (
        <div style={{ padding: 60, textAlign: 'center' as const, color: '#9ca3af' }}>Loading customers…</div>
      ) : error ? (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 12, padding: '14px 18px', fontSize: 13, color: '#dc2626' }}>
          {error}
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 48, textAlign: 'center' as const }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 6 }}>No customers in this view</div>
          <div style={{ fontSize: 13, color: '#6b7280' }}>Try a different tab or clear the search.</div>
        </div>
      ) : (
        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' as const }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f9fafb' }}>
                  <th style={th('left')}>Organisation</th>
                  <th style={th('left')}>Email</th>
                  <th style={th('right')}>Plan</th>
                  <th style={th('right')}>Stage</th>
                  <th style={th('right')}>On platform</th>
                  <th style={th('right')}>Integrations</th>
                  <th style={th('right')}>Last sync</th>
                  <th style={th('right')}>AI today</th>
                  <th style={th('center')}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c: any) => {
                  const meta = STAGE_META[c.stage] ?? STAGE_META.new
                  return (
                    <tr
                      key={c.id}
                      onClick={() => router.push(`/admin/customers/${c.id}`)}
                      style={{ borderTop: '1px solid #f3f4f6', cursor: 'pointer' }}
                      onMouseEnter={e => (e.currentTarget as HTMLTableRowElement).style.background = '#fafbff'}
                      onMouseLeave={e => (e.currentTarget as HTMLTableRowElement).style.background = 'white'}
                    >
                      <td style={td}>
                        <div style={{ fontWeight: 600, color: '#111' }}>{c.name || '—'}</div>
                        {c.setup_requested && (
                          <div style={{ fontSize: 11, color: '#d97706', marginTop: 2 }}>Setup requested</div>
                        )}
                      </td>
                      <td style={{ ...td, color: '#6b7280' }}>{c.email || '—'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: '#f3f4f6', color: '#374151', textTransform: 'uppercase' as const }}>
                          {c.plan || 'trial'}
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: 'right' }}>
                        <span title={meta.hint} style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                          {meta.label}
                        </span>
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{c.days_on_platform}d</td>
                      <td style={{ ...td, textAlign: 'right', color: c.has_integration_error ? '#dc2626' : '#374151' }}>
                        {c.integrations_connected}/{c.integrations_total}
                        {c.has_integration_error && <span style={{ marginLeft: 4 }}>⚠</span>}
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>
                        {c.last_sync_days_ago === null ? '—'
                          : c.last_sync_days_ago === 0 ? 'today'
                          : c.last_sync_days_ago === 1 ? '1d ago'
                          : `${c.last_sync_days_ago}d ago`}
                      </td>
                      <td style={{ ...td, textAlign: 'right', color: '#6b7280' }}>{c.ai_queries_today}</td>
                      <td style={{ ...td, textAlign: 'center', color: '#9ca3af' }}>›</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

const th: (align: 'left' | 'right' | 'center') => React.CSSProperties = (align) => ({
  padding: '10px 14px', textAlign: align, fontSize: 10, fontWeight: 700, color: '#9ca3af',
  textTransform: 'uppercase', letterSpacing: '.05em',
})
const td: React.CSSProperties = { padding: '12px 14px' }
