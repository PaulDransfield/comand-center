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

    // Get businesses (active only for display, but keep IDs for integration lookup)
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name, city, is_active')
      .eq('org_id', org.id)
      .eq('is_active', true)

    const bizIds = (businesses ?? []).map((b: any) => b.id)

    // Fetch integrations two ways to catch any org_id/business_id mismatch edge cases:
    // 1. By org_id (normal path)
    // 2. By business_id directly (catches rows where org_id was not set)
    const [{ data: byOrg }, { data: byBiz }] = await Promise.all([
      db.from('integrations')
        .select('id, provider, status, business_id, last_sync_at, last_error, department')
        .eq('org_id', org.id),
      bizIds.length > 0
        ? db.from('integrations')
            .select('id, provider, status, business_id, last_sync_at, last_error, department')
            .in('business_id', bizIds)
        : Promise.resolve({ data: [] }),
    ])

    // Merge and deduplicate by id
    const seen = new Set<string>()
    const integrations = [...(byOrg ?? []), ...(byBiz ?? [])].filter((i: any) => {
      if (seen.has(i.id)) return false
      seen.add(i.id)
      return true
    })

    const enrichedBizs = (businesses ?? []).map((biz: any) => ({
      ...biz,
      integrations: integrations.filter((i: any) => i.business_id === biz.id || !i.business_id),
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
