'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'
// app/upgrade/page.tsx — Pricing page with Stripe checkout integration

import AppShell from '@/components/AppShell'
import { useState, useEffect, useRef } from 'react'
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

const PLAN_ORDER = ['trial', 'starter', 'pro', 'group', 'enterprise'] as const
const PLAN_DESCS: Record<string, string> = {
  trial:      '30 days to explore the full platform',
  starter:    'For single-location restaurants',
  pro:        'For groups with up to 5 locations',
  group:      'For unlimited locations — best value',
  enterprise: 'Custom pricing for large chains',
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
  const focusAi        = searchParams.get('focus') === 'ai'

  const boosterRef = useRef<HTMLDivElement>(null)
  const [flashBooster, setFlashBooster] = useState(false)

  // Fetch usage data
  useEffect(() => {
    fetchUsage()
  }, [])

  // If user came from AskAI limit banner, scroll booster into view and flash it
  useEffect(() => {
    if (!focusAi || !usage) return
    const t = setTimeout(() => {
      boosterRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setFlashBooster(true)
      setTimeout(() => setFlashBooster(false), 2500)
    }, 150)
    return () => clearTimeout(t)
  }, [focusAi, usage])

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

  if (!usage) return (
    <AppShell>
      <div style={{ padding: 60, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>Loading...</div>
    </AppShell>
  )

  return (
    <AppShell>
    <div style={S.page}>

      {/* Success / cancelled banners */}
      {upgradeSuccess && (
        <div style={S.bannerSuccess}>
          🎉 You're now on the {PLANS[new URLSearchParams(window.location.search).get('plan') ?? '']?.name ?? 'new'} plan. All features are unlocked.
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
            {usage.trialDaysLeft! <= 0 ? '⏰' : '⏳'}
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
          ⚠️ Your last payment failed. Please update your payment method to restore full access.
          <button style={S.bannerBtn} onClick={openPortal}>Update payment method →</button>
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
          Annual <span style={S.saveBadge}>2 months free</span>
        </span>
      </div>

      {/* Plan cards */}
      <div style={S.plansGrid}>
        {PLAN_ORDER.map(planKey => {
          const plan      = PLANS[planKey]
          const isCurrent = currentPlan === planKey
          const isPopular = planKey === 'pro'
          const isBestVal = planKey === 'group'

          const monthlyPrice = plan.price_usd
          // Annual = 10 months price for 12 months (2 months free)
          const annualMonthly = monthlyPrice ? Math.round(monthlyPrice * 10 / 12) : null
          const displayPrice  = billing === 'annual' && annualMonthly ? annualMonthly : monthlyPrice

          return (
            <div key={planKey} style={{
              ...S.planCard,
              ...(isCurrent  ? S.planCardCurrent  : {}),
              ...(isPopular  && !isCurrent ? S.planCardPopular  : {}),
              ...(isBestVal  && !isCurrent ? S.planCardBestVal  : {}),
            }}>
              {isPopular && !isCurrent && <div style={S.popularBadge}>Most Popular</div>}
              {isBestVal && !isCurrent && <div style={{ ...S.popularBadge, background: '#15803d' }}>Best Value</div>}
              {isCurrent && <div style={S.currentBadge}>Current Plan</div>}

              <div style={S.planName}>{plan.name}</div>

              <div style={S.planPrice}>
                {displayPrice === null ? (
                  <span style={S.planAmount}>Custom</span>
                ) : displayPrice === 0 ? (
                  <span style={S.planAmount}>Free</span>
                ) : (
                  <>
                    <span style={{ fontSize: 18, color: '#6b7280', marginBottom: 4 }}>$</span>
                    <span style={S.planAmount}>{displayPrice}</span>
                    <span style={{ fontSize: 12, color: '#9ca3af', alignSelf: 'flex-end', marginBottom: 4 }}>/mo</span>
                    {billing === 'annual' && annualMonthly && monthlyPrice && (
                      <span style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'line-through', alignSelf: 'flex-end', marginBottom: 4, marginLeft: 4 }}>
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
                    <span style={{ color: '#15803d', flexShrink: 0 }}>✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              {/* CTA button */}
              {isCurrent ? (
                usage?.hasSubscription ? (
                  <button style={S.btnCurrent} onClick={openPortal}>Manage billing →</button>
                ) : (
                  <button style={S.btnCurrent} disabled>Current plan</button>
                )
              ) : planKey === 'enterprise' ? (
                <button style={S.btnUpgrade} onClick={() => handleUpgrade('enterprise')}>
                  Contact sales →
                </button>
              ) : planKey === 'group' ? (
                <button
                  style={{ ...S.btnUpgrade, background: '#15803d' }}
                  disabled={loading === planKey}
                  onClick={() => handleUpgrade(planKey)}
                >
                  {loading === planKey ? 'Loading…' : currentPlan === 'trial' ? 'Start with Group' : 'Upgrade to Group'}
                </button>
              ) : (
                <button
                  style={{ ...S.btnUpgrade, ...(isPopular ? S.btnUpgradePopular : {}) }}
                  disabled={loading === planKey}
                  onClick={() => handleUpgrade(planKey)}
                >
                  {loading === planKey
                    ? <><span className="spin">⟳</span> Loading…</>
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

      {/* AI Booster add-on — hidden only for unlimited-query plans */}
      {usage && currentPlan !== 'group' && currentPlan !== 'enterprise' && (
        <div
          ref={boosterRef}
          style={{
            background:   'white',
            border:       `${flashBooster ? 2 : 1}px solid ${flashBooster ? '#6366f1' : '#e5e7eb'}`,
            borderRadius: 16,
            padding:      '20px 24px',
            marginBottom: 20,
            display:      'flex',
            alignItems:   'center',
            justifyContent: 'space-between',
            flexWrap:     'wrap' as const,
            gap:          16,
            boxShadow:    flashBooster ? '0 0 0 6px rgba(99,102,241,0.15)' : 'none',
            transition:   'border-color .3s, box-shadow .3s, border-width .3s',
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 18 }}>⚡</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>AI Booster</span>
              <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: '#fce7f3', color: '#9d174d' }}>+299 kr/mo</span>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              {currentPlan === 'trial'
                ? 'Add 100 extra AI queries per day on top of any paid plan. Pick a plan above first.'
                : 'Add 100 extra AI queries per day on top of your plan. Cancel anytime.'}
            </div>
          </div>
          {currentPlan === 'trial' ? (
            <button
              disabled
              style={{ padding: '9px 18px', background: '#e5e7eb', color: '#9ca3af', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'not-allowed', whiteSpace: 'nowrap' as const }}
            >
              Upgrade a plan first
            </button>
          ) : (
            <button
              style={{ padding: '9px 18px', background: '#6366f1', color: 'white', border: 'none', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' as const }}
              disabled={loading === 'ai_addon'}
              onClick={() => handleUpgrade('ai_addon')}
            >
              {loading === 'ai_addon' ? 'Loading…' : 'Add AI Booster →'}
            </button>
          )}
        </div>
      )}

      {/* Usage meters */}
      {usage && (
        <div style={S.usageSection}>
          <div style={S.usageHeader}>
            <h2 style={S.usageTitle}>Current usage</h2>
            {usage.costUsdThisMonth > 0 && (
              <span style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'monospace' }}>
                AI cost this month: ${usage.costUsdThisMonth.toFixed(4)}
              </span>
            )}
          </div>
          <div style={S.metersGrid}>
            {Object.entries(usage.meters).map(([key, meter]) => {
              const label   = METER_LABELS[key] ?? key
              const pct     = meter.limit === Infinity ? 0 : Math.min(100, meter.pct)
              const colour  = meter.atLimit ? '#dc2626' : meter.nearLimit ? '#d97706' : '#15803d'
              const usedFmt = formatMetric(key, meter.used)
              const limFmt  = meter.limit === Infinity ? '∞' : formatMetric(key, meter.limit)
              return (
                <div key={key} style={{
                  ...S.meter,
                  ...(meter.atLimit   ? S.meterCrit : {}),
                  ...(meter.nearLimit && !meter.atLimit ? S.meterWarn : {}),
                }}>
                  <div style={S.meterLabel}>{label}</div>
                  <div style={S.meterValues}>
                    <span style={{ fontFamily: 'monospace', fontSize: 14, fontWeight: 600, color: '#111827' }}>{usedFmt}</span>
                    <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'monospace' }}>/ {limFmt}</span>
                  </div>
                  <div style={S.meterTrack}>
                    <div style={{ ...S.meterFill, width: `${pct}%`, background: colour }} />
                  </div>
                  {meter.atLimit && (
                    <div style={{ fontSize: 10, color: '#dc2626', marginTop: 3 }}>Limit reached — upgrade to continue</div>
                  )}
                  {meter.nearLimit && !meter.atLimit && (
                    <div style={{ fontSize: 10, color: '#d97706', marginTop: 3 }}>Approaching limit</div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

    </div>
    </AppShell>
  )
}

function formatMetric(key: string, val: number): string {
  if (val === Infinity) return '∞'
  if (key === 'monthly_tokens') return val >= 1_000_000 ? `${(val/1_000_000).toFixed(1)}M` : `${(val/1000).toFixed(0)}k`
  return val.toLocaleString('en-GB')
}

// ── Styles ────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  page:       { maxWidth: 1000, margin: '0 auto', padding: 'clamp(16px,4vw,32px) clamp(12px,3vw,24px) 80px' },
  header:     { textAlign: 'center', marginBottom: 28 },
  title:      { fontFamily: 'Georgia, serif', fontSize: 34, fontWeight: 300, fontStyle: 'italic', color: '#1a1f2e' },
  subtitle:   { fontSize: 14, color: '#6b7280', marginTop: 6 },

  bannerSuccess: { background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#15803d', marginBottom: 20, fontWeight: 500 },
  bannerInfo:    { background: '#eff6ff', border: '1px solid #818cf8', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#6366f1', marginBottom: 20 },
  bannerTrial:   { background: '#1a1f2e', color: 'white', borderRadius: 10, padding: '12px 18px', fontSize: 13, fontWeight: 500, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 },
  bannerTrialUrgent: { background: '#dc2626' },
  bannerError:   { background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 12, fontWeight: 500 },
  bannerBtn:     { marginLeft: 'auto', background: 'none', border: '1px solid currentColor', borderRadius: 7, padding: '5px 12px', cursor: 'pointer', color: 'inherit', fontFamily: '-apple-system, sans-serif', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' as const },

  toggleRow:        { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginBottom: 32 },
  toggleLabel:      { fontSize: 13, fontWeight: 500, color: '#6b7280', cursor: 'pointer' },
  toggleLabelActive:{ color: '#111827' },
  toggleSwitch:     { width: 44, height: 24, borderRadius: 12, background: '#1a1f2e', cursor: 'pointer', position: 'relative', transition: 'background .15s' },
  toggleDot:        { width: 20, height: 20, borderRadius: '50%', background: 'white', position: 'absolute', top: 2, left: 2, transition: 'transform .15s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' },
  saveBadge:        { fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 8, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0', marginLeft: 6 },

  plansGrid:        { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(280px,1fr))', gap: 14, marginBottom: 40 },
  planCard:         { background: '#ffffff', border: '2px solid #e5e7eb', borderRadius: 16, padding: '24px 20px', display: 'flex', flexDirection: 'column', position: 'relative', transition: 'all .15s' },
  planCardCurrent:  { borderColor: '#15803d', background: '#f0fdf4' },
  planCardPopular:  { borderColor: '#1a1f2e' },
  planCardBestVal:  { borderColor: '#15803d' },
  popularBadge:     { position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: '#1a1f2e', color: 'white', fontSize: 10, fontWeight: 700, padding: '3px 12px', borderRadius: 12, whiteSpace: 'nowrap' as const },
  currentBadge:     { position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: '#15803d', color: 'white', fontSize: 10, fontWeight: 700, padding: '3px 12px', borderRadius: 12, whiteSpace: 'nowrap' as const },
  planName:         { fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.08em', color: '#6b7280', marginBottom: 10 },
  planPrice:        { display: 'flex', alignItems: 'baseline', gap: 2, marginBottom: 6 },
  planAmount:       { fontFamily: 'Georgia, serif', fontSize: 40, fontWeight: 600, color: '#111827', lineHeight: 1 },
  planDesc:         { fontSize: 12, color: '#9ca3af', lineHeight: 1.5, marginBottom: 18, minHeight: 36 },
  featureList:      { listStyle: 'none', padding: 0, margin: '0 0 20px', flex: 1 },
  featureItem:      { display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12, color: '#374151', marginBottom: 7, lineHeight: 1.4 },
  btnUpgrade:       { width: '100%', padding: 11, borderRadius: 9, background: '#1a1f2e', color: 'white', border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: '-apple-system, sans-serif', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  btnUpgradePopular:{ background: '#6366f1' },
  btnCurrent:       { width: '100%', padding: 11, borderRadius: 9, background: 'none', color: '#15803d', border: '1.5px solid #bbf7d0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: '-apple-system, sans-serif' },

  usageSection:  { background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 24 },
  usageHeader:   { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  usageTitle:    { fontFamily: 'Georgia, serif', fontSize: 18, fontWeight: 400, fontStyle: 'italic', color: '#111827' },
  metersGrid:    { display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 14 },
  meter:         { background: '#fafafa', borderRadius: 10, padding: 14 },
  meterWarn:     { background: '#fffbeb', border: '1px solid rgba(122,72,0,.15)' },
  meterCrit:     { background: '#fef2f2', border: '1px solid rgba(139,26,26,.15)' },
  meterLabel:    { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.07em', color: '#6b7280', marginBottom: 6 },
  meterValues:   { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 5 },
  meterTrack:    { height: 5, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' },
  meterFill:     { height: '100%', borderRadius: 3, transition: 'width .5s ease' },
}
