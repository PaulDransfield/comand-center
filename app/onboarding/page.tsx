'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { validateOrgNr, formatOrgNr } from '@/lib/sweden/orgnr'

const RESTAURANT_TYPE_KEYS = ['restaurant', 'bar', 'cafe', 'bakery', 'catering', 'group'] as const
const STAGE_KEYS            = ['new', 'established_1y', 'established_3y'] as const
const DAY_KEYS              = ['mon','tue','wed','thu','fri','sat','sun'] as const

const STAFF_SYSTEMS = ['Personalkollen', 'Caspeco', 'Quinyx', 'Planday', 'Other', 'None']
const ACCOUNTING    = ['Fortnox', 'Visma', 'Bokio', 'Other', 'None']
const POS_SYSTEMS   = ['Ancon', 'Swess', 'Trivec', 'Zettle', 'Other', 'None']

export default function OnboardingPage() {
  const router = useRouter()
  const t      = useTranslations('onboarding')
  // 3-step wizard. The old "Welcome" slide was marketing, not data
  // capture — dropped so the progress bar reflects real progress.
  const STEPS  = [t('steps.restaurant'), t('steps.systems'), t('steps.done')]

  const [step,    setStep]    = useState(0)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [businessId, setBusinessId] = useState<string | null>(null)

  // M046 follow-up: org_number is currently collected at /api/auth/signup
  // (look at the signup form on /login). The wizard would be asking for
  // it twice. On mount, peek at /api/settings/company-info — if the org
  // already has one, hide the field + skip its validation. If signup is
  // ever simplified to drop org-nr collection, this just lights the
  // field back up automatically.
  const [orgAlreadySet, setOrgAlreadySet] = useState<boolean>(false)
  const [orgPreview,    setOrgPreview]    = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/company-info', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled || !j?.organisation) return
        if (j.organisation.org_number) {
          setOrgAlreadySet(true)
          setOrgPreview(j.organisation.org_number_display ?? j.organisation.org_number)
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const [form, setForm] = useState({
    restaurantName:  '',
    city:            '',
    type:            'restaurant',
    address:         '',
    orgNumber:       '',
    businessStage:   '',
    targetFoodCost:  '31',
    targetStaffCost: '35',
    targetMargin:    '15',
  })

  const [openDays, setOpenDays] = useState<Record<string, boolean>>(
    Object.fromEntries(DAY_KEYS.map(d => [d, true]))
  )

  const [systems, setSystems] = useState({
    staff:      '',
    accounting: '',
    pos:        '',
  })

  // PDF upload state for step 2 (only relevant when businessStage !== 'new')
  const [pdfFile,    setPdfFile]    = useState<File | null>(null)
  const [pdfStatus,  setPdfStatus]  = useState<'idle' | 'uploading' | 'uploaded' | 'failed'>('idle')
  const [pdfError,   setPdfError]   = useState<string>('')

  function updateForm(field: string, value: string) {
    setForm(f => ({ ...f, [field]: value }))
    setError('')
  }
  function toggleDay(d: string) {
    setOpenDays(o => ({ ...o, [d]: !o[d] }))
    setError('')
  }
  function updateSystem(field: string, value: string) {
    setSystems(f => ({ ...f, [field]: value }))
  }

  // Restaurant step → Systems step: validate, then create the business
  // so Systems can attach an optional PDF upload to a real business_id.
  // If creation already happened (user went back and forward), don't
  // double-create.
  async function saveAndContinue() {
    if (!form.restaurantName.trim()) {
      setError(t('restaurant.errors.missingName')); return
    }
    if (!form.address.trim()) {
      setError(t('restaurant.errors.missingAddress')); return
    }
    // Skip org-nr validation when it was already collected during signup
    // (the field is hidden in that case — see orgAlreadySet effect above).
    if (!orgAlreadySet) {
      const orgCheck = validateOrgNr(form.orgNumber)
      if (!orgCheck.ok) {
        setError(form.orgNumber.trim()
          ? t('restaurant.errors.invalidOrgNumber')
          : t('restaurant.errors.missingOrgNumber'))
        return
      }
    }
    if (!form.businessStage) {
      setError(t('restaurant.errors.missingStage')); return
    }
    if (!Object.values(openDays).some(Boolean)) {
      setError(t('restaurant.errors.noOpenDays')); return
    }
    setError('')

    if (businessId) { setStep(1); return }

    setLoading(true)
    try {
      const r = await fetch('/api/businesses/add', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:              form.restaurantName.trim(),
          city:              form.city.trim(),
          type:              form.type,
          address:           form.address.trim(),
          // We DON'T set org_number on the business row here — the
          // org-level org_number written via /api/onboarding/complete
          // is the authoritative one (drives invoicing). Per-business
          // org_number is reserved for restaurant groups with multiple
          // legal entities, which they can fill in later.
          opening_days:      openDays,
          business_stage:    form.businessStage,
          target_food_pct:   parseFloat(form.targetFoodCost)  || 31,
          target_staff_pct:  parseFloat(form.targetStaffCost) || 35,
          target_margin_pct: parseFloat(form.targetMargin)    || 15,
        }),
      })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error || 'Failed to create restaurant')
      }
      const j = await r.json()
      setBusinessId(j?.id ?? null)
      setStep(1)
    } catch (e: any) {
      setError(e?.message || 'Something went wrong')
    } finally {
      setLoading(false)
    }
  }

  // Step 2 PDF upload — fires immediately on file pick. Best-effort:
  // failure here doesn't block the wizard, the owner can re-upload from
  // /overheads later.
  async function uploadPdf(file: File) {
    if (!businessId) {
      setPdfStatus('failed')
      setPdfError('No business id')
      return
    }
    setPdfFile(file)
    setPdfStatus('uploading')
    setPdfError('')
    try {
      const fd = new FormData()
      fd.append('business_id', businessId)
      fd.append('files', file)
      const r = await fetch('/api/fortnox/upload', { method: 'POST', body: fd })
      if (!r.ok) {
        const j = await r.json().catch(() => ({}))
        throw new Error(j?.error || `HTTP ${r.status}`)
      }
      setPdfStatus('uploaded')
    } catch (e: any) {
      setPdfStatus('failed')
      setPdfError(e?.message || 'Upload failed')
    }
  }

  async function finish() {
    setLoading(true)
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
    // Complete onboarding — also writes the org-level org_number
    // (M046 made this required; the helper validates server-side).
    await fetch('/api/onboarding/complete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        business_name: form.restaurantName,
        city:          form.city,
        systems:       systems,
        // Only send org_number when it was NOT already set (the field
        // wasn't shown in that case, so form.orgNumber is empty). The
        // complete endpoint treats absent org_number as a no-op.
        ...(orgAlreadySet ? {} : { org_number: form.orgNumber }),
      }),
    }).catch(() => {})
    router.push('/dashboard')
  }

  // Styles
  const card:  React.CSSProperties = { background: 'white', borderRadius: 16, padding: '40px 36px', width: '100%', maxWidth: 520, boxShadow: '0 4px 32px rgba(0,0,0,0.10)' }
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

        {/* ── Step 0: Restaurant details ───────────────────────── */}
        {step === 0 && (
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

              <div>
                <label style={label}>{t('restaurant.address')}</label>
                <input style={input} value={form.address} onChange={e => updateForm('address', e.target.value)} placeholder={t('restaurant.addressPlaceholder')} />
              </div>

              {/* Org-nr field — only shown when the value isn't already on
                  the org row (signup may have already captured it; double-
                  asking is a known papercut). */}
              {!orgAlreadySet && (
                <div>
                  <label style={label}>{t('restaurant.orgNumber')}</label>
                  <input
                    style={input}
                    value={form.orgNumber}
                    onChange={e => updateForm('orgNumber', e.target.value)}
                    placeholder={t('restaurant.orgNumberPlaceholder')}
                    inputMode="numeric"
                  />
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>{t('restaurant.orgNumberHint')}</div>
                </div>
              )}

              <div>
                <label style={label}>{t('restaurant.stage')}</label>
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 6 }}>
                  {STAGE_KEYS.map(k => (
                    <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: form.businessStage === k ? '#eff6ff' : '#f9fafb', border: `1.5px solid ${form.businessStage === k ? '#6366f1' : '#f3f4f6'}`, borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151' }}>
                      <input type="radio" name="stage" value={k} checked={form.businessStage === k} onChange={() => updateForm('businessStage', k)} style={{ accentColor: '#6366f1' }} />
                      {t(`restaurant.stageOptions.${k}`)}
                    </label>
                  ))}
                </div>
              </div>

              <div>
                <label style={label}>{t('restaurant.openingDays')}</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                  {DAY_KEYS.map(d => {
                    const on = openDays[d]
                    return (
                      <button
                        key={d}
                        type="button"
                        onClick={() => toggleDay(d)}
                        style={{
                          padding: '8px 14px',
                          background:   on ? '#1a1f2e' : '#f9fafb',
                          color:        on ? 'white'   : '#6b7280',
                          border:       `1.5px solid ${on ? '#1a1f2e' : '#e5e7eb'}`,
                          borderRadius: 8,
                          fontSize: 12,
                          fontWeight: 600,
                          cursor: 'pointer',
                          minWidth: 52,
                        }}
                      >
                        {t(`restaurant.days.${d}`)}
                      </button>
                    )
                  })}
                </div>
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>{t('restaurant.openingDaysHint')}</div>
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

            <button onClick={saveAndContinue} disabled={loading} style={btnP}>
              {loading ? t('done.loading') : t('restaurant.continue')}
            </button>
            {/* No "back" — Restaurant is the first step now. */}
          </div>
        )}

        {/* ── Step 1: Systems selection ────────────────────────── */}
        {step === 1 && (
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

            {/* Optional PDF upload — only for established businesses; a
                "new" business has no last-year results to pre-load. */}
            {form.businessStage !== 'new' && businessId && (
              <div style={{ background: '#f9fafb', border: '1px dashed #e5e7eb', borderRadius: 10, padding: '14px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>{t('systems.upload.title')}</div>
                <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.55, marginBottom: 12 }}>{t('systems.upload.subtitle')}</div>

                {pdfStatus === 'idle' && (
                  <label style={{ display: 'inline-block', padding: '8px 14px', background: '#1a1f2e', color: 'white', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                    {t('systems.upload.cta')}
                    <input
                      type="file"
                      accept="application/pdf"
                      style={{ display: 'none' }}
                      onChange={e => {
                        const f = e.target.files?.[0]
                        if (f) uploadPdf(f)
                      }}
                    />
                  </label>
                )}
                {pdfStatus === 'uploading' && pdfFile && (
                  <div style={{ fontSize: 12, color: '#6b7280' }}>{t('systems.upload.uploading')} — {pdfFile.name}</div>
                )}
                {pdfStatus === 'uploaded' && pdfFile && (
                  <div style={{ fontSize: 12, color: '#15803d' }}>
                    ✓ {t('systems.upload.selected', { name: pdfFile.name })}
                    <div style={{ marginTop: 4, color: '#6b7280' }}>{t('systems.upload.uploaded')}</div>
                  </div>
                )}
                {pdfStatus === 'failed' && (
                  <div style={{ fontSize: 12, color: '#dc2626' }}>
                    {t('systems.upload.failed', { error: pdfError })}
                  </div>
                )}
              </div>
            )}

            <button onClick={() => setStep(2)} style={btnP}>{t('systems.continue')}</button>
            <button onClick={() => setStep(0)} style={btnS}>{t('systems.back')}</button>
          </div>
        )}

        {/* ── Step 2: All done ─────────────────────────────────── */}
        {step === 2 && (
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
