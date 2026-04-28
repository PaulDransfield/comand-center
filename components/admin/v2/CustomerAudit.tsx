'use client'
// components/admin/v2/CustomerAudit.tsx
// Audit sub-tab — last 100 admin_audit_log rows scoped to this org.

import { useState } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface AuditEntry {
  id: string
  action: string
  actor: string
  target_type: string | null
  target_id: string | null
  payload: any
  ip_address: string | null
  user_agent: string | null
  created_at: string
}

interface AuditResponse {
  entries: AuditEntry[]
  total:   number
}

export function CustomerAudit({ orgId }: { orgId: string }) {
  const { data, loading, error } = useAdminData<AuditResponse>(`/api/admin/v2/customers/${orgId}/audit`)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  if (loading) return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading audit log…</div>
  if (error)   return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {error}</div>
  if (!data || data.entries.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>No admin actions recorded for this organisation yet.</div>
  }

  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '8px 14px', fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f3f4f6' }}>
        Last {data.total} entries · click row to expand payload
      </div>
      {data.entries.map(e => {
        const open = expanded.has(e.id)
        const isV2 = e.payload?.surface === 'admin_v2'
        return (
          <div key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
            <button
              onClick={() => toggle(e.id)}
              style={{
                width:        '100%',
                background:   open ? '#fafbfc' : 'white',
                border:       'none',
                padding:      '10px 14px',
                textAlign:    'left' as const,
                cursor:       'pointer',
                display:      'grid',
                gridTemplateColumns: '160px 1fr 100px 80px',
                gap:          12,
                alignItems:   'center',
                fontSize:     12,
              }}
            >
              <span style={{ color: '#9ca3af' }}>{fmtDateTime(e.created_at)}</span>
              <span>
                <span style={{ fontWeight: 500, color: '#111' }}>{e.action}</span>
                {isV2 && <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#4338ca', background: '#eef2ff', padding: '1px 4px', borderRadius: 3 }}>V2</span>}
                {e.payload?.reason && (
                  <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3, fontStyle: 'italic' as const, paddingLeft: 6, borderLeft: '2px solid #e5e7eb', overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
                    {e.payload.reason}
                  </div>
                )}
              </span>
              <span style={{ color: '#6b7280' }}>{e.actor}</span>
              <span style={{ color: '#9ca3af', textAlign: 'right' as const, fontSize: 11 }}>{open ? '▾' : '▸'}</span>
            </button>
            {open && (
              <div style={{ padding: '10px 14px 12px 14px', background: '#fafbfc', borderTop: '1px solid #f3f4f6' }}>
                <pre style={{ margin: 0, fontSize: 11, color: '#374151', fontFamily: 'ui-monospace, monospace', overflow: 'auto' as const, maxHeight: 360 }}>
                  {JSON.stringify({
                    target_type: e.target_type,
                    target_id:   e.target_id,
                    ip_address:  e.ip_address,
                    user_agent:  e.user_agent,
                    payload:     e.payload,
                  }, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
