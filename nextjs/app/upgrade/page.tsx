// @ts-nocheck
// app/upgrade/page.tsx
//
// THE PRICING / UPGRADE PAGE.
// Shows all plans, current usage meters, and handles the upgrade flow.
// Ported from upgrade_page.html with real Stripe integration wired in.

'use client'

import { useState, useEffect } from 'react'
import { useSearchParams }     from 'next/navigation'
import { createClient }        from '@/lib/supabase/client'
import { track }               from '@/lib/analytics/posthog'
import { PLANS }               from '@/lib/stripe/config'

interface UsageData {
  plan:         string
  trialDaysLeft:number | null
  hasSubscription: boolean
  costUsdThisMonth: number
  meters: Record<string, {
    used:      number
    limit:     number
    pct:       number
    nearLimit: boolean
    atLimit:   boolean
  }>
}

const PLAN_ORDER = ['trial', 'starter', 'pro', 'enterprise'] as const
const PLAN_DESCS: Record<string, string> = {
  trial:      '30 days to explore the full platform',
  starter:    'For restaurants getting started with AI',
  pro:        'For growing restaurant groups',
  enterprise: 'For chains and enterprise groups',
}

const METER_LABELS: Record<string, string> = {
  businesses:       'Businesses',
  documents:        'Documents',
  monthly_tokens:   'AI Tokens',
  monthly_requests: 'AI Requests',
  team_members:     'Team Members',
  audio_overviews:  'Audio Overviews',
  export_schedules: 'Schedules',
}

