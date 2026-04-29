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
import { validateOrgNr, formatOrgNr } from '@/lib/sweden/orgnr'

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

  const check = validateOrgNr(body?.org_number)
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 })
  }

  const db = createAdminClient()

  // Need stripe_customer_id for the Stripe sync below — fetch alongside the
  // update target. Single round-trip: read first, then conditional update.
  const { data: orgRow, error: readErr } = await db
    .from('organisations')
    .select('stripe_customer_id')
    .eq('id', auth.orgId)
    .maybeSingle()
  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 })

  const { error } = await db
    .from('organisations')
    .update({
      org_number:        check.value,
      org_number_set_at: new Date().toISOString(),
    })
    .eq('id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Push the org-nr to Stripe so future invoices carry it as metadata.
  // Best-effort: a Stripe outage shouldn't block the owner from setting
  // the field locally. Failure logs to console + Sentry but the response
  // still reports success on our side.
  let stripeSynced = false
  if (orgRow?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' as any })
      await stripe.customers.update(orgRow.stripe_customer_id, {
        metadata: {
          org_number:         check.value,
          org_number_display: formatOrgNr(check.value),
          org_number_set_at:  new Date().toISOString(),
        },
      })
      stripeSynced = true
    } catch (e: any) {
      // Common reasons: Stripe customer was deleted, key rotated, network blip.
      // None of these should block the owner — we record the field locally
      // and Stripe sync can be retried via "save again" later.
      console.warn('[company-info] Stripe metadata sync failed:', e?.message)
    }
  }

  return NextResponse.json({
    ok: true,
    org_number:         check.value,
    org_number_display: formatOrgNr(check.value),
    stripe_synced:      stripeSynced,
  })
}
