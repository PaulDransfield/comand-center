// app/api/admin/v2/customers/[orgId]/users/[userId]/set-password/route.ts
//
// Admin "Set password directly" — admin override that sets a new password
// on the user's auth account. For when a user is locked out and needs
// emergency access, or when password reset emails aren't reaching them.
//
// Triggers an audit log entry with the reason. Does NOT email the user
// the new password — the admin is expected to communicate it via a side
// channel (phone call, in-person). Storing/emailing plaintext passwords
// is bad practice; admin telling the user "your password is now X" via a
// secure channel is better than us sending it via email.
//
// Body: { reason: string (≥10 chars), new_password: string (≥8 chars) }

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'
const REASON_MIN   = 10
const PASSWORD_MIN = 8

export async function POST(req: NextRequest, { params }: { params: { orgId: string; userId: string } }) {
  const { orgId, userId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason       = String(body?.reason       ?? '').trim()
  const newPassword  = String(body?.new_password ?? '')
  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }
  if (newPassword.length < PASSWORD_MIN) {
    return NextResponse.json({ error: `new_password required (min ${PASSWORD_MIN} chars)` }, { status: 400 })
  }

  const db = createAdminClient()

  // Cross-org check: user must be a member of THIS org
  const { data: member } = await db
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!member) return NextResponse.json({ error: 'User is not a member of this org' }, { status: 404 })

  // Get the user's email for the audit log
  let email: string | null = null
  try {
    const { data: u } = await db.auth.admin.getUserById(userId)
    email = u?.user?.email ?? null
  } catch {}

  // Set the password
  const { error: updErr } = await db.auth.admin.updateUserById(userId, {
    password: newPassword,
  })
  if (updErr) {
    return NextResponse.json({ error: `Set password failed: ${updErr.message}` }, { status: 500 })
  }

  // CRITICAL audit entry — this is the most-sensitive admin action we
  // expose. Reason is mandatory; password value is NEVER logged (only
  // its length, for forensic purposes).
  await recordAdminAction(db as any, {
    action:     'password_set_admin' as any,
    orgId,
    targetType: 'user',
    targetId:   userId,
    payload:    {
      surface:         'admin_v2',
      email,
      reason,
      password_length: newPassword.length,
    },
    req,
  })

  return NextResponse.json({
    ok:      true,
    user_id: userId,
    email,
    set_at:  new Date().toISOString(),
  })
}
