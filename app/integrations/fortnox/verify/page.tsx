'use client'
// app/integrations/fortnox/verify/page.tsx
//
// Phase 1 — Post-OAuth verification screen. Shown immediately after the
// Fortnox OAuth callback so the customer SEES exactly what's wired up and
// what's still completing. Polls /api/integrations/fortnox/readiness
// every ~3 s and renders a live progress list.
//
// Three terminal states:
//   - All green → "Setup complete" CTA → dashboard.
//   - Yellow / warns → "Continue to dashboard" + "Setup health" card hint.
//   - Red / fails → "Get help" CTA. Customer can still proceed but is
//     warned that numbers may be wrong until the listed issues clear.

import { useEffect, useState } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { UXP, UX } from '@/lib/constants/tokens'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'pending'
interface ReadinessCheck {
  key:       string
  label:     string
  status:    CheckStatus
  detail:    string
  evidence?: Record<string, unknown>
}
interface ReadinessResult {
  business_id:  string
  overall:      CheckStatus
  ready_to_use: boolean
  checks:       ReadinessCheck[]
  duration_ms:  number
}

const POLL_MS_PENDING = 3000
const POLL_MS_TERMINAL = 0       // stop polling once nothing is pending

export default function FortnoxVerifyPage() {
  const params = useSearchParams()
  const router = useRouter()
  const bizId = params.get('business_id') ?? ''

  const [result,  setResult]  = useState<ReadinessResult | null>(null)
  const [error,   setError]   = useState<string | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!bizId) { setError('Saknar business_id i URL'); return }
    let cancelled = false
    let timer: number | undefined

    const fetchOnce = async () => {
      try {
        const r = await fetch(`/api/integrations/fortnox/readiness?business_id=${encodeURIComponent(bizId)}`,
                              { cache: 'no-store' })
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        const j: ReadinessResult = await r.json()
        if (cancelled) return
        setResult(j)
        const hasPending = j.checks.some(c => c.status === 'pending')
        const stillPolling = hasPending
        setPolling(stillPolling)
        if (stillPolling) {
          timer = window.setTimeout(fetchOnce, POLL_MS_PENDING)
        }
      } catch (e: any) {
        if (cancelled) return
        setError(e.message)
        setPolling(false)
      }
    }
    fetchOnce()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [bizId])

  return (
    <div style={{ minHeight: '100vh', background: UXP.pageBg, padding: '40px 20px' }}>
      <div style={{
        maxWidth: 720, margin: '0 auto',
        background: UXP.cardBg, borderRadius: UXP.r_lg,
        border: `0.5px solid ${UXP.border}`,
        padding: 32,
        boxShadow: '0 1px 3px rgba(58,53,80,0.04)',
      }}>
        <div style={{ marginBottom: 24 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
            Verifierar din Fortnox-anslutning
          </h1>
          <p style={{ margin: '6px 0 0', fontSize: 13, color: UXP.ink3, lineHeight: 1.5 }}>
            Vi kontrollerar att all data är på plats så att din balansräkning, momsrapport och dashboard fungerar
            korrekt från första stund. Brukar ta 1–10 minuter beroende på hur mycket historik Fortnox skickar oss.
          </p>
        </div>

        {error && (
          <div style={{
            padding: '10px 14px', background: UXP.roseFill,
            border: `0.5px solid ${UXP.rose}`, borderRadius: UXP.r_md,
            color: UXP.roseText, fontSize: 12,
          }}>
            Kunde inte köra verifieringen: {error}
          </div>
        )}

        {!result && !error && (
          <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13 }}>
            Startar kontroller…
          </div>
        )}

        {result && (
          <>
            <div style={{ marginBottom: 18 }}>
              {result.checks.map(c => (
                <CheckRow key={c.key} check={c} />
              ))}
            </div>

            <OverallBanner result={result} polling={polling} />

            <div style={{ marginTop: 18, display: 'flex', gap: 10, alignItems: 'center' }}>
              {result.overall === 'ok' && !polling && (
                <button onClick={() => router.push('/dashboard')} style={btnPrimary}>
                  Till dashboarden →
                </button>
              )}
              {(result.overall === 'warn' || result.overall === 'pending') && (
                <>
                  <button onClick={() => router.push('/dashboard')} style={btnPrimary}>
                    Fortsätt till dashboarden
                  </button>
                  {polling && (
                    <span style={{ fontSize: 11, color: UXP.ink3 }}>
                      Resterande kontroller fortsätter i bakgrunden.
                    </span>
                  )}
                </>
              )}
              {result.overall === 'fail' && (
                <>
                  <a href="mailto:hello@comandcenter.se?subject=Fortnox-verifiering misslyckades" style={btnPrimary}>
                    Kontakta supporten
                  </a>
                  <button onClick={() => router.push('/dashboard')} style={btnSecondary}>
                    Fortsätt ändå
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function CheckRow({ check }: { check: ReadinessCheck }) {
  const tone = toneFor(check.status)
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '32px 1fr',
      gap: 10, padding: '10px 0',
      borderBottom: `0.5px solid ${UXP.borderSoft}`,
    }}>
      <div style={{ paddingTop: 2 }}>{statusIcon(check.status)}</div>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1 }}>{check.label}</div>
        <div style={{ fontSize: 12, color: tone.color, marginTop: 2, lineHeight: 1.5 }}>
          {check.detail}
        </div>
      </div>
    </div>
  )
}

