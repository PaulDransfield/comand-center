// lib/inventory/pdf-extractor.ts
//
// Path B of the inventory catalogue (INVENTORY-PATH-B-PDF-EXTRACTION.md).
// Given a Fortnox supplier invoice + its attached PDF file_id, extract
// structured product rows via Claude Sonnet 4.6 (vision + tool use) and
// persist them to supplier_invoice_lines atomically via the M078
// apply_invoice_pdf_extraction RPC.
//
// Pure function — caller (the kick worker or onboarding hook) is
// responsible for picking which invoices to extract and for writing the
// job state row to invoice_pdf_extractions.
//
// NEVER bypassed: validators (total-match within 2 %, VAT presence,
// description non-empty) gate the persistence. Failed validation → the
// caller sets status='needs_review' and the rows are NOT applied.

import { AI_MODELS } from '@/lib/ai/models'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fortnoxFetch } from '@/lib/fortnox/api/fetch'

const FORTNOX_API = 'https://api.fortnox.se/3'

// ── Public types ─────────────────────────────────────────────────────

export interface ExtractInput {
  org_id:                    string
  business_id:               string
  fortnox_invoice_number:    string
  invoice_date:              string             // YYYY-MM-DD
  supplier_fortnox_number:   string | null
  supplier_name_snapshot:    string | null
  pdf_file_id:               string
  invoice_total_header:      number | null      // Fortnox header total (excl. VAT) — used for validation
}

export type ExtractStatus =
  | 'extracted'        // ✓ rows persisted via the RPC
  | 'needs_review'     // ✗ validation failed; rows NOT persisted, owner must curate
  | 'failed'           // ✗ unrecoverable error (e.g. PDF too big, model failure)
  | 'no_pdf'           // input had no pdf_file_id (caller filters these out before calling)

export interface ExtractResult {
  status:              ExtractStatus
  rows_extracted:      number
  total_extracted:     number | null
  total_header:        number | null
  total_delta_pct:     number | null            // |extracted - header| / header
  validation_warnings: Array<{ code: string; message: string; severity: 'warn' | 'block' }>
  ai_model:            string | null
  tokens_input:        number
  tokens_output:       number
  cost_usd:            number
  error_message:       string | null
  /** The raw rows Claude extracted, preserved on EVERY outcome (success,
   *  needs_review, failed). Phase B.4 review UI reads this so the owner
   *  can edit + re-apply rows that hit the validator. Null when the
   *  extractor returned before Claude was called (e.g. no_pdf). */
  extracted_rows:      Array<{
    row_number:     number
    description:    string
    article_number: string | null
    quantity:       number | null
    unit:           string | null
    price_per_unit: number | null
    total_excl_vat: number | null
    vat_rate:       number | null
  }> | null
}

// ── Configuration ───────────────────────────────────────────────────

const PDF_BYTES_LIMIT     = 10 * 1024 * 1024     // 10 MB — anything bigger fails
const TOTAL_MATCH_TOL_PCT = 0.02                 // 2% tolerance for total-match validator

// Model pricing (per token). We price extractions in USD so the
// dashboard's cost-report can sum them directly. If pricing changes
// we update these and re-run any reports; historical rows preserve
// the rate they were costed at via ai_model + tokens_input/output.
//
//   Haiku 4.5: input $1/MTok, output $5/MTok      — cheap first pass
//   Sonnet 4.6: input $3/MTok, output $15/MTok    — escalation fallback
//
// Cascade pattern: Haiku tries first; if its extraction passes the
// validators cleanly (no block-severity warnings) we use it. Else we
// escalate to Sonnet. Typical save: ~70-80% of invoices clear on
// Haiku → ~3× cost reduction at the column.
const HAIKU_INPUT_USD_PER_TOKEN   = 1  / 1_000_000
const HAIKU_OUTPUT_USD_PER_TOKEN  = 5  / 1_000_000
const SONNET_INPUT_USD_PER_TOKEN  = 3  / 1_000_000
const SONNET_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000

function pricingFor(model: string): { input: number; output: number } {
  if (model === AI_MODELS.AGENT) {
    return { input: HAIKU_INPUT_USD_PER_TOKEN, output: HAIKU_OUTPUT_USD_PER_TOKEN }
  }
  return { input: SONNET_INPUT_USD_PER_TOKEN, output: SONNET_OUTPUT_USD_PER_TOKEN }
}

