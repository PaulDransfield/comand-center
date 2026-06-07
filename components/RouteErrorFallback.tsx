'use client'
// components/RouteErrorFallback.tsx
//
// Shared "something went wrong" surface for Next.js route-segment error
// boundaries. Imported by every app/**/error.tsx so the failure UI looks
// identical regardless of which page crashed. Uses UXP palette to match
// the rest of the app.
//
// What the user sees: a contained card with a short explanation, the
// digest id (for support ticket cross-reference), a "Try again" button
// (calls Next.js reset()) and a "Report this" mailto link. No emojis.
// Sentry capture is fired from a useEffect so it logs even when the
// user never clicks anything.

import { useEffect } from 'react'
import * as Sentry from '@sentry/nextjs'
import { UXP } from '@/lib/constants/tokens'

interface Props {
  error: Error & { digest?: string }
  reset: () => void
  // Optional surface label so the UI can say which area crashed:
  // "We hit a snag loading your inventory." Defaults to a generic line.
  surface?: string
}

export function RouteErrorFallback({ error, reset, surface }: Props) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { surface: surface ?? 'unknown' },
    })
    // Also log to console so devs see the actual error during dev.
    // In production this is swallowed by Sentry.
    if (typeof console !== 'undefined') console.error('[RouteError]', error)
  }, [error, surface])

  const digest = error.digest ?? 'no-digest'
  const subject = `[CommandCenter] Error on ${surface ?? 'the app'} (${digest})`
  const body = `Hi,\n\nI hit an error on ${surface ?? 'the app'} just now.\n\nError digest: ${digest}\n\nWhat I was doing:\n\n\n\nThanks!`
  const mailto = `mailto:support@comandcenter.se?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`

  return (
    <div style={{
      minHeight: '60vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 20,
    }}>
      <div style={{
        maxWidth: 480,
        width: '100%',
        background: UXP.cardBg,
        border: `0.5px solid ${UXP.border}`,
        borderRadius: 10,
        padding: 24,
        boxShadow: '0 6px 20px rgba(58,53,80,0.10)',
        textAlign: 'left' as const,
      }}>
        <div style={{
          display: 'inline-block',
          padding: '3px 8px',
          background: '#fef3e0',
          border: `0.5px solid ${UXP.coral}55`,
          borderRadius: 5,
          fontSize: 10,
          color: UXP.coral,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase' as const,
          marginBottom: 12,
        }}>
          Error
        </div>
        <h2 style={{
          margin: '0 0 8px',
          fontSize: 18,
          fontWeight: 600,
          color: UXP.ink1,
          lineHeight: 1.3,
        }}>
          {surface
            ? `We hit a snag loading ${surface}.`
            : 'Something went wrong loading this page.'}
        </h2>
        <p style={{
          margin: '0 0 16px',
          fontSize: 13,
          color: UXP.ink2,
          lineHeight: 1.5,
        }}>
          The rest of the app is still working — you can keep using other pages
          from the sidebar. Our team has been notified automatically.
        </p>
        <div style={{
          padding: '8px 10px',
          background: UXP.subtleBg,
          border: `0.5px solid ${UXP.border}`,
          borderRadius: 6,
          fontSize: 10,
          color: UXP.ink3,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          marginBottom: 16,
          wordBreak: 'break-all' as const,
        }}>
          Reference: {digest}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
          <button
            onClick={reset}
            style={{
              padding: '8px 16px',
              background: UXP.lavDeep,
              color: '#fff',
              border: 'none',
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Try again
          </button>
          <a
            href={mailto}
            style={{
              padding: '8px 16px',
              background: UXP.cardBg,
              color: UXP.ink1,
              border: `0.5px solid ${UXP.border}`,
              borderRadius: 6,
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none' as const,
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            Report this
          </a>
        </div>
      </div>
    </div>
  )
}
