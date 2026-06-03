'use client'
// app/settings/setup-health/page.tsx
//
// Phase 2 — Setup Health page. Read-only view of every readiness check
// for a given business + a Re-run button + a VAT cadence picker. Linked
// from the dashboard widget AND from the verify screen ("Inställningar →
// Setup-status").
//
// URL: /settings/setup-health?business_id=X
// If no business_id is provided, picks the user's first active business.

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { PageContainer } from '@/components/ui/Layout'
import { UXP, UX } from '@/lib/constants/tokens'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'pending'
interface Check {
  key:    string
  label:  string
  status: CheckStatus
  detail: string
}
interface ReadinessResult {
  business_id:  string
  overall:      CheckStatus
  ready_to_use: boolean
  checks:       Check[]
  duration_ms:  number
}
interface Business {
  id:                  string
  name:                string
  vat_filing_cadence?: 'monthly' | 'quarterly' | 'annually' | null
}

export default function SetupHealthPage() {
  const params = useSearchParams()
  const queryBizId = params.get('business_id')

  const [businesses, setBusinesses]   = useState<Business[]>([])
  const [bizId,      setBizId]        = useState<string>(queryBizId ?? '')
  const [readiness,  setReadiness]    = useState<ReadinessResult | null>(null)
  const [loading,    setLoading]      = useState(false)
  const [error,      setError]        = useState<string | null>(null)
  const [cadenceSaving, setCadenceSaving] = useState(false)

  // 1. Load the user's businesses on mount; pick the queried one or the first.
  useEffect(() => {
    fetch('/api/businesses?all=true', { cache: 'no-store' })
      .then(r => r.json())
      .then((bs: Business[]) => {
        const list = Array.isArray(bs) ? bs : []
        setBusinesses(list)
        if (!bizId && list[0]) setBizId(list[0].id)
      })
      .catch(() => {})
  }, [])

  // 2. When bizId changes, run the readiness check.
  useEffect(() => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    fetch(`/api/integrations/fortnox/readiness?business_id=${encodeURIComponent(bizId)}`,
          { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        return r.json()
      })
      .then((j: ReadinessResult) => setReadiness(j))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [bizId])

  const currentBiz = businesses.find(b => b.id === bizId)

  const saveCadence = async (cadence: 'monthly' | 'quarterly' | 'annually') => {
    if (!bizId) return
    setCadenceSaving(true)
    try {
      const r = await fetch('/api/settings/vat-cadence', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ business_id: bizId, cadence }),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      // Refresh businesses + readiness
      const bs = await fetch('/api/businesses?all=true', { cache: 'no-store' }).then(r => r.json())
      if (Array.isArray(bs)) setBusinesses(bs)
      // Re-run readiness so the VAT cadence check flips to OK
      const rr = await fetch(`/api/integrations/fortnox/readiness?business_id=${encodeURIComponent(bizId)}`,
                             { cache: 'no-store' })
      if (rr.ok) setReadiness(await rr.json())
    } catch (e: any) {
      setError(`Kunde inte spara momsperiod: ${e.message}`)
    } finally {
      setCadenceSaving(false)
    }
  }

  return (
    <AppShell>
      <PageContainer maxWidth={800}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
          Setup-status
        </h1>
        <p style={{ margin: '6px 0 20px', fontSize: 13, color: UXP.ink3, maxWidth: 640, lineHeight: 1.5 }}>
          Vi kör 12 kontroller mot dina data så att balansräkning, momsrapport och dashboard fungerar korrekt.
          Här kan du se status och köra om kontrollerna när som helst.
        </p>

        {/* Business picker (only shown if multiple) */}
        {businesses.length > 1 && (
          <div style={{ marginBottom: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: UXP.ink3, fontWeight: 500 }}>Verksamhet:</span>
            <select
              value={bizId}
              onChange={e => setBizId(e.target.value)}
              style={selectStyle}
            >
              {businesses.map(b => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* VAT cadence picker */}
        {currentBiz && (
          <div style={card}>
            <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink3, letterSpacing: '0.06em',
                          textTransform: 'uppercase' as const, marginBottom: 8 }}>
              Momsperiod (SKV)
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12, color: UXP.ink2, lineHeight: 1.5 }}>
              Hur ofta du redovisar moms till Skatteverket. Driver omfånget på <b>Momsrapporten</b> — kvartalsvis är vanligast för restauranger (omsättning 1–40 MSEK).
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['monthly', 'quarterly', 'annually'] as const).map(c => {
                const isSelected = currentBiz.vat_filing_cadence === c
                const label = c === 'monthly' ? 'Månadsvis' : c === 'quarterly' ? 'Kvartalsvis' : 'Årsvis'
                return (
                  <button
                    key={c}
                    onClick={() => saveCadence(c)}
                    disabled={cadenceSaving}
                    style={{
                      ...pillButton,
                      background: isSelected ? UXP.lavFill : 'transparent',
                      color:      isSelected ? UXP.lavText : UXP.ink2,
                      border:     `0.5px solid ${isSelected ? UXP.lavMid : UXP.border}`,
                      cursor:     cadenceSaving ? 'wait' : 'pointer',
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        {/* Re-run / overall banner */}
        {readiness && (
          <div style={{
            ...card,
            background: toneFor(readiness.overall).bg,
            border:     `0.5px solid ${toneFor(readiness.overall).border}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: toneFor(readiness.overall).color }}>
                  {readiness.overall === 'ok'      ? '✓ Allt klart'         :
                   readiness.overall === 'pending' ? '⏳ Bearbetar'         :
                   readiness.overall === 'warn'    ? '⚠ Mindre observationer' :
                                                     '✕ Behöver åtgärd'}
                </div>
                <div style={{ fontSize: 11, color: toneFor(readiness.overall).color, marginTop: 4 }}>
                  {readiness.checks.filter(c => c.status === 'ok').length} av {readiness.checks.length} kontroller godkända.
                </div>
              </div>
              <button
                onClick={() => bizId && setBizId(bizId)}   // trigger useEffect
                disabled={loading}
                style={{
                  padding: '6px 14px', fontSize: 12, fontWeight: 500,
                  background: UXP.cardBg, color: UXP.ink2,
                  border: `0.5px solid ${UXP.border}`, borderRadius: 6,
                  cursor: loading ? 'wait' : 'pointer',
                }}
              >
                {loading ? 'Kör…' : 'Kör om'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            padding: '10px 14px', background: UXP.roseFill,
            border: `0.5px solid ${UXP.rose}`, borderRadius: UXP.r_md,
            color: UXP.roseText, fontSize: 12, marginBottom: 16,
          }}>
            {error}
          </div>
        )}

        {loading && !readiness && (
          <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13 }}>
            Kör kontroller…
          </div>
        )}

        {/* Check list */}
        {readiness && (
          <div style={card}>
            {readiness.checks.map(c => (
              <div key={c.key} style={{
                display: 'grid', gridTemplateColumns: '32px 1fr',
                gap: 10, padding: '10px 0',
                borderBottom: `0.5px solid ${UXP.borderSoft}`,
              }}>
                <div style={{ paddingTop: 2 }}>{statusIcon(c.status)}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1 }}>{c.label}</div>
                  <div style={{ fontSize: 12, color: toneFor(c.status).color, marginTop: 2, lineHeight: 1.5 }}>
                    {c.detail}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </PageContainer>
    </AppShell>
  )
}

function statusIcon(s: CheckStatus): React.ReactNode {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 700,
  }
  if (s === 'ok')      return <span style={{ ...base, background: UXP.greenFill, color: UXP.greenDeep }}>✓</span>
  if (s === 'pending') return <span style={{ ...base, background: UXP.lavFill,   color: UXP.lavText   }}>⋯</span>
  if (s === 'warn')    return <span style={{ ...base, background: UX.amberBg,    color: UX.amberInk2  }}>!</span>
  return                       <span style={{ ...base, background: UXP.roseFill, color: UXP.roseText  }}>✕</span>
}

function toneFor(s: CheckStatus) {
  if (s === 'ok')      return { bg: UXP.greenFill, border: UXP.green,       color: UXP.greenDeep }
  if (s === 'pending') return { bg: UXP.lavFill,   border: UXP.lavMid,      color: UXP.lavText   }
  if (s === 'warn')    return { bg: UX.amberBg,    border: UX.amberBorder,  color: UX.amberInk2  }
  return                       { bg: UXP.roseFill, border: UXP.rose,        color: UXP.roseText  }
}

const card: React.CSSProperties = {
  background:   UXP.cardBg,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: UXP.r_lg,
  padding:      16,
  marginBottom: 16,
  boxShadow:    '0 1px 3px rgba(58,53,80,0.04)',
}

const selectStyle: React.CSSProperties = {
  padding:      '6px 10px',
  fontSize:     13,
  background:   UXP.cardBg,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: 6,
  color:        UXP.ink1,
  fontFamily:   'inherit',
}

const pillButton: React.CSSProperties = {
  padding:      '6px 14px',
  fontSize:     12,
  fontWeight:   500,
  borderRadius: 999,
  fontFamily:   'inherit',
  transition:   'all 120ms ease',
}