// ── Main entrypoint ──────────────────────────────────────────────────

export async function extractInvoicePdf(
  db:    any,
  input: ExtractInput,
): Promise<ExtractResult> {
  const warnings: ExtractResult['validation_warnings'] = []

  // ── 1. Fetch the PDF ──────────────────────────────────────────────
  const token = await getFreshFortnoxAccessToken(db, input.org_id, input.business_id)
  if (!token) {
    return fail('no_fortnox_token', 'Fortnox token unavailable')
  }

  const pdfBuffer = await fetchPdfBytes(token, input.pdf_file_id)
  if (pdfBuffer.kind === 'error') {
    return fail(pdfBuffer.code, pdfBuffer.message)
  }
  if (pdfBuffer.bytes.length > PDF_BYTES_LIMIT) {
    return fail('pdf_too_large', `PDF is ${(pdfBuffer.bytes.length / 1024 / 1024).toFixed(1)} MB (max ${PDF_BYTES_LIMIT / 1024 / 1024}); manual upload required`)
  }
  const pdfBase64 = pdfBuffer.bytes.toString('base64')

  // ── 2. Model cascade: Haiku 4.5 first pass, escalate to Sonnet 4.6 ──
  // Haiku is ~3× cheaper and handles standard restaurant invoices
  // (clean layouts, machine-printed, common suppliers) fine. Only the
  // hard ones (handwritten, blurry, unusual layouts, foreign-language)
  // need Sonnet's depth. The validators below already gate persistence;
  // we just re-use them as the escalation trigger.
  let modelResponse: ClaudeRecordedRows
  let tokensIn  = 0
  let tokensOut = 0
  let modelUsed: string = AI_MODELS.AGENT  // Haiku 4.5 attempted first
  let escalated = false
  let haikuFailureReason: string | null = null

  try {
    const haiku = await callClaude(pdfBase64, input, AI_MODELS.AGENT)
    const haikuPasses = haikuLooksGoodEnough(haiku.payload, input.invoice_total_header)
    if (haikuPasses.ok) {
      modelResponse = haiku.payload
      tokensIn      = haiku.tokensIn
      tokensOut     = haiku.tokensOut
    } else {
      haikuFailureReason = haikuPasses.reason
      throw new Error(`escalate: ${haikuPasses.reason}`)
    }
  } catch (haikuErr: any) {
    // Escalate to Sonnet. Covers both:
    //  - Haiku passed validation thrown-out → quality not good enough
    //  - Haiku threw (Anthropic 429/5xx after retry exhausted, or
    //    malformed JSON, etc.) → fall back to Sonnet
    escalated = true
    if (!haikuFailureReason) haikuFailureReason = String(haikuErr?.message ?? haikuErr)
    try {
      const sonnet = await callClaude(pdfBase64, input, AI_MODELS.ANALYSIS)
      modelResponse = sonnet.payload
      tokensIn      = sonnet.tokensIn
      tokensOut     = sonnet.tokensOut
      modelUsed     = AI_MODELS.ANALYSIS
    } catch (sonnetErr: any) {
      return fail('claude_call_failed', `Sonnet escalation: ${String(sonnetErr?.message ?? sonnetErr)} (Haiku first-pass: ${haikuFailureReason})`)
    }
  }

  if (escalated) {
    warnings.push({
      code: 'escalated_to_sonnet',
      message: `Haiku 4.5 first pass insufficient (${haikuFailureReason}); re-ran with Sonnet 4.6.`,
      severity: 'warn',
    })
  }

  const rates  = pricingFor(modelUsed)
  const aiCost = (tokensIn * rates.input) + (tokensOut * rates.output)

  // ── 3. Validate ───────────────────────────────────────────────────

  if (!modelResponse.rows || modelResponse.rows.length === 0) {
    warnings.push({
      code: 'no_rows',
      message: 'Claude returned zero rows for this PDF. Owner review required.',
      severity: 'block',
    })
    return {
      status: 'needs_review',
      rows_extracted: 0,
      total_extracted: 0,
      total_header: input.invoice_total_header,
      total_delta_pct: null,
      validation_warnings: warnings,
      ai_model: modelUsed,
      tokens_input: tokensIn,
      tokens_output: tokensOut,
      cost_usd: aiCost,
      error_message: null,
      extracted_rows: [],
    }
  }

  // Drop rows with empty descriptions but warn
  const validRows = modelResponse.rows.filter((r, i) => {
    const desc = String(r.description ?? '').trim()
    if (desc.length < 3) {
      warnings.push({
        code: 'row_empty_description',
        message: `Row ${i + 1} has empty/short description; dropped.`,
        severity: 'warn',
      })
      return false
    }
    return true
  })

  if (validRows.length === 0) {
    warnings.push({
      code: 'no_usable_rows',
      message: 'All extracted rows had empty descriptions.',
      severity: 'block',
    })
    return {
      status: 'needs_review',
      rows_extracted: 0,
      total_extracted: 0,
      total_header: input.invoice_total_header,
      total_delta_pct: null,
      validation_warnings: warnings,
      ai_model: modelUsed,
      tokens_input: tokensIn,
      tokens_output: tokensOut,
      cost_usd: aiCost,
      error_message: null,
      extracted_rows: normalizeExtractedRows(modelResponse.rows),
    }
  }

  // Total-match validator
  let totalExtracted = validRows.reduce((s, r) => s + Number(r.total_excl_vat ?? 0), 0)
  const headerTotal  = input.invoice_total_header ?? modelResponse.header?.invoice_total_excl_vat ?? null

  // Server-side credit-note sign-flip rescue. Despite the explicit
  // prompt section, Claude still occasionally returns positive values
  // for credit notes (signature: header is negative, extracted is
  // positive, |extracted| ≈ |header|). Catching it here saves the
  // owner a manual review per credit note. Conditions:
  //   - header is meaningfully negative (< -10 kr to avoid noise)
  //   - extracted is positive (sign error in Claude's output)
  //   - absolute values match within 5 % (so we're not flipping
  //     genuinely-wrong extractions that happen to have signs reversed)
  if (
    headerTotal != null && headerTotal < -10 &&
    totalExtracted > 10 &&
    Math.abs(Math.abs(headerTotal) - Math.abs(totalExtracted)) / Math.abs(headerTotal) < 0.05
  ) {
    for (const r of validRows) {
      if (r.quantity       != null) r.quantity       = -Number(r.quantity)
      if (r.total_excl_vat != null) r.total_excl_vat = -Number(r.total_excl_vat)
      if (r.price_per_unit != null) r.price_per_unit = -Number(r.price_per_unit)
    }
    totalExtracted = -totalExtracted
    warnings.push({
      code: 'credit_note_sign_flipped',
      message: `Credit note detected (header ${headerTotal.toFixed(2)}, extracted +${Math.abs(totalExtracted).toFixed(2)}). Flipped all row signs to negative to match.`,
      severity: 'warn',
    })
  }

  let totalDeltaPct: number | null = null
  // Guard against floating-point near-zero noise. Chicce's placeholder
  // supplier_invoice_lines rows summed to numbers like -2.8e-13 which
  // are mathematically zero but not strictly `=== 0`. Treating those
  // as a real total produced 10^16 % delta percentages and dumped
  // every extraction into needs_review. Anything below 1 öre (0.01 SEK)
  // is treated as "no real header total".
  const HEADER_NOISE_THRESHOLD = 0.01
  const headerIsReal = headerTotal != null && Math.abs(headerTotal) >= HEADER_NOISE_THRESHOLD
  if (headerIsReal) {
    totalDeltaPct = Math.abs(totalExtracted - headerTotal) / Math.abs(headerTotal)
    if (totalDeltaPct > TOTAL_MATCH_TOL_PCT) {
      warnings.push({
        code: 'total_mismatch',
        message: `Extracted total ${totalExtracted.toFixed(2)} vs Fortnox header ${headerTotal.toFixed(2)} — delta ${(totalDeltaPct * 100).toFixed(1)}%, exceeds ${(TOTAL_MATCH_TOL_PCT * 100).toFixed(0)}% tolerance.`,
        severity: 'block',
      })
    }
  } else {
    warnings.push({
      code: 'no_header_total',
      message: 'No Fortnox header total available for cross-check; extracted total stored without validation.',
      severity: 'warn',
    })
  }

  // VAT presence validator (warn only)
  for (let i = 0; i < validRows.length; i++) {
    const v = Number(validRows[i].vat_rate ?? NaN)
    if (!Number.isFinite(v) || ![0, 6, 12, 25].includes(v)) {
      warnings.push({
        code: 'unusual_vat',
        message: `Row ${i + 1} has VAT rate ${validRows[i].vat_rate ?? 'null'} — outside standard Swedish 0/6/12/25.`,
        severity: 'warn',
      })
    }
  }

  // If any block-severity warning, do not persist
  if (warnings.some(w => w.severity === 'block')) {
    return {
      status: 'needs_review',
      rows_extracted: validRows.length,
      total_extracted: totalExtracted,
      total_header: headerTotal,
      total_delta_pct: totalDeltaPct,
      validation_warnings: warnings,
      ai_model: modelUsed,
      tokens_input: tokensIn,
      tokens_output: tokensOut,
      cost_usd: aiCost,
      error_message: null,
      extracted_rows: normalizeExtractedRows(validRows),
    }
  }

  // ── 4. Persist via RPC ────────────────────────────────────────────
  const rowsForRpc = validRows.map((r, idx) => ({
    row_number:     idx + 1,
    description:    String(r.description ?? '').trim(),
    article_number: r.article_number ? String(r.article_number).trim() : null,
    quantity:       r.quantity       != null ? String(Number(r.quantity)) : null,
    unit:           r.unit           ? String(r.unit).trim() : null,
    price_per_unit: r.price_per_unit != null ? String(Number(r.price_per_unit)) : null,
    total_excl_vat: String(Number(r.total_excl_vat ?? 0)),
    vat_rate:       r.vat_rate       != null ? String(Number(r.vat_rate)) : null,
  }))

  const { error: rpcErr } = await db.rpc('apply_invoice_pdf_extraction', {
    p_org_id:                  input.org_id,
    p_business_id:             input.business_id,
    p_supplier_fortnox_number: input.supplier_fortnox_number ?? '',
    p_supplier_name_snapshot:  input.supplier_name_snapshot ?? '',
    p_fortnox_invoice_number:  input.fortnox_invoice_number,
    p_invoice_date:            input.invoice_date,
    p_rows:                    rowsForRpc,
  })
  if (rpcErr) {
    return fail('rpc_failed', `apply_invoice_pdf_extraction: ${rpcErr.message}`)
  }

  // Currency post-pass. The RPC defaults currency to SEK (the column
  // default). When the extractor detected a non-SEK invoice, update
  // every row we just inserted. Whole-invoice scope — Claude returns
  // one currency per invoice, not per row.
  const VALID_CURRENCIES = ['SEK', 'EUR', 'USD', 'NOK', 'DKK', 'GBP']
  const detected = (modelResponse.header?.currency ?? '').toString().trim().toUpperCase()
  if (detected && detected !== 'SEK' && VALID_CURRENCIES.includes(detected)) {
    await db
      .from('supplier_invoice_lines')
      .update({ currency: detected })
      .eq('business_id', input.business_id)
      .eq('fortnox_invoice_number', input.fortnox_invoice_number)
      // Don't try/catch — if this fails the rows are still good in SEK,
      // owner can fix via the line PATCH endpoint. Log and continue.
      .then((res: any) => {
        if (res?.error) console.error('[pdf-extractor] currency post-update failed:', res.error.message)
      }, (err: any) => console.error('[pdf-extractor] currency post-update threw:', err?.message ?? err))
  }

  return {
    status:              'extracted',
    rows_extracted:      validRows.length,
    total_extracted:     totalExtracted,
    total_header:        headerTotal,
    total_delta_pct:     totalDeltaPct,
    validation_warnings: warnings,
    ai_model:            modelUsed,
    tokens_input:        tokensIn,
    tokens_output:       tokensOut,
    cost_usd:            aiCost,
    error_message:       null,
    extracted_rows:      normalizeExtractedRows(validRows),
  }
}

