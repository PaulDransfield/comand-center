'use client'
// components/admin/v2/CustomerIntegrations.tsx
//
// Integrations sub-tab. Per-integration: provider, status, last sync,
// health pill, last error if any.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface IntegrationRow {
  id: string
  business_id: string
  business_name: string
  provider: string
  status: string
  last_sync_at: string | null
  last_sync_age_days: number | null
  last_error: string | null
  reauth_notified_at: string | null
  created_at: string
  health: 'ok' | 'warn' | 'critical'
  backfill_status: 'pending' | 'running' | 'completed' | 'failed' | 'idle' | null
  backfill_progress: any
  backfill_error: string | null
  backfill_started_at: string | null
  backfill_finished_at: string | null
}

const BACKFILL_BADGE: Record<string, { bg: string; fg: string; label: string }> = {
  pending:   { bg: '#eff6ff', fg: '#1d4ed8', label: 'BACKFILL PENDING' },
  running:   { bg: '#fef3c7', fg: '#92400e', label: 'BACKFILL RUNNING' },
  completed: { bg: '#dcfce7', fg: '#15803d', label: 'BACKFILL DONE' },
  failed:    { bg: '#fef2f2', fg: '#b91c1c', label: 'BACKFILL FAILED' },
}

interface IntegrationsResponse {
  integrations: IntegrationRow[]
  total:        number
}

const HEALTH: Record<string, { bg: string; fg: string; label: string }> = {
  ok:       { bg: '#dcfce7', fg: '#15803d', label: 'OK' },
  warn:     { bg: '#fef3c7', fg: '#92400e', label: 'WARN' },
  critical: { bg: '#fef2f2', fg: '#b91c1c', label: 'CRITICAL' },
}

export function CustomerIntegrations({ orgId }: { orgId: string }) {
  const { data, loading, error } = useAdminData<IntegrationsResponse>(`/api/admin/v2/customers/${orgId}/integrations`)

  if (loading) return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading integrations…</div>
  if (error)   return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {error}</div>
  if (!data || data.integrations.length === 0) {
    return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10 }}>No integrations configured.</div>
  }

  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
        <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
          <tr>
            <Th>Provider</Th>
            <Th>Business</Th>
            <Th>Status</Th>
            <Th align="right">Last sync</Th>
            <Th>Health</Th>
            <Th>Notes</Th>
          </tr>
        </thead>
        <tbody>
          {data.integrations.map(i => {
            const h = HEALTH[i.health]
            return (
              <tr key={i.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                <Td><span style={{ fontWeight: 500, color: '#111', textTransform: 'capitalize' as const }}>{i.provider}</span></Td>
                <Td muted>{i.business_name}</Td>
                <Td muted style={{ textTransform: 'uppercase' as const, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em' }}>{i.status}</Td>
                <Td muted align="right">
                  {i.last_sync_age_days === null ? 'never'
                    : i.last_sync_age_days === 0 ? 'today'
                    : i.last_sync_age_days === 1 ? 'yesterday'
                    : `${i.last_sync_age_days}d ago`}
                  {i.last_sync_at && (
                    <div style={{ fontSize: 10, color: '#9ca3af' }}>{fmtDateTime(i.last_sync_at)}</div>
                  )}
                </Td>
                <Td>
                  <span style={{
                    fontSize:     9,
                    fontWeight:   700,
                    letterSpacing:'0.06em',
                    padding:      '2px 6px',
                    borderRadius: 3,
                    background:   h.bg,
                    color:        h.fg,
                  }}>{h.label}</span>
                </Td>
                <Td>
                  {i.last_error && (
                    <div style={{ fontSize: 11, color: '#b91c1c', maxWidth: 280, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }} title={i.last_error}>
                      {i.last_error}
                    </div>
                  )}
                  {!i.last_error && i.reauth_notified_at && (
                    <div style={{ fontSize: 11, color: '#92400e' }}>
                      Re-auth notified {fmtDate(i.reauth_notified_at)}
                    </div>
                  )}
                  {i.backfill_status && BACKFILL_BADGE[i.backfill_status] && (() => {
                    const b = BACKFILL_BADGE[i.backfill_status as string]
                    const p = i.backfill_progress ?? {}
                    const detail = i.backfill_status === 'running'
                      ? `${p.months_done ?? p.months_written ?? 0}/${p.months_total ?? 12} months`
                      : i.backfill_status === 'completed'
                        ? `${p.months_written ?? 0} written${p.months_skipped_pdf ? ` · ${p.months_skipped_pdf} skipped (PDF)` : ''}`
                        : i.backfill_status === 'failed'
                          ? (i.backfill_error?.slice(0, 60) ?? 'see logs')
                          : null
                    return (
                      <div style={{ marginTop: i.last_error || i.reauth_notified_at ? 4 : 0 }}>
                        <span style={{
                          fontSize:      9,
                          fontWeight:    700,
                          letterSpacing: '0.06em',
                          padding:       '2px 6px',
                          borderRadius:  3,
                          background:    b.bg,
                          color:         b.fg,
                        }}>{b.label}</span>
                        {detail && <span style={{ fontSize: 11, color: '#6b7280', marginLeft: 6 }}>{detail}</span>}
                      </div>
                    )
                  })()}
                  {!i.last_error && !i.reauth_notified_at && !i.backfill_status && (
                    <span style={{ color: '#d1d5db' }}>—</span>
                  )}
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
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${fmtDate(iso)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
