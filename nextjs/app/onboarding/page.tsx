// @ts-nocheck
// app/onboarding/page.tsx
//
// 6-STEP ONBOARDING WIZARD â€” shown immediately after signup.
// Progress is saved to Supabase after each step so users can
// pause and resume without losing their place.
//
// Steps:
//   1. Welcome (auto-complete)
//   2. Add your first business
//   3. Connect Fortnox
//   4. Connect POS (Ancon / Caspeco)
//   5. Connect scheduling
//   6. Done â€” go to dashboard

'use client'

import { useState, useEffect } from 'react'
import { useRouter }           from 'next/navigation'
import { createClient }        from '@/lib/supabase/client'
import { track }               from '@/lib/analytics/posthog'

type Step = 1 | 2 | 3 | 4 | 5 | 6

interface WizardState {
  step:             Step
  completedSteps:   number[]
  businessName:     string
  businessType:     string
  city:             string
  orgNumber:        string
}

const STEP_TITLES: Record<Step, string> = {
  1: 'Welcome to CommandCenter',
  2: 'Add your first restaurant',
  3: 'Connect Fortnox',
  4: 'Connect your POS',
  5: 'Connect scheduling',
  6: 'You\'re all set!',
}

const STEP_DESCS: Record<Step, string> = {
  1: 'Your 30-day free trial has started. Let\'s get you set up in under 5 minutes.',
  2: 'Tell us about your restaurant so we can configure cost targets automatically.',
  3: 'Connect your Fortnox account to automatically pull invoices and revenue data.',
  4: 'Connect your POS system to track daily sales.',
  5: 'Connect your scheduling system to track staff costs accurately.',
  6: 'Your account is configured. Head to the dashboard to see your first insights.',
}

