'use client'
// components/admin/v2/CustomerHeader.tsx
//
// Top of the customer-detail page — org name, plan pill, business count,
// owner email, status pills (active / churned / trial / past_due).

interface OrgPayload {
  id: string
  name: string
  plan: string
  is_active: boolean
  trial_end: string | null
  billing_email: string | null
  mrr_sek: number
  stripe_subscription_id: string | null
}

interface CustomerHeaderProps {
  org:        OrgPayload
  business_count: number
  owner_email?: string | null
}

export function CustomerHeader({ org, business_count, owner_email }: CustomerHeaderProps) {
  const status = !org.is_active ? 'churned'
    : org.plan === 'past_due'   ? 'past_due'
    : org.plan === 'trial'      ? 'trial'
    : 'active'
  const STATUS_TONE: Record<string, { bg: string; fg: string; label: string }> = {
    churned:  { bg: '#f3f4f6', fg: '#6b7280', label: 'CHURNED' },
    past_due: { bg: '#fef2f2', fg: '#b91c1c', label: 'PAST DUE' },
    trial:    { bg: '#fef3c7', fg: '#92400e', label: 'TRIAL' },
    active:   { bg: '#dcfce7', fg: '#15803d', label: 'ACTIVE' },
  }
  const tone = STATUS_TONE[status]

  return (
    <div style={{
      background:   'white',
      border:       '1px solid #e5e7eb',
      borderRadius: 10,
      padding:      '16px 20px',
      marginBottom: 14,
      display:      'flex',
      alignItems:   'flex-start',
      justifyContent: 'space-between',
      gap:          16,
      flexWrap:     'wrap' as const,
    }}>
      <div style={{ minWidth: 0, flex: '1 1 320px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' as const }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, color: '#111', margin: 0, letterSpacing: '-0.01em' }}>
            {org.name}
          </h1>
          <span style={{
            fontSize:     10,
            fontWeight:   700,
            letterSpacing:'0.06em',
            padding:      '3px 8px',
            borderRadius: 4,
            background:   tone.bg,
            color:        tone.fg,
          }}>
            {tone.label}
          </span>
          <span style={{
            fontSize:     10,
            fontWeight:   700,
            letterSpacing:'0.06em',
            padding:      '3px 8px',
            borderRadius: 4,
            background:   '#eef2ff',
            color:        '#4338ca',
          }}>
            {(org.plan ?? 'TRIAL').toUpperCase()}
          </span>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: '#6b7280', display: 'flex', gap: 14, flexWrap: 'wrap' as const }}>
          <span>{business_count} {business_count === 1 ? 'business' : 'businesses'}</span>
          {owner_email && <span>· Owner: <span style={{ color: '#374151' }}>{owner_email}</span></span>}
          {org.billing_email && org.billing_email !== owner_email && (
            <span>· Billing: <span style={{ color: '#374151' }}>{org.billing_email}</span></span>
          )}
          {org.trial_end && org.plan === 'trial' && (
            <span>· Trial ends <span style={{ color: '#374151' }}>{org.trial_end}</span></span>
          )}
        </div>
      </div>

      <div style={{ textAlign: 'right' as const, minWidth: 140 }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: '#9ca3af', textTransform: 'uppercase' as const }}>MRR</div>
        <div style={{ fontSize: 20, fontWeight: 600, color: '#111', marginTop: 4, letterSpacing: '-0.01em' }}>
          {org.mrr_sek > 0 ? `${org.mrr_sek.toLocaleString('en-GB').replace(/,/g, ' ')} kr` : '—'}
        </div>
        {org.stripe_subscription_id && (
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
            Stripe sub: <span style={{ fontFamily: 'ui-monospace,monospace' }}>{org.stripe_subscription_id.slice(0, 14)}…</span>
          </div>
        )}
      </div>
    </div>
  )
}
