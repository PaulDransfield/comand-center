// app/api/settings/vat-cadence/route.ts
//
// Update businesses.vat_filing_cadence ('monthly' | 'quarterly' | 'annually').
// Used by the /settings/setup-health page so the customer can declare
// their Skatteverket filing cadence — drives the momsrapport scope.
//
// POST /api/settings/vat-cadence
//   Body: { business_id, cadence }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness } from '@/lib/auth/permissions'

const ALLOWED = new Set(['monthly', 'quarterly', 'annually'])

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const cadence    = String(body.cadence    ?? '').trim()
  if (!businessId)        return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!ALLOWED.has(cadence)) return NextResponse.json({ error: 'invalid cadence (monthly/quarterly/annually)' }, { status: 400 })
  if (!canAccessBusiness(subject, businessId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const { error } = await db
    .from('businesses')
    .update({ vat_filing_cadence: cadence })
    .eq('id', businessId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, cadence },
    { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
