// app/api/settings/team/route.ts
//
// Owner-facing team management. Mirrors the admin v2 users endpoint
// shape but auths via session (owner) instead of admin secret. The
// owner can:
//   - GET  list members of their own org (incl. self)
//   - POST invite a manager or revisor (owner can't be added; the
//     signup user is the org's owner by definition)
//
// Roles allowed via this endpoint: 'manager' | 'revisor'.
// 'owner' and 'viewer' are deliberately excluded — owner is set on
// signup; viewer is reserved for v2.
//
// Revisor invites MUST scope to specific businesses (matches the
// permissions module's canAccessBusiness rule). Manager invites may
// be unscoped (all businesses in org) or scoped.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { sendInviteEmail }            from '@/lib/email/sendInviteEmail'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_INVITE_ROLES = new Set(['manager', 'revisor', 'staff'])

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const db = createAdminClient()
  const { data: members, error } = await db
    .from('organisation_members')
    .select('user_id, role, business_ids, can_view_finances, invited_at, last_active_at, created_at')
    .eq('org_id', auth.orgId)
    .order('created_at', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Hydrate emails + names
  const userIds = (members ?? []).map((m: any) => m.user_id)
  const usersById: Record<string, { email: string | null; full_name: string | null }> = {}
  if (userIds.length > 0) {
    const { data: users } = await db
      .from('users')
      .select('id, email, full_name')
      .in('id', userIds)
    for (const u of (users ?? []) as any[]) {
      usersById[u.id] = { email: u.email ?? null, full_name: u.full_name ?? null }
    }
  }

  // Hydrate business names for scope display
  const allBizIds = new Set<string>()
  for (const m of (members ?? []) as any[]) {
    if (Array.isArray(m.business_ids)) m.business_ids.forEach((b: string) => allBizIds.add(b))
  }
  const businessNamesById: Record<string, string> = {}
  if (allBizIds.size > 0) {
    const { data: biz } = await db
      .from('businesses')
      .select('id, name')
      .in('id', Array.from(allBizIds))
    for (const b of (biz ?? []) as any[]) businessNamesById[b.id] = b.name
  }

  const result = (members ?? []).map((m: any) => ({
    user_id:           m.user_id,
    email:             usersById[m.user_id]?.email ?? null,
    full_name:         usersById[m.user_id]?.full_name ?? null,
    role:              m.role,
    business_ids:      m.business_ids ?? null,
    business_names:    Array.isArray(m.business_ids)
      ? m.business_ids.map((id: string) => businessNamesById[id] ?? id.slice(0, 8))
      : null,
    can_view_finances: !!m.can_view_finances,
    invited_at:        m.invited_at,
    last_active_at:    m.last_active_at,
    joined_at:         m.created_at,
    is_self:           m.user_id === auth.userId,
  }))

  return NextResponse.json({ members: result }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'owner') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: any = {}
  try { body = await req.json() } catch {}
  const email           = String(body?.email ?? '').trim().toLowerCase()
  const role            = String(body?.role ?? 'manager')
  const businessIds     = Array.isArray(body?.business_ids) ? body.business_ids.filter((x: any) => typeof x === 'string') : null
  const canViewFinances = body?.can_view_finances === true

  if (!email || !email.includes('@')) {
    return NextResponse.json({ error: 'Valid email required.' }, { status: 400 })
  }
  if (!VALID_INVITE_ROLES.has(role)) {
    return NextResponse.json({
      error: `role must be one of: ${Array.from(VALID_INVITE_ROLES).join(', ')}`,
    }, { status: 400 })
  }

  // Self-invite guard. Owner invites are upserts keyed on (org_id, user_id),
  // so inviting yourself as a manager/revisor would DOWNGRADE your own
  // membership in place — locking you out of owner-only surfaces.
  const db = createAdminClient()  // need this earlier than before to look up self
  try {
    const { data: selfRow } = await db.from('users').select('email').eq('id', auth.userId).maybeSingle()
    if (selfRow?.email && selfRow.email.toLowerCase() === email) {
      return NextResponse.json({
        error:
          'You can\'t invite yourself as a manager or revisor — that would downgrade your owner access. ' +
          'Use a different email (e.g. paul+test@comandcenter.se) to test the flow.',
      }, { status: 400 })
    }
  } catch { /* best-effort guard; if lookup fails we proceed */ }
  // Revisor + staff MUST be scoped — the permissions module rejects unscoped
  // ones anyway (a staff/revisor login that sees every location is a leak).
  if ((role === 'revisor' || role === 'staff') && (!businessIds || businessIds.length === 0)) {
    return NextResponse.json({
      error: `${role === 'staff' ? 'Staff' : 'Revisor'} invites require at least one business in scope.`,
    }, { status: 400 })
  }

  // Validate that the businessIds (if any) actually belong to this org
  if (businessIds && businessIds.length > 0) {
    const { data: orgBiz } = await db
      .from('businesses')
      .select('id')
      .eq('org_id', auth.orgId)
      .in('id', businessIds)
    const validIds = new Set((orgBiz ?? []).map((b: any) => b.id))
    const invalid  = businessIds.filter((b: string) => !validIds.has(b))
    if (invalid.length > 0) {
      return NextResponse.json({
        error: `Business id(s) not in your org: ${invalid.join(', ')}`,
      }, { status: 400 })
    }
  }

  // ── Find or create auth user ──────────────────────────────────────
  let userId: string | null = null
  try {
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const found = list?.users?.find((u: any) => u?.email?.toLowerCase() === email)
    if (found) userId = found.id
  } catch (e: any) {
    console.warn('[settings/team] listUsers fallback:', e?.message)
  }

  if (!userId) {
    const tempPassword = `cc-${Math.random().toString(36).slice(2, 14)}-${Date.now().toString(36)}`
    const { data: created, error: createErr } = await db.auth.admin.createUser({
      email,
      password:      tempPassword,
      email_confirm: true,
      user_metadata: { invited_via: 'owner', invited_at: new Date().toISOString() },
    })
    if (createErr || !created?.user?.id) {
      return NextResponse.json({
        error: createErr?.message ?? 'Failed to create auth user',
      }, { status: 500 })
    }
    userId = created.user.id
  }

  // ── Mirror into public.users (always, not just on create) ──────────
  // FK on organisation_members.user_id points here. We have to handle
  // an edge case: legacy accounts where auth.users.id ≠ public.users.id
  // for the same email (early-signup data drift before the mirror was
  // wired). For those, upsert-by-id tries to INSERT (id doesn't exist)
  // and hits the email unique constraint.
  //
  // Detect this case up-front via email lookup, then either:
  //   a) row exists with matching id → already mirrored, no-op
  //   b) row exists with DIFFERENT id → return a specific error explaining
  //      the mismatch (admin needs to repair, see /docs/runbook)
  //   c) no row → safe to insert
  const { data: existingByEmail } = await db
    .from('users')
    .select('id')
    .eq('email', email)
    .maybeSingle()

  if (existingByEmail) {
    if (existingByEmail.id !== userId) {
      return NextResponse.json({
        error:
          `This email is associated with a different user record in our database (data drift). ` +
          `Use a different email for this invite, OR ask an admin to repair the mismatch ` +
          `(public.users.id=${existingByEmail.id} vs auth.users.id=${userId} for ${email}).`,
      }, { status: 409 })
    }
    // Matching id — already mirrored, skip the upsert.
  } else {
    const { error: usersErr } = await db
      .from('users')
      .insert({ id: userId, email })
    if (usersErr) {
      return NextResponse.json({
        error: `Could not mirror auth user into public.users: ${usersErr.message}`,
      }, { status: 500 })
    }
  }

  // ── Insert membership ─────────────────────────────────────────────
  const { error: memberErr } = await db.from('organisation_members').upsert({
    org_id:            auth.orgId,
    user_id:           userId,
    role,
    business_ids:      businessIds && businessIds.length > 0 ? businessIds : null,
    // Managers + revisors see financials (managers run service on the numbers);
    // staff never do, regardless of the flag.
    can_view_finances: role === 'staff' ? false : (role === 'manager' || role === 'revisor' ? true : canViewFinances),
    accepted_at:       new Date().toISOString(),
    invited_at:        new Date().toISOString(),
    invited_by:        auth.userId,
  }, { onConflict: 'org_id,user_id' })
  if (memberErr) return NextResponse.json({ error: memberErr.message }, { status: 500 })

  // ── Send the branded invite email ─────────────────────────────────
  const appOrigin = process.env.NEXT_PUBLIC_APP_URL || 'https://comandcenter.se'
  const redirectNext = role === 'revisor' ? '/revisor'
                     : role === 'staff'   ? '/inventory/recipes/prep'
                     : '/dashboard'

  // Get the inviter's name + org name for the greeting copy
  let inviterName: string | null = null
  let orgName:     string | null = null
  try {
    const { data: me } = await db.from('users').select('full_name').eq('id', auth.userId).maybeSingle()
    inviterName = me?.full_name ?? null
  } catch {}
  try {
    const { data: org } = await db.from('organisations').select('name').eq('id', auth.orgId).maybeSingle()
    orgName = org?.name ?? null
  } catch {}

  const emailResult = await sendInviteEmail({
    supabaseAdmin: db,
    email,
    orgName,
    inviterName,
    appOrigin,
    redirectNext,
  })

  return NextResponse.json({
    ok:      true,
    user_id: userId,
    role,
    email_sent:    emailResult.ok,
    email_error:   emailResult.error,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
