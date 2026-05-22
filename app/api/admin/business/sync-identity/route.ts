// app/api/admin/business/sync-identity/route.ts
//
// Admin endpoint to pull a business's identity (org-nr, name, city,
// country) from Fortnox and reconcile against our businesses row.
// Auto-corrects org_number; flags name/city divergences as alerts
// the owner reviews. See lib/fortnox/company-identity.ts for policy.
//
// POST { business_id }
//
// Use cases:
//   - Backfill missing org_number on existing businesses (Chicce's
//     case 2026-05-22 — org_number was NULL, Fortnox had the legal
//     value, R1 print compliance needs it).
//   - On-demand reconciliation after a customer re-OAuths Fortnox to
//     a different company by mistake.
//
// The same syncBusinessIdentityFromFortnox() helper will be wired into
// the per-sync engine path in a follow-up commit so this becomes the
// daily-automated case; this admin endpoint stays for force-runs.

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { requireAdmin }                from '@/lib/admin/require-admin'
import { createAdminClient }           from '@/lib/supabase/server'
import { syncBusinessIdentityFromFortnox } from '@/lib/fortnox/company-identity'

export async function POST(req: NextRequest) {
  noStore()

  const body       = await req.json().catch(() => ({} as any))
  const businessId = String(body?.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  // Look up the business's org_id so requireAdmin can verify (admin
  // doesn't know org_id; same pattern as kick-backfill).
  const db = createAdminClient()
  const { data: biz, error: bizErr } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('id', businessId)
    .maybeSingle()
  if (bizErr) return NextResponse.json({ error: bizErr.message }, { status: 500 })
  if (!biz)   return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const guard = await requireAdmin(req, { orgId: biz.org_id, businessId })
  if (!('ok' in guard)) return guard

  const result = await syncBusinessIdentityFromFortnox(db, biz.org_id, businessId)

  return NextResponse.json(result, {
    status: result.ok ? 200 : 502,
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
