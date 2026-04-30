'use client'
// app/settings/company/page.tsx
//
// Company info — currently just the organisationsnummer. Designed as a
// dedicated minimal page so the soft-banner CTA lands somewhere focused.
// More fields (legal address, VAT number, etc.) can land here in future
// PRs without changing the entry point.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import PageHero from '@/components/ui/PageHero'
import { UX } from '@/lib/constants/tokens'
import { formatOrgNr, validateOrgNr } from '@/lib/sweden/orgnr'

interface CompanyInfo {
  id:                    string
  name:                  string
  org_number:            string | null
  org_number_display:    string | null
  org_number_set_at:     string | null
  grace_days_remaining:  number
  in_grace:              boolean
  grace_expired:         boolean
}

export default function CompanySettingsPage() {
  const router = useRouter()
  const t      = useTranslations('settings.company')
  const [info,       setInfo]      = useState<CompanyInfo | null>(null)
  const [loading,    setLoading]   = useState<boolean>(true)
  const [draft,      setDraft]     = useState<string>('')
  const [validation, setValidation] = useState<string | null>(null)
  const [saving,     setSaving]    = useState<boolean>(false)
  const [savedAt,    setSavedAt]   = useState<number | null>(null)

  async function load() {
    setLoading(true)
    try {
      const r = await fetch('/api/settings/company-info', { cache: 'no-store' })
      const j = await r.json()
      if (j?.organisation) {
        setInfo(j.organisation)
        setDraft(j.organisation.org_number_display ?? '')
      }
    } catch (e: any) {
      console.warn('[company-settings] load failed:', e?.message)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function onChange(value: string) {
    setDraft(value)
    setValidation(null)
  }

  async function save() {
    const check = validateOrgNr(draft)
    if (!check.ok) {
      setValidation(check.error)
      return
    }
    setSaving(true)
    setValidation(null)
    try {
      const r = await fetch('/api/settings/company-info', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ org_number: check.value }),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j?.error ?? t('saveFailed'))
      setSavedAt(Date.now())
      await load()
    } catch (e: any) {
      setValidation(e?.message ?? t('saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const headline = info?.org_number
    ? t('headline.set')
    : info?.grace_expired
      ? t('headline.expired')
      : t('headline.grace', { days: info?.grace_days_remaining ?? 30 })

  return (
    <AppShell>
      <PageHero
        eyebrow={t('eyebrow')}
        headline={headline}
        context={t('context')}
      />

      <div style={{ padding: '0 24px 40px', maxWidth: 720, margin: '0 auto' }}>
        {info?.grace_expired && !info.org_number && (
          <div style={{
            background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
            padding: '12px 16px', marginBottom: 14,
            color: '#991b1b', fontSize: 13,
          }}>
            <strong>{t('expired')}</strong> {t('expiredFollowup')}
          </div>
        )}

        <div style={{
          background: 'white', border: `1px solid ${UX.borderSoft}`, borderRadius: 10,
          padding: 18, marginBottom: 14,
        }}>
          <label style={{
            display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
            textTransform: 'uppercase' as const, color: UX.ink3, marginBottom: 6,
          }}>
            {t('label')}
          </label>
          <input
            type="text"
            value={draft}
            onChange={e => onChange(e.target.value)}
            placeholder="556677-8899"
            inputMode="numeric"
            disabled={loading || saving}
            style={{
              width: '100%', padding: '10px 12px', border: `1px solid ${UX.border}`,
              borderRadius: 8, fontSize: 14, fontFamily: 'ui-monospace, monospace',
              color: UX.ink1, boxSizing: 'border-box' as const,
            }}
          />
          <div style={{ fontSize: 11, color: UX.ink4, marginTop: 6 }}>
            {t('hint')}
          </div>

          {validation && (
            <div style={{
              marginTop: 10, padding: '8px 10px', background: '#fef2f2',
              border: '1px solid #fecaca', borderRadius: 7, fontSize: 12, color: '#991b1b',
            }}>
              {validation}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <div style={{ fontSize: 11, color: UX.ink4 }}>
              {info?.org_number && info.org_number_set_at && (
                <>{t('setOn', { date: new Date(info.org_number_set_at).toLocaleDateString('sv-SE') })}</>
              )}
              {savedAt && Date.now() - savedAt < 5000 && (
                <span style={{ color: UX.greenInk, marginLeft: 8 }}>· {t('saved')}</span>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving || !draft.trim()}
              style={{
                padding: '8px 16px',
                background: saving || !draft.trim() ? UX.ink4 : UX.ink1,
                color: 'white', border: 'none', borderRadius: 7,
                fontSize: 12, fontWeight: 500,
                cursor: saving || !draft.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? t('saving') : info?.org_number ? t('update') : t('save')}
            </button>
          </div>
        </div>

        <div style={{ fontSize: 11, color: UX.ink4, lineHeight: 1.5, padding: '0 4px' }}>
          {t('whyTitle')}
          <ul style={{ paddingLeft: 18, marginTop: 4 }}>
            <li>{t('why1')}</li>
            <li>{t('why2')}</li>
            <li>{t('why3')}</li>
          </ul>
        </div>
      </div>
    </AppShell>
  )
}
