// app/api/inventory/extractions/[id]/route.ts
//
// GET — full detail for one invoice_pdf_extractions row, including the
//       cached extracted_rows_json (Phase B.4 review UI's row grid).
//
// POST — actions on this extraction. Body { action: 'apply' | 'reextract' }
//   apply    — persist the rows (optionally overridden in body.rows)
//              via the existing apply_invoice_pdf_extraction RPC, marks
//              status='extracted'.
//   reextract — re-run Claude on the PDF (fresh extraction); useful when
//              extracted_rows_json is null (extraction happened pre-M082).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { extractInvoicePdf } from '@/lib/inventory/pdf-extractor'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = params.id
  const db = createAdminClient()

  // Pull extraction WITH the rows JSON (graceful if column missing)
  let { data: row, error } = await db
    .from('invoice_pdf_extractions')
    .select('*, extracted_rows_json')
    .eq('id', id)
    .maybeSingle()
  if (error && error.message?.includes('extracted_rows_json')) {
    const fallback = await db
      .from('invoice_pdf_extractions')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    row = fallback.data as any
  }
  if (!row) return NextResponse.json({ error: 'extraction not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, row.business_id)
  if (forbidden) return forbidden

  return NextResponse.json({
    id:                       row.id,
    business_id:              row.business_id,
    org_id:                   row.org_id,
    status:                   row.status,
    supplier:                 row.supplier_name_snapshot,
    supplier_number:          row.supplier_fortnox_number,
    invoice_number:           row.fortnox_invoice_number,
    invoice_date:             row.invoice_date,
    pdf_file_id:              row.pdf_file_id,
    rows_extracted:           row.rows_extracted,
    total_extracted:          row.total_extracted,
    total_header:             row.total_header,
    total_delta_pct:          row.total_delta_pct,
    validation_warnings:      row.validation_warnings ?? [],
    extracted_rows:           row.extracted_rows_json ?? null,
    ai_model:                 row.ai_model,
    cost_usd:                 row.cost_usd,
    completed_at:             row.completed_at,
    fortnox_url:              `https://apps.fortnox.se/supplierinvoice/${encodeURIComponent(row.fortnox_invoice_number)}`,
    pdf_proxy_url:            row.pdf_file_id
      ? `/api/integrations/fortnox/file?file_id=${encodeURIComponent(row.pdf_file_id)}&business_id=${row.business_id}`
      : null,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = params.id
  const body = await req.json().catch(() => ({})) as any
  const action = String(body.action ?? '').trim()

  const db = createAdminClient()
  const { data: row } = await db
    .from('invoice_pdf_extractions')
    .select('id, org_id, business_id, fortnox_invoice_number, invoice_date, supplier_fortnox_number, supplier_name_snapshot, pdf_file_id, total_header')
    .eq('id', id)
    .maybeSingle()
  if (!row) return NextResponse.json({ error: 'extraction not found' }, { status: 404 })

  const forbidden = requireBusinessAccess(auth, row.business_id)
  if (forbidden) return forbidden

  if (action === 'apply') {
    // Use rows from body (owner-edited) if provided, else read the
    // cached extracted_rows_json from the extraction row.
    let rowsToApply = Array.isArray(body.rows) ? body.rows : null
    if (!rowsToApply) {
      const { data: rj } = await db
        .from('invoice_pdf_extractions')
        .select('extracted_rows_json')
        .eq('id', id)
        .maybeSingle()
      rowsToApply = (rj as any)?.extracted_rows_json ?? null
    }
    if (!rowsToApply || rowsToApply.length === 0) {
      return NextResponse.json({
        error: 'no_rows_to_apply',
        detail: 'No rows in body and no cached extracted_rows_json. Run action=reextract first.',
      }, { status: 400 })
    }
    // Normalise into the RPC-accepted shape
    const rpcRows = (rowsToApply as any[]).map((r, idx) => ({
      row_number:     idx + 1,
      description:    String(r.description ?? '').trim(),
      article_number: r.article_number ? String(r.article_number).trim() : null,
      quantity:       r.quantity       != null && r.quantity       !== '' ? String(Number(r.quantity))       : null,
      unit:           r.unit           ? String(r.unit).trim() : null,
      price_per_unit: r.price_per_unit != null && r.price_per_unit !== '' ? String(Number(r.price_per_unit)) : null,
      total_excl_vat: String(Number(r.total_excl_vat ?? 0)),
      vat_rate:       r.vat_rate       != null && r.vat_rate       !== '' ? String(Number(r.vat_rate))       : null,
    }))

    const { error: rpcErr } = await db.rpc('apply_invoice_pdf_extraction', {
      p_org_id:                  row.org_id,
      p_business_id:             row.business_id,
      p_supplier_fortnox_number: row.supplier_fortnox_number ?? '',
      p_supplier_name_snapshot:  row.supplier_name_snapshot ?? '',
      p_fortnox_invoice_number:  row.fortnox_invoice_number,
      p_invoice_date:            row.invoice_date,
      p_rows:                    rpcRows,
    })
    if (rpcErr) {
      return NextResponse.json({ error: 'apply_failed', detail: rpcErr.message }, { status: 500 })
    }

    // Mark the extraction as extracted (owner has approved)
    const totalExtracted = rpcRows.reduce((s, r) => s + (Number(r.total_excl_vat) || 0), 0)
    const updatePayload: any = {
      status:           'extracted',
      rows_extracted:   rpcRows.length,
      total_extracted:  totalExtracted,
      validation_warnings: [{ code: 'owner_approved', message: 'Approved via review UI', severity: 'warn' }],
      completed_at:     new Date().toISOString(),
    }
    try {
      await db.from('invoice_pdf_extractions').update({
        ...updatePayload,
        extracted_rows_json: rowsToApply,
      }).eq('id', id)
    } catch {
      await db.from('invoice_pdf_extractions').update(updatePayload).eq('id', id)
    }

    return NextResponse.json({
      ok:               true,
      action:           'apply',
      rows_persisted:   rpcRows.length,
      total_extracted:  totalExtracted,
    })
  }

  if (action === 'reextract') {
    if (!row.pdf_file_id) {
      return NextResponse.json({ error: 'no_pdf', detail: 'Extraction has no pdf_file_id; cannot re-extract.' }, { status: 400 })
    }
    // Run a fresh extraction
    const result = await extractInvoicePdf(db, {
      org_id:                  row.org_id,
      business_id:             row.business_id,
      fortnox_invoice_number:  row.fortnox_invoice_number,
      invoice_date:            row.invoice_date,
      supplier_fortnox_number: row.supplier_fortnox_number,
      supplier_name_snapshot:  row.supplier_name_snapshot,
      pdf_file_id:             row.pdf_file_id,
      invoice_total_header:    row.total_header,
    })

    // Persist the new outcome (rows + status)
    const update: any = {
      status:              result.status,
      rows_extracted:      result.rows_extracted,
      total_extracted:     result.total_extracted,
      total_header:        result.total_header,
      total_delta_pct:     result.total_delta_pct,
      validation_warnings: result.validation_warnings,
      ai_model:            result.ai_model,
      tokens_input:        result.tokens_input,
      tokens_output:       result.tokens_output,
      cost_usd:            result.cost_usd,
      error_message:       result.error_message,
      completed_at:        new Date().toISOString(),
    }
    try {
      await db.from('invoice_pdf_extractions').update({
        ...update,
        extracted_rows_json: result.extracted_rows,
      }).eq('id', id)
    } catch {
      await db.from('invoice_pdf_extractions').update(update).eq('id', id)
    }

    return NextResponse.json({
      ok:                true,
      action:            'reextract',
      new_status:        result.status,
      rows_extracted:    result.rows_extracted,
      cost_usd:          result.cost_usd,
      warnings:          result.validation_warnings,
    })
  }

  return NextResponse.json({ error: 'unknown_action', detail: `expected action in [apply, reextract], got ${action}` }, { status: 400 })
}
