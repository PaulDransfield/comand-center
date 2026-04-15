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
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'sans-serif', background: '#f9fafb' }}>
          <div style={{ textAlign: 'center', maxWidth: 400, padding: 32 }}>
            <div style={{ fontSize: 32, marginBottom: 16 }}>⚠️</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, color: '#111' }}>Something went wrong</h2>
            <p style={{ color: '#6b7280', fontSize: 14, marginBottom: 24 }}>
              An unexpected error occurred. Our team has been notified automatically.
            </p>
            <button
              onClick={reset}
              style={{ padding: '10px 20px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer' }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
