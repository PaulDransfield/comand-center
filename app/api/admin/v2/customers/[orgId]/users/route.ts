// app/api/admin/v2/customers/[orgId]/users/route.ts
// READ-ONLY user list for the Users sub-tab.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const { data: members } = await db
    .from('organisation_members')
    .select('user_id, role, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })

  const users: any[] = []
  for (const m of members ?? []) {
    try {
      const { data } = await db.auth.admin.getUserById(m.user_id)
      users.push({
        user_id:        m.user_id,
        role:           m.role,
        joined_at:      m.created_at,
        email:          data?.user?.email ?? null,
        last_sign_in_at: data?.user?.last_sign_in_at ?? null,
        created_at:     data?.user?.created_at ?? null,
        confirmed:      !!data?.user?.email_confirmed_at,
      })
    } catch {
      users.push({
        user_id:    m.user_id,
        role:       m.role,
        joined_at:  m.created_at,
        email:      null,
        last_sign_in_at: null,
        created_at: null,
        confirmed:  false,
      })
    }
  }

  return NextResponse.json({ users, total: users.length }, { headers: { 'Cache-Control': 'no-store' } })
}
