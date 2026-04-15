// @ts-nocheck
// app/api/admin/diagnose/route.ts
// TEMPORARY — diagnoses what Personalkollen sales API returns for connected integrations.
// Remove after investigation is complete.
// Call: GET /api/admin/diagnose?secret=commandcenter123

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { decrypt }                   from '@/lib/integrations/encryption'

export const dynamic    = 'force-dynamic'
export const maxDuration = 30

const BASE = 'https://personalkollen.se/api'

export async function GET(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET && secret !== 'commandcenter123') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Check what revenue data exists in the DB and where it came from
  const { data: revenueSummary } = await db
    .from('revenue_logs')
    .select('business_id, provider, period_year, period_month, revenue')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(24)

  // Check tracker_data to see what revenue is stored there
  const { data: trackerSummary } = await db
    .from('tracker_data')
    .select('business_id, period_year, period_month, revenue, staff_cost, food_cost, net_profit')
    .order('period_year', { ascending: false })
    .order('period_month', { ascending: false })
    .limit(24)

  // Count total revenue_logs rows
  const { count: revCount } = await db
    .from('revenue_logs')
    .select('id', { count: 'exact', head: true })

  // Count covers rows
  const { count: coversCount } = await db
    .from('covers')
    .select('id', { count: 'exact', head: true })

  return NextResponse.json({
    revenue_logs_total:  revCount ?? 0,
    covers_total:        coversCount ?? 0,
    revenue_logs_sample: revenueSummary ?? [],
    tracker_sample:      trackerSummary ?? [],
  })
}
