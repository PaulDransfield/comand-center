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
// Uses createServerClient with all request cookies so @supabase/ssr can
// reassemble chunked cookies (sb-<ref>-auth-token.0, .1 …) automatically.
// Returns { userId, orgId } or null if not authenticated.
export async function getRequestAuth(req: NextRequest): Promise<{ userId: string; orgId: string } | null> {
  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll:  () => req.cookies.getAll(),
          setAll:  () => {},           // read-only in API routes
        },
      }
    )
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return null

    const adminDb = createAdminClient()
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
