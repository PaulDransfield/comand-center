// @ts-nocheck
// lib/supabase/server.ts
// Server-side Supabase clients for API routes and Server Components.

import { createServerClient } from '@supabase/ssr'
import { cookies }            from 'next/headers'
import type { NextRequest }   from 'next/server'

export function createClient() {
  const cookieStore = cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            )
          } catch {}
        },
      },
    }
  )
}

export function createAdminClient() {
  // Uses the service role key — bypasses RLS, for server-only use
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      cookies: {
        getAll() { return [] },
        setAll() {},
      },
    }
  )
}

// ── Shared auth helper for API routes ────────────────────────────────────────
// Reads the Supabase session from request cookies, handles @supabase/ssr v0.3+
// chunked cookie storage (sb-<ref>-auth-token.0, .1, …), extracts the JWT,
// validates it with the admin client, and resolves the org membership.
// Returns { userId, orgId, role, plan } or null if not authenticated.
//
// Prefer this over lib/auth/get-org.ts `getOrgFromRequest`; this one has a
// battle-tested cookie parser (the other one relies on createServerClient's
// session getter which misses some Supabase cookie formats silently).
export async function getRequestAuth(
  req: NextRequest
): Promise<{ userId: string; orgId: string; role: string; plan: string } | null> {
  try {
    const BASE = 'sb-llzmixkrysduztsvmfzi-auth-token'

    // Read the session value — @supabase/ssr may spread large JWTs across
    // multiple cookies named BASE.0, BASE.1, …
    let raw: string | null = req.cookies.get(BASE)?.value ?? null

    if (!raw) {
      // Base cookie absent — try collecting indexed chunks
      const chunks: string[] = []
      for (let i = 0; ; i++) {
        const c = req.cookies.get(`${BASE}.${i}`)?.value
        if (!c) break
        chunks.push(c)
      }
      if (chunks.length) raw = chunks.join('')
    } else if (/^\d+$/.test(raw.trim())) {
      // Base cookie holds only the chunk count, not the token itself
      const n = parseInt(raw, 10)
      const chunks: string[] = []
      for (let i = 0; i < n; i++) {
        const c = req.cookies.get(`${BASE}.${i}`)?.value
        if (c) chunks.push(c)
      }
      if (chunks.length) raw = chunks.join('')
    }

    // Bearer-token fallback — some pages still pass the access_token via
    // Authorization. Useful for API-only calls and for the AskAI component
    // which pulls session via supabase-js then forwards it.
    if (!raw) {
      const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      if (bearer && bearer.length > 20) raw = bearer
    }

    if (!raw) return null

    // Extract the JWT access_token from the stored session object
    let accessToken = raw
    try {
      const decoded = decodeURIComponent(raw)
      const parsed  = JSON.parse(decoded)
      if (Array.isArray(parsed))        accessToken = parsed[0]
      else if (parsed?.access_token)    accessToken = parsed.access_token
    } catch {
      // raw is already a plain JWT — use as-is
    }

    // Validate and resolve org membership + plan using the admin client
    const adminDb = createAdminClient()
    const { data: { user } } = await adminDb.auth.getUser(accessToken)
    if (!user) return null

    // Multi-org selection: pick the EARLIEST-joined org deterministically.
    // .single() previously threw for any user with ≥2 memberships, making
    // them appear unauthenticated forever — invisible bug today (Paul has
    // one org) but blocks the first accountant or consolidating-group
    // customer from logging in.
    //
    // TODO: replace with explicit org selection (cookie or query param) when
    // we add multi-org users. Today this picks the user's earliest membership;
    // that's deterministic but won't let an accountant switch between client
    // orgs. Mirror change in lib/auth/get-org.ts.
    const { data: m } = await adminDb
      .from('organisation_members')
      .select('org_id, role, organisations(plan, is_active)')
      .eq('user_id', user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle()

    if (!m) return null
    const org = (m as any).organisations
    if (org && org.is_active === false) return null

    const result = {
      userId: user.id,
      orgId:  (m as any).org_id,
      role:   (m as any).role || 'viewer',
      plan:   org?.plan || 'trial',
    }

    // Attach this customer to the current Sentry scope so any error captured
    // later in the request is tagged by org + plan. No-op when Sentry is off.
    try {
      const { setSentryUser } = await import('@/lib/monitoring/sentry')
      setSentryUser({ orgId: result.orgId, userId: result.userId, plan: result.plan })
    } catch { /* non-fatal */ }

    return result
  } catch {
    return null
  }
}
