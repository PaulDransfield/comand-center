// app/api/revisor/data/route.ts
//
// Single endpoint that powers the /revisor surface. Returns either:
//   - landing-page data: list of businesses + 12 most recent months
//                        (when no business_id specified)
//   - month-detail data: P&L summary + BAS line items + overhead flags
//                        (when business_id + year + month specified)
//
// Auth: revisor or owner role. Revisor MUST be scoped to the business via
// organisation_members.business_ids; owner sees everything in their org.
//
// No mutations — the revisor surface is strictly read-only. Permission
// model enforced both at the lib/auth/permissions.ts canAccessBusiness
// check and at the row-level WHERE clauses below.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness } from '@/lib/auth/permissions'

export const runtime  = 'nodejs'
export const dynamic  = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  if (auth.role !== 'revisor' && auth.role !== 'owner') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // getRequestAuth returns `businessIds` (camelCase). The permission helper
  // expects `business_ids` (snake_case) per its AuthSubject interface. Map
  // here so the revisor's scoping carries through correctly.
  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }

  const url      = new URL(req.url)
  const bizId    = url.searchParams.get('business_id')
  const yearRaw  = url.searchParams.get('year')
  const monthRaw = url.searchParams.get('month')

  const db = createAdminClient()

  // ── Landing-page mode: enumerate accessible businesses + recent months ──
  if (!bizId) {
    // Get businesses the subject can see
    const { data: allBiz } = await db
      .from('businesses')
      .select('id, name, city, country, org_number')
      .eq('org_id', auth.orgId)
      .eq('is_active', true)
      .order('name')

    const accessibleBiz = (allBiz ?? []).filter((b: any) => canAccessBusiness(subject, b.id))

    // Last 12 closed months per business: tracker_data rows where is_provisional
    // is null or false. Sort newest first.
    const bizIds = accessibleBiz.map((b: any) => b.id)
    const { data: months } = bizIds.length
      ? await db
          .from('tracker_data')
          .select('business_id, period_year, period_month, revenue, net_profit, margin_pct, source, created_via, updated_at')
          .in('business_id', bizIds)
          .or('is_provisional.is.null,is_provisional.eq.false')
          .order('period_year', { ascending: false })
          .order('period_month', { ascending: false })
          .limit(12 * Math.max(1, bizIds.length))
      : { data: [] as any[] }

    return NextResponse.json({
      mode:       'landing',
      businesses: accessibleBiz,
      months:     months ?? [],
    }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
  }

  // ── Month-detail mode ───────────────────────────────────────────────
  if (!canAccessBusiness(subject, bizId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  const year  = parseInt(yearRaw  ?? '', 10)
  const month = parseInt(monthRaw ?? '', 10)
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return NextResponse.json({ error: 'year + month required (year=YYYY, month=1-12)' }, { status: 400 })
  }

  // Business info
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, city, country, org_number')
    .eq('id', bizId)
    .maybeSingle()
  if (!biz || biz.org_number == null) {
    // Don't crash if org_number missing — just omit it. Revisor sees a
    // gentle warning in the UI rather than an error.
  }

  // P&L row for the period (closed/non-provisional only)
  const { data: tracker } = await db
    .from('tracker_data')
    .select('*')
    .eq('business_id', bizId)
    .eq('period_year', year)
    .eq('period_month', month)
    .or('is_provisional.is.null,is_provisional.eq.false')
    .maybeSingle()

  // BAS line items for the same period
  const { data: lineItems } = await db
    .from('tracker_line_items')
    .select('account_number, account_description, amount, kind, source')
    .eq('business_id', bizId)
    .eq('period_year', year)
    .eq('period_month', month)
    .order('account_number', { ascending: true })

  // Recent same-month historical (12 months back) for variance context
  const { data: history } = await db
    .from('tracker_data')
    .select('period_year, period_month, revenue, food_cost, staff_cost, other_cost, net_profit, margin_pct')
    .eq('business_id', bizId)
    .or('is_provisional.is.null,is_provisional.eq.false')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(13)

  // Overhead flags for the period (skip if the table doesn't exist — soft-fail)
  let overheadFlags: any[] = []
  try {
    const { data: flags } = await db
      .from('overhead_review_flags')
      .select('*')
      .eq('business_id', bizId)
      .eq('period_year', year)
      .eq('period_month', month)
    overheadFlags = flags ?? []
  } catch { /* table may not exist in all envs */ }

  return NextResponse.json({
    mode:           'month_detail',
    business:       biz ?? null,
    period:         { year, month },
    tracker:        tracker ?? null,
    line_items:     lineItems ?? [],
    history:        history ?? [],
    overhead_flags: overheadFlags,
    generated_at:   new Date().toISOString(),
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