export default function UpgradePage() {
  const searchParams = useSearchParams()
  const [usage,   setUsage]   = useState<UsageData | null>(null)
  const [billing, setBilling] = useState<'monthly' | 'annual'>('monthly')
  const [loading, setLoading] = useState<string | null>(null)   // which plan is loading

  const upgradeSuccess = searchParams.get('upgrade') === 'success'
  const cancelled      = searchParams.get('cancelled') === '1'

  // Fetch usage data
  useEffect(() => {
    fetchUsage()
  }, [])

  async function fetchUsage() {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) return

    const res = await fetch('/api/stripe/usage', {
      headers: { 'Authorization': `Bearer ${session.access_token}` },
    })
    if (res.ok) setUsage(await res.json())
  }

  async function handleUpgrade(plan: string) {
    if (plan === 'enterprise') {
      window.location.href = 'mailto:sales@commandcenter.se?subject=Enterprise+Enquiry'
      return
    }

    track('upgrade_clicked', { plan_target: plan })
    setLoading(plan)

    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    try {
      const res  = await fetch('/api/stripe/checkout', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session?.access_token}`,
        },
        body: JSON.stringify({ plan, annual: billing === 'annual' }),
      })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error)
      if (data.url) window.location.href = data.url

    } catch (err: any) {
      alert(`Upgrade failed: ${err.message}`)
      track('upgrade_cancelled', { plan_target: plan, reason: 'error' })
    } finally {
      setLoading(null)
    }
  }

  async function openPortal() {
    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    const res  = await fetch('/api/stripe/portal', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${session?.access_token}`,
      },
      body: JSON.stringify({}),
    })
    const data = await res.json()
    if (data.url) window.open(data.url, '_blank')
  }

  const currentPlan = usage?.plan ?? 'trial'

  return (
    <div style={S.page}>

      {/* Success / cancelled banners */}
      {upgradeSuccess && (
        <div style={S.bannerSuccess}>
          ðŸŽ‰ You're now on the {PLANS[new URLSearchParams(window.location.search).get('plan') ?? '']?.name ?? 'new'} plan. All features are unlocked.
        </div>
      )}
      {cancelled && (
        <div style={S.bannerInfo}>No changes were made. You can upgrade any time.</div>
      )}

      {/* Trial expiry banner */}
      {currentPlan === 'trial' && usage?.trialDaysLeft !== null && (
        <div style={{
          ...S.bannerTrial,
          ...(usage.trialDaysLeft! <= 3 ? S.bannerTrialUrgent : {}),
        }}>
          <span style={{ fontSize: 22, flexShrink: 0 }}>
            {usage.trialDaysLeft! <= 0 ? 'â°' : 'â³'}
          </span>
          <span>
            {usage.trialDaysLeft! <= 0
              ? 'Your free trial has ended. Choose a plan to restore access.'
              : `${usage.trialDaysLeft} days left on your free trial. Upgrade to keep all your data and integrations.`}
          </span>
        </div>
      )}

      {/* Payment failed banner */}
      {currentPlan === 'past_due' && (
        <div style={S.bannerError}>
          âš ï¸ Your last payment failed. Please update your payment method to restore full access.
          <button style={S.bannerBtn} onClick={openPortal}>Update payment method â†’</button>
        </div>
      )}

      {/* Page header */}
      <div style={S.header}>
        <h1 style={S.title}>Choose your plan</h1>
        <p style={S.subtitle}>All plans include a 30-day free trial. No card required to start.</p>
      </div>

      {/* Billing toggle */}
      <div style={S.toggleRow}>
        <span style={{ ...S.toggleLabel, ...(billing==='monthly'?S.toggleLabelActive:{}) }}
              onClick={() => setBilling('monthly')}>Monthly</span>
        <div style={S.toggleSwitch} onClick={() => setBilling(b => b === 'monthly' ? 'annual' : 'monthly')}>
          <div style={{ ...S.toggleDot, transform: billing === 'annual' ? 'translateX(20px)' : 'none' }} />
        </div>
        <span style={{ ...S.toggleLabel, ...(billing==='annual'?S.toggleLabelActive:{}) }}
              onClick={() => setBilling('annual')}>
          Annual <span style={S.saveBadge}>Save 20%</span>
        </span>
      </div>

      {/* Plan cards */}
      <div style={S.plansGrid}>
        {PLAN_ORDER.map(planKey => {
          const plan      = PLANS[planKey]
          const isCurrent = currentPlan === planKey
          const isPopular = planKey === 'pro'

          const monthlyPrice = plan.price_usd
          const annualPrice  = monthlyPrice ? Math.round(monthlyPrice * 0.8) : null
          const displayPrice = billing === 'annual' && annualPrice ? annualPrice : monthlyPrice

          return (
            <div key={planKey} style={{
              ...S.planCard,
              ...(isCurrent ? S.planCardCurrent : {}),
              ...(isPopular && !isCurrent ? S.planCardPopular : {}),
            }}>
              {isPopular  && !isCurrent && <div style={S.popularBadge}>Most Popular</div>}
              {isCurrent  && <div style={S.currentBadge}>Current Plan</div>}

              <div style={S.planName}>{plan.name}</div>

              <div style={S.planPrice}>
                {displayPrice === null ? (
                  <span style={S.planAmount}>Custom</span>
                ) : displayPrice === 0 ? (
                  <span style={S.planAmount}>Free</span>
                ) : (
                  <>
                    <span style={{ fontSize: 18, color: 'var(--ink-3)', marginBottom: 4 }}>$</span>
                    <span style={S.planAmount}>{displayPrice}</span>
                    <span style={{ fontSize: 12, color: 'var(--ink-4)', alignSelf: 'flex-end', marginBottom: 4 }}>/mo</span>
                    {billing === 'annual' && monthlyPrice && (
                      <span style={{ fontSize: 11, color: 'var(--ink-4)', textDecoration: 'line-through', alignSelf: 'flex-end', marginBottom: 4, marginLeft: 4 }}>
                        ${monthlyPrice}
                      </span>
                    )}
                  </>
                )}
              </div>

              <div style={S.planDesc}>{PLAN_DESCS[planKey]}</div>

              <ul style={S.featureList}>
                {plan.features.map(f => (
                  <li key={f} style={S.featureItem}>
                    <span style={{ color: 'var(--green)', flexShrink: 0 }}>âœ“</span>
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA button */}
              {isCurrent ? (
                usage?.hasSubscription ? (
                  <button style={S.btnCurrent} onClick={openPortal}>Manage billing â†’</button>
                ) : (
                  <button style={S.btnCurrent} disabled>Current plan</button>
                )
              ) : planKey === 'enterprise' ? (
                <button style={S.btnUpgrade} onClick={() => handleUpgrade('enterprise')}>
                  Contact sales â†’
                </button>
              ) : (
                <button
                  style={{ ...S.btnUpgrade, ...(isPopular ? S.btnUpgradePopular : {}) }}
                  disabled={loading === planKey}
                  onClick={() => handleUpgrade(planKey)}
                >
                  {loading === planKey
                    ? <><span className="spin">âŸ³</span> Loadingâ€¦</>
                    : currentPlan === 'trial' ? 'Start with ' + plan.name
                    : PLAN_ORDER.indexOf(planKey) > PLAN_ORDER.indexOf(currentPlan as any)
                    ? 'Upgrade to ' + plan.name
                    : 'Switch to '  + plan.name}
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Usage meters */}
      {usage && (
        <div style={S.usageSection}>
          <div style={S.usageHeader}>
            <h2 style={S.usageTitle}>Current usage</h2>
            {usage.costUsdThisMonth > 0 && (
              <span style={{ fontSize: 12, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
                AI cost this month: ${usage.costUsdThisMonth.toFixed(4)}
              </span>
            )}
          </div>
          <div style={S.metersGrid}>
            {Object.entries(usage.meters).map(([key, meter]) => {
              const label   = METER_LABELS[key] ?? key
              const pct     = meter.limit === Infinity ? 0 : Math.min(100, meter.pct)
              const colour  = meter.atLimit ? 'var(--red)' : meter.nearLimit ? 'var(--amber)' : 'var(--green)'
              const usedFmt = formatMetric(key, meter.used)
              const limFmt  = meter.limit === Infinity ? 'âˆž' : formatMetric(key, meter.limit)
              return (
                <div key={key} style={{
                  ...S.meter,
                  ...(meter.atLimit   ? S.meterCrit : {}),
                  ...(meter.nearLimit && !meter.atLimit ? S.meterWarn : {}),
                }}>
                  <div style={S.meterLabel}>{label}</div>
                  <div style={S.meterValues}>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>{usedFmt}</span>
                    <span style={{ fontSize: 11, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>/ {limFmt}</span>
                  </div>
                  <div style={S.meterTrack}>
                    <div style={{ ...S.meterFill, width: `${pct}%`, background: colour }} />
                  </div>
                  {meter.atLimit && (
                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 3 }}>Limit reached â€” upgrade to continue</div>
                  )}
                  {meter.nearLimit && !meter.atLimit && (
                    <div style={{ fontSize: 10, color: 'var(--amber)', marginTop: 3 }}>Approaching limit</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

    </div>
  )
}

function formatMetric(key: string, val: number): string {
  if (val === Infinity) return 'âˆž'
  if (key === 'monthly_tokens') return val >= 1_000_000 ? `${(val/1_000_000).toFixed(1)}M` : `${(val/1000).toFixed(0)}k`
  return val.toLocaleString('sv-SE')
}

// â”€â”€ Styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 1000, margin: '0 auto', padding: '32px 24px 80px' },
  header:     { textAlign: 'center', marginBottom: 28 },
  title:      { fontFamily: 'var(--display)', fontSize: 34, fontWeight: 300, fontStyle: 'italic', color: 'var(--navy)' },
  subtitle:   { fontSize: 14, color: 'var(--ink-3)', marginTop: 6 },

  bannerSuccess: { background: 'var(--green-lt)', border: '1px solid var(--green-mid)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: 'var(--green)', marginBottom: 20, fontWeight: 500 },
  bannerInfo:    { background: 'var(--blue-lt)', border: '1px solid var(--blue-mid)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: 'var(--blue)', marginBottom: 20 },
  bannerTrial:   { background: 'var(--navy)', color: 'white', borderRadius: 10, padding: '12px 18px', fontSize: 13, fontWeight: 500, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 },
  bannerTrialUrgent: { background: 'var(--red)' },
  bannerError:   { background: 'var(--red-lt)', border: '1px solid var(--red-mid)', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: 'var(--red)', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, fontWeight: 500 },
  bannerBtn:     { marginLeft: 'auto', background: 'none', border: '1px solid currentColor', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', color: 'inherit', fontFamily: 'var(--font)', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' as const },

  toggleRow:        { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 32 },
  toggleLabel:      { fontSize: 13, fontWeight: 500, color: 'var(--ink-3)', cursor: 'pointer' },
  toggleLabelActive:{ color: 'var(--ink)' },
  toggleSwitch:     { width: 44, height: 24, borderRadius: 12, background: 'var(--navy)', cursor: 'pointer', position: 'relative', transition: 'background .15s' },
  toggleDot:        { width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute', top: 2, left: 2, transition: 'transform .15s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' },
  saveBadge:        { fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 8, background: 'var(--green-lt)', color: 'var(--green)', border: '1px solid var(--green-mid)', marginLeft: 6 },

  plansGrid:        { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 40 },
  planCard:         { background: 'var(--white)', border: '2px solid var(--border)', borderRadius: 16, padding: '24px 20px', display: 'flex', flexDirection: 'column', position: 'relative', transition: 'all .15s' },
  planCardCurrent:  { borderColor: 'var(--green)', background: 'var(--green-lt)' },
  planCardPopular:  { borderColor: 'var(--navy)' },
  popularBadge:     { position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: 'var(--navy)', color: 'white', fontSize: 10, fontWeight: 700, padding: '3px 12px', borderRadius: 12, whiteSpace: 'nowrap' as const },
  currentBadge:     { position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: 'var(--green)', color: 'white', fontSize: 10, fontWeight: 700, padding: '3px 12px', borderRadius: 12, whiteSpace: 'nowrap' as const },
  planName:         { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: 'var(--ink-3)', marginBottom: 10 },
  planPrice:        { display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 6 },
  planAmount:       { fontFamily: 'var(--display)', fontSize: 40, fontWeight: 600, color: 'var(--ink)', lineHeight: 1 },
  planDesc:         { fontSize: 12, color: 'var(--ink-4)', lineHeight: 1.5, marginBottom: 18, minHeight: 36 },
  featureList:      { listStyle: 'none', padding: 0, margin: '0 0 20px', flex: 1 },
  featureItem:      { display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, color: 'var(--ink-2)', marginBottom: 7, lineHeight: 1.4 },
  btnUpgrade:       { width: '100%', padding: 11, borderRadius: 9, background: 'var(--navy)', color: 'white', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  btnUpgradePopular:{ background: 'var(--blue)' },
  btnCurrent:       { width: '100%', padding: 11, borderRadius: 9, background: 'none', color: 'var(--green)', border: '1.5px solid var(--green-mid)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font)' },

  usageSection:  { background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 16, padding: 24 },
  usageHeader:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  usageTitle:    { fontFamily: 'var(--display)', fontSize: 18, fontWeight: 400, fontStyle: 'italic', color: 'var(--ink)' },
  metersGrid:    { display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 14 },
  meter:         { background: 'var(--parchment)', borderRadius: 10, padding: 14 },
  meterWarn:     { background: 'var(--amber-lt)', border: '1px solid rgba(122,72,0,.15)' },
  meterCrit:     { background: 'var(--red-lt)', border: '1px solid rgba(139,26,26,.15)' },
  meterLabel:    { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--ink-3)', marginBottom: 6 },
  meterValues:   { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 },
  meterTrack:    { height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' },
  meterFill:     { height: '100%', borderRadius: 3, transition: 'width .5s ease' },
}