/**
 * Pre-validation quality gate for Haiku's response. Decides whether to
 * accept Haiku's output or escalate to Sonnet. We DO NOT re-run the full
 * downstream validator here — we want a fast check that catches the
 * common Haiku failure modes (zero rows, total way off, garbage
 * descriptions) without duplicating logic.
 *
 * Returns ok=true → trust Haiku's output, run it through the standard
 *                   validators downstream (the validators will still
 *                   gate persistence if anything else is wrong).
 * Returns ok=false → escalate to Sonnet immediately.
 *
 * Tolerance is intentionally slightly tighter than the downstream
 * total-match validator (TOTAL_MATCH_TOL_PCT = 2 %) — we want to
 * escalate BEFORE the downstream validator would block, so the user
 * doesn't get a stream of needs_review rows from cheap-model
 * extractions.
 */
function haikuLooksGoodEnough(
  payload: ClaudeRecordedRows,
  headerTotal: number | null,
): { ok: true } | { ok: false; reason: string } {
  if (!payload.rows || payload.rows.length === 0) {
    return { ok: false, reason: 'haiku returned zero rows' }
  }

  const validRows = payload.rows.filter(r => String(r.description ?? '').trim().length >= 3)
  if (validRows.length === 0) {
    return { ok: false, reason: 'haiku produced no rows with usable descriptions' }
  }

  // If we have a header total to cross-check against, require Haiku to
  // be within 5 % (slightly looser than the 2 % validator — gives Haiku
  // breathing room for normal arithmetic drift on weird invoice layouts).
  if (headerTotal != null && Math.abs(headerTotal) >= 0.01) {
    const extracted = validRows.reduce((s, r) => s + Number(r.total_excl_vat ?? 0), 0)
    const delta = Math.abs(extracted - headerTotal) / Math.abs(headerTotal)
    const HAIKU_ESCALATION_TOL = 0.05
    if (delta > HAIKU_ESCALATION_TOL) {
      return {
        ok: false,
        reason: `haiku total ${extracted.toFixed(2)} vs header ${headerTotal.toFixed(2)} — ${(delta * 100).toFixed(1)}% delta`,
      }
    }
  }

  return { ok: true }
}

