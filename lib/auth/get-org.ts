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
  // DEVELOPMENT MODE: Return mock authentication for local development
  if (process.env.NODE_ENV === 'development' || 
      process.env.NEXT_PUBLIC_SUPABASE_URL?.includes('mock-supabase-url-for-development')) {
    console.log('DEVELOPMENT MODE: Using mock authentication')
    
    // Check for mock user header or return default mock user
    const mockUserId = request.headers.get('x-mock-user-id') || 'mock-user-id-123'
    const mockOrgId = request.headers.get('x-mock-org-id') || 'mock-org-id-456'
    
    return {
      userId: mockUserId,
      orgId: mockOrgId,
      role: 'owner' as OrgContext['role'],
      plan: 'pro' as OrgContext['plan'],
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

  // Look up org membership
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
    .single()

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
