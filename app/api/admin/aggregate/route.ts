// @ts-nocheck
// /api/admin/aggregate — trigger aggregation for all businesses
// Populates daily_metrics, monthly_metrics, dept_metrics from raw data

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { aggregateAll } from '@/lib/sync/aggregate'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  const secret = req.headers.get('x-admin-secret') ?? req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Get all active businesses
  const { data: businesses } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('is_active', true)

  if (!businesses?.length) {
    return NextResponse.json({ error: 'No active businesses found' })
  }

  const results = []
  for (const biz of businesses) {
    try {
      const result = await aggregateAll(biz.org_id, biz.id)
      results.push({ business: biz.name, ...result })
    } catch (e: any) {
      results.push({ business: biz.name, error: e.message })
    }
  }

  return NextResponse.json({ ok: true, businesses: results })
}