// Project the Claude-returned rows into the JSONB shape we persist on
// invoice_pdf_extractions.extracted_rows_json. Same shape as what the
// apply_invoice_pdf_extraction RPC accepts so the review-UI apply
// endpoint can pass it through unchanged.
function normalizeExtractedRows(rows: any[]): NonNullable<ExtractResult['extracted_rows']> {
  return rows.map((r, idx) => ({
    row_number:     idx + 1,
    description:    String(r.description ?? '').trim(),
    article_number: r.article_number ? String(r.article_number).trim() : null,
    quantity:       r.quantity       != null ? Number(r.quantity)       : null,
    unit:           r.unit           ? String(r.unit).trim()            : null,
    price_per_unit: r.price_per_unit != null ? Number(r.price_per_unit) : null,
    total_excl_vat: r.total_excl_vat != null ? Number(r.total_excl_vat) : null,
    vat_rate:       r.vat_rate       != null ? Number(r.vat_rate)       : null,
  }))
}

// ─────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────

function fail(code: string, message: string): ExtractResult {
  return {
    status:              'failed',
    rows_extracted:      0,
    total_extracted:     null,
    total_header:        null,
    total_delta_pct:     null,
    validation_warnings: [{ code, message, severity: 'block' }],
    ai_model:            null,
    tokens_input:        0,
    tokens_output:       0,
    cost_usd:            0,
    error_message:       message,
    extracted_rows:      null,
  }
}

