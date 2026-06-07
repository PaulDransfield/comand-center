'use client'
// app/global-error.tsx
// Catches React rendering errors at the root level and reports them to Sentry.
// Shown when the entire app crashes — should never be seen by users normally.

import * as Sentry from '@sentry/nextjs'
import { useEffect } from 'react'

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    Sentry.captureException(error)
  }, [error])

  return (
    <html>
      <body>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', background: '#f1eff9', padding: 20 }}>
          <div style={{
            maxWidth: 480, width: '100%',
            background: '#ffffff',
            border: '0.5px solid rgba(58,53,80,0.08)',
            borderRadius: 10, padding: 24,
            boxShadow: '0 6px 20px rgba(58,53,80,0.10)',
            textAlign: 'left',
          }}>
            <div style={{
              display: 'inline-block',
              padding: '3px 8px',
              background: '#fef3e0',
              border: '0.5px solid rgba(192,112,58,0.33)',
              borderRadius: 5,
              fontSize: 10,
              color: '#c0703a',
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginBottom: 12,
            }}>
              Error
            </div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600, color: '#3a3550', lineHeight: 1.3 }}>
              Something went wrong loading the app.
            </h2>
            <p style={{ margin: '0 0 16px', color: 'rgba(58,53,80,0.62)', fontSize: 13, lineHeight: 1.5 }}>
              We had to stop loading. Our team has been notified automatically.
              Try reloading; if it keeps happening, email support.
            </p>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                onClick={reset}
                style={{
                  padding: '8px 16px', background: '#7d6cc9', color: 'white',
                  border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="mailto:support@comandcenter.se?subject=CommandCenter%20crashed"
                style={{
                  padding: '8px 16px', background: '#ffffff', color: '#3a3550',
                  border: '0.5px solid rgba(58,53,80,0.08)', borderRadius: 6,
                  fontSize: 13, fontWeight: 500, textDecoration: 'none',
                  display: 'inline-flex', alignItems: 'center',
                }}
              >
                Report this
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
