// app/api/admin/reextract-invoice/route.ts
//
// POST — re-run the FULL production extractor on a list of invoices and
// return per-invoice ExtractResult so the caller can classify the outcome
// against the reconciliation acceptance bar.
//
// Used to validate the Marini/Rima passthrough-scaling fix on the 5 known
// passthrough invoices. Unlike the dry-run endpoint, this goes through
// extractInvoicePdf() — the same code production cron uses, including:
//   - Haiku-first cascade with Sonnet escalation
//   - passthrough_scaling tool-schema field + server-side scaling
//   - All validators (over_extraction, total_mismatch, sign-flip rescues, …)
//   - Persistence via apply_invoice_pdf_extraction RPC on success
//
// Persistence is idempotent (the RPC handles dedup), so re-runs against
// an already-extracted invoice are safe — if the new attempt fails
// validation, the old state is preserved.
//
// Body: { invoices: [{ business_id, fortnox_invoice_number }, ...] }
// Auth: x-admin-secret header must match ADMIN_SECRET env.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { extractInvoicePdf } from '@/lib/inventory/pdf-extractor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  noStore()
  const secret = req.headers.get('x-admin-secret')
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const invoices: { business_id: string; fortnox_invoice_number: string }[] = Array.isArray(body?.invoices) ? body.invoices : []
  if (invoices.length === 0) return NextResponse.json({ error: 'invoices required' }, { status: 400 })
  if (invoices.length > 10) return NextResponse.json({ error: 'max 10 invoices per request' }, { status: 400 })

  const db = createAdminClient()
  const results: any[] = []

  for (const inv of invoices) {
    const r: any = { business_id: inv.business_id, fortnox_invoice_number: inv.fortnox_invoice_number }
    try {
      // Pull the input shape extractInvoicePdf needs from invoice_pdf_extractions + fortnox_supplier_invoices.
      const { data: ext } = await db
        .from('invoice_pdf_extractions')
        .select('org_id, pdf_file_id, supplier_name_snapshot, supplier_fortnox_number, invoice_date, total_header, status, rows_extracted')
        .eq('business_id', inv.business_id)
        .eq('fortnox_invoice_number', inv.fortnox_invoice_number)
        .maybeSingle()
      if (!ext) { r.error = 'no extraction record'; results.push(r); continue }
      r.prev_status         = ext.status
      r.prev_rows_extracted = ext.rows_extracted
      if (!ext.pdf_file_id) { r.error = 'no pdf_file_id'; results.push(r); continue }

      const result = await extractInvoicePdf(db, {
        org_id:                  ext.org_id,
        business_id:             inv.business_id,
        fortnox_invoice_number:  inv.fortnox_invoice_number,
        invoice_date:            ext.invoice_date,
        supplier_fortnox_number: ext.supplier_fortnox_number,
        supplier_name_snapshot:  ext.supplier_name_snapshot,
        pdf_file_id:             ext.pdf_file_id,
        invoice_total_header:    ext.total_header,
      })

      r.status              = result.status
      r.rows_extracted      = result.rows_extracted
      r.total_extracted     = result.total_extracted
      r.total_header        = result.total_header
      r.total_delta_pct     = result.total_delta_pct
      r.validation_warnings = result.validation_warnings
      r.ai_model            = result.ai_model
      r.tokens_input        = result.tokens_input
      r.tokens_output       = result.tokens_output
      r.cost_usd            = result.cost_usd
      r.error_message       = result.error_message
      r.sample_rows         = (result.extracted_rows ?? []).slice(0, 5).map(row => ({
        description: row.description?.slice(0, 80),
        quantity:    row.quantity,
        unit:        row.unit,
        ppu:         row.price_per_unit,
        total:       row.total_excl_vat,
      }))

      // Classification per the prompt's three buckets.
      const scalingApplied = (result.validation_warnings ?? []).some(w => w.code === 'proportional_scaling_applied')
      const scalingRejected = (result.validation_warnings ?? []).some(w => w.code === 'passthrough_scaling_rejected')
      const reconciles = result.total_extracted != null && result.total_header != null
        && Math.abs(Number(result.total_extracted) - Number(result.total_header)) < 1.0
      if (result.status === 'extracted' && scalingApplied && reconciles) r.classification = 'GOOD'
      else if (scalingRejected)                                          r.classification = 'REJECTED'
      else if (result.rows_extracted <= 1)                               r.classification = 'INERT'
      else                                                                r.classification = result.status === 'extracted' ? 'OTHER_ACCEPTED' : 'OTHER_BLOCKED'
    } catch (e: any) {
      r.error = e?.message ?? String(e)
    }
    results.push(r)
  }

  return NextResponse.json({
    results,
    summary: {
      total:                   results.length,
      good:                    results.filter(r => r.classification === 'GOOD').length,
      inert:                   results.filter(r => r.classification === 'INERT').length,
      rejected:                results.filter(r => r.classification === 'REJECTED').length,
      other_accepted:          results.filter(r => r.classification === 'OTHER_ACCEPTED').length,
      other_blocked:           results.filter(r => r.classification === 'OTHER_BLOCKED').length,
      errors:                  results.filter(r => r.error).length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
