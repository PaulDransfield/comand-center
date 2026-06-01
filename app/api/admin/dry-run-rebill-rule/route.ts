// app/api/admin/dry-run-rebill-rule/route.ts
//
// POST — dry-run extraction against a list of invoices using the CURRENT
// branch's SYSTEM_PROMPT, WITHOUT writing to any DB table. Returns the
// extracted rows + per-invoice reconciliation diagnostic so the operator
// can verify the rule rewrite handles both passthroughs and rebills
// correctly before approving real re-extraction.
//
// Body: { invoices: [{ business_id, fortnox_invoice_number }, ...] }
// Auth: x-admin-secret header must match ADMIN_SECRET env.
//
// READ-ONLY against our DB. Hits Fortnox for the PDF (GET-only via the
// existing supplierinvoicefileconnections path) and Anthropic for the
// extraction itself. Per invoice this is ~1 Anthropic call + ~1 Fortnox
// GET; budget accordingly when picking the input list.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS } from '@/lib/ai/models'
import { _dryRunFetchPdfBytes, _dryRunCallClaude, evaluateReconciliation } from '@/lib/inventory/pdf-extractor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: NextRequest) {
  noStore()

  // Admin gate — endpoint touches Anthropic + Fortnox on owner request.
  const secret = req.headers.get('x-admin-secret')
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: any
  try { body = await req.json() } catch { body = {} }
  const invoices: { business_id: string; fortnox_invoice_number: string }[] = Array.isArray(body?.invoices) ? body.invoices : []
  if (invoices.length === 0) {
    return NextResponse.json({ error: 'invoices required' }, { status: 400 })
  }
  if (invoices.length > 20) {
    return NextResponse.json({ error: 'max 20 invoices per request' }, { status: 400 })
  }

  const db = createAdminClient()
  const { getFreshFortnoxAccessToken } = await import('@/lib/fortnox/api/auth')

  const results: any[] = []

  for (const inv of invoices) {
    const result: any = {
      business_id:            inv.business_id,
      fortnox_invoice_number: inv.fortnox_invoice_number,
    }
    try {
      // Pull the extraction record so we have the pdf_file_id + supplier hint.
      const { data: ext } = await db
        .from('invoice_pdf_extractions')
        .select('pdf_file_id, supplier_name_snapshot, total_header, status, rows_extracted')
        .eq('business_id', inv.business_id)
        .eq('fortnox_invoice_number', inv.fortnox_invoice_number)
        .maybeSingle()
      if (!ext) { result.error = 'no extraction record'; results.push(result); continue }
      result.prev_status         = ext.status
      result.prev_rows_extracted = ext.rows_extracted
      result.prev_total_header   = ext.total_header
      if (!ext.pdf_file_id) { result.error = 'no pdf_file_id'; results.push(result); continue }

      // Fresh Fortnox token for the business's org — use the same helper
      // the prod extractor uses so refresh-lock logic applies.
      const { data: biz } = await db.from('businesses').select('org_id').eq('id', inv.business_id).maybeSingle()
      if (!biz?.org_id) { result.error = 'business not found'; results.push(result); continue }
      const token = await getFreshFortnoxAccessToken(db, biz.org_id, inv.business_id)
      if (!token) { result.error = 'no fortnox token'; results.push(result); continue }

      // Fetch the PDF (Fortnox inbox → archive fallback).
      const pdf = await _dryRunFetchPdfBytes(token, ext.pdf_file_id)
      if (pdf.kind === 'error') { result.error = pdf.message; results.push(result); continue }
      const pdfBase64 = pdf.bytes.toString('base64')

      // Call the model with the current branch's SYSTEM_PROMPT. Haiku
      // first (mirrors prod cascade). For the dry-run we don't escalate
      // automatically to Sonnet — the rewrite is about classification,
      // not extraction depth; if Haiku gets it right, prod will too.
      const claude = await _dryRunCallClaude(
        pdfBase64,
        {
          org_id:                  '', // unused by callClaude
          business_id:             inv.business_id,
          fortnox_invoice_number:  inv.fortnox_invoice_number,
          supplier_name_snapshot:  ext.supplier_name_snapshot ?? null,
          pdf_file_id:             ext.pdf_file_id,
        } as any,
        AI_MODELS.AGENT,
      )

      const rows = claude.payload?.rows ?? []
      const totalExtracted = rows.reduce((s: number, r: any) => s + Number(r.total_excl_vat ?? 0), 0)
      const headerTotal = Number(ext.total_header ?? 0)

      // The server-side guard — the LOAD-BEARING safety floor. Call the
      // same evaluateReconciliation the prod extractor calls, so the
      // dry-run surfaces exactly what would happen on a real run.
      const recon = headerTotal && Math.abs(headerTotal) > 0.01
        ? evaluateReconciliation(totalExtracted, headerTotal, rows)
        : null

      result.rows_count        = rows.length
      result.total_extracted   = Math.round(totalExtracted * 100) / 100
      result.total_header      = headerTotal
      result.recon_delta_pct      = recon ? Math.round(recon.signed_delta_pct * 1000) / 10 : null
      result.recon_warning_code   = recon?.warning?.code ?? null
      result.recon_warning_msg    = recon?.warning?.message ?? null
      result.would_block          = recon?.warning?.severity === 'block'
      result.would_accept         = recon?.warning === null || recon?.warning?.severity === 'warn'
      result.tokens_input      = claude.tokensIn
      result.tokens_output     = claude.tokensOut
      result.sample_rows       = rows.slice(0, 5).map((r: any) => ({
        description: String(r.description ?? '').slice(0, 80),
        quantity:    r.quantity,
        unit:        r.unit,
        ppu:         r.price_per_unit,
        total:       r.total_excl_vat,
      }))
      result.first_row_is_summary = rows.length > 0
        && /levererat\s+från|axfood\s+\d{6,}/i.test(String(rows[0]?.description ?? ''))
    } catch (e: any) {
      result.error = e?.message ?? String(e)
    }
    results.push(result)
  }

  return NextResponse.json({
    results,
    summary: {
      total:                       results.length,
      with_errors:                 results.filter(r => r.error).length,
      one_row_extractions:         results.filter(r => r.rows_count === 1).length,
      multi_row_extractions:       results.filter(r => (r.rows_count ?? 0) > 1).length,
      would_accept:                results.filter(r => r.would_accept === true).length,
      would_block:                 results.filter(r => r.would_block === true).length,
      blocked_over_extraction:     results.filter(r => r.recon_warning_code === 'over_extraction').length,
      blocked_total_mismatch:      results.filter(r => r.recon_warning_code === 'total_mismatch').length,
      accepted_rebill_loose:       results.filter(r => r.recon_warning_code === 'rebill_loose_tolerance').length,
    },
  }, { headers: { 'Cache-Control': 'no-store' } })
}
