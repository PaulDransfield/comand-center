// app/api/scheduling/acceptances/route.ts
//
// GET the accepted-day list for a business + date range. The scheduling
// page uses this on load so "Accepted ✓" state survives navigation.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore } from 'next/cache'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(req: NextRequest) {
  unstable_noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u = new URL(req.url)
  const business_id = u.searchParams.get('business_id')
  const from        = u.searchParams.get('from')
  const to          = u.searchParams.get('to')
  if (!business_id || !/^\d{4}-\d{2}-\d{2}$/.test(from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? '')) {
    return NextResponse.json({ error: 'business_id + from + to (YYYY-MM-DD) required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('id, org_id').eq('id', business_id).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  // .gte only + in-memory filter — PostgREST's chained .gte.lte silently
  // drops top-boundary rows on date columns (CLAUDE.md §10b).
  const { data: allRows } = await db
    .from('schedule_acceptances')
    .select('date, ai_hours, ai_cost_kr, current_hours, current_cost_kr, est_revenue_kr, batch_id, decided_at')
    .eq('business_id', biz.id)
    .gte('date', from!)
    .order('date', { ascending: true })

  const rows = (allRows ?? []).filter((r: any) => r.date <= to!)

  return NextResponse.json({ rows }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
