'use client'
// @ts-nocheck
// app/auth/handle/page.tsx
//
// Client-side landing for Supabase implicit-flow auth redirects (the
// "after you click the verify-your-email link" page).
//
// Why this exists: `auth.admin.generateLink({type:'signup'})` produces
// a magic URL that goes through Supabase's /auth/v1/verify endpoint,
// which then redirects to our `redirect_to` with tokens in the URL
// FRAGMENT (#access_token=...&refresh_token=...). The fragment is
// browser-only — it never reaches the server — so /api/auth/callback
// (which expects a ?code= query param from the PKCE flow) sees nothing
// and bounces.
//
// This page reads the fragment in JS, hands the tokens to the Supabase
// browser client to set a real session cookie, then redirects to
// ?next=/onboarding (or wherever the email-builder pointed).
//
// /api/auth/callback stays in place — it handles the OTHER flow
// (password-reset, magic-link sign-in via PKCE) where Supabase DOES
// produce a ?code= query param.

export const dynamic = 'force-dynamic'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

function HandleInner() {
  const params = useSearchParams()
  const [status, setStatus] = useState<'parsing' | 'setting' | 'redirecting' | 'error'>('parsing')
  const [error,  setError]  = useState<string>('')

  useEffect(() => {
    if (typeof window === 'undefined') return

    // Two failure modes encoded in the fragment by Supabase:
    //   error_description=...  — the verification token was bad/expired
    //   (no fragment at all)   — link was tampered with or already used
    const hash = (window.location.hash ?? '').replace(/^#/, '')
    const fragment = new URLSearchParams(hash)

    const errDesc = fragment.get('error_description') ?? fragment.get('error')
    if (errDesc) {
      setError(decodeURIComponent(errDesc).replace(/\+/g, ' '))
      setStatus('error')
      return
    }

    const accessToken  = fragment.get('access_token')
    const refreshToken = fragment.get('refresh_token')
    if (!accessToken || !refreshToken) {
      setError('This confirmation link is missing its token. It may have already been used or copied incorrectly. Try signing in again or request a new link.')
      setStatus('error')
      return
    }

    setStatus('setting')
    const supabase = createClient()
    supabase.auth.setSession({
      access_token:  accessToken,
      refresh_token: refreshToken,
    }).then(({ error: setErr }) => {
      if (setErr) {
        setError(setErr.message ?? 'Failed to establish session.')
        setStatus('error')
        return
      }
      setStatus('redirecting')
      // Default destination = /onboarding (the signup confirmation flow).
      // Magic-link / OTP flows can pass next=/dashboard explicitly via
      // the email builder.
      const next = params.get('next') || '/onboarding'
      // Use replace, not push — don't leave the token-laden URL in
      // history. The hash is dropped automatically by replace().
      window.location.replace(next)
    })
  }, [params])

  return (
    <div style={{ minHeight: '100vh', background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}>
      <div style={{ background: 'white', borderRadius: 14, padding: '32px 36px', maxWidth: 480, width: '100%', boxShadow: '0 4px 24px rgba(0,0,0,.08)', textAlign: 'center' as const }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: '#1a1f2e', marginBottom: 18, letterSpacing: '-0.01em' }}>CommandCenter</div>
        {status !== 'error' && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#111', marginBottom: 8 }}>Signing you in…</div>
            <div style={{ fontSize: 13, color: '#6b7280', lineHeight: 1.55 }}>
              {status === 'parsing'      && 'Reading verification link…'}
              {status === 'setting'      && 'Setting up your session…'}
              {status === 'redirecting'  && 'Redirecting to onboarding…'}
            </div>
          </>
        )}
        {status === 'error' && (
          <>
            <div style={{ fontSize: 18, fontWeight: 600, color: '#991b1b', marginBottom: 10 }}>Confirmation failed</div>
            <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.55, marginBottom: 18 }}>{error}</div>
            <a
              href="/login"
              style={{ display: 'inline-block', padding: '10px 20px', background: '#1a1f2e', color: 'white', textDecoration: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600 }}
            >
              Back to sign in
            </a>
          </>
        )}
      </div>
    </div>
  )
}

export default function AuthHandlePage() {
  return (
    <Suspense fallback={null}>
      <HandleInner />
    </Suspense>
  )
}
