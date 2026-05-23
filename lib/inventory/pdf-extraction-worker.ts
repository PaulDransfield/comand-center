// lib/inventory/pdf-extraction-worker.ts
//
// The background-worker loop that drives Path B end-to-end:
//
//   1. Find invoices needing extraction (placeholder rows + has PDF +
//      not already extracted/needs_review).
//   2. For each: insert/refresh invoice_pdf_extractions job row.
//   3. Call extractInvoicePdf — validators run inside; persists on success.
//   4. Update the job row with outcome.
//   5. Flush progress to inventory_backfill_state every N invoices.
//
// Wires into the same status panel as the backfill (one in-flight
// operation per business at a time). Hard cap of N invoices per
// invocation so we don't overrun the function maxDuration; the kick
// endpoint chains another batch via waitUntil when more remain.

import { extractInvoicePdf, type ExtractResult } from './pdf-extractor'

// One invocation processes at most this many invoices. At ~10-15 s per
// PDF extraction (most of that is the Claude vision call), this leaves
// plenty of headroom under the 800 s maxDuration cap.
const BATCH_SIZE = 40

// Persist progress every N invoices so the UI stays alive.
const FLUSH_EVERY_N = 5

export interface RunInput {
  org_id:       string
  business_id:  string
}

export interface BatchSummary {
  invoices_in_batch:        number
  extracted:                number
  needs_review:             number
  failed:                   number
  no_pdf:                   number
  rows_persisted:           number
  total_cost_usd:           number
  remaining_after_batch:    number
}

interface CandidateInvoice {
  fortnox_invoice_number:   string
  invoice_date:             string
  supplier_fortnox_number:  string | null
  supplier_name_snapshot:   string | null
  pdf_lookup:               PdfLookupResult
  invoice_total_header:     number | null
}

// Tagged result so the worker can tell the THREE outcomes apart:
//   has_pdf       → Fortnox returned a SupplierInvoiceFileConnections[].FileId
//   no_pdf        → Fortnox returned 200 with empty FileConnections (truly no file)
//   lookup_failed → HTTP non-200 / network error / token problem (retryable)
//
// Previously lookupPdfFileId silently collapsed all three into "string | null",
// so any Fortnox 401/429/5xx looked identical to "no PDF" — and got marked
// terminal. Chicce's first 784 invoices all hit this trap.
//
// `has_pdf` also carries the invoice header's net total (excl. VAT) read
// directly from Fortnox. Critical: do NOT compute this by summing the
// placeholder supplier_invoice_lines rows — Chicce's placeholder rows are
// balanced debit-credit pairs that net to ~0 (machine-epsilon noise),
// which causes the validator's |extracted - header| / header ratio to
// blow up to 10^16. Use the Fortnox header value or null (validator
// skips the ratio check on null).
export type PdfLookupResult =
  | { kind: 'has_pdf';      file_id: string; header_total_excl_vat: number | null }
  | { kind: 'no_pdf' }
  | { kind: 'lookup_failed'; reason: string }