type PdfResult =
  | { kind: 'ok'; bytes: Buffer }
  | { kind: 'error'; code: string; message: string }

async function fetchPdfBytes(token: string, fileId: string): Promise<PdfResult> {
  // Try inbox first (most invoices), then archive (older / archived).
  let res = await fortnoxFetch(`${FORTNOX_API}/inbox/${encodeURIComponent(fileId)}`, token, { accept: '*/*' })
  if (res.status === 404) {
    res = await fortnoxFetch(`${FORTNOX_API}/archive/${encodeURIComponent(fileId)}`, token, { accept: '*/*' })
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return { kind: 'error', code: 'pdf_fetch_failed', message: `Fortnox file fetch: HTTP ${res.status} — ${text.slice(0, 200)}` }
  }
  const arrayBuf = await res.arrayBuffer()
  return { kind: 'ok', bytes: Buffer.from(arrayBuf) }
}

// ── Claude shape ─────────────────────────────────────────────────────

interface ClaudeRowOut {
  row_number?:     number
  description?:    string
  article_number?: string | null
  quantity?:       number | null
  unit?:           string | null
  price_per_unit?: number | null
  total_excl_vat?: number
  vat_rate?:       number | null
}

interface ClaudeRecordedRows {
  rows:    ClaudeRowOut[]
  header?: {
    invoice_total_excl_vat?: number
    invoice_total_inc_vat?:  number
    supplier_org_number?:    string | null
    invoice_date?:           string | null
    currency?:               string | null   // ISO 4217 — null/missing → caller defaults to SEK
  }
}

