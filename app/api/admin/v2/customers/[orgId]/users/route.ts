// app/api/admin/v2/customers/[orgId]/users/route.ts
// User list + provisioning for the Users sub-tab.
//
// GET  → list members with auth-user metadata (email, last_sign_in_at, etc.)
// POST → add a new member. Creates the Supabase auth user (random password)
//        and triggers a password-reset email so the user sets their own.
//        Body: { email, role, business_ids?, can_view_finances? }
//
// Edit / delete of an existing member live at the [userId] sub-route.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const VALID_ROLES = new Set(['owner', 'manager', 'viewer'])

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const { data: members } = await db
    .from('organisation_members')
    .select('user_id, role, business_ids, can_view_finances, invited_by, invited_at, last_active_at, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })

  const users: any[] = []
  for (const m of members ?? []) {
    try {
      const { data } = await db.auth.admin.getUserById(m.user_id)
      users.push({
        user_id:           m.user_id,
        role:              m.role,
        business_ids:      m.business_ids ?? null,
        can_view_finances: !!m.can_view_finances,
        invited_at:        m.invited_at,
        last_active_at:    m.last_active_at,
        joined_at:         m.created_at,
        email:             data?.user?.email ?? null,
        last_sign_in_at:   data?.user?.last_sign_in_at ?? null,
        created_at:        data?.user?.created_at ?? null,
        confirmed:         !!data?.user?.email_confirmed_at,
      })
    } catch {
      users.push({
        user_id:           m.user_id,
        role:              m.role,
        business_ids:      m.business_ids ?? null,
        can_view_finances: !!m.can_view_finances,
        invited_at:        m.invited_at,
        last_active_at:    m.last_active_at,
        joined_at:         m.created_at,
        email:             null,
        last_sign_in_at:   null,
        created_at:        null,
        confirmed:         false,
      })
    }
  }

  return NextResponse.json({ users, total: users.length }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}

  const email           = String(body?.email ?? '').trim().toLowerCase()
  const role            = String(body?.role ?? 'manager')
  const businessIds     = Array.isArray(body?.business_ids) ? body.business_ids : null
  const canViewFinances = body?.can_view_finances === true

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Valid email required.' }, { status: 400 })
  }
  if (!VALID_ROLES.has(role)) {
    return NextResponse.json({ error: `role must be one of: ${Array.from(VALID_ROLES).join(', ')}` }, { status: 400 })
  }

  const db = createAdminClient()

  // Look up an existing auth user by email (admin getUserByEmail isn't in
  // every Supabase JS version — use listUsers + filter).
  let userId: string | null = null
  try {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const found = list?.users?.find((u: any) => u?.email?.toLowerCase() === email)
    if (found) userId = found.id
  } catch (e: any) {
    // listUsers can be slow on big tenants; degrade to "create new" path.
    console.warn('[admin/users] listUsers fallback:', e?.message)
  }

  // Create the auth user if it doesn't exist. Random password — user will
  // set their own via the password-reset email below.
  if (!userId) {
    const tempPassword = `cc-${Math.random().toString(36).slice(2, 14)}-${Date.now().toString(36)}`
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email,
      password:      tempPassword,
      email_confirm: true,                 // skip the verification step
      user_metadata: { invited_via: 'admin', invited_at: new Date().toISOString() },
    })
    if (createErr || !created?.user?.id) {
      return NextResponse.json({
        error: createErr?.message ?? 'Failed to create auth user',
      }, { status: 500 })
    }
    userId = created.user.id

    // Make sure a row exists in `users` so other joins work. Best-effort.
    try {
      await db.from('users').insert({ id: userId, email, full_name: null, auth_methods: ['email'] })
    } catch { /* may already exist */ }
  }

  // Insert the membership. Use upsert so re-adding an already-removed user
  // (or correcting a wrong scope) is idempotent.
  const { error: memberErr } = await db.from('organisation_members').upsert({
    org_id:            orgId,
    user_id:           userId,
    role,
    business_ids:      businessIds && businessIds.length > 0 ? businessIds : null,
    can_view_finances: canViewFinances,
    accepted_at:       new Date().toISOString(),
    invited_at:        new Date().toISOString(),
    invited_by:        null,                                  // admin — no specific user id
  }, {
    onConflict: 'org_id,user_id',
  })
  if (memberErr) {
    return NextResponse.json({ error: memberErr.message }, { status: 500 })
  }

  // Send the password-reset email so the user can set their own password.
  // generateLink() produces the recovery URL; we'd email it via Resend.
  // For simplicity at v1, use Supabase's built-in password reset which
  // emails directly using the project's SMTP config.
  let resetSent = false
  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
    const { error: resetErr } = await db.auth.resetPasswordForEmail(email, {
      redirectTo: `${appUrl}/reset-password`,
    })
    if (!resetErr) resetSent = true
    else console.warn('[admin/users] reset email failed:', resetErr.message)
  } catch (e: any) {
    console.warn('[admin/users] reset email threw:', e?.message)
  }

  await recordAdminAction(db as any, {
    action:     'member_invite' as any,
    orgId,
    targetType: 'user',
    targetId:   userId,
    payload: {
      surface:           'admin_v2',
      email,
      role,
      business_ids:      businessIds,
      can_view_finances: canViewFinances,
      reset_email_sent:  resetSent,
    },
    req,
  })

  return NextResponse.json({
    user_id:          userId,
    email,
    role,
    business_ids:     businessIds,
    can_view_finances: canViewFinances,
    reset_email_sent: resetSent,
  }, { status: 201 })
}
