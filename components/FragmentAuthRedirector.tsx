'use client'
// components/FragmentAuthRedirector.tsx
//
// Catches Supabase implicit-flow auth redirects that landed at the
// WRONG URL — usually because the Supabase project's "Redirect URLs"
// allowlist doesn't include our /auth/handle target, so Supabase falls
// back to "Site URL" (typically the root) and dumps tokens there.
//
// Without this, the browser shows a landing page with #access_token=...
// in the address bar and the user has no idea what's happening — or in
// the dev case, just gets ERR_CONNECTION_REFUSED if their local server
// isn't running on the localhost URL Supabase baked into the email.
//
// Render this in app/layout.tsx so it runs on EVERY route — the
// fragment can land on any path the Site URL points at, and we want
// to catch it regardless. Returns null (no UI). Re-routes to the
// real handler at /auth/handle?next=/onboarding while preserving the
// fragment, so /auth/handle's own setSession() call has the tokens
// available.

import { useEffect } from 'react'

export default function FragmentAuthRedirector() {
  useEffect(() => {
    if (typeof window === 'undefined') return

    const hash = window.location.hash ?? ''
    // Implicit-flow signal — Supabase always includes access_token
    // in the fragment when verify or signInWithOtp completes.
    if (!hash.includes('access_token=')) return

    // Already on /auth/handle → the real handler is consuming the
    // fragment, don't bounce. Avoids an infinite loop if Supabase ever
    // does point straight at the handler.
    if (window.location.pathname.startsWith('/auth/handle')) return

    // Preserve the fragment AS-IS so the handler reads access_token,
    // refresh_token, type, error_description verbatim.
    const target = '/auth/handle?next=/onboarding' + hash
    // replace, not push — don't keep the token-laden URL in history.
    window.location.replace(target)
  }, [])

  return null
}