export async function runPdfExtractionBatch(
  db: any,
  input: RunInput,
): Promise<BatchSummary> {
  // Mark the inventory_backfill_state row so the admin UI knows we're
  // in the PDF-extraction phase. We share the same state row as the
  // Phase A backfill — one in-flight op per business.
  await db
    .from('inventory_backfill_state')
    .upsert({
      org_id:        input.org_id,
      business_id:   input.business_id,
      status:        'running',
      progress: {
        phase:                  'extracting_pdfs',
        operation:              'pdf_extraction',
        triggered_at:           new Date().toISOString(),
        invoices_in_batch:      0,
        extracted:              0,
        needs_review:           0,
        failed:                 0,
        no_pdf:                 0,
        rows_persisted:         0,
        total_cost_usd:         0,
        remaining_after_batch:  0,
      },
      started_at:    new Date().toISOString(),
      finished_at:   null,
      error_message: null,
    }, { onConflict: 'business_id' })

  // ── Find invoices needing extraction ─────────────────────────────
  // Criteria:
  //   - At least one supplier_invoice_lines row exists with raw_description
  //     empty (placeholder rows from Phase A backfill that didn't get item
  //     descriptions from Fortnox).
  //   - No invoice_pdf_extractions row with terminal status yet
  //     (extracted / needs_review / no_pdf / failed-with-attempts>=3).
  const candidates = await findCandidates(db, input.business_id, BATCH_SIZE)

  // Count how many more remain after this batch — for UI estimation.
  const remainingTotal = await countRemaining(db, input.business_id)
  const remainingAfterBatch = Math.max(0, remainingTotal - candidates.length)

  const summary: BatchSummary = {
    invoices_in_batch:     candidates.length,
    extracted:             0,
    needs_review:          0,
    failed:                0,
    no_pdf:                0,
    rows_persisted:        0,
    total_cost_usd:        0,
    remaining_after_batch: remainingAfterBatch,
  }

  for (let i = 0; i < candidates.length; i++) {
    const inv = candidates[i]
    const lookup = inv.pdf_lookup

    // Three-way branch on the tagged lookup result. Critical: a
    // lookup_failed status must NEVER persist as 'no_pdf' (terminal).
    // That was the corruption pattern on Chicce's 784 invoices.
    if (lookup.kind === 'no_pdf') {
      summary.no_pdf += 1
      await db.from('invoice_pdf_extractions').upsert({
        org_id:                  input.org_id,
        business_id:             input.business_id,
        fortnox_invoice_number:  inv.fortnox_invoice_number,
        invoice_date:            inv.invoice_date,
        supplier_fortnox_number: inv.supplier_fortnox_number,
        supplier_name_snapshot:  inv.supplier_name_snapshot,
        pdf_file_id:             null,
        status:                  'no_pdf',
        attempts:                1,
        started_at:              new Date().toISOString(),
        completed_at:            new Date().toISOString(),
      }, { onConflict: 'business_id,fortnox_invoice_number' })
      continue
    }

    if (lookup.kind === 'lookup_failed') {
      // Retryable — bump attempts but don't write a terminal status.
      // After 3 attempts the worker's candidate filter will skip it
      // so we don't loop forever; until then the next kick re-tries.
      summary.failed += 1
      const { data: existing } = await db
        .from('invoice_pdf_extractions')
        .select('attempts')
        .eq('business_id', input.business_id)
        .eq('fortnox_invoice_number', inv.fortnox_invoice_number)
        .maybeSingle()
      const newAttempts = (existing?.attempts ?? 0) + 1
      const isTerminal = newAttempts >= 3
      await db.from('invoice_pdf_extractions').upsert({
        org_id:                  input.org_id,
        business_id:             input.business_id,
        fortnox_invoice_number:  inv.fortnox_invoice_number,
        invoice_date:            inv.invoice_date,
        supplier_fortnox_number: inv.supplier_fortnox_number,
        supplier_name_snapshot:  inv.supplier_name_snapshot,
        pdf_file_id:             null,
        status:                  isTerminal ? 'failed' : 'pending',
        attempts:                newAttempts,
        error_message:           `pdf_lookup_failed: ${lookup.reason}`,
        started_at:              new Date().toISOString(),
        completed_at:            isTerminal ? new Date().toISOString() : null,
      }, { onConflict: 'business_id,fortnox_invoice_number' })
      continue
    }

    // lookup.kind === 'has_pdf' — proceed with extraction.
    const fileId = lookup.file_id
    // Prefer the header total from Fortnox over the placeholder-row
    // sum we computed in findCandidates. The placeholder-sum is
    // unreliable (Chicce's rows are debit-credit balanced to ~0).
    const headerTotalForValidator =
      lookup.header_total_excl_vat != null && Number.isFinite(lookup.header_total_excl_vat)
        ? lookup.header_total_excl_vat
        : inv.invoice_total_header

    // Pre-write the job row in 'extracting' state.
    await db.from('invoice_pdf_extractions').upsert({
      org_id:                  input.org_id,
      business_id:             input.business_id,
      fortnox_invoice_number:  inv.fortnox_invoice_number,
      invoice_date:            inv.invoice_date,
      supplier_fortnox_number: inv.supplier_fortnox_number,
      supplier_name_snapshot:  inv.supplier_name_snapshot,
      pdf_file_id:             fileId,
      status:                  'extracting',
      attempts:                1,
      started_at:              new Date().toISOString(),
    }, { onConflict: 'business_id,fortnox_invoice_number' })

    let result: ExtractResult
    try {
      result = await extractInvoicePdf(db, {
        org_id:                  input.org_id,
        business_id:             input.business_id,
        fortnox_invoice_number:  inv.fortnox_invoice_number,
        invoice_date:            inv.invoice_date,
        supplier_fortnox_number: inv.supplier_fortnox_number,
        supplier_name_snapshot:  inv.supplier_name_snapshot,
        pdf_file_id:             fileId,
        invoice_total_header:    headerTotalForValidator,
      })
    } catch (e: any) {
      // Unexpected throw — treat as failed, will retry on a future kick.
      result = {
        status: 'failed',
        rows_extracted: 0,
        total_extracted: null,
        total_header: headerTotalForValidator,
        total_delta_pct: null,
        validation_warnings: [{ code: 'unhandled', message: String(e?.message ?? e), severity: 'block' }],
        ai_model: null,
        tokens_input: 0,
        tokens_output: 0,
        cost_usd: 0,
        error_message: String(e?.message ?? e),
        extracted_rows: null,
      }
    }

    if (result.status === 'extracted')         summary.extracted    += 1
    else if (result.status === 'needs_review') summary.needs_review += 1
    else if (result.status === 'failed')       summary.failed       += 1
    summary.rows_persisted += result.rows_extracted
    summary.total_cost_usd += Number(result.cost_usd ?? 0)

    // Update the job row with the outcome. Try with the M082 column
    // (extracted_rows_json) first; if the column doesn't exist yet,
    // retry without it. This keeps the worker forward-compatible with
    // the M082 SQL apply order — code can ship before the SQL.
    const baseUpdate: any = {
      status:               result.status,
      rows_extracted:       result.rows_extracted,
      total_extracted:      result.total_extracted,
      total_header:         result.total_header,
      total_delta_pct:      result.total_delta_pct,
      validation_warnings:  result.validation_warnings,
      ai_model:             result.ai_model,
      tokens_input:         result.tokens_input,
      tokens_output:        result.tokens_output,
      cost_usd:             result.cost_usd,
      error_message:        result.error_message,
      completed_at:         new Date().toISOString(),
    }
    const { error: updateErr } = await db.from('invoice_pdf_extractions').update({
      ...baseUpdate,
      extracted_rows_json:  result.extracted_rows,
    })
    .eq('business_id', input.business_id)
    .eq('fortnox_invoice_number', inv.fortnox_invoice_number)
    if (updateErr && updateErr.message?.includes('extracted_rows_json')) {
      await db.from('invoice_pdf_extractions').update(baseUpdate)
        .eq('business_id', input.business_id)
        .eq('fortnox_invoice_number', inv.fortnox_invoice_number)
    }

    if ((i + 1) % FLUSH_EVERY_N === 0) {
      await flushProgress(db, input.business_id, summary, 'running')
    }
  }

  // Final flush.
  await flushProgress(db, input.business_id, summary, remainingAfterBatch === 0 ? 'completed' : 'running')

  return summary
}