export default function OnboardingPage() {
  const router = useRouter()
  const [state, setState] = useState<WizardState>({
    step: 1, completedSteps: [], businessName: '', businessType: 'Restaurant', city: '', orgNumber: '',
  })
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState('')

  // Load saved progress on mount
  useEffect(() => {
    loadProgress()
  }, [])

  async function loadProgress() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { router.push('/login'); return }

    const { data: org } = await supabase
      .from('organisation_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    if (!org) return

    const { data: progress } = await supabase
      .from('onboarding_progress')
      .select('current_step, steps_completed, completed_at')
      .eq('org_id', org.org_id)
      .single()

    if (progress?.completed_at) {
      // Already completed â€” go to dashboard
      router.push('/dashboard')
      return
    }

    if (progress) {
      setState(prev => ({
        ...prev,
        step:           (progress.current_step ?? 1) as Step,
        completedSteps: progress.steps_completed ?? [],
      }))
    }
  }

  async function saveProgress(step: Step, completedSteps: number[]) {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: org } = await supabase
      .from('organisation_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    if (!org) return

    await supabase
      .from('onboarding_progress')
      .update({ current_step: step, steps_completed: completedSteps, updated_at: new Date().toISOString() })
      .eq('org_id', org.org_id)
  }

  async function completeStep(step: Step, skip = false) {
    const newCompleted = [...new Set([...state.completedSteps, step])]
    const nextStep     = (step + 1) as Step

    if (!skip) track(`onboarding_step_${step}` as any)

    setState(prev => ({ ...prev, step: nextStep, completedSteps: newCompleted }))
    await saveProgress(nextStep, newCompleted)
  }

  async function handleStep2() {
    if (!state.businessName.trim()) { setError('Business name is required'); return }
    setSaving(true)
    setError('')

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: org } = await supabase
      .from('organisation_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    // Create the business
    const { error: bizError } = await supabase.from('businesses').insert({
      org_id:   org!.org_id,
      name:     state.businessName,
      type:     state.businessType,
      city:     state.city || null,
      org_number: state.orgNumber || null,
    })

    if (bizError) {
      setError('Failed to save. Please try again.')
      setSaving(false)
      return
    }

    setSaving(false)
    completeStep(2)
  }

  async function finishOnboarding() {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return

    const { data: org } = await supabase
      .from('organisation_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    if (org) {
      await supabase
        .from('onboarding_progress')
        .update({ completed_at: new Date().toISOString() })
        .eq('org_id', org.org_id)
    }

    track('onboarding_completed' as any)
    router.push('/dashboard')
  }

  const step = state.step

  return (
    <div style={S.page}>
      <div style={S.card}>

        {/* Progress dots */}
        <div style={S.dots}>
          {([1,2,3,4,5,6] as Step[]).map(s => (
            <div key={s} style={{
              ...S.dot,
              background: state.completedSteps.includes(s) ? 'var(--green)'
                : s === step ? 'var(--navy)' : 'var(--border)',
            }} />
          ))}
        </div>

        {/* Step indicator */}
        <div style={S.stepIndicator}>Step {step} of 6</div>

        {/* Title */}
        <h1 style={S.title}>{STEP_TITLES[step]}</h1>
        <p style={S.subtitle}>{STEP_DESCS[step]}</p>

        {/* â”€â”€ STEP 1: Welcome â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {step === 1 && (
          <div>
            <div style={S.featureList}>
              {[
                ['ðŸ“Š', 'Live financial tracker', 'Updates automatically from Fortnox'],
                ['ðŸ¤–', 'AI document intelligence', 'Ask questions about your invoices and reports'],
                ['ðŸ“ˆ', 'Multi-location overview', 'Compare all your restaurants in one view'],
                ['ðŸ“„', 'Automated reports', 'Monthly PDFs, Excel, and presentations'],
              ].map(([icon, title, sub]) => (
                <div key={title as string} style={S.featureItem}>
                  <span style={{ fontSize: 22 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{title}</div>
                    <div style={{ fontSize: 12, color: 'var(--ink-4)', marginTop: 1 }}>{sub}</div>
                  </div>
                </div>
              ))}
            </div>
            <button className="btn btn-primary btn-full" style={{ marginTop: 24 }} onClick={() => completeStep(1)}>
              Get started â†’
            </button>
          </div>
        )}

        {/* â”€â”€ STEP 2: Add business â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {error && <div style={S.errorBox}>{error}</div>}

            <div>
              <label style={S.label}>Restaurant / bar / cafÃ© name *</label>
              <input className="input" type="text" placeholder="Restaurang BjÃ¶rken"
                value={state.businessName} onChange={e => setState(p => ({ ...p, businessName: e.target.value }))} />
            </div>

            <div>
              <label style={S.label}>Type</label>
              <select className="input" value={state.businessType} onChange={e => setState(p => ({ ...p, businessType: e.target.value }))}>
                {['Restaurant','Bar','CafÃ©','Pub','Food truck','Catering','Other'].map(t => <option key={t}>{t}</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={S.label}>City</label>
                <input className="input" type="text" placeholder="Stockholm"
                  value={state.city} onChange={e => setState(p => ({ ...p, city: e.target.value }))} />
              </div>
              <div style={{ flex: 1 }}>
                <label style={S.label}>Org number (optional)</label>
                <input className="input" type="text" placeholder="559059-3025"
                  value={state.orgNumber} onChange={e => setState(p => ({ ...p, orgNumber: e.target.value }))} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn btn-full" onClick={() => completeStep(2, true)}>Skip for now</button>
              <button className="btn btn-primary btn-full" disabled={saving} onClick={handleStep2}>
                {saving ? <><span className="spin">âŸ³</span> Savingâ€¦</> : 'Save & continue â†’'}
              </button>
            </div>
          </div>
        )}

        {/* â”€â”€ STEP 3: Fortnox â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {step === 3 && (
          <div>
            <div style={S.infoBox}>
              <span style={{ fontSize: 20 }}>ðŸ“’</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3 }}>About Fortnox OAuth</div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6 }}>
                  Clicking "Connect Fortnox" will open Fortnox's login page. Log in with your Fortnox credentials and approve access. You'll be redirected back here automatically.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
              <button className="btn btn-full" onClick={() => completeStep(3, true)}>Skip for now</button>
              <button
                className="btn btn-primary btn-full"
                onClick={() => { track('integration_connected' as any, { provider:'fortnox', from:'onboarding' }); window.location.href = '/api/integrations/fortnox?action=connect' }}
              >
                Connect Fortnox â†’
              </button>
            </div>
          </div>
        )}

        {/* â”€â”€ STEP 4: POS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {step === 4 && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
              {[['Ancon','ðŸ–¥ï¸'],['Caspeco','ðŸ“…'],['Trivec','ðŸ–¥ï¸'],['Other','ðŸ“¤']].map(([name, icon]) => (
                <div key={name as string} style={{ background:'var(--parchment)', border:'1px solid var(--border)', borderRadius:10, padding:'14px', cursor:'pointer', textAlign:'center' }}
                     onClick={() => { track('integration_connected' as any, { provider: (name as string).toLowerCase() }); completeStep(4) }}>
                  <div style={{ fontSize: 24, marginBottom: 4 }}>{icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{name}</div>
                </div>
              ))}
            </div>
            <button className="btn btn-full" onClick={() => completeStep(4, true)}>Skip â€” I'll connect later</button>
          </div>
        )}

        {/* â”€â”€ STEP 5: Scheduling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {step === 5 && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
              {[['Caspeco','ðŸ“…'],['Personalkollen','ðŸ‘¥'],['Quinyx','ðŸ—“ï¸'],['None','â­ï¸']].map(([name, icon]) => (
                <div key={name as string} style={{ background:'var(--parchment)', border:'1px solid var(--border)', borderRadius:10, padding:'14px', cursor:'pointer', textAlign:'center' }}
                     onClick={() => completeStep(5)}>
                  <div style={{ fontSize: 24, marginBottom: 4 }}>{icon}</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{name}</div>
                </div>
              ))}
            </div>
            <button className="btn btn-full" onClick={() => completeStep(5, true)}>Skip â€” I'll connect later</button>
          </div>
        )}

        {/* â”€â”€ STEP 6: Done â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
        {step === 6 && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 56, marginBottom: 16 }}>ðŸŽ‰</div>
            <div style={S.summaryList}>
              <div style={S.summaryItem}>âœ“ Account created with 30-day free trial</div>
              {state.businessName && <div style={S.summaryItem}>âœ“ {state.businessName} added</div>}
              {state.completedSteps.includes(3) && <div style={S.summaryItem}>âœ“ Fortnox connected</div>}
              <div style={{ ...S.summaryItem, color: 'var(--ink-4)' }}>
                + Upload documents in the Notebook to start getting AI insights
              </div>
            </div>
            <button className="btn btn-primary btn-full" style={{ marginTop: 24 }} onClick={finishOnboarding}>
              Go to your dashboard â†’
            </button>
          </div>
        )}

      </div>
    </div>
  )
}

const S: Record<string, React.CSSProperties> = {
  page:      { minHeight:'100vh', background:'var(--parchment)', display:'flex', alignItems:'flex-start', justifyContent:'center', padding:'48px 20px 80px' },
  card:      { background:'var(--white)', border:'1px solid var(--border)', borderRadius:16, padding:'36px', width:500, maxWidth:'100%', boxShadow:'0 4px 24px rgba(0,0,0,.06)' },
  dots:      { display:'flex', gap:8, justifyContent:'center', marginBottom:20 },
  dot:       { width:8, height:8, borderRadius:'50%', transition:'background .2s' },
  stepIndicator: { textAlign:'center', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.1em', color:'var(--ink-4)', marginBottom:10 },
  title:     { fontFamily:'var(--display)', fontSize:24, fontWeight:300, fontStyle:'italic', color:'var(--navy)', marginBottom:8, textAlign:'center' },
  subtitle:  { fontSize:13, color:'var(--ink-3)', lineHeight:1.6, marginBottom:24, textAlign:'center' },
  label:     { display:'block', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', color:'var(--ink-4)', marginBottom:5 },
  errorBox:  { background:'var(--red-lt)', border:'1px solid var(--red-mid)', borderRadius:8, padding:'10px 14px', fontSize:13, color:'var(--red)' },
  infoBox:   { background:'var(--blue-lt)', border:'1px solid var(--blue-mid)', borderRadius:10, padding:'14px 16px', display:'flex', gap:12, alignItems:'flex-start' },
  featureList:  { display:'flex', flexDirection:'column', gap:12 },
  featureItem:  { display:'flex', alignItems:'center', gap:12, padding:'10px 12px', background:'var(--parchment)', borderRadius:9, border:'1px solid var(--border)' },
  summaryList:  { display:'flex', flexDirection:'column', gap:8, textAlign:'left', background:'var(--green-lt)', borderRadius:10, padding:'16px 18px', border:'1px solid var(--green-mid)' },
  summaryItem:  { fontSize:13, color:'var(--green)', fontWeight:500 },
}
