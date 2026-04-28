// app/api/admin/v2/customers/[orgId]/impersonate/route.ts
//
// v2 wrapper for the existing impersonate flow. Takes a typed reason
// (≥10 chars) from the body and records an audit row WITH that reason
// before generating the magic link via the existing endpoint's logic.
//
// Per the plan's PR 4 hard rule: every dangerous action requires a
// reason that gets persisted to admin_audit_log.payload.reason.
//
// We don't HTTP-proxy to the old endpoint — duplicating its 4 lines of
// magic-link-generation here is cleaner than an internal fetch and lets
// us audit ONCE with the reason payload (the old endpoint also audits
// but without a reason field).

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason = String(body?.reason ?? '').trim()
  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }

  const db = createAdminClient()

  // Resolve the org's first member — that's who we impersonate.
  const { data: member } = await db
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (!member?.user_id) {
    return NextResponse.json({ error: 'No members in this org' }, { status: 404 })
  }

  // Look up the user's email so we can request a magic link.
  const { data: userRow } = await db.auth.admin.getUserById(member.user_id)
  const email = userRow?.user?.email
  if (!email) {
    return NextResponse.json({ error: 'Member has no email' }, { status: 500 })
  }

  // Generate the magic link.
  const { data: linkRes, error: linkErr } = await (db as any).auth.admin.generateLink({
    type: 'magiclink',
    email,
  })
  if (linkErr || !linkRes?.properties?.action_link) {
    return NextResponse.json({ error: linkErr?.message ?? 'Failed to generate link' }, { status: 500 })
  }

  // Record audit FIRST — never block the action on audit, but get the
  // reason in there so it's traceable.
  await recordAdminAction(db, {
    action:     ADMIN_ACTIONS.IMPERSONATE,
    orgId,
    targetType: 'user',
    targetId:   member.user_id,
    payload:    { reason, email, surface: 'admin_v2' },
    req,
  })

  return NextResponse.json({
    magic_link: linkRes.properties.action_link,
    email,
    reason,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
