'use client'
// components/admin/v2/CustomerBilling.tsx
// Billing sub-tab: Stripe IDs, recent billing_events, link to Stripe portal.

import { useAdminData } from '@/lib/admin/v2/use-admin-data'

interface BillingResponse {
  org: {
    id: string; name: string; plan: string; is_active: boolean
    stripe_customer_id: string | null
    stripe_subscription_id: string | null
    trial_end: string | null
    billing_email: string | null
  }
  events: Array<{
    id: string
    event_type: string
    plan: string | null
    amount_sek: number | null
    stripe_event_id: string | null
    metadata: any
    created_at: string
  }>
  stripe_portal_url: string | null
}

export function CustomerBilling({ orgId }: { orgId: string }) {
  const { data, loading, error } = useAdminData<BillingResponse>(`/api/admin/v2/customers/${orgId}/billing`)

  if (loading) return <Loading />
  if (error)   return <ErrorBox text={error} />
  if (!data)   return <Loading />

  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
      <Card title="Stripe">
        <div style={{ padding: '14px 16px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
          <Row label="Customer ID"     value={data.org.stripe_customer_id ?? <Muted>—</Muted>} mono />
          <Row label="Subscription ID" value={data.org.stripe_subscription_id ?? <Muted>none</Muted>} mono />
          <Row label="Plan"            value={(data.org.plan ?? 'trial').toUpperCase()} />
          <Row label="Billing email"   value={data.org.billing_email ?? <Muted>—</Muted>} />
          <Row label="Status"          value={data.org.is_active ? <Pill tone="good">ACTIVE</Pill> : <Pill tone="bad">INACTIVE</Pill>} />
          <Row label="Trial end"       value={data.org.trial_end ?? <Muted>—</Muted>} />
        </div>
        {data.org.stripe_customer_id && (
          <div style={{ padding: '10px 16px', borderTop: '1px solid #f3f4f6', display: 'flex', gap: 8 }}>
            <a
              href={`https://dashboard.stripe.com/customers/${data.org.stripe_customer_id}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 12, color: '#6366f1', fontWeight: 500, textDecoration: 'none' }}
            >
              Open in Stripe Dashboard ↗
            </a>
          </div>
        )}
      </Card>

      <Card title="Recent billing events">
        {data.events.length === 0 ? (
          <Empty text="No billing events yet" />
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
            <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
              <tr>
                <Th>Event</Th><Th>Plan</Th><Th align="right">Amount</Th><Th align="right">When</Th>
              </tr>
            </thead>
            <tbody>
              {data.events.map(e => (
                <tr key={e.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  <Td>
                    <span style={{ fontWeight: 500, color: '#111' }}>{e.event_type}</span>
                    {e.metadata?.reason && (
                      <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4, fontStyle: 'italic' as const, paddingLeft: 6, borderLeft: '2px solid #e5e7eb' }}>
                        {e.metadata.reason}
                      </div>
                    )}
                  </Td>
                  <Td muted>{e.plan ?? '—'}</Td>
                  <Td align="right" muted>
                    {e.amount_sek != null ? `${(e.amount_sek / 100).toLocaleString('en-GB').replace(/,/g, ' ')} kr` : '—'}
                  </Td>
                  <Td align="right" muted>{fmtDateTime(e.created_at)}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: '#9ca3af', textTransform: 'uppercase' as const, marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: 12, color: '#111', fontFamily: mono ? 'ui-monospace, monospace' : 'inherit', overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>{value}</div>
    </div>
  )
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', fontSize: 12, fontWeight: 600, color: '#374151' }}>{title}</div>
      {children}
    </div>
  )
}
function Th({ children, align }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 14px', textAlign: (align ?? 'left') as any, fontSize: 11, fontWeight: 600, color: '#6b7280' }}>{children}</th>
}
function Td({ children, muted, align }: { children: React.ReactNode; muted?: boolean; align?: 'left' | 'right' }) {
  return <td style={{ padding: '10px 14px', fontSize: 12, color: muted ? '#6b7280' : '#111', textAlign: (align ?? 'left') as any }}>{children}</td>
}
function Pill({ children, tone }: { children: React.ReactNode; tone: 'good' | 'bad' | 'neutral' }) {
  const t = { good: { bg: '#dcfce7', fg: '#15803d' }, bad: { bg: '#fef2f2', fg: '#b91c1c' }, neutral: { bg: '#f3f4f6', fg: '#6b7280' } }[tone]
  return <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', padding: '2px 6px', borderRadius: 3, background: t.bg, color: t.fg }}>{children}</span>
}
function Muted({ children }: { children: React.ReactNode }) {
  return <span style={{ color: '#d1d5db' }}>{children}</span>
}
function Empty({ text }: { text: string }) {
  return <div style={{ padding: 24, fontSize: 12, color: '#9ca3af', textAlign: 'center' as const }}>{text}</div>
}
function Loading() {
  return <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading billing…</div>
}
function ErrorBox({ text }: { text: string }) {
  return <div style={{ padding: 16, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', fontSize: 12 }}>Error: {text}</div>
}
function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
