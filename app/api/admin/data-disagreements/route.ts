// app/api/admin/data-disagreements/route.ts
//
// On-demand admin view of every period where the aggregator detected a
// data-source mismatch. Backs both /admin/v2 surfaces and the daily
// digest cron (which calls this same logic via the lib).
//
// "Disagreement" means the aggregator wrote one of these to
// monthly_metrics.cost_source or .rev_source:
//
//   COST                                                     SEVERITY
//   - 'fortnox_pk_disagrees'   PK staff outside 70-130 % of Fortnox      critical
//   - 'fortnox_pk_partial'     PK was connected mid-period               warning
//   - 'pk_partial'             PK only, mid-period (no Fortnox to fall   warning
//                              back to)
//
//   REVENUE
//   - 'pos_partial'            POS covers <90 % of calendar days         warning
//
// Source-agnostic by design: the moment Caspeco / Onslip / Ancon land
// with their own dedup paths producing similar `_disagrees` values, this
// alert pipeline picks them up automatically — no per-integration code.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin }      from '@/lib/admin/require-admin'
import { findDisagreements, type Disagreement } from '@/lib/admin/disagreements'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'

export async function GET(req: NextRequest) {
  noStore()
  const guard = await requireAdmin(req, {})
  if ('ok' in guard === false) return guard as NextResponse

  const url = new URL(req.url)
  const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30)))
  // Optional org_id filter — used by /admin/v2/customers/[orgId] page
  const orgId = url.searchParams.get('org_id') ?? undefined

  const db = createAdminClient()
  const { rows, byCategory } = await findDisagreements(db, { days, orgId })

  return NextResponse.json({
    days,
    org_id:        orgId ?? null,
    total:         rows.length,
    by_category:   byCategory,
    disagreements: rows,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
