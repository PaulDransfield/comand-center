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
// Returns { userId, orgId } or null if not authenticated.
export async function getRequestAuth(req: NextRequest): Promise<{ userId: string; orgId: string } | null> {
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

    // Validate and resolve org membership using the service-role admin client
    const adminDb = createAdminClient()
    const { data: { user } } = await adminDb.auth.getUser(accessToken)
    if (!user) return null

    const { data: m } = await adminDb
      .from('organisation_members')
      .select('org_id')
      .eq('user_id', user.id)
      .single()

    return m ? { userId: user.id, orgId: m.org_id } : null
  } catch {
    return null
  }
}
