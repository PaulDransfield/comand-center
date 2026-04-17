// @ts-nocheck
// app/api/admin/diagnose-inzii/route.ts
// DIAGNOSTIC — why are Inzii departments not appearing in admin panel?
// Dumps all businesses + inzii integrations for an org, labels each row:
//   - matches_active_biz: business_id points to an active business in the org
//   - matches_inactive_biz: business_id points to an inactive business in the org
//   - wrong_org: business_id points to a business in a DIFFERENT org
//   - no_business: business_id is null
//   - ghost_business: business_id points to a business that does not exist at all
//
// Call: GET /api/admin/diagnose-inzii?org_id=...&secret=<ADMIN_SECRET>
// Or pass org_id via query and x-admin-secret header.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret }          from '@/lib/admin/check-secret'
import { timingSafeEqual }           from 'crypto'

export const dynamic     = 'force-dynamic'
export const maxDuration = 30

function checkAuth(req: NextRequest): boolean {
  // Accept ?secret= query (diagnostic uses this) OR the standard admin headers/cookie.
  if (checkAdminSecret(req)) return true
  const querySecret = req.nextUrl.searchParams.get('secret')
  const want        = process.env.ADMIN_SECRET
  if (!querySecret || !want) return false
  const a = Buffer.from(querySecret, 'utf8')
  const b = Buffer.from(want, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const orgId = req.nextUrl.searchParams.get('org_id')
  if (!orgId) return NextResponse.json({ error: 'org_id required' }, { status: 400 })

  const db = createAdminClient()

  // 1. All businesses in this org (active AND inactive)
  const { data: bizs, error: bizErr } = await db
    .from('businesses')
    .select('id, name, city, is_active, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })

  if (bizErr) return NextResponse.json({ error: bizErr.message }, { status: 500 })

  const bizMap = new Map<string, any>()
  for (const b of bizs ?? []) bizMap.set(b.id, b)

  // 2. All Inzii integrations whose org_id matches
  const { data: byOrg } = await db
    .from('integrations')
    .select('id, provider, status, org_id, business_id, department, last_sync_at, last_error, created_at, updated_at')
    .eq('org_id', orgId)
    .eq('provider', 'inzii')

  // 3. All Inzii integrations whose business_id is in the org's business list — catches org_id mismatches
  const bizIds = (bizs ?? []).map(b => b.id)
  const { data: byBiz } = bizIds.length
    ? await db
        .from('integrations')
        .select('id, provider, status, org_id, business_id, department, last_sync_at, last_error, created_at, updated_at')
        .eq('provider', 'inzii')
        .in('business_id', bizIds)
    : { data: [] as any[] }

  // Merge and dedupe by id
  const seen = new Set<string>()
  const allInzii = [...(byOrg ?? []), ...(byBiz ?? [])].filter(i => {
    if (seen.has(i.id)) return false
    seen.add(i.id)
    return true
  })

  // 4. For each inzii row, look up its business_id even if it points to a different org
  const unknownBizIds = [...new Set(allInzii
    .map(i => i.business_id)
    .filter(bid => bid && !bizMap.has(bid)))] as string[]

  let foreignBizs: any[] = []
  if (unknownBizIds.length) {
    const { data } = await db
      .from('businesses')
      .select('id, name, city, is_active, org_id')
      .in('id', unknownBizIds)
    foreignBizs = data ?? []
  }
  const foreignMap = new Map<string, any>(foreignBizs.map(b => [b.id, b]))

  // 5. Label each integration
  const labelled = allInzii.map(i => {
    let label: string
    let biz: any = null
    if (!i.business_id) {
      label = 'no_business'
    } else if (bizMap.has(i.business_id)) {
      biz = bizMap.get(i.business_id)
      label = biz.is_active ? 'matches_active_biz' : 'matches_inactive_biz'
    } else if (foreignMap.has(i.business_id)) {
      biz = foreignMap.get(i.business_id)
      label = biz.org_id === orgId ? 'matches_unlinked_biz' : 'wrong_org'
    } else {
      label = 'ghost_business'
    }

    return {
      id:           i.id,
      department:   i.department,
      status:       i.status,
      org_id:       i.org_id,
      org_id_matches_query: i.org_id === orgId,
      business_id:  i.business_id,
      label,
      biz_name:     biz?.name ?? null,
      biz_is_active: biz?.is_active ?? null,
      biz_org_id:   biz?.org_id ?? null,
      last_sync_at: i.last_sync_at,
      last_error:   i.last_error,
      created_at:   i.created_at,
    }
  })

  // 6. Simulate what /api/admin/orgs shows for this org, to confirm the drop
  const activeBizs = (bizs ?? []).filter(b => b.is_active)
  const visibleInAdmin = activeBizs.map(biz => ({
    biz_id:   biz.id,
    biz_name: biz.name,
    inzii_shown: allInzii
      .filter(i => i.business_id === biz.id || !i.business_id)
      .map(i => ({ id: i.id, department: i.department })),
  }))

  // Totals
  const summary = {
    businesses_total:        (bizs ?? []).length,
    businesses_active:       activeBizs.length,
    businesses_inactive:     (bizs ?? []).length - activeBizs.length,
    inzii_rows_total:        allInzii.length,
    inzii_matches_active:    labelled.filter(l => l.label === 'matches_active_biz').length,
    inzii_matches_inactive:  labelled.filter(l => l.label === 'matches_inactive_biz').length,
    inzii_matches_unlinked:  labelled.filter(l => l.label === 'matches_unlinked_biz').length,
    inzii_wrong_org:         labelled.filter(l => l.label === 'wrong_org').length,
    inzii_no_business:       labelled.filter(l => l.label === 'no_business').length,
    inzii_ghost_business:    labelled.filter(l => l.label === 'ghost_business').length,
    inzii_org_id_mismatch:   labelled.filter(l => !l.org_id_matches_query).length,
    inzii_shown_in_admin:    visibleInAdmin.reduce((n, b) => n + b.inzii_shown.length, 0),
  }

  return NextResponse.json({
    org_id:         orgId,
    summary,
    businesses:     bizs ?? [],
    inzii_rows:     labelled,
    visible_in_admin_ui: visibleInAdmin,
    foreign_businesses:  foreignBizs,
  })
}
