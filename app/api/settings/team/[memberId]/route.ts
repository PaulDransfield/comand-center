// app/api/settings/team/[memberId]/route.ts
//
// Remove a member from the owner's org. memberId = user_id (the FK
// from organisation_members). Owner can remove anyone EXCEPT themselves
// — the org always needs at least one owner. Removing also clears the
// CASCADE-protected child rows.
//
// Doesn't delete the auth.users row — that's intentional. If the
// same person is later re-invited (different role, or same role on a
// different scope) we don't want to recreate the auth identity.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(req: NextRequest, { params }: { params: { memberId: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const memberId = params.memberId
  if (!memberId) return NextResponse.json({ error: 'memberId required' }, { status: 400 })

  if (memberId === auth.userId) {
    return NextResponse.json({
      error: 'You cannot remove yourself. Contact support if you need to transfer ownership.',
    }, { status: 400 })
  }

  const db = createAdminClient()

  // Sanity: the membership must belong to the caller's org. Without
  // this check an owner could DELETE memberships in another org by
  // guessing user_ids.
  const { data: existing } = await db
    .from('organisation_members')
    .select('user_id, role, org_id')
    .eq('org_id', auth.orgId)
    .eq('user_id', memberId)
    .maybeSingle()
  if (!existing) {
    return NextResponse.json({ error: 'Member not found in your org' }, { status: 404 })
  }
  if (existing.role === 'owner') {
    return NextResponse.json({
      error: 'Cannot remove an owner via this endpoint.',
    }, { status: 400 })
  }

  const { error } = await db
    .from('organisation_members')
    .delete()
    .eq('org_id', auth.orgId)
    .eq('user_id', memberId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, removed: memberId })
}
