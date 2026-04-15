'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const STEPS = ['Welcome', 'Your restaurant', 'Your systems', 'All done']

const RESTAURANT_TYPES = [
  { value: 'restaurant', label: 'Restaurant' },
  { value: 'bar',        label: 'Bar & Nightclub' },
  { value: 'cafe',       label: 'Cafe' },
  { value: 'bakery',     label: 'Bakery' },
  { value: 'catering',   label: 'Catering' },
  { value: 'group',      label: 'Restaurant Group' },
]

const STAFF_SYSTEMS = ['Personalkollen', 'Caspeco', 'Quinyx', 'Planday', 'Other', 'None']
const ACCOUNTING    = ['Fortnox', 'Visma', 'Bokio', 'Other', 'None']
const POS_SYSTEMS   = ['Ancon', 'Swess', 'Trivec', 'Zettle', 'Other', 'None']

export default function OnboardingPage() {
  const router = useRouter()

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
      setError('Please enter your restaurant name')
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
          Step {step + 1} of {STEPS.length}
        </div>

        {/* ── Step 0: Welcome ─────────────────────────────────── */}
        {step === 0 && (
          <div>
            <h1 style={{ margin: '0 0 10px', fontSize: 26, fontWeight: 700, color: '#111', lineHeight: 1.2 }}>
              Welcome to CommandCenter
            </h1>
            <p style={{ margin: '0 0 28px', fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>
              Your all-in-one platform for managing restaurant finances, staff costs and performance. We will get you set up in about 2 minutes.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 28 }}>
              {[
                { title: 'P&L Tracker',        desc: 'Track revenue, costs and profit every month' },
                { title: 'Staff management',    desc: 'Hours, costs and department breakdowns' },
                { title: 'Smart forecasting',   desc: 'AI predictions based on your history' },
                { title: 'AI assistant',        desc: 'Ask questions about your business in plain language' },
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

            <button onClick={() => setStep(1)} style={btnP}>Get started</button>
          </div>
        )}

        {/* ── Step 1: Restaurant details ───────────────────────── */}
        {step === 1 && (
          <div>
            <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#111' }}>Your restaurant</h1>
            <p style={{ margin: '0 0 24px', fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>Tell us the basics so we can set up your account.</p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14, marginBottom: 20 }}>
              <div>
                <label style={label}>Restaurant name</label>
                <input style={input} value={form.restaurantName} onChange={e => updateForm('restaurantName', e.target.value)} placeholder="e.g. Vero Italiano" />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={label}>City</label>
                  <input style={input} value={form.city} onChange={e => updateForm('city', e.target.value)} placeholder="e.g. Stockholm" />
                </div>
                <div>
                  <label style={label}>Type</label>
                  <select style={input} value={form.type} onChange={e => updateForm('type', e.target.value)}>
                    {RESTAURANT_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ background: '#f9fafb', borderRadius: 10, padding: '14px 16px' }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 12 }}>Cost targets</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  {[
                    { key: 'targetFoodCost',  label: 'Food cost %',  hint: '28-35%' },
                    { key: 'targetStaffCost', label: 'Staff cost %', hint: '30-40%' },
                    { key: 'targetMargin',    label: 'Net margin %', hint: '10-20%' },
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

            <button onClick={saveAndContinue} style={btnP}>Continue</button>
            <button onClick={() => setStep(0)} style={btnS}>Back</button>
          </div>
        )}

        {/* ── Step 2: Systems selection ────────────────────────── */}
        {step === 2 && (
          <div>
            <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#111' }}>Your systems</h1>
            <p style={{ margin: '0 0 24px', fontSize: 14, color: '#6b7280', lineHeight: 1.6 }}>
              Tell us which systems you use. Our team will connect everything for you — no technical work needed on your end.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 20, marginBottom: 24 }}>
              <div>
                <label style={label}>Staff scheduling</label>
                <RadioGroup field="staff" options={STAFF_SYSTEMS} />
              </div>
              <div>
                <label style={label}>Accounting</label>
                <RadioGroup field="accounting" options={ACCOUNTING} />
              </div>
              <div>
                <label style={label}>POS system</label>
                <RadioGroup field="pos" options={POS_SYSTEMS} />
              </div>
            </div>

            <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: '12px 14px', marginBottom: 16, fontSize: 13, color: '#92400e', lineHeight: 1.6 }}>
              Our team will set up your connections within 1 business day and email you when everything is ready.
            </div>

            <button onClick={() => setStep(3)} style={btnP}>Continue</button>
            <button onClick={() => setStep(1)} style={btnS}>Back</button>
          </div>
        )}

        {/* ── Step 3: All done ─────────────────────────────────── */}
        {step === 3 && (
          <div style={{ textAlign: 'center' as const }}>
            <div style={{ width: 60, height: 60, borderRadius: '50%', background: '#f0fdf4', border: '2px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 20px', fontSize: 24, color: '#15803d' }}>
              +
            </div>

            <h1 style={{ margin: '0 0 10px', fontSize: 22, fontWeight: 700, color: '#111' }}>You are all set!</h1>
            <p style={{ margin: '0 0 28px', fontSize: 14, color: '#6b7280', lineHeight: 1.7 }}>
              {form.restaurantName || 'Your restaurant'} is ready. Our team will be in touch within 1 business day to connect your systems. In the meantime, explore the platform.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10, marginBottom: 28, textAlign: 'left' as const }}>
              {[
                { num: '1', title: 'View your dashboard',     desc: 'See your KPIs and performance overview'   },
                { num: '2', title: 'Check the forecast page', desc: 'AI predictions for upcoming months'       },
                { num: '3', title: 'Try the AI assistant',    desc: 'Ask questions about your business'        },
                { num: '4', title: 'Upload an invoice',       desc: 'AI reads and categorises it automatically' },
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
              {loading ? 'Loading...' : 'Go to dashboard'}
            </button>
          </div>
        )}

        {/* Footer */}
        <div style={{ marginTop: 24, fontSize: 12, color: '#d1d5db', textAlign: 'center' as const }}>
          Need help? <a href="mailto:paul@laweka.com" style={{ color: '#6366f1', textDecoration: 'none' }}>Contact support</a>
          {' · '}
          <a href="/privacy" style={{ color: '#6366f1', textDecoration: 'none' }}>Privacy Policy</a>
        </div>
      </div>
    </div>
  )
}
