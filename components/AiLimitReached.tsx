'use client'
// @ts-nocheck
// components/AiLimitReached.tsx
//
// Upsell card shown inside the AskAI panel when the user hits their daily AI query limit.
// Two modes based on current plan:
//   - Paid plan (starter / pro): offer AI Booster (+100/day for 299 kr/mo) with direct Stripe checkout
//   - Trial:                      offer upgrade to a paid plan (Booster isn't available on trial)
// group / enterprise have unlimited queries, so they shouldn't see this component at all.

import { useState }      from 'react'
import { useTranslations } from 'next-intl'
import { createClient }  from '@/lib/supabase/client'

interface Props {
  used:  number
  limit: number
  plan:  string
}

export default function AiLimitReached({ used, limit, plan }: Props) {
  const t = useTranslations('askai.limitReached')
  const [checkingOut, setCheckingOut] = useState(false)
  const [error,       setError]       = useState('')

  const isTrial = plan === 'trial'

  async function addBooster() {
    setCheckingOut(true)
    setError('')
    try {
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()

      const res  = await fetch('/api/stripe/checkout', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ plan: 'ai_addon' }),
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error ?? t('checkoutFailed'))
      window.location.href = data.url
    } catch (e: any) {
      setError(e.message ?? t('somethingWrong'))
      setCheckingOut(false)
    }
  }

  return (
    <div style={S.card}>
      <div style={S.header}>
        <div style={S.iconWrap}>
          <span style={{ fontSize: 18 }}>✦</span>
        </div>
        <div style={{ flex: 1 }}>
          <div style={S.title}>{t('title')}</div>
          <div style={S.meta}>{t('meta', { used, limit })}</div>
        </div>
      </div>

      {isTrial ? (
        <>
          <div style={S.pitch}>
            {t('trialPitch')}
          </div>
          <a href="/upgrade?focus=ai" style={S.primaryBtn}>
            {t('trialCta')}
          </a>
        </>
      ) : (
        <>
          <div style={S.boosterBox}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={S.boosterTag}>{t('boosterTag')}</span>
              <span style={S.price}>{t('boosterPrice')}</span>
            </div>
            <div style={S.boosterDesc}>{t('boosterDesc')}</div>
          </div>

          <button
            onClick={addBooster}
            disabled={checkingOut}
            style={{ ...S.primaryBtn, border: 'none', cursor: checkingOut ? 'not-allowed' : 'pointer', opacity: checkingOut ? 0.6 : 1 }}
          >
            {checkingOut ? t('redirecting') : t('addBooster')}
          </button>

          <a href="/upgrade?focus=ai" style={S.secondary}>
            {t('comparePlans')}
          </a>
        </>
      )}

      {error && <div style={S.error}>{error}</div>}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  card: {
    background:    'linear-gradient(160deg, #1a1f2e 0%, #2a3580 100%)',
    color:         'white',
    borderRadius:  14,
    padding:       '16px 18px',
    marginTop:     4,
    marginBottom:  4,
  },
  header: {
    display:      'flex',
    alignItems:   'center',
    gap:          12,
    marginBottom: 14,
  },
  iconWrap: {
    width:        36,
    height:       36,
    borderRadius: 10,
    background:   'rgba(255,255,255,0.12)',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
    flexShrink:   0,
  },
  title: {
    fontSize:   14,
    fontWeight: 700,
    color:      'white',
    marginBottom: 2,
  },
  meta: {
    fontSize: 11,
    color:    'rgba(255,255,255,0.65)',
  },
  pitch: {
    fontSize:     13,
    lineHeight:   1.5,
    color:        'rgba(255,255,255,0.85)',
    marginBottom: 14,
  },
  boosterBox: {
    background:    'rgba(255,255,255,0.08)',
    border:        '1px solid rgba(255,255,255,0.15)',
    borderRadius:  10,
    padding:       '12px 14px',
    marginBottom:  12,
  },
  boosterTag: {
    fontSize:      10,
    fontWeight:    700,
    letterSpacing: '.08em',
    color:         '#c4b5fd',
  },
  price: {
    fontSize:   12,
    fontWeight: 600,
    color:      'rgba(255,255,255,0.9)',
  },
  boosterDesc: {
    fontSize:   12,
    color:      'rgba(255,255,255,0.75)',
    lineHeight: 1.5,
  },
  primaryBtn: {
    display:        'block',
    width:          '100%',
    padding:        '11px 14px',
    background:     'white',
    color:          '#1a1f2e',
    borderRadius:   9,
    fontSize:       13,
    fontWeight:     700,
    textAlign:      'center',
    textDecoration: 'none',
    cursor:         'pointer',
  },
  secondary: {
    display:        'block',
    textAlign:      'center',
    marginTop:      10,
    fontSize:       12,
    fontWeight:     500,
    color:          'rgba(255,255,255,0.7)',
    textDecoration: 'underline',
  },
  error: {
    marginTop:  10,
    padding:    '8px 10px',
    background: 'rgba(252,82,82,0.15)',
    border:     '1px solid rgba(252,82,82,0.3)',
    borderRadius: 6,
    fontSize:   12,
    color:      '#fecaca',
  },
}
