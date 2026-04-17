// @ts-nocheck
// app/api/admin/customers/[orgId]/impersonate/route.ts
//
// Generates a one-time magic-link URL that signs the admin in as the first
// member of the target org. The admin uses this from an incognito window
// (recommended) so their own admin session doesn't get overwritten.
//
// Security:
//   - x-admin-secret header required
//   - Returns the magic link in the response; only the admin sees it
//   - Supabase magic links expire after 1 hour and are single-use
//
// UX note: opening the link in a regular window will overwrite the admin's
// own Supabase session cookie (same domain). Incognito/private window is
// the supported flow.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'
import { checkAdminSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

function checkAuth(req: NextRequest): boolean {
  return checkAdminSecret(req)
}

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = params.orgId
  const db = createAdminClient()

  // Find the first org member's user_id
  const { data: member } = await db
    .from('organisation_members')
    .select('user_id, role')
    .eq('org_id', orgId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()

  if (!member) return NextResponse.json({ error: 'No members in this org' }, { status: 404 })

  // Look up the user's email
  const { data: { user } } = await db.auth.admin.getUserById(member.user_id)
  if (!user?.email) return NextResponse.json({ error: 'Member has no email' }, { status: 404 })

  // Generate a magic link that, when visited, signs the user in
  // `type: 'magiclink'` means existing-user sign-in (not signup)
  // `redirectTo` is where the user lands after the link is processed
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'

  const { data: link, error } = await db.auth.admin.generateLink({
    type:    'magiclink',
    email:   user.email,
    options: {
      redirectTo: `${appUrl}/dashboard?impersonated=1`,
    },
  })

  if (error) return NextResponse.json({ error: 'Generate link failed: ' + error.message }, { status: 500 })

  const actionLink = (link as any)?.properties?.action_link ?? (link as any)?.action_link ?? null
  if (!actionLink) return NextResponse.json({ error: 'No action link returned from Supabase' }, { status: 500 })

  await recordAdminAction(db, {
    action:     ADMIN_ACTIONS.IMPERSONATE,
    orgId,
    targetType: 'user',
    targetId:   user.id,
    payload:    { user_email: user.email, role: member.role },
    req,
  })

  return NextResponse.json({
    ok:           true,
    action_link:  actionLink,
    user_email:   user.email,
    role:         member.role,
    expires_in:   '1 hour',
    note:         'Open this link in an incognito/private window to avoid overwriting your admin session cookie. Single-use; expires in 1 hour.',
  })
}