const SYSTEM_PROMPT = `
You are an expert at extracting structured row data from Swedish restaurant
supplier invoices (leverantörsfakturor). The PDF you are given is one
invoice; your job is to return EVERY product line item via the
record_invoice_rows tool.

What counts as a row:
- Itemised products the supplier is selling (food, drink, packaging, cleaning).
- One row per line printed on the invoice.

What does NOT count as a row:
- Subtotals, "moms summa", "att betala", or any aggregate line.
- VAT-only summary rows.
- Freight/delivery charges unless they're itemised against goods.
- Any payment-terms or remittance information.

Hard rules:
- Use 1-based, sequential row_number with no gaps.
- description = product name, including brand + variant + size if printed.
- article_number = supplier's SKU/article code IF printed on the row, else null.
- quantity, price_per_unit, total_excl_vat = numbers (no kr suffix, no thousands separators).
- vat_rate = 0, 6, 12, or 25 — the Swedish standard rate, taken from what's
  printed on the row (Wolt/Foodora takeaway = 6, dine-in food = 12,
  alcohol/durables = 25).
- If a line is illegible OR the PDF is unreadable, return rows: [] and let
  the calling system flag it for owner review. Never invent rows.

CREDIT NOTES — CRITICAL (this is the most common extraction bug):
- A credit note ("kreditfaktura" / "kreditnota") is the supplier refunding
  money TO us — usually for returns, mis-shipments, oil/grease recycling
  pickups, deposit returns, etc.
- The header total on a credit note is NEGATIVE (e.g. -1 250 kr).
- EVERY line item on a credit note must ALSO have NEGATIVE values for
  both quantity AND total_excl_vat. Even if the PDF prints the numbers
  WITHOUT a minus sign (which is common — only the header carries the
  sign), you must flip them negative because they represent money
  coming BACK to the buyer.
- Indicators that a PDF is a credit note:
    * Title says "KREDITFAKTURA" or "KREDITNOTA" instead of "FAKTURA"
    * A reference like "Krediterar faktura 12345" or "Avser faktura X"
    * Supplier types like oil recycling (Quatra), deposit returns,
      empty-pallet credits, return-of-goods
    * Header amount printed as -X or shown in red / brackets
- If you see ANY of these, the entire invoice is a credit and signs
  flip negative. Get this wrong and the variance calc breaks.

INCLUSIVE vs EXCLUSIVE OF VAT — second most common bug:
- The total_excl_vat field MUST be ex-VAT. If the row prints both an
  inc-VAT and ex-VAT number (Swedish invoices often show both columns
  side by side, with headers like "Pris" / "Bel. ex moms" / "Bel. inc moms"),
  use the EX-VAT figure.
- If the row only prints an inc-VAT price, divide by (1 + vat_rate/100)
  to get ex-VAT (e.g. 11 kr inc 10% VAT → 10 kr ex-VAT).
- The sum of total_excl_vat across all rows MUST match the invoice's
  ex-VAT header total within ~2%, NOT the inc-VAT "att betala" total.

Currency detection (header.currency):
- Default is SEK if the invoice clearly shows kr / SEK / "Svenska kronor".
- Use the ISO 4217 code when you see a different currency:
    €  / EUR / Euro            → EUR
    $  / USD / U.S. dollar     → USD
    kr / NOK / norska kronor   → NOK
    kr / DKK / danska kronor   → DKK (don't confuse with SEK — DKK invoices
                                       usually say "DKK" or "Danmark" explicitly)
    £  / GBP / pund sterling   → GBP
- If you cannot tell, return null and the caller defaults to SEK.
- All numeric amounts MUST be in the invoice's native currency — DO NOT
  pre-convert to SEK. Conversion happens server-side.
`.trim()

