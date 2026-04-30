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

  // Push the org-nr to Stripe.
  //
  // Two pieces:
  //   1. customer.metadata — universal, always succeeds. Future invoices
  //      can include the org-nr via Stripe's display rules.
  //   2. customer.taxIds — structured tax_id resource. For Swedish
  //      VAT-registered companies this should be eu_vat type with value
  //      `SE${orgNr}01` (the trailing "01" is the legal-entity sub-account
  //      identifier used by Skatteverket). Stripe validates the format
  //      server-side; non-VAT-registered companies (e.g. sole proprietors
  //      below the registration threshold) get rejected, in which case
  //      we keep the metadata-only state.
  //
  // Both are best-effort. The whole block is skipped when STRIPE_SECRET_KEY
  // isn't set (Stripe not yet wired) — code is dormant until that happens,
  // then activates automatically.
  let stripeSynced  = false
  let taxIdSynced   = false
  let taxIdRejected = false
  if (orgRow?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' as any })

      // Metadata sync — always attempt.
      await stripe.customers.update(orgRow.stripe_customer_id, {
        metadata: {
          org_number:         check.value,
          org_number_display: formatOrgNr(check.value),
          org_number_set_at:  new Date().toISOString(),
        },
      })
      stripeSynced = true

      // Tax-ID sync — replace any existing SE eu_vat with the current
      // org-nr. Delete-then-create keeps the resource clean (Stripe doesn't
      // expose an update-in-place for tax_ids). Skipped if the create
      // throws: that signals the customer isn't VAT-registered, which is
      // fine — metadata is still in place for invoice display.
      const targetVatValue = `SE${check.value}01`
      try {
        // The Stripe Node SDK exposes tax-id methods directly on the
        // customers resource: listTaxIds / createTaxId / deleteTaxId.
        const customers: any = stripe.customers
        const existing = await customers.listTaxIds(orgRow.stripe_customer_id, { limit: 100 })
        const stale = (existing.data ?? []).filter((t: any) =>
          t?.type === 'eu_vat' && typeof t?.value === 'string' && t.value.startsWith('SE')
        )
        const alreadyMatches = stale.length === 1 && stale[0].value === targetVatValue
        if (!alreadyMatches) {
          for (const t of stale) {
            try { await customers.deleteTaxId(orgRow.stripe_customer_id, t.id) } catch { /* skip */ }
          }
          await customers.createTaxId(orgRow.stripe_customer_id, {
            type:  'eu_vat',
            value: targetVatValue,
          })
        }
        taxIdSynced = true
      } catch (taxErr: any) {
        // Stripe rejects when the value isn't a VAT-registered SE org-nr.
        // The metadata sync already succeeded; that's the universal fallback.
        taxIdRejected = true
        console.warn('[company-info] Stripe tax_id sync rejected:', taxErr?.message)
      }
    } catch (e: any) {
      // Outer failure — Stripe outage, deleted customer, key rotated.
      // Local save already happened above; surfaces as stripe_synced=false
      // so the UI can show a non-blocking warning.
      console.warn('[company-info] Stripe sync failed:', e?.message)
    }
  }

  return NextResponse.json({
    ok: true,
    org_number:         check.value,
    org_number_display: formatOrgNr(check.value),
    stripe_synced:      stripeSynced,
    tax_id_synced:      taxIdSynced,
    tax_id_rejected:    taxIdRejected,
  })
}
