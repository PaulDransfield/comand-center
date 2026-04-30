'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

const RESTAURANT_TYPE_KEYS = ['restaurant', 'bar', 'cafe', 'bakery', 'catering', 'group'] as const

const STAFF_SYSTEMS = ['Personalkollen', 'Caspeco', 'Quinyx', 'Planday', 'Other', 'None']
const ACCOUNTING    = ['Fortnox', 'Visma', 'Bokio', 'Other', 'None']
const POS_SYSTEMS   = ['Ancon', 'Swess', 'Trivec', 'Zettle', 'Other', 'None']

export default function OnboardingPage() {
  const router = useRouter()
  const t      = useTranslations('onboarding')
  const STEPS  = [t('steps.welcome'), t('steps.restaurant'), t('steps.systems'), t('steps.done')]

  const [step,    setStep]    = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const [form, setForm] = useState({
    restaurantName:  '',
    city:            '',
    type:            'restaurant',
    targetFoodCost:  '31',
    targetStaffCost: '35',
    targetMargin:    '15',
  })

  const [systems, setSystems] = useState({
    staff:      '',
    accounting: '',
    pos:        '',
  })

  function updateForm(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
    setError('')
  }

  function updateSystem(field: string, value: string) {
    setSystems(f => ({ ...f, [field]: value }))
  }

  function saveAndContinue() {
    if (!form.restaurantName.trim()) {
      setError(t('restaurant.errors.missingName'))
      return
    }
    setError('')
    setStep(2)
  }

  async function finish() {
    setLoading(true)
    // Save the restaurant first
    try {
      await fetch('/api/businesses/add', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:              form.restaurantName.trim(),
          city:              form.city.trim(),
          type:              form.type,
          target_food_pct:   parseFloat(form.targetFoodCost)  || 31,
          target_staff_pct:  parseFloat(form.targetStaffCost) || 35,
          target_margin_pct: parseFloat(form.targetMargin)    || 15,
        }),
      })
    } catch {}
    // Save system preferences for support team
    await fetch('/api/onboarding/setup-request', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurantName: form.restaurantName,
        city:           form.city,
        staffSystem:    systems.staff,
        accounting:     systems.accounting,
        pos:            systems.pos,
      }),
    }).catch(() => {})
    await fetch('/api/onboarding/complete', { method: 'POST' }).catch(() => {})
    router.push('/dashboard')
  }

  // Styles
  const card:  React.CSSProperties = { background: 'white', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 500, boxShadow: '0 4px 32px rgba(0,0,0,0.10)' }
  const label: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6, textTransform: 'uppercase' as const, letterSpacing: '.05em' }
  const input: React.CSSProperties = { width: '100%', padding: '10px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 14, boxSizing: 'border-box' as const, outline: 'none', color: '#111', background: 'white' }
  const btnP:  React.CSSProperties = { width: '100%', padding: '13px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', marginTop: 12 }
  const btnS:  React.CSSProperties = { width: '100%', padding: '11px', background: 'transparent', color: '#9ca3af', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 13, cursor: 'pointer', marginTop: 8 }

  function RadioGroup({ field, options }: { field: string; options: string[] }) {
    const val = (systems as any)[field]
    return (
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
        {options.map(opt => (
          <label key={opt} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: val === opt ? '#eff6ff' : '#f9fafb', border: `1.5px solid ${val === opt ? '#6366f1' : '#f3f4f6'}`, borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
            <input type="radio" name={field} value={opt} checked={val === opt} onChange={() => updateSystem(field, opt)} style={{ accentColor: '#6366f1' }} />
            {opt}
          </label>
        ))}
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px' }}>
      <div style={card}>

        {/* Logo */}
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1f2e', marginBottom: 28, letterSpacing: '-0.01em' }}>
          CommandCenter
        </div>

        {/* Progress bar */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 32 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ flex: 1, height: 3, borderRadius: 2, background: i <= step ? '#1a1f2e' : '#e5e7eb', transition: 'background .3s' }} />
          ))}
        </div>

        {/* Step label */}
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: '#9ca3af', marginBottom: 16 }}>
          {t('stepLabel', { n: step + 1, total: STEPS.length })}
        </div>

        {/* ── Step 0: Welcome ─────────────────────────────────── */}
        {step === 0 && (
          <div>
            <h1 style={{ margin: '0 0 10px', fontSize: 26, fontWeight: 700, color: '#111', lineHeight: 1.2 }}>
              {t('welcome.title')}
            </h1>
            <p style={{ margin: '0 0 28px', fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>
              {t('welcome.subtitle')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 28 }}>
              {[
                { title: t('welcome.features.pnl_t'),    desc: t('welcome.features.pnl_d') },
                { title: t('welcome.features.staff_t'),  desc: t('welcome.features.staff_d') },
                { title: t('welcome.features.fc_t'),     desc: t('welcome.features.fc_d') },
                { title: t('welcome.features.ai_t'),     desc: t('welcome.features.ai_d') },
              ].map(f => (
                <div key={f.title} style={{ display: 'flex', gap: 12, padding: '11px 14px', background: '#f9fafb', borderRadius: 10, alignItems: 'center' }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#1a1f2e', flexShrink: 0 }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{f.title}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 1 }}>{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={() => setStep(1)} style={btnP}>{t('welcome.cta')}</button>
          </div>
        )}

        {/* ── Step 1: Restaurant details ───────────────────────── */}
        {step === 1 && (
          <div>
            <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#111' }}>{t('restaurant.title')}</h1>
            <p style={{ margin: '0 0 24px', fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>{t('restaurant.subtitle')}</p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14, marginBottom: 20 }}>
              <div>
                <label style={label}>{t('restaurant.name')}</label>
                <input style={input} value={form.restaurantName} onChange={e => updateForm('restaurantName', e.target.value)} placeholder={t('restaurant.namePlaceholder')} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={label}>{t('restaurant.city')}</label>
                  <input style={input} value={form.city} onChange={e => updateForm('city', e.target.value)} placeholder={t('restaurant.cityPlaceholder')} />
                </div>
                <div>
                  <label style={label}>{t('restaurant.type')}</label>
                  <select style={input} value={form.type} onChange={e => updateForm('type', e.target.value)}>
                    {RESTAURANT_TYPE_KEYS.map(k => <option key={k} value={k}>{t(`restaurant.typeOptions.${k}`)}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ background: '#f9fafb', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 12 }}>{t('restaurant.targetsHeader')}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  {[
                    { key: 'targetFoodCost',  label: t('restaurant.foodCost'),  hint: t('restaurant.foodHint') },
                    { key: 'targetStaffCost', label: t('restaurant.staffCost'), hint: t('restaurant.staffHint') },
                    { key: 'targetMargin',    label: t('restaurant.margin'),    hint: t('restaurant.marginHint') },
                  ].map(f => (
                    <div key={f.key}>
                      <label style={{ ...label, fontSize: 10, marginBottom: 4 }}>{f.label}</label>
                      <input
                        style={{ ...input, textAlign: 'center' as const, padding: '8px' }}
                        type="number"
                        value={(form as any)[f.key]}
                        onChange={e => updateForm(f.key, e.target.value)}
                      />
                      <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 3, textAlign: 'center' as const }}>{f.hint}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {error && (
              <div style={{ fontSize: 13, color: '#dc2626', padding: '10px 12px', background: '#fef2f2', borderRadius: 8, marginBottom: 12 }}>
                {error}
              </div>
            )}

            <button onClick={saveAndContinue} style={btnP}>{t('restaurant.continue')}</button>
            <button onClick={() => setStep(0)} style={btnS}>{t('restaurant.back')}</button>
          </div>
        )}

        {/* ── Step 2: Systems selection ────────────────────────── */}
        {step === 2 && (
          <div>
            <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#111' }}>{t('systems.title')}</h1>
            <p style={{ margin: '0 0 24px', fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>
              {t('systems.subtitle')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20, marginBottom: 24 }}>
              <div>
                <label style={label}>{t('systems.staff')}</label>
                <RadioGroup field="staff" options={STAFF_SYSTEMS} />
              </div>
              <div>
                <label style={label}>{t('systems.accounting')}</label>
                <RadioGroup field="accounting" options={ACCOUNTING} />
              </div>
              <div>
                <label style={label}>{t('systems.pos')}</label>
                <RadioGroup field="pos" options={POS_SYSTEMS} />
              </div>
            </div>

            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
              {t('systems.promise')}
            </div>

            <button onClick={() => setStep(3)} style={btnP}>{t('systems.continue')}</button>
            <button onClick={() => setStep(1)} style={btnS}>{t('systems.back')}</button>
          </div>
        )}

        {/* ── Step 3: All done ─────────────────────────────────── */}
        {step === 3 && (
          <div style={{ textAlign: 'center' as const }}>
            <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#f0fdf4', border: '2px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 24, color: '#15803d' }}>
              +
            </div>

            <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#111' }}>{t('done.title')}</h1>
            <p style={{ margin: '0 0 28px', fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>
              {form.restaurantName
                ? t('done.subtitleNamed', { name: form.restaurantName })
                : t('done.subtitlePlain')}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 28, textAlign: 'left' as const }}>
              {[
                { num: '1', title: t('done.next1_t'), desc: t('done.next1_d') },
                { num: '2', title: t('done.next2_t'), desc: t('done.next2_d') },
                { num: '3', title: t('done.next3_t'), desc: t('done.next3_d') },
                { num: '4', title: t('done.next4_t'), desc: t('done.next4_d') },
              ].map(a => (
                <div key={a.num} style={{ display: 'flex', gap: 12, padding: '11px 14px', background: '#f9fafb', borderRadius: 10, alignItems: 'center' }}>
                  <div style={{ width: 26, height: 26, borderRadius: '50%', background: '#1a1f2e', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, flexShrink: 0 }}>{a.num}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{a.title}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{a.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={finish} disabled={loading} style={btnP}>
              {loading ? t('done.loading') : t('done.cta')}
            </button>
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 24, fontSize: 12, color: '#d1d5db', textAlign: 'center' as const }}>
          {t('footer.needHelp')} <a href="mailto:support@comandcenter.se" style={{ color: '#6366f1', textDecoration: 'none' }}>{t('footer.contactSupport')}</a>
          {' · '}
          <a href="/privacy" style={{ color: '#6366f1', textDecoration: 'none' }}>{t('footer.privacyPolicy')}</a>
        </div>
      </div>
    </div>
  )
}