function OverallBanner({ result, polling }: { result: ReadinessResult; polling: boolean }) {
  const okCount   = result.checks.filter(c => c.status === 'ok').length
  const total     = result.checks.length
  const tone = toneFor(result.overall)
  let title: string
  let body: string
  if (result.overall === 'ok') {
    title = '✓ Allt klart'
    body  = `${okCount} av ${total} kontroller godkända. Din data är redo att användas.`
  } else if (result.overall === 'fail') {
    title = '⚠ Anslutningen behöver åtgärd'
    body  = `Vi hittade kritiska problem som måste fixas i Fortnox innan vi kan garantera korrekta siffror.`
  } else if (polling) {
    title = '⏳ Bearbetar i bakgrunden'
    body  = `${okCount} av ${total} klara. Resterande hämtas just nu från Fortnox.`
  } else {
    title = '⚠ Mindre observationer'
    body  = `${okCount} av ${total} klara. Du kan använda produkten direkt — kontrollera påpekanden i Inställningar → Setup-status.`
  }
  return (
    <div style={{
      padding: '12px 14px',
      background: tone.bg,
      border:     `0.5px solid ${tone.border}`,
      borderRadius: UXP.r_md,
    }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: tone.color }}>{title}</div>
      <div style={{ fontSize: 12, color: tone.color, marginTop: 4, lineHeight: 1.5 }}>{body}</div>
    </div>
  )
}

function statusIcon(s: CheckStatus): React.ReactNode {
  if (s === 'ok')      return <span style={{ ...iconBase, background: UXP.greenFill, color: UXP.greenDeep }}>✓</span>
  if (s === 'pending') return <span style={{ ...iconBase, background: UXP.lavFill,   color: UXP.lavText }}>⋯</span>
  if (s === 'warn')    return <span style={{ ...iconBase, background: UX.amberBg,   color: UX.amberInk2 }}>!</span>
  return                       <span style={{ ...iconBase, background: UXP.roseFill, color: UXP.roseText }}>✕</span>
}

function toneFor(s: CheckStatus) {
  if (s === 'ok')      return { bg: UXP.greenFill, border: UXP.green,       color: UXP.greenDeep }
  if (s === 'pending') return { bg: UXP.lavFill,   border: UXP.lavMid,      color: UXP.lavText   }
  if (s === 'warn')    return { bg: UX.amberBg,   border: UX.amberBorder, color: UX.amberInk2 }
  return                       { bg: UXP.roseFill, border: UXP.rose,        color: UXP.roseText  }
}

const iconBase: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  width:          22,
  height:         22,
  borderRadius:   '50%',
  fontSize:       11,
  fontWeight:     700,
}

const btnPrimary: React.CSSProperties = {
  padding:      '8px 18px',
  background:   UXP.ink1,
  color:        '#fff',
  border:       'none',
  borderRadius: UXP.r_md,
  fontSize:     13,
  fontWeight:   500,
  cursor:       'pointer',
  textDecoration: 'none' as const,
  display:      'inline-block',
}

const btnSecondary: React.CSSProperties = {
  padding:      '8px 18px',
  background:   'transparent',
  color:        UXP.ink2,
  border:       `0.5px solid ${UXP.border}`,
  borderRadius: UXP.r_md,
  fontSize:     13,
  fontWeight:   500,
  cursor:       'pointer',
}
