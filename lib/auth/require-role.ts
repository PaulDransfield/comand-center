// lib/auth/require-role.ts
//
// API-route guard. Wraps `getRequestAuth` and returns either the auth
// subject (when the role + path is allowed) or a 403 NextResponse the
// caller returns directly.
//
// Usage:
//   const auth = await requireRoleForRoute(req)
//   if ('error' in auth) return auth.error
//   // ...auth.userId, auth.orgId, auth.role, auth.businessIds...
//
// The path argument defaults to req.nextUrl.pathname so most callers
// don't need to think about it. Pass an explicit path when the auth
// check needs to be different from the request URL (rare).

import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuth } from '@/lib/supabase/server'
import { canAccessPath, type AuthSubject } from '@/lib/auth/permissions'

export interface AuthOk {
  userId:          string
  orgId:           string
  role:            string
  plan:            string
  businessIds:     string[] | null
  canViewFinances: boolean
}

export type AuthGuardResult =
  | AuthOk
  | { error: NextResponse }

export async function requireRoleForRoute(
  req: NextRequest,
  pathOverride?: string,
): Promise<AuthGuardResult> {
  const auth = await getRequestAuth(req)
  if (!auth) {
    return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) }
  }

  const path = pathOverride ?? req.nextUrl?.pathname ?? ''
  const subject: AuthSubject = {
    role:              (auth.role as any) ?? 'viewer',
    business_ids:      auth.businessIds,
    can_view_finances: auth.canViewFinances,
  }

  if (!canAccessPath(subject, path)) {
    return {
      error: NextResponse.json({
        error: 'Forbidden — your role does not include access to this resource.',
        role:  auth.role,
      }, { status: 403 }),
    }
  }

  return auth
}

/**
 * Helper for routes that take a `business_id` query param. Returns 403
 * when the business isn't in the authenticated subject's scope.
 */
export function requireBusinessAccess(auth: AuthOk, businessId: string | null | undefined): NextResponse | null {
  if (!businessId) return null
  if (auth.role === 'owner') return null
  if (auth.businessIds == null) return null
  if (auth.businessIds.includes(businessId)) return null
  return NextResponse.json({
    error: 'Forbidden — this business is outside your assigned scope.',
  }, { status: 403 })
}
