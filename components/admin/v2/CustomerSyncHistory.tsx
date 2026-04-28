'use client'
// components/admin/v2/CustomerSyncHistory.tsx
// Sync history sub-tab: last 50 sync_log rows for this org.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface SyncRow {
  id: string
  provider: string
  status: string
  records_synced: number | null
  date_from: string | null
  date_to: string | null
  error_msg: string | null
  duration_ms: number | null
  created_at: string
}

interface SyncResponse {
  logs: SyncRow[]
  total: number
}

export function CustomerSyncHistory({ orgId }: { orgId: string }) {
  const { data, loading, error } = useAdminData<SyncResponse>(`/api/admin/v2/customers/${orgId}/sync_history`)

  if (loading) return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading sync history…</div>
  if (error)   return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {error}</div>
  if (!data || data.logs.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>No sync runs recorded yet.</div>
  }

  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '8px 14px', fontSize: 11, color: '#6b7280', borderBottom: '1px solid #f3f4f6' }}>
        Last {data.total} runs · newest first
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
        <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
          <tr>
            <Th align="right">When</Th><Th>Provider</Th><Th>Status</Th><Th align="right">Records</Th><Th align="right">Duration</Th><Th>Window</Th><Th>Error</Th>
          </tr>
        </thead>
        <tbody>
          {data.logs.map(l => (
            <tr key={l.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
              <Td align="right" muted>{fmtDateTime(l.created_at)}</Td>
              <Td><span style={{ fontWeight: 500, color: '#111', textTransform: 'capitalize' as const }}>{l.provider}</span></Td>
              <Td>
                {l.status === 'success' ? <Pill tone="good">OK</Pill>
                  : l.status === 'error' ? <Pill tone="bad">ERROR</Pill>
                  : <Pill tone="neutral">{l.status.toUpperCase()}</Pill>}
              </Td>
              <Td align="right" muted>{l.records_synced != null ? l.records_synced.toLocaleString('en-GB').replace(/,/g, ' ') : '—'}</Td>
              <Td align="right" muted>{l.duration_ms != null ? `${(l.duration_ms / 1000).toFixed(1)}s` : '—'}</Td>
              <Td muted>{l.date_from && l.date_to ? `${l.date_from} → ${l.date_to}` : '—'}</Td>
              <Td>
                {l.error_msg ? (
                  <div style={{ fontSize: 11, color: '#b91c1c', maxWidth: 320, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }} title={l.error_msg}>
                    {l.error_msg}
                  </div>
                ) : <span style={{ color: '#d1d5db' }}>—</span>}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 14px', textAlign: (align ?? 'left') as any, fontSize: 11, fontWeight: 600, color: '#6b7280', whiteSpace: 'nowrap' as const }}>{children}</th>
}
function Td({ children, muted, align }: { children: React.ReactNode; muted?: boolean; align?: 'left' | 'right' }) {
  return <td style={{ padding: '10px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111', textAlign: (align ?? 'left') as any, whiteSpace: 'nowrap' as const }}>{children}</td>
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'neutral' }) {
  const t = { good: { bg: '#dcfce7', fg: '#15803d' }, bad: { bg: '#fef2f2', fg: '#b91c1c' }, neutral: { bg: '#f3f4f6', fg: '#6b7280' } }[tone]
  return <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: t.bg, color: t.fg }}>{children}</span>
}
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