const RECORD_TOOL = {
  name: 'record_invoice_rows',
  description: 'Persist the structured row data extracted from the invoice PDF.',
  input_schema: {
    type: 'object',
    properties: {
      rows: {
        type:  'array',
        items: {
          type: 'object',
          properties: {
            row_number:     { type: 'integer' },
            description:    { type: 'string'  },
            article_number: { type: ['string', 'null'] },
            quantity:       { type: ['number', 'null'] },
            unit:           { type: ['string', 'null'] },
            price_per_unit: { type: ['number', 'null'] },
            total_excl_vat: { type: 'number'  },
            vat_rate:       { type: ['number', 'null'] },
          },
          required: ['row_number', 'description', 'total_excl_vat'],
        },
      },
      header: {
        type: 'object',
        properties: {
          invoice_total_excl_vat: { type: ['number', 'null'] },
          invoice_total_inc_vat:  { type: ['number', 'null'] },
          supplier_org_number:    { type: ['string', 'null'] },
          invoice_date:           { type: ['string', 'null'] },
          currency:               { type: ['string', 'null'], description: 'ISO 4217 code (SEK / EUR / USD / NOK / DKK / GBP). Default SEK if unclear.' },
        },
      },
    },
    required: ['rows'],
  },
}

interface ClaudeCallResult {
  payload:    ClaudeRecordedRows
  tokensIn:   number
  tokensOut:  number
}

async function callClaude(pdfBase64: string, input: ExtractInput, model: string): Promise<ClaudeCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')

  const userMessage = [
    {
      type:    'document',
      source: {
        type:       'base64',
        media_type: 'application/pdf',
        data:       pdfBase64,
      },
    },
    {
      type: 'text',
      text:
        `Extract the product rows from this invoice. ` +
        `Fortnox invoice number: ${input.fortnox_invoice_number}. ` +
        (input.supplier_name_snapshot ? `Supplier on Fortnox: ${input.supplier_name_snapshot}. ` : '') +
        `Return via the record_invoice_rows tool.`,
    },
  ]

  // Retry-with-backoff for Anthropic 429 (rate limit) + 5xx (transient).
  // Sonnet 4.6 + vision burns ~5-10k input tokens per invoice; the
  // org-wide 30k-tokens-per-minute ceiling trips when 4+ extractions run
  // in parallel. Honour Retry-After when Anthropic sends it; otherwise
  // exponential 2/4/8/16s. ~30s worst case before giving up — well under
  // the cron's 60s budget. 429 is a transient, retriable signal here:
  // it just means "too much in flight RIGHT NOW", not "bad request".
  const ANTHROPIC_MAX_RETRIES   = 4
  const ANTHROPIC_BACKOFF_MS    = [2000, 4000, 8000, 16000]
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

  let res: Response
  for (let attempt = 0; attempt <= ANTHROPIC_MAX_RETRIES; attempt++) {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model,                                    // Haiku 4.5 (first pass) OR Sonnet 4.6 (escalation)
        max_tokens:  4096,
        system:      SYSTEM_PROMPT,
        tools:       [RECORD_TOOL],
        tool_choice: { type: 'tool', name: 'record_invoice_rows' },
        messages:    [{ role: 'user', content: userMessage }],
      }),
    })

    // Retry on 429 (rate limit) and 5xx (transient server errors).
    // Don't retry on 4xx other than 429 — those are auth/payload bugs
    // that won't change with another attempt.
    const isRetriable = res.status === 429 || (res.status >= 500 && res.status < 600)
    if (!isRetriable || attempt === ANTHROPIC_MAX_RETRIES) break

    let waitMs = ANTHROPIC_BACKOFF_MS[attempt] ?? 16000
    const retryAfterRaw = res.headers.get('retry-after')
    if (retryAfterRaw) {
      const asSeconds = Number(retryAfterRaw)
      if (Number.isFinite(asSeconds)) {
        waitMs = Math.max(waitMs, asSeconds * 1000)
      }
    }
    await sleep(waitMs)
  }

  if (!res!.ok) {
    const errText = await res!.text().catch(() => '')
    throw new Error(`Anthropic HTTP ${res!.status}: ${errText.slice(0, 300)}`)
  }

  const json: any = await res!.json()
  const tokensIn  = json?.usage?.input_tokens  ?? 0
  const tokensOut = json?.usage?.output_tokens ?? 0

  // tool_use should be in the content array
  const toolBlock = Array.isArray(json?.content)
    ? json.content.find((b: any) => b.type === 'tool_use' && b.name === 'record_invoice_rows')
    : null
  if (!toolBlock || !toolBlock.input) {
    throw new Error('Claude did not invoke record_invoice_rows tool')
  }

  return { payload: toolBlock.input as ClaudeRecordedRows, tokensIn, tokensOut }
}
