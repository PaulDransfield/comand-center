// app/api/auth/me/route.ts
//
// Client-callable endpoint returning the current user's auth subject.
// Used by <RoleGate>, the sidebar permission filter, and any client
// component that needs to render conditionally on role.
//
// Returns the same shape as `getRequestAuth` so client + server agree
// on the rule. Never returns sensitive data — no email, no plan
// pricing, no internal flags.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  return NextResponse.json({
    userId:            auth.userId,
    orgId:             auth.orgId,
    role:              auth.role,
    plan:              auth.plan,
    business_ids:      auth.businessIds,
    can_view_finances: auth.canViewFinances,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
