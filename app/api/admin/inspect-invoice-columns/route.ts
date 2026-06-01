// app/api/admin/inspect-invoice-columns/route.ts
//
// POST — diagnostic. Asks Claude to DESCRIBE the invoice's line-item
// table layout in plain text (no tool_use), so I can see how the model
// interprets the columns BEFORE I tell it which column is the line total.
//
// Used to scope the Marini/Rima per-line-value-extraction fix. The
// rebill rule dry-run showed Direction-A passthroughs extract rows
// summing to only ~8% of the invoice header total — the model is picking
// the wrong numeric column. This endpoint tells me which one it's
// picking by asking it to walk through the layout.
//
// Body: { invoices: [{ business_id, fortnox_invoice_number }, ...] }
// Auth: x-admin-secret header must match ADMIN_SECRET env.
//
// No DB writes. One Anthropic call per invoice. Returns the model's
// free-text description per invoice plus the parsed header total for
// cross-reference.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS } from '@/lib/ai/models'
import { _dryRunFetchPdfBytes } from '@/lib/inventory/pdf-extractor'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const INSPECTION_PROMPT = `You are looking at a Swedish restaurant supplier invoice PDF.

I need you to DESCRIBE the line-item table layout — DO NOT extract rows
into a structured tool. Instead, walk me through what you see, like an
expert explaining it.

Answer all of these specifically:

1. INVOICE HEADER:
   - Supplier name (as printed on the invoice)
   - Invoice/document type ("FAKTURA", "KREDITFAKTURA", etc.)
   - Total amount the buyer owes (ex-VAT, the number that should match
     what's printed as "Summa exkl. moms" or "Att betala excl. moms"
     or similar). State the exact value.
   - Number of pages

2. PAGE-1 STRUCTURE:
   - Is there a single summary line referencing another supplier or a
     period (e.g. "Levererat från Marini/Rima"), or is page 1 itself an
     itemized invoice?

3. ITEMIZED TABLE LAYOUT (the actual product rows — wherever they live,
   page 1 or page 2+):
   - List EVERY column header you see, in the order they appear left-to-
     right (e.g. "Artikel | Kvantitet | Enhet | Pris/styck | Pris/kg |
     Rabatt | Belopp | Moms"). Use the exact words/codes on the invoice.
   - For each column header, say what UNIT and what it represents
     (per-piece price, per-kg price, line total ex-VAT, line total inc-
     VAT, discount amount, etc).
   - Tell me which column represents the LINE TOTAL EX-VAT (the number
     that, summed across all rows, should equal the invoice header
     total).

4. THREE SAMPLE ROWS:
   - For three actual product rows from the itemization, give me the
     COMPLETE row as printed: every column's value in order, plus what
     product it's describing.
   - Especially: what's the difference between the per-unit price column
     and the line total column? Is there a multiplier (per-100g, per-
     dozen, per-pallet) that's NOT just qty?

5. RECONCILIATION CHECK:
   - Sum the LINE TOTAL EX-VAT column across all itemized rows you can
     see. State that sum.
   - Compare it to the invoice header total. Do they match within 5%?
     If not, which other column would, summed across all rows, match the
     header? That's the column the extractor SHOULD pick.

Be precise about numbers. If a column has multiple decimal places (like
"6,9512"), report it that way. If you can't tell what something means,
say so explicitly rather than guess.`

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
  if (invoices.length > 6) return NextResponse.json({ error: 'max 6 invoices per request' }, { status: 400 })

  const db = createAdminClient()
  const { getFreshFortnoxAccessToken } = await import('@/lib/fortnox/api/auth')
  const results: any[] = []

  for (const inv of invoices) {
    const r: any = { business_id: inv.business_id, fortnox_invoice_number: inv.fortnox_invoice_number }
    try {
      const { data: ext } = await db
        .from('invoice_pdf_extractions')
        .select('pdf_file_id, supplier_name_snapshot, total_header')
        .eq('business_id', inv.business_id)
        .eq('fortnox_invoice_number', inv.fortnox_invoice_number)
        .maybeSingle()
      if (!ext?.pdf_file_id) { r.error = 'no pdf_file_id'; results.push(r); continue }
      r.expected_header_total = ext.total_header
      r.supplier              = ext.supplier_name_snapshot

      const { data: biz } = await db.from('businesses').select('org_id').eq('id', inv.business_id).maybeSingle()
      if (!biz?.org_id) { r.error = 'business not found'; results.push(r); continue }
      const token = await getFreshFortnoxAccessToken(db, biz.org_id, inv.business_id)
      if (!token) { r.error = 'no fortnox token'; results.push(r); continue }

      const pdf = await _dryRunFetchPdfBytes(token, ext.pdf_file_id)
      if (pdf.kind === 'error') { r.error = pdf.message; results.push(r); continue }
      const pdfBase64 = pdf.bytes.toString('base64')

      // Plain Claude call — text response, no tool_use. Use Sonnet here
      // because we want the most careful read of the layout possible.
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) { r.error = 'no anthropic key'; results.push(r); continue }
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model:      AI_MODELS.ANALYSIS,   // Sonnet 4.6
          max_tokens: 4096,
          messages: [{
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
              { type: 'text',     text: INSPECTION_PROMPT },
            ],
          }],
        }),
      })
      if (!apiRes.ok) { r.error = `anthropic ${apiRes.status}: ${(await apiRes.text()).slice(0, 200)}`; results.push(r); continue }
      const json: any = await apiRes.json()
      const textBlock = Array.isArray(json?.content) ? json.content.find((b: any) => b.type === 'text') : null
      r.description = textBlock?.text ?? '(empty)'
      r.tokens_input  = json?.usage?.input_tokens  ?? 0
      r.tokens_output = json?.usage?.output_tokens ?? 0
    } catch (e: any) {
      r.error = e?.message ?? String(e)
    }
    results.push(r)
  }
  return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } })
}
