// app/api/admin/v2/customers/[orgId]/users/[userId]/route.ts
//
// Edit + remove a single member. Admin-only.
//
// PATCH body: { role?, business_ids?, can_view_finances? } — partial update
// DELETE → removes the membership row (the auth user remains so they can
//          still sign in to other orgs they belong to)

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const VALID_ROLES = new Set(['owner', 'manager', 'viewer'])

export async function PATCH(req: NextRequest, { params }: { params: { orgId: string; userId: string } }) {
  const { orgId, userId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}

  const patch: Record<string, any> = {}
  if (Object.prototype.hasOwnProperty.call(body, 'role')) {
    if (!VALID_ROLES.has(String(body.role))) {
      return NextResponse.json({ error: `role must be one of: ${Array.from(VALID_ROLES).join(', ')}` }, { status: 400 })
    }
    patch.role = body.role
  }
  if (Object.prototype.hasOwnProperty.call(body, 'business_ids')) {
    const arr = body.business_ids
    if (arr === null) patch.business_ids = null
    else if (Array.isArray(arr)) patch.business_ids = arr.length > 0 ? arr : null
    else return NextResponse.json({ error: 'business_ids must be an array or null' }, { status: 400 })
  }
  if (Object.prototype.hasOwnProperty.call(body, 'can_view_finances')) {
    patch.can_view_finances = !!body.can_view_finances
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'no valid fields supplied' }, { status: 400 })
  }

  const db = createAdminClient()

  const { data: prev } = await db
    .from('organisation_members')
    .select('role, business_ids, can_view_finances')
    .eq('org_id', orgId).eq('user_id', userId)
    .maybeSingle()
  if (!prev) return NextResponse.json({ error: 'member not found' }, { status: 404 })

  const { error } = await db.from('organisation_members')
    .update(patch)
    .eq('org_id', orgId)
    .eq('user_id', userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db as any, {
    action:     'member_update' as any,
    orgId,
    targetType: 'user',
    targetId:   userId,
    payload:    { surface: 'admin_v2', prev, next: patch },
    req,
  })

  return NextResponse.json({ ok: true, ...patch })
}

export async function DELETE(req: NextRequest, { params }: { params: { orgId: string; userId: string } }) {
  const { orgId, userId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  // Don't let admin remove the last owner — would orphan the org.
  const { data: owners } = await db
    .from('organisation_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .eq('role', 'owner')
  if ((owners ?? []).length === 1 && owners![0].user_id === userId) {
    return NextResponse.json({
      error: 'Cannot remove the last owner. Promote another member first.',
    }, { status: 400 })
  }

  const { error } = await db.from('organisation_members')
    .delete()
    .eq('org_id', orgId)
    .eq('user_id', userId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db as any, {
    action:     'member_remove' as any,
    orgId,
    targetType: 'user',
    targetId:   userId,
    payload:    { surface: 'admin_v2' },
    req,
  })

  return NextResponse.json({ ok: true })
}
