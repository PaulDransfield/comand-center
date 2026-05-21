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
import { UXP } from '@/lib/constants/tokens'
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
      <div style={{ maxWidth: 720 }}>
        <div style={{ marginBottom: 14 }}>
          <div style={{
            fontSize:      10,
            fontWeight:    600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color:         UXP.lavText,
            marginBottom:  4,
          }}>
            {t('eyebrow')}
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1, letterSpacing: '-0.01em' }}>
            {headline}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            {t('context')}
          </p>
        </div>
        {info?.grace_expired && !info.org_number && (
          <div style={{
            background: UXP.roseFill, border: `1px solid ${UXP.rose}`, borderRadius: 10,
            padding: '12px 16px', marginBottom: 14,
            color: UXP.roseText, fontSize: 13,
          }}>
            <strong>{t('expired')}</strong> {t('expiredFollowup')}
          </div>
        )}

        <div style={{
          background: 'white', border: `1px solid ${UXP.borderSoft}`, borderRadius: 10,
          padding: 18, marginBottom: 14,
        }}>
          <label style={{
            display: 'block', fontSize: 11, fontWeight: 600, letterSpacing: '0.06em',
            textTransform: 'uppercase' as const, color: UXP.ink3, marginBottom: 6,
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
              width: '100%', padding: '10px 12px', border: `1px solid ${UXP.border}`,
              borderRadius: 8, fontSize: 14, fontFamily: 'ui-monospace, monospace',
              color: UXP.ink1, boxSizing: 'border-box' as const,
            }}
          />
          <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 6 }}>
            {t('hint')}
          </div>

          {validation && (
            <div style={{
              marginTop: 10, padding: '8px 10px', background: UXP.roseFill,
              border: `1px solid ${UXP.rose}`, borderRadius: 7, fontSize: 12, color: UXP.roseText,
            }}>
              {validation}
            </div>
          )}

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <div style={{ fontSize: 11, color: UXP.ink4 }}>
              {info?.org_number && info.org_number_set_at && (
                <>{t('setOn', { date: new Date(info.org_number_set_at).toLocaleDateString('sv-SE') })}</>
              )}
              {savedAt && Date.now() - savedAt < 5000 && (
                <span style={{ color: UXP.greenDeep, marginLeft: 8 }}>· {t('saved')}</span>
              )}
            </div>
            <button
              onClick={save}
              disabled={saving || !draft.trim()}
              style={{
                padding: '8px 16px',
                background: saving || !draft.trim() ? UXP.ink4 : UXP.ink1,
                color: 'white', border: 'none', borderRadius: 7,
                fontSize: 12, fontWeight: 500,
                cursor: saving || !draft.trim() ? 'not-allowed' : 'pointer',
              }}
            >
              {saving ? t('saving') : info?.org_number ? t('update') : t('save')}
            </button>
          </div>
        </div>

        <div style={{ fontSize: 11, color: UXP.ink4, lineHeight: 1.5, padding: '0 4px' }}>
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
