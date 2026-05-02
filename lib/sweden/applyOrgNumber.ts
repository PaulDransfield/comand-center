// lib/sweden/applyOrgNumber.ts
//
// Single source of truth for "set the organisation's org-nr and propagate
// to Stripe". Used by:
//   - /api/settings/company-info (owner editing later)
//   - /api/onboarding/complete   (set during signup, M046)
//
// Why a helper: pre-M046 the Stripe sync logic lived inline in
// company-info; onboarding-complete needed the same dance. Duplicating
// the Stripe metadata + tax_id flow risked drift (one path forgetting
// to delete stale tax_ids before re-creating, etc.).
//
// Stripe sync is best-effort — local DB write always happens, Stripe
// errors are reported in the result so callers can surface a non-blocking
// warning. Skipped entirely when STRIPE_SECRET_KEY isn't set or the
// org has no stripe_customer_id yet.

import { validateOrgNr, formatOrgNr } from '@/lib/sweden/orgnr'

export type ApplyOrgNumberResult =
  | {
      ok:                  true
      org_number:          string   // 10 digits
      org_number_display:  string   // XXXXXX-XXXX
      stripe_synced:       boolean
      tax_id_synced:       boolean
      tax_id_rejected:     boolean
    }
  | {
      ok:    false
      error: string
    }

export async function applyOrgNumberToOrg(opts: {
  db:            any                // SupabaseAdminClient
  orgId:         string
  rawOrgNumber:  string | null | undefined
}): Promise<ApplyOrgNumberResult> {
  const check = validateOrgNr(opts.rawOrgNumber)
  if (!check.ok) return { ok: false, error: check.error }

  // Need stripe_customer_id for the Stripe sync. Single round-trip: read
  // first, then conditional update.
  const { data: orgRow, error: readErr } = await opts.db
    .from('organisations')
    .select('stripe_customer_id')
    .eq('id', opts.orgId)
    .maybeSingle()
  if (readErr) return { ok: false, error: readErr.message }

  const { error: updateErr } = await opts.db
    .from('organisations')
    .update({
      org_number:        check.value,
      org_number_set_at: new Date().toISOString(),
    })
    .eq('id', opts.orgId)
  if (updateErr) return { ok: false, error: updateErr.message }

  let stripeSynced  = false
  let taxIdSynced   = false
  let taxIdRejected = false

  if (orgRow?.stripe_customer_id && process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = (await import('stripe')).default
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' as any })

      // Metadata sync — universal, always succeeds for live customers.
      await stripe.customers.update(orgRow.stripe_customer_id, {
        metadata: {
          org_number:         check.value,
          org_number_display: formatOrgNr(check.value),
          org_number_set_at:  new Date().toISOString(),
        },
      })
      stripeSynced = true

      // Tax-ID sync — replace any existing SE eu_vat with the current
      // org-nr. Delete-then-create because Stripe doesn't expose
      // update-in-place. createTaxId throws when the customer isn't
      // VAT-registered (e.g. sole proprietor below threshold) — we
      // swallow that, metadata is already in place for invoice display.
      const targetVatValue = `SE${check.value}01`
      try {
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
        taxIdRejected = true
        console.warn('[applyOrgNumber] Stripe tax_id sync rejected:', taxErr?.message)
      }
    } catch (e: any) {
      // Outer Stripe failure — outage, deleted customer, key rotated.
      // Local save already happened; surfaces as stripe_synced=false so
      // the UI can show a non-blocking warning.
      console.warn('[applyOrgNumber] Stripe sync failed:', e?.message)
    }
  }

  return {
    ok:                 true,
    org_number:         check.value,
    org_number_display: formatOrgNr(check.value),
    stripe_synced:      stripeSynced,
    tax_id_synced:      taxIdSynced,
    tax_id_rejected:    taxIdRejected,
  }
}
