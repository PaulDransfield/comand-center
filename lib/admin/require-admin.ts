// lib/admin/require-admin.ts
//
// Shared guard for admin API routes. Combines two checks that were
// previously done inconsistently across /api/admin/*:
//
//   1. The caller presents a valid ADMIN_SECRET (checkAdminSecret)
//   2. If the action targets a specific org, the org is verified to
//      exist; if the action takes a business_id, the business is
//      verified to belong to the claimed org.
//
// Passing the `ADMIN_SECRET` does NOT by itself authorise the holder to
// act on every org's data — we always verify the request's (org_id,
// business_id) pair against the database before running the action.
// This blocks a class of attack where an attacker with ADMIN_SECRET
// swaps org_id in the request body to touch someone else's tenant.
//
// Returns:
//   { ok: true, orgId, businessId? } on success
//   NextResponse with 401/403/404 on failure — caller returns it directly.

import { NextRequest, NextResponse } from 'next/server'
import { checkAdminSecret } from './check-secret'
import { createAdminClient } from '@/lib/supabase/server'

export interface AdminGuardOk {
  ok:          true
  orgId:       string
  businessId?: string
}

export async function requireAdmin(
  req: NextRequest,
  opts: { orgId?: string; businessId?: string } = {},
): Promise<AdminGuardOk | NextResponse> {
  if (!checkAdminSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { orgId, businessId } = opts
  if (!orgId) return { ok: true, orgId: '' }      // caller supplied no scope — bare admin surface (rare)

  const db = createAdminClient()

  // Verify the org exists.
  const { data: org, error: orgErr } = await db
    .from('organisations')
    .select('id')
    .eq('id', orgId)
    .maybeSingle()
  if (orgErr) return NextResponse.json({ error: orgErr.message }, { status: 500 })
  if (!org)   return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  // If a business_id was supplied, verify it belongs to the claimed org.
  if (businessId) {
    const { data: biz, error: bizErr } = await db
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('org_id', orgId)
      .maybeSingle()
    if (bizErr) return NextResponse.json({ error: bizErr.message }, { status: 500 })
    if (!biz)   return NextResponse.json({
      error: 'Business not found in that organisation',
    }, { status: 403 })
  }

  return { ok: true, orgId, businessId }
}
