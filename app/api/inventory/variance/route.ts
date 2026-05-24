// app/api/inventory/variance/route.ts
//
// GET ?business_id=&from=YYYY-MM-DD&to=YYYY-MM-DD
//   → variance report (theoretical vs actual product usage).
//
// Default range: last 30 days. The report needs at least a few weeks of
// POS sales + invoices to be meaningful — the page tells the owner so.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { computeVariance } from '@/lib/inventory/variance'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url        = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const from       = String(url.searchParams.get('from') ?? '').trim() || isoDaysAgo(30)
  const to         = String(url.searchParams.get('to')   ?? '').trim() || isoToday()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return NextResponse.json({ error: 'from/to must be YYYY-MM-DD' }, { status: 400 })
  }
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  try {
    const result = await computeVariance(db, businessId, from, to)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'computation failed' }, { status: 500 })
  }
}

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}
function isoDaysAgo(n: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}