// ─────────────────────────────────────────────────────────────────────

async function findCandidates(db: any, businessId: string, limit: number): Promise<CandidateInvoice[]> {
  // Strategy: pick invoices that have at least one empty-description
  // line in supplier_invoice_lines AND aren't already terminal in
  // invoice_pdf_extractions.
  //
  // CRITICAL: Supabase's PostgREST caps queries at 1000 rows server-side
  // even when .limit(N) requests more. See feedback_supabase_max_rows.
  // Paginate via .range() so we see ALL of Chicce's 3218-row dataset,
  // not just the most recent 1000 lines.

  const byInvoice = new Map<string, CandidateInvoice & { has_empty: boolean }>()
  const PAGE = 1000
  let from = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await db
      .from('supplier_invoice_lines')
      .select('fortnox_invoice_number, invoice_date, supplier_fortnox_number, supplier_name_snapshot, total_excl_vat, raw_description')
      .eq('business_id', businessId)
      .order('invoice_date', { ascending: false })
      .range(from, from + PAGE - 1)
    const rows = (data ?? []) as any[]
    if (rows.length === 0) break
    for (const r of rows) {
      const key = r.fortnox_invoice_number
      if (!key) continue
      let entry = byInvoice.get(key)
      if (!entry) {
        entry = {
          fortnox_invoice_number:  key,
          invoice_date:            r.invoice_date,
          supplier_fortnox_number: r.supplier_fortnox_number ?? null,
          supplier_name_snapshot:  r.supplier_name_snapshot  ?? null,
          pdf_lookup:              { kind: 'lookup_failed', reason: 'not_yet_attempted' },
          invoice_total_header:    0,
          has_empty:               false,
        }
        byInvoice.set(key, entry)
      }
      entry.invoice_total_header = (entry.invoice_total_header ?? 0) + Number(r.total_excl_vat ?? 0)
      if (!r.raw_description || String(r.raw_description).trim() === '') {
        entry.has_empty = true
      }
    }
    if (rows.length < PAGE) break
    from += PAGE
  }

  const needsExtraction = Array.from(byInvoice.values()).filter(e => e.has_empty)
  if (needsExtraction.length === 0) return []

  // Filter out invoices already in a terminal extraction state.
  const numbers = needsExtraction.map(e => e.fortnox_invoice_number)
  const { data: jobs } = await db
    .from('invoice_pdf_extractions')
    .select('fortnox_invoice_number, status, attempts')
    .eq('business_id', businessId)
    .in('fortnox_invoice_number', numbers)
  const jobByNumber = new Map<string, { status: string; attempts: number }>()
  for (const j of (jobs ?? []) as any[]) {
    jobByNumber.set(j.fortnox_invoice_number, { status: j.status, attempts: j.attempts ?? 0 })
  }

  const candidates: CandidateInvoice[] = []
  for (const e of needsExtraction) {
    const j = jobByNumber.get(e.fortnox_invoice_number)
    // Skip terminal states. 'failed' with <3 attempts can retry.
    if (j) {
      if (j.status === 'extracted')    continue
      if (j.status === 'needs_review') continue
      if (j.status === 'no_pdf')       continue
      if (j.status === 'failed' && j.attempts >= 3) continue
    }
    candidates.push({
      fortnox_invoice_number:  e.fortnox_invoice_number,
      invoice_date:            e.invoice_date,
      supplier_fortnox_number: e.supplier_fortnox_number,
      supplier_name_snapshot:  e.supplier_name_snapshot,
      pdf_lookup:              { kind: 'lookup_failed', reason: 'not_yet_attempted' },
      invoice_total_header:    e.invoice_total_header,
    })
    if (candidates.length >= limit) break
  }

  // For each candidate, fetch the PDF file_id. Tagged-union result
  // (has_pdf / no_pdf / lookup_failed) so the worker can distinguish
  // terminal vs retryable in the loop below.
  await Promise.all(candidates.map(async c => {
    c.pdf_lookup = await lookupPdfFileId(db, businessId, c.fortnox_invoice_number)
  }))

  return candidates
}

