// app/api/forecast/accuracy/route.ts
//
// A2.9 — Forecast accuracy badge data source.
// GET /api/forecast/accuracy?business_id=…&months=6

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeForecastAccuracy } from '@/lib/forecast/accuracy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const u = new URL(req.url)
  const businessId = u.searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const monthsRaw = Number(u.searchParams.get('months') ?? 6)
  const months    = Number.isFinite(monthsRaw) ? Math.max(1, Math.min(24, Math.round(monthsRaw))) : 6

  const db = createAdminClient()
  try {
    const acc = await computeForecastAccuracy(db, businessId, months)
    return NextResponse.json(acc, {
      headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
    })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'accuracy_failed' }, { status: 500 })
  }
}
