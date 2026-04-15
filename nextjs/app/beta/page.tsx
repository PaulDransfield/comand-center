// @ts-nocheck
// app/beta/page.tsx
//
// BETA PROGRAM SIGNUP PAGE
// A clean landing page where potential beta users register their interest.
//
// What happens when someone submits:
//   1. Their details go into the beta_signups table in Supabase
//   2. You (Paul) get a Slack notification
//   3. They see a confirmation with next steps
//
// The admin view at /beta/admin shows all signups and lets you approve/reject them.

'use client'

import { useState }  from 'react'
import { track }     from '@/lib/analytics/posthog'

interface FormData {
  name:           string
  email:          string
  restaurant_name:string
  locations:      string
  pos_system:     string
  accounting:     string
  biggest_pain:   string
  referral:       string
}

const EMPTY: FormData = {
  name: '', email: '', restaurant_name: '', locations: '1',
  pos_system: '', accounting: '', biggest_pain: '', referral: '',
}

export default function BetaPage() {
  const [form,      setForm]      = useState<FormData>(EMPTY)
  const [submitted, setSubmitted] = useState(false)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')

  function set(k: keyof FormData, v: string) {
    setForm(prev => ({ ...prev, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    track('beta_signup_submitted' as any, {
      pos_system:   form.pos_system,
      accounting:   form.accounting,
      locations:    form.locations,
    })

    const res = await fetch('/api/beta/signup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(form),
    })

    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      setError(d.error ?? 'Something went wrong. Please try again.')
      setLoading(false)
      return
    }

    setSubmitted(true)
    setLoading(false)
  }

  if (submitted) {
    return (
      <div style={S.page}>
        <div style={S.card}>
          <div style={{ fontSize: 48, marginBottom: 12, textAlign: 'center' }}>ðŸŽ‰</div>
          <h1 style={{ ...S.title, textAlign: 'center' }}>You're on the list!</h1>
          <p style={{ ...S.subtitle, textAlign: 'center', marginBottom: 20 }}>
            We'll be in touch within 24 hours to set up your account and onboarding call.
          </p>
          <div style={S.confirmBox}>
            <div style={S.confirmItem}>âœ“ Account will be created with your details</div>
            <div style={S.confirmItem}>âœ“ 90-day extended trial (instead of 30)</div>
            <div style={S.confirmItem}>âœ“ Direct line to Paul for support during beta</div>
            <div style={S.confirmItem}>âœ“ Your feedback shapes the product roadmap</div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={S.page}>
      <div style={S.card}>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--navy)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--display)', fontSize: 12, fontWeight: 700, color: 'white' }}>CC</div>
          <span style={{ fontFamily: 'var(--display)', fontSize: 16, fontWeight: 600, color: 'var(--navy)' }}>CommandCenter</span>
          <span style={{ marginLeft: 4, fontSize: 11, fontWeight: 700, padding: '2px 8px', background: 'var(--amber-lt)', color: 'var(--amber)', borderRadius: 8, border: '1px solid rgba(122,72,0,.2)' }}>BETA</span>
        </div>

        {/* Heading */}
        <h1 style={S.title}>Join the beta</h1>
        <p style={S.subtitle}>
          We're onboarding 5â€“10 Swedish restaurant groups to test CommandCenter before public launch.
          Beta users get 90 days free and direct input into the product roadmap.
        </p>

        {/* Benefits */}
        <div style={S.benefitsRow}>
          {[
            ['ðŸ¤–', '90-day free trial', 'vs 30 days at launch'],
            ['ðŸ“ž', 'Onboarding call', 'Personal setup with Paul'],
            ['ðŸ—ºï¸', 'Shape the roadmap', 'Your feedback is priority'],
          ].map(([icon, title, sub]) => (
            <div key={title as string} style={S.benefit}>
              <span style={{ fontSize: 20 }}>{icon}</span>
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
                <div style={{ fontSize: 11, color: 'var(--ink-4)' }}>{sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          <div style={S.fieldRow}>
            <Field label="Your name *" required>
              <input className="input" type="text" placeholder="Paul Dransfield" required
                value={form.name} onChange={e => set('name', e.target.value)} />
            </Field>
            <Field label="Email *" required>
              <input className="input" type="email" placeholder="paul@restaurant.se" required
                value={form.email} onChange={e => set('email', e.target.value)} />
            </Field>
          </div>

          <Field label="Restaurant / group name *" required>
            <input className="input" type="text" placeholder="Vero Italiano AB" required
              value={form.restaurant_name} onChange={e => set('restaurant_name', e.target.value)} />
          </Field>

          <div style={S.fieldRow}>
            <Field label="Number of locations">
              <select className="input" value={form.locations} onChange={e => set('locations', e.target.value)}>
                {['1','2','3','4-6','7-10','10+'].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="POS system">
              <select className="input" value={form.pos_system} onChange={e => set('pos_system', e.target.value)}>
                <option value="">Selectâ€¦</option>
                {['Ancon','Caspeco','Trivec','Lightspeed','Other','None'].map(v => <option key={v}>{v}</option>)}
              </select>
            </Field>
            <Field label="Accounting system">
              <select className="input" value={form.accounting} onChange={e => set('accounting', e.target.value)}>
                <option value="">Selectâ€¦</option>
                {['Fortnox','Visma','PE Accounting','Other'].map(v => <option key={v}>{v}</option>)}
              </select>
            </Field>
          </div>

          <Field label="What's your biggest financial reporting pain today?">
            <textarea
              style={{ width: '100%', padding: '9px 12px', border: '1.5px solid var(--border-d)', borderRadius: 8, fontFamily: 'var(--font)', fontSize: 13, color: 'var(--ink)', resize: 'none', minHeight: 72, background: 'var(--parchment)', outline: 'none' }}
              placeholder="e.g. 'I spend 4 hours every month pulling numbers from Fortnox into Excelâ€¦'"
              value={form.biggest_pain}
              onChange={e => set('biggest_pain', e.target.value)}
            />
          </Field>

          <Field label="How did you hear about CommandCenter?">
            <input className="input" type="text" placeholder="LinkedIn, friend, Googleâ€¦"
              value={form.referral} onChange={e => set('referral', e.target.value)} />
          </Field>

          {error && (
            <div style={{ background: 'var(--red-lt)', border: '1px solid var(--red-mid)', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: 'var(--red)' }}>
              {error}
            </div>
          )}

          <button
            type="submit"
            className="btn btn-primary btn-full"
            disabled={loading}
            style={{ marginTop: 4 }}
          >
            {loading ? <><span className="spin">âŸ³</span> Submittingâ€¦</> : 'Apply for beta access â†’'}
          </button>

          <p style={{ fontSize: 11, color: 'var(--ink-4)', textAlign: 'center', lineHeight: 1.5 }}>
            By submitting, you agree to our privacy policy. We'll never share your details with third parties.
          </p>
        </form>

      </div>
    </div>
  )
}

function Field({ label, children, required }: { label: string; children: React.ReactNode; required?: boolean }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: 'var(--ink-4)', marginBottom: 5 }}>
        {label}
      </label>
      {children}
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:     { minHeight: '100vh', background: 'var(--parchment)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px 80px' },
  card:     { background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 16, padding: '36px', width: 620, maxWidth: '100%', boxShadow: '0 4px 24px rgba(0,0,0,.06)' },
  title:    { fontFamily: 'var(--display)', fontSize: 28, fontWeight: 300, fontStyle: 'italic', color: 'var(--navy)', marginBottom: 8 },
  subtitle: { fontSize: 14, color: 'var(--ink-3)', lineHeight: 1.6, marginBottom: 20 },
  benefitsRow: { display: 'flex', gap: 12, marginBottom: 24 },
  benefit:     { flex: 1, background: 'var(--parchment)', borderRadius: 9, padding: '12px', display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12 },
  fieldRow:    { display: 'flex', gap: 12 },
  confirmBox:  { background: 'var(--green-lt)', borderRadius: 10, padding: '16px 18px', border: '1px solid var(--green-mid)' },
  confirmItem: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--green)', fontWeight: 500, marginBottom: 8, lineHeight: 1.5 },
}