async function countRemaining(db: any, businessId: string): Promise<number> {
  // Same Supabase 1000-row cap workaround as findCandidates. Paginate
  // with .range() so we see all distinct invoice numbers.
  const empties = new Set<string>()
  const PAGE = 1000
  let from = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data } = await db
      .from('supplier_invoice_lines')
      .select('fortnox_invoice_number, raw_description')
      .eq('business_id', businessId)
      .range(from, from + PAGE - 1)
    const rows = (data ?? []) as any[]
    if (rows.length === 0) break
    for (const r of rows) {
      if (!r.raw_description || String(r.raw_description).trim() === '') {
        empties.add(r.fortnox_invoice_number)
      }
    }
    if (rows.length < PAGE) break
    from += PAGE
  }

  // Subtract terminal jobs.
  const numbers = Array.from(empties)
  if (numbers.length === 0) return 0
  const { data: jobs } = await db
    .from('invoice_pdf_extractions')
    .select('fortnox_invoice_number, status, attempts')
    .eq('business_id', businessId)
    .in('fortnox_invoice_number', numbers)
  let terminal = 0
  for (const j of (jobs ?? []) as any[]) {
    if (j.status === 'extracted' || j.status === 'needs_review' || j.status === 'no_pdf') terminal += 1
    else if (j.status === 'failed' && (j.attempts ?? 0) >= 3) terminal += 1
  }
  return Math.max(0, empties.size - terminal)
}

