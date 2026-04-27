// lib/auth/get-org.ts
//
// Extracts the authenticated org context from any request.
// Works with both cookie-based sessions (browser) and Bearer tokens (API).

import { createAdminClient } from '@/lib/supabase/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'

export interface OrgContext {
  userId: string
  orgId:  string
  role:   'owner' | 'admin' | 'viewer' | 'accountant'
  plan:   'trial' | 'starter' | 'pro' | 'enterprise' | 'past_due'
}

export async function getOrgFromRequest(request: Request): Promise<OrgContext | null> {
  // Mock authentication was previously enabled whenever NODE_ENV === 'development'
  // OR the Supabase URL included a sentinel substring. Both heuristics made it
  // trivial to ship a deployment that was silently unauthenticated. Removed.
  //
  // If you genuinely need a local mock, set ENABLE_AUTH_MOCK=1 explicitly and
  // run against real Supabase for dev instead.
  if (process.env.ENABLE_AUTH_MOCK === '1') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ENABLE_AUTH_MOCK must never be set in production')
    }
    console.warn('[auth] mock enabled via ENABLE_AUTH_MOCK=1 — do not ship')
    return {
      userId: request.headers.get('x-mock-user-id') || 'mock-user-id-123',
      orgId:  request.headers.get('x-mock-org-id')  || 'mock-org-id-456',
      role:   'owner',
      plan:   'pro',
    }
  }

  const supabase = createAdminClient()
  let userId: string | null = null

  // Try Bearer token first (API calls)
  const token = request.headers.get('authorization')?.replace('Bearer ', '')
  if (token) {
    const { data: { user } } = await supabase.auth.getUser(token)
    if (user) userId = user.id
  }

  // Fall back to cookie session (browser navigation)
  if (!userId) {
    try {
      const cookieStore = cookies()
      const browserClient = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            getAll() { return cookieStore.getAll() },
            setAll() {},
          },
        }
      )
      const { data: { session } } = await browserClient.auth.getSession()
      if (session?.user) userId = session.user.id
    } catch {}
  }

  if (!userId) return null

  // Look up org membership.
  //
  // Multi-org selection: pick the EARLIEST-joined org deterministically.
  // .single() previously threw for any user with ≥2 memberships, making
  // them appear unauthenticated forever — invisible bug today (Paul has
  // one org) but blocks the first accountant or consolidating-group
  // customer from logging in.
  //
  // TODO: replace with explicit org selection (cookie or query param) when
  // we add multi-org users. Today this picks the user's earliest membership;
  // that's deterministic but won't let an accountant switch between client
  // orgs. Mirror change in lib/supabase/server.ts::getRequestAuth.
  const { data: membership } = await supabase
    .from('organisation_members')
    .select(`
      org_id,
      role,
      organisations (
        plan,
        is_active
      )
    `)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!membership) return null

  const org = membership.organisations as any
  if (!org?.is_active) return null

  return {
    userId,
    orgId:  membership.org_id,
    role:   membership.role as OrgContext['role'],
    plan:   (org?.plan || 'trial') as OrgContext['plan'],
  }
}

export function requireRole(auth: OrgContext, minRole: 'admin' | 'owner') {
  const RANK: Record<string, number> = {
    accountant: 0, viewer: 1, admin: 2, owner: 3,
  }
  if ((RANK[auth.role] ?? 0) < RANK[minRole]) {
    throw Response.json(
      { error: 'You do not have permission to perform this action.' },
      { status: 403 }
    )
  }
}
