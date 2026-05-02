// app/api/settings/company-info/route.ts
//
// Owner-facing endpoint for the org-nr (and any future company-level
// fields). GET returns the current state; POST validates + writes.
//
// Auth: session-based (the owner editing their own organisation).
// Validation: lib/sweden/orgnr.ts handles checksum + format.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { formatOrgNr } from '@/lib/sweden/orgnr'
import { applyOrgNumberToOrg } from '@/lib/sweden/applyOrgNumber'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data, error } = await db
    .from('organisations')
    .select('id, name, org_number, org_number_set_at, org_number_grace_started_at')
    .eq('id', auth.orgId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data)  return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  // Compute grace status — used by the soft-banner UI.
  const now            = Date.now()
  const graceStarted   = data.org_number_grace_started_at ? new Date(data.org_number_grace_started_at).getTime() : now
  const GRACE_MS       = 30 * 24 * 60 * 60 * 1000
  const graceEnds      = graceStarted + GRACE_MS
  const inGrace        = !data.org_number && now < graceEnds
  const graceExpired   = !data.org_number && now >= graceEnds
  const daysRemaining  = Math.max(0, Math.ceil((graceEnds - now) / (24 * 60 * 60 * 1000)))

  return NextResponse.json({
    organisation: {
      id:                  data.id,
      name:                data.name,
      org_number:          data.org_number,
      org_number_display:  data.org_number ? formatOrgNr(data.org_number) : null,
      org_number_set_at:   data.org_number_set_at,
      grace_started_at:    data.org_number_grace_started_at,
      grace_ends_at:       new Date(graceEnds).toISOString(),
      grace_days_remaining: daysRemaining,
      in_grace:            inGrace,
      grace_expired:       graceExpired,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any = {}
  try { body = await req.json() } catch {}

  // All the validation + DB write + Stripe metadata + tax_id sync lives in
  // the shared helper so /api/onboarding/complete and this endpoint can't
  // drift. See lib/sweden/applyOrgNumber.ts for the full rationale.
  const result = await applyOrgNumberToOrg({
    db:           createAdminClient(),
    orgId:        auth.orgId,
    rawOrgNumber: body?.org_number,
  })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 })
  }

  return NextResponse.json({
    ok:                 true,
    org_number:         result.org_number,
    org_number_display: result.org_number_display,
    stripe_synced:      result.stripe_synced,
    tax_id_synced:      result.tax_id_synced,
    tax_id_rejected:    result.tax_id_rejected,
  })
}