async function lookupPdfFileId(db: any, businessId: string, invoiceNumber: string): Promise<PdfLookupResult> {
  // Hit Fortnox's /supplierinvoices/{n} detail to pull
  // SupplierInvoiceFileConnections[0].FileId. Returns a tagged union so
  // the worker can distinguish "Fortnox confirmed no attachment"
  // (terminal) from "Fortnox call failed" (retryable). Mixing the two
  // is what corrupted Chicce's 784 invoices on the first Path B kick.
  const { getFreshFortnoxAccessToken } = await import('@/lib/fortnox/api/auth')
  const { fortnoxFetch } = await import('@/lib/fortnox/api/fetch')

  const { data: integ } = await db
    .from('integrations')
    .select('org_id')
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .maybeSingle()
  if (!integ?.org_id) {
    return { kind: 'lookup_failed', reason: 'no_fortnox_integration_row' }
  }

  let token: string | null = null
  try {
    token = await getFreshFortnoxAccessToken(db, integ.org_id, businessId)
  } catch (e: any) {
    // FORTNOX_NEEDS_REAUTH or any other token-refresh failure: lift
    // explicitly so the worker can mark the row for retry (not no_pdf).
    return { kind: 'lookup_failed', reason: `token_refresh: ${e?.message ?? e}` }
  }
  if (!token) {
    return { kind: 'lookup_failed', reason: 'no_token_available' }
  }

  // Two-step lookup. Fortnox's /supplierinvoices/{n} detail response
  // INCONSISTENTLY embeds SupplierInvoiceFileConnections — often empty
  // even when files exist (Chicce's 784 invoices: 100% empty). The
  // dedicated /3/supplierinvoicefileconnections?supplierinvoicenumber=N
  // resource is the reliable path. We try inline first (saves a Fortnox
  // call when populated) and fall through to the dedicated endpoint
  // otherwise. Same pattern as
  // app/api/integrations/fortnox/invoice-pdf/route.ts.
  let res: Response
  try {
    res = await fortnoxFetch(
      `https://api.fortnox.se/3/supplierinvoices/${encodeURIComponent(invoiceNumber)}`,
      token,
    )
  } catch (e: any) {
    return { kind: 'lookup_failed', reason: `fetch_threw: ${e?.message ?? e}` }
  }
  if (!res.ok) {
    return { kind: 'lookup_failed', reason: `http_${res.status}` }
  }

  let json: any
  try {
    json = await res.json()
  } catch (e: any) {
    return { kind: 'lookup_failed', reason: `json_parse: ${e?.message ?? e}` }
  }

  // Header total (excl. VAT) for the validator. Fortnox SupplierInvoice
  // header carries `Total` (inc. VAT) and `VAT` (the VAT amount). Some
  // responses also include `Net` directly. We compute `Total - VAT`
  // when both are present, falling back to whichever is available.
  const header = json?.SupplierInvoice
  const headerTotalExclVat = (() => {
    if (!header) return null
    if (typeof header.Net === 'number' && Number.isFinite(header.Net)) return Number(header.Net)
    const total = typeof header.Total === 'number' ? header.Total : Number(header.Total ?? NaN)
    const vat   = typeof header.VAT   === 'number' ? header.VAT   : Number(header.VAT   ?? NaN)
    if (Number.isFinite(total) && Number.isFinite(vat)) return total - vat
    if (Number.isFinite(total)) return total              // best-effort: incl-VAT total
    return null
  })()

  // Step 1 — inline connections from the detail response.
  let conns: any[] = json?.SupplierInvoice?.SupplierInvoiceFileConnections
                  ?? json?.SupplierInvoiceFileConnections
                  ?? []
  let inlineFileId = Array.isArray(conns) && conns.length > 0
    ? (conns[0]?.FileId ? String(conns[0].FileId) : null)
    : null
  if (inlineFileId) {
    return { kind: 'has_pdf', file_id: inlineFileId, header_total_excl_vat: headerTotalExclVat }
  }

  // Step 2 — fallback to the dedicated file-connections resource.
  let fcRes: Response
  try {
    fcRes = await fortnoxFetch(
      `https://api.fortnox.se/3/supplierinvoicefileconnections/?supplierinvoicenumber=${encodeURIComponent(invoiceNumber)}`,
      token,
    )
  } catch (e: any) {
    return { kind: 'lookup_failed', reason: `fc_fetch_threw: ${e?.message ?? e}` }
  }
  if (!fcRes.ok) {
    // 401 / 403 here usually means the `connectfile` scope wasn't
    // granted. Bubble as lookup_failed so the row is retryable after
    // re-OAuth rather than silently terminal.
    return { kind: 'lookup_failed', reason: `fc_http_${fcRes.status}` }
  }
  let fcJson: any
  try {
    fcJson = await fcRes.json()
  } catch (e: any) {
    return { kind: 'lookup_failed', reason: `fc_json_parse: ${e?.message ?? e}` }
  }
  const fcConns: any[] = fcJson?.SupplierInvoiceFileConnections ?? []
  const fcFileId = Array.isArray(fcConns) && fcConns.length > 0
    ? (fcConns[0]?.FileId ? String(fcConns[0].FileId) : null)
    : null
  if (fcFileId) {
    return { kind: 'has_pdf', file_id: fcFileId, header_total_excl_vat: headerTotalExclVat }
  }

  // Fortnox confirmed via BOTH endpoints — genuinely no attachment.
  return { kind: 'no_pdf' }
}

async function flushProgress(
  db: any,
  businessId: string,
  summary: BatchSummary,
  status: 'running' | 'completed',
): Promise<void> {
  const update: any = {
    status,
    progress: {
      phase:                  'extracting_pdfs',
      operation:              'pdf_extraction',
      invoices_in_batch:      summary.invoices_in_batch,
      extracted:              summary.extracted,
      needs_review:           summary.needs_review,
      failed:                 summary.failed,
      no_pdf:                 summary.no_pdf,
      rows_persisted:         summary.rows_persisted,
      total_cost_usd:         summary.total_cost_usd,
      remaining_after_batch:  summary.remaining_after_batch,
    },
  }
  if (status === 'completed') update.finished_at = new Date().toISOString()
  await db.from('inventory_backfill_state').update(update).eq('business_id', businessId)
}
