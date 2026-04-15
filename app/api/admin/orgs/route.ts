// @ts-nocheck
import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const db = createAdminClient()

  // Get all orgs with member emails
  const { data: orgs } = await db
    .from('organisations')
    .select('id, name, created_at')
    .order('created_at', { ascending: false })

  if (!orgs) return NextResponse.json({ orgs: [] })

  // Enrich each org
  const enriched = await Promise.all(orgs.map(async (org: any) => {
    // Get email from members
    const { data: members } = await db
      .from('organisation_members')
      .select('user_id')
      .eq('org_id', org.id)
      .limit(1)

    let email = null
    if (members?.[0]) {
      const { data: { user } } = await db.auth.admin.getUserById(members[0].user_id)
      email = user?.email ?? null
    }

    // Get businesses
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name, city, is_active')
      .eq('org_id', org.id)
      .eq('is_active', true)

    // Get integrations per business
    const { data: integrations } = await db
      .from('integrations')
      .select('id, provider, status, business_id, last_sync_at, last_error, department')
      .eq('org_id', org.id)

    const enrichedBizs = (businesses ?? []).map((biz: any) => ({
      ...biz,
      integrations: (integrations ?? []).filter((i: any) => i.business_id === biz.id || !i.business_id),
    }))

    // Get setup request if any
    const { data: onboarding } = await db
      .from('onboarding_progress')
      .select('step, metadata')
      .eq('org_id', org.id)
      .maybeSingle()

    return {
      ...org,
      email,
      businesses:      enrichedBizs,
      has_connection:  (integrations ?? []).some((i: any) => i.status === 'connected'),
      setup_requested: onboarding?.step === 'setup_requested',
      setup_data:      onboarding?.metadata ?? null,
    }
  }))

  return NextResponse.json({ orgs: enriched })
}
