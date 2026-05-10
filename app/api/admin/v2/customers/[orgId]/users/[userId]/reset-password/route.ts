// app/api/admin/v2/customers/[orgId]/users/[userId]/reset-password/route.ts
//
// Admin "Send password reset" — generates a Supabase recovery link and
// emails it via Resend with our branding. For when an existing user
// can't log in and needs a fresh password.
//
// Body: { reason: string } (≥10 chars, audit-logged)

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'
import { sendPasswordResetEmail }    from '@/lib/email/sendPasswordResetEmail'

export const dynamic = 'force-dynamic'
const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string; userId: string } }) {
  const { orgId, userId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason = String(body?.reason ?? '').trim()
  if (reason.length < REASON_MIN) {
    return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify the user is actually a member of this org — prevents cross-org
  // password resets via URL fiddling.
  const { data: member } = await db
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!member) return NextResponse.json({ error: 'User is not a member of this org' }, { status: 404 })

  // Get the user's email
  let email: string | null = null
  try {
    const { data: u } = await db.auth.admin.getUserById(userId)
    email = u?.user?.email ?? null
  } catch {}
  if (!email) return NextResponse.json({ error: 'Could not resolve user email' }, { status: 404 })

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
  const result = await sendPasswordResetEmail({
    supabaseAdmin: db,
    email,
    appOrigin:     appUrl,
    triggeredBy:   'admin',
  })

  await recordAdminAction(db as any, {
    action:     'password_reset_sent' as any,
    orgId,
    targetType: 'user',
    targetId:   userId,
    payload:    {
      surface:    'admin_v2',
      email,
      reason,
      success:    result.ok,
      error:      result.error ?? null,
    },
    req,
  })

  if (!result.ok) {
    return NextResponse.json({
      error:       result.error ?? 'Email send failed',
      action_link: result.actionLink ?? null,   // surface fallback link if Resend was offline
    }, { status: 500 })
  }

  return NextResponse.json({
    ok:         true,
    user_id:    userId,
    email,
    sent_at:    new Date().toISOString(),
    message_id: result.messageId,
  })
}
