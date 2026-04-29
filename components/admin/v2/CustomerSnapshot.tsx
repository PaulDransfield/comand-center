'use client'
// components/admin/v2/CustomerSnapshot.tsx
//
// Snapshot sub-tab: KPIs + business list + recent uploads + recent
// admin actions. Pulls from /api/admin/v2/customers/[orgId]/snapshot.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'
import { KpiStrip } from './KpiStrip'
import type { KpiStat } from '@/lib/admin/v2/types'

interface SnapshotResponse {
  org: {
    id: string; name: string; plan: string; is_active: boolean
    trial_end: string | null; created_at: string
    billing_email: string | null
    stripe_customer_id: string | null; stripe_subscription_id: string | null
    mrr_sek: number
    org_number: string | null
    org_number_set_at: string | null
    org_number_grace_started_at: string | null
  }
  businesses: Array<{ id: string; name: string; city: string | null; is_active: boolean; created_at: string }>
  recent_uploads: Array<{ id: string; business_id: string; doc_type: string; status: string; period_year: number; period_month: number | null; applied_at: string | null; created_at: string }>
  recent_audit:   Array<{ action: string; actor: string; target_type: string | null; target_id: string | null; payload: any; created_at: string }>
  ai: { queries_today: number; daily_cap: number | null; pct_of_cap: number | null; monthly_cost_sek: number }
}

export function CustomerSnapshot({ orgId, onLoaded }: { orgId: string; onLoaded?: (snap: SnapshotResponse) => void }) {
  const { data, loading, error } = useAdminData<SnapshotResponse>(`/api/admin/v2/customers/${orgId}/snapshot`)

  // Surface the loaded snapshot to the parent (used by the header
  // before its own data is shaped). One-shot via onLoaded.
  if (data && onLoaded) onLoaded(data)

  if (loading) return <Loading text="Loading snapshot…" />
  if (error)   return <ErrorBox text={error} />
  if (!data)   return <Loading text="No data" />

  // Org-nr grace state — same math as /api/settings/company-info but
  // computed client-side from the snapshot data so we don't need a
  // second round-trip.
  const orgNrFmt = data.org.org_number
    ? `${data.org.org_number.slice(0, 6)}-${data.org.org_number.slice(6)}`
    : null
  const graceStarted = data.org.org_number_grace_started_at
    ? new Date(data.org.org_number_grace_started_at).getTime()
    : 0
  const graceEnds = graceStarted + 30 * 24 * 60 * 60 * 1000
  const graceExpired = !data.org.org_number && graceStarted > 0 && Date.now() >= graceEnds
  const orgNrTone: KpiStat['tone'] = data.org.org_number
    ? 'good'
    : graceExpired ? 'bad' : 'warn'
  const orgNrSub = data.org.org_number
    ? (data.org.org_number_set_at ? `set ${fmtDate(data.org.org_number_set_at)}` : 'set')
    : graceExpired
      ? 'grace expired'
      : `${Math.max(0, Math.ceil((graceEnds - Date.now()) / (24 * 60 * 60 * 1000)))} days remaining`

  const kpis: KpiStat[] = [
    { label: 'MRR',           value: data.org.mrr_sek > 0 ? `${data.org.mrr_sek.toLocaleString('en-GB').replace(/,/g, ' ')} kr` : '—', tone: 'good' },
    { label: 'Businesses',    value: String(data.businesses.length), sub: `${data.businesses.filter(b => b.is_active).length} active` },
    { label: 'AI today',      value: String(data.ai.queries_today), sub: data.ai.daily_cap != null ? `of ${data.ai.daily_cap} cap (${data.ai.pct_of_cap}%)` : 'unlimited', tone: data.ai.pct_of_cap != null && data.ai.pct_of_cap > 80 ? 'warn' : 'neutral' },
    { label: 'AI cost (mo)',  value: `${data.ai.monthly_cost_sek.toFixed(2)} kr`, sub: 'this calendar month' },
    { label: 'Created',       value: fmtDate(data.org.created_at) },
    { label: 'Trial end',     value: data.org.trial_end ? fmtDate(data.org.trial_end) : '—', tone: data.org.trial_end && data.org.plan === 'trial' ? 'warn' : 'neutral' },
    { label: 'Org-nr',        value: orgNrFmt ?? '—', sub: orgNrSub, tone: orgNrTone },
  ]

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
      <KpiStrip items={kpis} columns={3} />

      <Card title="Businesses">
        {data.businesses.length === 0 ? (
          <div style={{ padding: '12px 16px', fontSize: 12, color: '#9ca3af' }}>None</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
            <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
              <tr>
                <Th>Name</Th><Th>City</Th><Th>Active</Th><Th>Created</Th>
              </tr>
            </thead>
            <tbody>
              {data.businesses.map(b => (
                <tr key={b.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <Td><span style={{ fontWeight: 500, color: '#111' }}>{b.name}</span></Td>
                  <Td muted>{b.city ?? '—'}</Td>
                  <Td>{b.is_active ? <Pill tone="good">YES</Pill> : <Pill tone="bad">NO</Pill>}</Td>
                  <Td muted>{fmtDate(b.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Card title="Recent Fortnox uploads">
          {data.recent_uploads.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 12, color: '#9ca3af' }}>None</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <tbody>
                {data.recent_uploads.map(u => (
                  <tr key={u.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <Td>
                      <div style={{ fontWeight: 500, color: '#111' }}>
                        {u.doc_type} {u.period_year}{u.period_month ? `-${String(u.period_month).padStart(2, '0')}` : ''}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{fmtDate(u.created_at)}</div>
                    </Td>
                    <Td><Pill tone={u.status === 'applied' ? 'good' : u.status === 'rejected' ? 'bad' : 'neutral'}>{u.status.toUpperCase()}</Pill></Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="Recent admin trail">
          {data.recent_audit.length === 0 ? (
            <div style={{ padding: '12px 16px', fontSize: 12, color: '#9ca3af' }}>None</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <tbody>
                {data.recent_audit.map((a, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                    <Td>
                      <div style={{ fontWeight: 500, color: '#111' }}>
                        {a.action}
                        {a.payload?.surface === 'admin_v2' && (
                          <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, color: '#4338ca', background: '#eef2ff', padding: '1px 4px', borderRadius: 3 }}>V2</span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                        by {a.actor} · {fmtDateTime(a.created_at)}
                      </div>
                      {a.payload?.reason && (
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, fontStyle: 'italic' as const, paddingLeft: 6, borderLeft: '2px solid #e5e7eb' }}>
                          {a.payload.reason}
                        </div>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </div>
  )
}

// ─── Atoms ─────────────────────────────────────────────────────────────────

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', fontSize: 12, fontWeight: 600, color: '#374151' }}>{title}</div>
      {children}
    </div>
  )
}
function Th({ children }: { children: React.ReactNode }) {
  return <th style={{ padding: '8px 14px', textAlign: 'left' as const, fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{children}</th>
}
function Td({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return <td style={{ padding: '10px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111' }}>{children}</td>
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'neutral' }) {
  const TONE: Record<string, { bg: string; fg: string }> = {
    good:    { bg: '#dcfce7', fg: '#15803d' },
    bad:     { bg: '#fef2f2', fg: '#b91c1c' },
    neutral: { bg: '#f3f4f6', fg: '#6b7280' },
  }
  const t = TONE[tone]
  return <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: t.bg, color: t.fg }}>{children}</span>
}
function Loading({ text }: { text: string }) {
  return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>{text}</div>
}
function ErrorBox({ text }: { text: string }) {
  return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {text}</div>
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
