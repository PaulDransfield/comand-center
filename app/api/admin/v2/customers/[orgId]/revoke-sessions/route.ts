// app/api/admin/v2/customers/[orgId]/revoke-sessions/route.ts
//
// Signs out every user in the org by calling
// supabase.auth.admin.signOut(userId) for each member. Audit-logged.
// Doesn't delete the user — just invalidates their refresh tokens so
// the next request forces re-auth.
//
// Body: { reason: string }

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'

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

  const { data: members } = await db
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', orgId)
  const userIds = (members ?? []).map((m: any) => m.user_id).filter(Boolean)

  if (userIds.length === 0) {
    return NextResponse.json({ error: 'No members to revoke' }, { status: 404 })
  }

  await recordAdminAction(db, {
    action:     'revoke_sessions',
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    {
      reason,
      surface:     'admin_v2',
      user_count:  userIds.length,
    },
    req,
  })

  const results: Array<{ user_id: string; ok: boolean; error?: string }> = []
  for (const uid of userIds) {
    try {
      const { error } = await (db as any).auth.admin.signOut(uid)
      if (error) results.push({ user_id: uid, ok: false, error: error.message })
      else results.push({ user_id: uid, ok: true })
    } catch (e: any) {
      results.push({ user_id: uid, ok: false, error: e?.message ?? 'signOut failed' })
    }
  }

  const ok = results.every(r => r.ok)
  return NextResponse.json({
    ok,
    revoked: results.filter(r => r.ok).length,
    failed:  results.filter(r => !r.ok).length,
    reason,
    results,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
