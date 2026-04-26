// app/api/fortnox/extract-worker/route.ts
//
// Background worker for Fortnox extraction jobs.
//
// Primary invoker: Supabase pg_cron fires fire_extraction_worker()
// every 20 seconds (M021). The worker claims one job per call via the
// atomic claim_next_extraction_job() RPC. pg_cron's 20s cadence means
// up to 3 jobs per minute are drained even without chain-triggers;
// crashed workers auto-release locks after 5 min via the paired
// cc-reset-stale-extraction-jobs cron.
//
// Secondary invokers: the dispatcher /api/fortnox/extract (fast-path
// when a user just uploaded) and /api/fortnox/sweep (user-scoped UI
// trigger). Both exist as belt-and-braces; pg_cron is the load-bearing
// path and keeps the queue draining even if every HTTP invoker fails.
//
// Authed via CRON_SECRET bearer token — not exposed to the browser.
//
// Lifecycle:
//   1. claim_next_extraction_job() — atomic FOR UPDATE SKIP LOCKED,
//      safe against concurrent worker invocations (two workers get
//      two different jobs, never the same one).
//   2. Load the PDF from Supabase storage.
//   3. Call Haiku with the compact schema (monthly rollups + annual
//      line-item list).
//   4. On success: write extraction_json + rollup rows on
//      fortnox_uploads, mark job completed.
//   5. On failure: reschedule with exponential backoff (30s, 2min,
//      10min), or mark job 'dead' if we've exhausted max_attempts.
//
// After finishing, if there are more pending jobs waiting it fires
// another worker invocation so the queue drains without waiting for
// the sweeper cron.

import { NextRequest, NextResponse } from 'next/server'
import { waitUntil } from '@vercel/functions'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS } from '@/lib/ai/models'
import { logAiRequest } from '@/lib/ai/usage'
import { log }          from '@/lib/log/structured'
import { classifyByAccount, classifyLabel, classifyByVat } from '@/lib/fortnox/classify'

export const runtime     = 'nodejs'
export const maxDuration = 300      // Haiku on a 12-month PDF fits in 300 s with the compact schema

// Classifiers (classifyByAccount, classifyLabel, classifyByVat) live in
// lib/fortnox/classify.ts so the deterministic Resultatrapport parser and
// this AI extractor share the exact same rules — no drift between paths.

// Backoff schedule — 30 s, 2 min, 10 min. Keeps failing-fast behaviour
// visible (user sees 'failed' quickly for bad input) without burning
// through retries when Anthropic is having a moment.
const BACKOFF_MS = [30_000, 120_000, 600_000]

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()

  // Atomic claim — RPC uses FOR UPDATE SKIP LOCKED so concurrent worker
  // invocations never grab the same job.
  const { data: claimed, error: claimErr } = await db.rpc('claim_next_extraction_job')
  if (claimErr) {
    console.error('[extract-worker] claim failed:', claimErr.message)
    return NextResponse.json({ error: claimErr.message }, { status: 500 })
  }
  const job = Array.isArray(claimed) ? claimed[0] : claimed
  if (!job) return NextResponse.json({ ok: true, empty: true }, { status: 200 })

  // Helper — progress writer. Each call updates the job's progress JSON
  // so the UI polling /api/fortnox/uploads (which joins this row) sees
  // live phase changes.
  const writeProgress = async (progress: Record<string, any>) => {
    try {
      await db.from('extraction_jobs')
        .update({ progress, updated_at: new Date().toISOString() })
        .eq('id', job.id)
      await db.from('fortnox_uploads')
        .update({ error_message: progress.message ?? null })
        .eq('id', job.upload_id)
    } catch (e: any) {
      console.warn('[extract-worker] writeProgress error:', e?.message)
    }
  }

  // Trigger another worker in parallel if more pending jobs are waiting,
  // so the queue drains without waiting for the sweeper tick.
  const triggerNext = async () => {
    const { data: more } = await db.rpc('list_ready_extraction_jobs', { max_jobs: 1 })
    if (!Array.isArray(more) || !more.length) return
    const base = process.env.NEXT_PUBLIC_APP_URL
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
    if (!base) return
    fetch(`${base}/api/fortnox/extract-worker`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.CRON_SECRET}`,
      },
      body: JSON.stringify({ trigger: 'chain' }),
    }).catch(() => {})
  }

  const jobStarted = Date.now()
  try {
    const result = await runExtraction(db, job, writeProgress)

    // Success — mark job completed + finalize upload row
    await db.from('extraction_jobs').update({
      status:       'completed',
      completed_at: new Date().toISOString(),
      progress:     { phase: 'completed', message: 'Extraction ready for review', percent: 100 },
      updated_at:   new Date().toISOString(),
    }).eq('id', job.id)

    log.info('extract-worker job complete', {
      route:       'fortnox/extract-worker',
      duration_ms: Date.now() - jobStarted,
      job_id:      job.id,
      upload_id:   job.upload_id,
      org_id:      job.org_id,
      attempt:     job.attempts,
      status:      'success',
    })

    waitUntil(triggerNext())
    return NextResponse.json({ ok: true, job_id: job.id, ...result })
  } catch (e: any) {
    const msg = String(e?.message ?? e)
    log.error('extract-worker job failed', {
      route:       'fortnox/extract-worker',
      duration_ms: Date.now() - jobStarted,
      job_id:      job.id,
      upload_id:   job.upload_id,
      org_id:      job.org_id,
      attempt:     job.attempts,
      error:       msg,
      status:      'error',
    })

    const attempt = Number(job.attempts ?? 0)      // already incremented by claim RPC
    const maxAttempts = Number(job.max_attempts ?? 3)
    const hasRetries = attempt < maxAttempts

    if (hasRetries) {
      const backoff = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
      const scheduledFor = new Date(Date.now() + backoff).toISOString()
      await db.from('extraction_jobs').update({
        status:        'pending',
        started_at:    null,
        scheduled_for: scheduledFor,
        error_message: msg.slice(0, 500),
        progress:      { phase: 'retry', message: `Attempt ${attempt} failed — retrying in ${Math.round(backoff / 1000)}s`, percent: 0 },
        updated_at:    new Date().toISOString(),
      }).eq('id', job.id)
      // Keep the upload row in 'extracting' so the UI still shows it as in-flight.
      await db.from('fortnox_uploads').update({
        error_message: `Attempt ${attempt} failed — auto-retry in ${Math.round(backoff / 1000)}s: ${msg.slice(0, 200)}`,
      }).eq('id', job.upload_id)
    } else {
      // Exhausted — mark dead, flip upload to failed so the user sees Retry.
      await db.from('extraction_jobs').update({
        status:        'dead',
        completed_at:  new Date().toISOString(),
        error_message: msg.slice(0, 500),
        progress:      { phase: 'dead', message: `Failed after ${maxAttempts} attempts`, percent: 0 },
        updated_at:    new Date().toISOString(),
      }).eq('id', job.id)
      await db.from('fortnox_uploads').update({
        status:        'failed',
        error_message: `Extraction failed after ${maxAttempts} attempts: ${msg.slice(0, 400)}`,
      }).eq('id', job.upload_id)
    }

    waitUntil(triggerNext())
    return NextResponse.json({ ok: false, job_id: job.id, error: msg }, { status: 200 })
  }
}

// ─────────────────────────────────────────────────────────────────────
// runExtraction — does one PDF. Pure business logic; the caller
// handles status transitions and retry. Throws on failure.
// ─────────────────────────────────────────────────────────────────────
async function runExtraction(db: any, job: any, writeProgress: (p: any) => Promise<void>) {
  await writeProgress({ phase: 'loading', message: 'Loading PDF…', percent: 5 })

  const { data: upload, error: uErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, pdf_storage_path, status')
    .eq('id', job.upload_id)
    .maybeSingle()
  if (uErr || !upload) throw new Error(`Upload not found: ${uErr?.message ?? 'missing row'}`)
  if (upload.status === 'applied') throw new Error('Upload is already applied — not re-runnable')

  const { data: blob, error: dlErr } = await db.storage.from('fortnox-pdfs').download(upload.pdf_storage_path)
  if (dlErr || !blob) throw new Error(`Storage download failed: ${dlErr?.message ?? 'no blob'}`)

  const arrayBuffer = await blob.arrayBuffer()
  const pdfBytes    = new Uint8Array(arrayBuffer)
  const base64      = Buffer.from(arrayBuffer).toString('base64')

  // ── Try the deterministic Resultatrapport parser FIRST ────────────────────
  // For Fortnox Resultatrapport PDFs the table layout is stable enough to
  // extract with positional PDF parsing — no LLM needed. ~100 ms vs Claude's
  // ~30 s, ~0 SEK vs ~3 SEK, and per-month line items are READ from the
  // monthly columns instead of estimated by proportional distribution from
  // the year total. See FIXES.md §0q.
  //
  // Only used when the parser succeeds with confidence='high' AND the math
  // reconciles. Any failure mode (unknown layout, scanned image PDF,
  // parse error, low confidence) falls through to the Claude path below.
  await writeProgress({ phase: 'parsing', message: 'Parsing PDF with deterministic parser…', percent: 15 })
  try {
    const { parseResultatrapport } = await import('@/lib/fortnox/resultatrapport-parser')
    const parsedResult = await parseResultatrapport(pdfBytes)
    // Use parser output for both 'high' AND 'medium' confidence. 'medium'
    // means the parser succeeded but flagged a soft warning (e.g. alcohol_
    // cost > food_cost from a stock-change credit) — the data is still
    // fully reconciled and far more accurate than the AI's per-column
    // guess on a 12-column table. Only fall through to Claude on 'low'.
    if (parsedResult.ok && parsedResult.extraction.confidence !== 'low') {
      const det = parsedResult.extraction
      // Map parser output → existing extracted_json shape so apply +
      // projectRollup don't need to know which path produced this row.
      const mainRollup = det.periods.length === 1
        ? det.periods[0].rollup
        : det.periods.reduce((acc: any, p: any) => {
            for (const k of Object.keys(p.rollup)) acc[k] = (acc[k] ?? 0) + p.rollup[k]
            return acc
          }, {
            revenue: 0, dine_in_revenue: 0, takeaway_revenue: 0, alcohol_revenue: 0,
            food_cost: 0, alcohol_cost: 0, staff_cost: 0, other_cost: 0,
            depreciation: 0, financial: 0, net_profit: 0,
          })
      const detPeriods = det.periods.map(p => ({
        year:   p.year,
        month:  p.month,
        rollup: p.rollup,
        lines:  p.lines.map(l => ({
          label:           l.label,
          label_sv:        l.label,
          amount:          l.amount,
          fortnox_account: l.account,
          category:        l.category,
          subcategory:     l.subcategory,
        })),
      }))
      const extraction = {
        doc_type:       det.doc_type,
        period:         det.periods.length === 1 ? { year: det.periods[0].year, month: det.periods[0].month } : { year: det.periods[0]?.year ?? null, month: null },
        periods:        detPeriods,
        business_hint:  null,
        rollup:         mainRollup,
        lines:          det.periods.length === 1 ? detPeriods[0].lines : [],
        confidence:     det.confidence,
        warnings:       [...det.warnings, '[parser] Extracted by deterministic Resultatrapport parser (no LLM)'],
        scale_detected: det.scale_detected,
        extraction_method: 'deterministic_parser',
      }

      await writeProgress({ phase: 'finalising', message: 'Writing parsed extraction…', percent: 95 })

      const pYear  = det.periods[0]?.year ?? null
      const pMonth = det.periods.length > 1 ? null : (det.periods[0]?.month ?? null)
      const { error: finalUpdateErr } = await db.from('fortnox_uploads').update({
        doc_type:           det.doc_type,
        period_year:        pYear,
        period_month:       pMonth,
        extracted_json:     extraction,
        extraction_model:   'deterministic_parser_v1',
        extraction_cost_kr: 0,
        status:             'extracted',
        extracted_at:       new Date().toISOString(),
        error_message:      null,
      }).eq('id', job.upload_id)
      if (finalUpdateErr) {
        throw new Error(`fortnox_uploads update failed (parser path): ${finalUpdateErr.message}`)
      }

      log.info('extract-worker parsed via deterministic parser', {
        route:        'fortnox/extract-worker',
        upload_id:    job.upload_id,
        org_id:       job.org_id,
        doc_type:     det.doc_type,
        periods:      det.periods.length,
        annual_lines: det.annual_lines.length,
        method:       'deterministic_parser',
      })

      return {
        upload_id:      job.upload_id,
        doc_type:       det.doc_type,
        period:         { year: pYear, month: pMonth },
        line_count:     det.periods.reduce((n, p) => n + p.lines.length, 0),
        input_tokens:   0,
        output_tokens:  0,
        method:         'deterministic_parser',
      }
    }
    // Parser ran but didn't reach 'high' confidence — fall through to Claude.
    if (parsedResult.ok) {
      log.info('extract-worker parser confidence too low, using LLM', {
        route: 'fortnox/extract-worker', upload_id: job.upload_id,
        parser_confidence: parsedResult.extraction.confidence,
        parser_warnings: parsedResult.extraction.warnings.slice(0, 3),
      })
    } else {
      log.info('extract-worker parser declined PDF, using LLM', {
        route: 'fortnox/extract-worker', upload_id: job.upload_id,
        reason: parsedResult.reason,
      })
    }
  } catch (e: any) {
    // Parser threw — fall through to Claude. Don't fail the whole extraction.
    log.warn('extract-worker parser crashed, using LLM', {
      route: 'fortnox/extract-worker', upload_id: job.upload_id, error: e?.message,
    })
  }

  await writeProgress({ phase: 'extracting', message: 'Extracting with Sonnet 4.6 + extended thinking…', percent: 20 })

  // System prompt — split so we can cache this portion on the Anthropic
  // side. The per-PDF document block is the only non-cacheable part.
  // Cache saves ~90% on input tokens for the repeated instructions across
  // every extraction.
  const systemPrompt = `You are extracting a Swedish Fortnox accounting report into structured JSON via the submit_extraction tool.

SCALE / UNIT.  Swedish reports are printed in SEK, KSEK (tkr / thousands) or MSEK (mkr / millions). Detect it from the header (look for "(kr)", "(tkr)", "Belopp i kkr", "Alla belopp i tusentals kronor", "MSEK", "mkr" etc). Then convert EVERYTHING to full SEK before returning:
  • SEK: as-is
  • KSEK / tkr: × 1 000
  • MSEK / mkr: × 1 000 000

A restaurant's monthly revenue is typically 200 000 – 3 000 000 SEK. If a number would be absurd in SEK (e.g. revenue 1 023 for a month), the scale is NOT SEK — reconvert.

MULTI-PERIOD.  If the PDF has one row per BAS account with multiple monthly columns (Jan–Dec), emit ONE "periods" entry per month with ONLY a rollup (no per-month lines — put line-item detail in "annual_lines" drawn from the year-total / "Ack." column). Ignore "Ack."/"Totalt"/"Året"/"Föregående" comparison columns when emitting per-month rows.

SINGLE-PERIOD.  If the PDF is a single-month or single-year report, emit ONE period with a rollup AND put all its line items into annual_lines.

TWO-COLUMN PERIOD+ACKUMULERAT.  Swedish Fortnox monthly P&Ls typically have two data columns: "Period" (current month only) and "Ackumulerat" (year-to-date). For the rollup use the PERIOD column for ALL categories (revenue, food_cost, staff_cost, other_cost, depreciation, financial, net_profit). For annual_lines use the ACKUMULERAT column amounts. Do NOT use 0 for food_cost or staff_cost just because you are unsure — sum ALL 4xxx accounts from the Period column into food_cost, and ALL 7xxx accounts from the Period column into staff_cost. If a category genuinely has no rows, emit 0; but if there are 4xxx rows visible, their Period amounts must appear in food_cost.

LINE ITEMS ARE MANDATORY.  "annual_lines" MUST contain ONE entry per BAS account leaf row visible in the PDF — a Swedish restaurant Resultatrapport typically has 15–40 rows (revenue splits by VAT, food/drink accounts, salary + tax rows, rent, utilities, insurance, bank fees, etc). Do NOT submit an empty "annual_lines": the downstream pipeline depends on them for category/VAT-rate/subcategory classification and for the Performance page's food-vs-alcohol split. If you're unsure whether a row is a subtotal, err on the side of including it — the server de-dupes. Subtotal rows that clearly say "Summa", "S:a", "Totalt", "Bruttovinst", "Rörelseresultat" or "Resultat före/efter…" must NOT be emitted (they would double-count).

For each line, "label" = the row text exactly as printed (Swedish), "amount" = the Ack./year-total (always positive for costs, signed for financial items), "account" = the BAS account number (integer). If a row has no visible account number but a clear label, still emit it with account=0 and rely on label classification downstream.

BAS CATEGORIES.  Sum accounts into rollup categories:
  revenue          = 3xxx (all operating revenue — total)
  dine_in_revenue  = subset of revenue: 3xxx lines flagged "12% moms" (in-restaurant food)
  takeaway_revenue = subset of revenue: 3xxx lines flagged "6% moms" or labelled "Wolt"/"Foodora"/"Uber Eats" (platform delivery)
  alcohol_revenue  = subset of revenue: 3xxx lines flagged "25% moms" (alcohol, non-food drinks)
  food_cost        = 4xxx (cost of goods — total, includes alcohol-cost)
  alcohol_cost     = subset of food_cost: 4xxx lines whose label or account indicates drinks/alcohol
                     (account 4020-4029 typically; or label contains "alkohol"/"vin"/"öl"/"sprit"/"drycker")
  staff_cost       = 7xxx (salaries + payroll tax + pension — 7000-7699 all go here)
  other_cost       = 5xxx + 6xxx (rent, utilities, admin, bank fees, insurance, consulting, marketing, software)
  depreciation     = 78xx (avskrivningar)
  financial        = 8xxx (interest + financial items — signed; interest expense negative)
  net_profit       = revenue − food_cost − staff_cost − other_cost − depreciation + financial

REVENUE SUBSETS.  Three Swedish VAT rates discriminate revenue type on a
restaurant P&L. They are SUBSETS of total revenue — never additive — and
should add up close to (but not necessarily exactly) the revenue total because
some revenue may be untagged or sit in "övriga intäkter":

  25 % moms → alcohol & non-food drinks      → alcohol_revenue
  12 % moms → dine-in food (sit-down service) → dine_in_revenue
   6 % moms → takeaway food (platform-led)    → takeaway_revenue

Wolt, Foodora, and Uber Eats invoices arrive at 6 % VAT — they are takeaway
even if the label says only "Försäljning Wolt" without explicit moms. If you
see Wolt/Foodora/UberEats in the label OR a generic 6 %-moms revenue line,
classify as takeaway.

ALCOHOL/FOOD COST SPLIT.  alcohol_cost is a SUBSET of food_cost, never additive.
The Performance page displays "food only = food_cost − alcohol_cost" alongside
alcohol_cost so the owner sees their margin split. If you can't tell from labels
whether a 4xxx line is alcohol vs food, default the line to food and leave
alcohol_cost at 0 — never guess high. Rule: alcohol_cost ≤ food_cost ALWAYS.

SIGN CONVENTION.  Costs positive, revenue positive, financial items signed (negative for interest expense, positive for interest income). Swedish decimal marker is comma: "1,5" in an MSEK report = 1 500 000 SEK.

VALIDATION.  Before submitting:
  1. SUM(all line items whose BAS account ∈ revenue range) must equal rollup.revenue within 2% — otherwise raise confidence='medium' and add warning
  2. For each monthly rollup, net_profit = revenue − food − staff − other − depreciation + financial. Compute yourself and compare; fix sign errors before submitting.
  3. alcohol_cost ≤ food_cost. If your computed alcohol exceeds food, you've double-counted — re-check.
  4. dine_in_revenue + takeaway_revenue + alcohol_revenue ≤ revenue. Each subset capped at total revenue. If they sum to MORE than revenue, you've double-counted (e.g. a "Total försäljning" row got included alongside its component VAT rows).
  5. Skip "Summa…" / "Total…" / "S:a" subtotal rows when listing line items (they'd double-count).
  6. Monthly revenue under 10 000 SEK or over 100 000 000 SEK almost always means scale misread — re-check the header before submitting.

EXAMPLE (single-month Resultatrapport, Vero restaurant, mars 2026, scale: SEK).

Visible PDF rows:
  3010 Försäljning mat 12% moms          412 800
  3012 Försäljning Wolt/Foodora 6% moms   72 400
  3015 Försäljning alkohol 25% moms      178 400
  Summa intäkter                         663 600
  4015 Inköp livsmedel                  -156 300
  4020 Inköp dryck/alkohol               -84 100
  Summa varuinköp                       -240 400
  7010 Löner                            -198 500
  7510 Sociala avgifter                  -62 400
  Summa personalkostnader               -260 900
  5010 Lokalhyra                         -45 000
  5040 El                                -12 800
  6310 Försäkringar                       -3 200
  6530 Redovisningstjänster               -8 500
  Summa övriga externa kostnader         -69 500
  7820 Avskrivningar inventarier         -15 000
  8410 Räntekostnader                     -2 800
  Resultat före skatt                     74 000

Correct submit_extraction call:
  doc_type: "pnl_monthly"
  scale_detected: "sek"
  confidence: "high"
  periods: [{
    year: 2026, month: 3,
    rollup: {
      revenue: 663600,
      dine_in_revenue: 412800, takeaway_revenue: 72400, alcohol_revenue: 178400,
      food_cost: 240400, alcohol_cost: 84100,
      staff_cost: 260900, other_cost: 69500,
      depreciation: 15000, financial: -2800,
      net_profit: 74800
    }
  }]
  annual_lines: [
    { label: "Försäljning mat 12% moms",         amount: 412800, account: 3010 },
    { label: "Försäljning Wolt/Foodora 6% moms", amount:  72400, account: 3012 },
    { label: "Försäljning alkohol 25% moms",     amount: 178400, account: 3015 },
    { label: "Inköp livsmedel",                  amount: 156300, account: 4015 },
    { label: "Inköp dryck/alkohol",              amount:  84100, account: 4020 },
    { label: "Löner",                            amount: 198500, account: 7010 },
    { label: "Sociala avgifter",                 amount:  62400, account: 7510 },
    { label: "Lokalhyra",                        amount:  45000, account: 5010 },
    { label: "El",                               amount:  12800, account: 5040 },
    { label: "Försäkringar",                     amount:   3200, account: 6310 },
    { label: "Redovisningstjänster",             amount:   8500, account: 6530 },
    { label: "Avskrivningar inventarier",        amount:  15000, account: 7820 },
    { label: "Räntekostnader",                   amount:  -2800, account: 8410 }
  ]

Notes on the example:
  • Three revenue subsets sum to total: 412 800 + 72 400 + 178 400 = 663 600 = revenue ✓
  • takeaway_revenue (72 400) is the 6 %-moms line — Wolt/Foodora platform delivery
  • dine_in_revenue (412 800) is the 12 %-moms line — sit-down food
  • alcohol_revenue (178 400) is the 25 %-moms line
  • alcohol_cost (84 100 = 4020 line) ≤ food_cost (240 400 = 4015 + 4020) ✓
  • net_profit declared 74 000 vs computed 74 800: the 800 diff is within tolerance (rounded subtotal in the source PDF)
  • Räntekostnader is negative because financial items are signed
  • All "Summa…" rows excluded from annual_lines to avoid double-counting`

  // Tool definition — enforces the JSON shape at the protocol level.
  // tool_choice forces Claude to respond with a structured tool call
  // (not free-form text), eliminating JSON parse failures entirely.
  const submitExtractionTool = {
    name: 'submit_extraction',
    description: 'Submit the structured extraction of the Fortnox accounting PDF. Must be called exactly once with the full extraction.',
    input_schema: {
      type: 'object',
      required: ['doc_type', 'scale_detected', 'confidence', 'periods', 'annual_lines'],
      properties: {
        doc_type:       { type: 'string', enum: ['pnl_monthly', 'pnl_annual', 'pnl_multi_month', 'invoice', 'sales', 'vat'] },
        business_hint:  { type: ['string', 'null'] },
        scale_detected: { type: 'string', enum: ['sek', 'ksek', 'msek'] },
        confidence:     { type: 'string', enum: ['high', 'medium', 'low'] },
        warnings:       { type: 'array', items: { type: 'string' } },
        periods: {
          type: 'array',
          items: {
            type: 'object',
            required: ['year', 'month', 'rollup'],
            properties: {
              year:   { type: 'integer' },
              month:  { type: 'integer', minimum: 0, maximum: 12 },
              rollup: {
                type: 'object',
                required: ['revenue', 'food_cost', 'staff_cost', 'other_cost', 'depreciation', 'financial', 'net_profit'],
                properties: {
                  revenue:          { type: 'number' },
                  // Revenue subsets — each is a portion of `revenue` discriminated
                  // by Swedish VAT rate. Optional for backwards-compat with old
                  // extractions — backfilled from line items where absent (M029).
                  dine_in_revenue:  { type: 'number' },   // 12% moms
                  takeaway_revenue: { type: 'number' },   // 6% moms (Wolt, Foodora etc)
                  alcohol_revenue:  { type: 'number' },   // 25% moms
                  food_cost:        { type: 'number' },
                  // alcohol_cost is a SUBSET of food_cost (the 25%-VAT drinks
                  // portion of cost-of-goods). Backfilled from line items if absent.
                  alcohol_cost:     { type: 'number' },
                  staff_cost:       { type: 'number' },
                  other_cost:       { type: 'number' },
                  depreciation:     { type: 'number' },
                  financial:        { type: 'number' },
                  net_profit:       { type: 'number' },
                },
              },
            },
          },
        },
        annual_lines: {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'amount', 'account'],
            properties: {
              label:   { type: 'string' },
              amount:  { type: 'number' },
              account: { type: 'integer' },
            },
          },
        },
      },
    },
  }

  const started = Date.now()
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  // ── Validation helpers (used for first pass + retry feedback) ─────────────
  // Returns the list of algebraic / sanity issues with the current parsed
  // output. Each issue is a short Swedish-style explanation safe to send
  // back to Claude as retry context. Empty list = passed.
  function runValidation(p: any): string[] {
    const issues: string[] = []
    if (!p || !Array.isArray(p.periods)) return issues
    for (const period of p.periods) {
      const r = period?.rollup ?? {}
      const rev   = Number(r.revenue)      || 0
      const food  = Number(r.food_cost)    || 0
      const alc   = Number(r.alcohol_cost) || 0
      const staff = Number(r.staff_cost)   || 0
      const other = Number(r.other_cost)   || 0
      const dep   = Number(r.depreciation) || 0
      const fin   = Number(r.financial)    || 0
      const declaredNet = Number(r.net_profit) || 0
      const computedNet = rev - food - staff - other - dep + fin
      const tolerance   = Math.max(Math.abs(computedNet) * 0.02, 1000)
      const tag = `${period.year}-${String(period.month ?? 0).padStart(2, '0')}`

      if (Math.abs(computedNet - declaredNet) > tolerance) {
        issues.push(`${tag} net_profit math: declared ${declaredNet} vs computed ${Math.round(computedNet)} (diff ${Math.round(computedNet - declaredNet)})`)
      }
      if (alc > food + 1) {
        issues.push(`${tag} alcohol_cost ${Math.round(alc)} exceeds food_cost ${Math.round(food)} — alcohol must be a subset of food, not additive`)
      }
      // Revenue subsets must each be ≤ revenue and the three together
      // shouldn't exceed revenue (would mean a "Total försäljning" subtotal
      // got included alongside its components).
      const dineIn   = Number(r.dine_in_revenue)  || 0
      const takeaway = Number(r.takeaway_revenue) || 0
      const alcRev   = Number(r.alcohol_revenue)  || 0
      const subsetSum = dineIn + takeaway + alcRev
      if (subsetSum > rev * 1.02 + 100) {
        issues.push(`${tag} revenue subsets (dine-in ${Math.round(dineIn)} + takeaway ${Math.round(takeaway)} + alcohol ${Math.round(alcRev)}) sum to ${Math.round(subsetSum)} — exceeds total revenue ${Math.round(rev)}, likely a subtotal row counted twice`)
      }
      if (dineIn > rev + 1)   issues.push(`${tag} dine_in_revenue ${Math.round(dineIn)} exceeds revenue ${Math.round(rev)}`)
      if (takeaway > rev + 1) issues.push(`${tag} takeaway_revenue ${Math.round(takeaway)} exceeds revenue ${Math.round(rev)}`)
      if (alcRev > rev + 1)   issues.push(`${tag} alcohol_revenue ${Math.round(alcRev)} exceeds revenue ${Math.round(rev)}`)
      if (period.month && period.month >= 1 && period.month <= 12) {
        if (rev > 0 && rev < 10_000) {
          issues.push(`${tag} revenue ${Math.round(rev)} SEK is suspiciously low — possible scale misdetection`)
        }
        if (rev > 100_000_000) {
          issues.push(`${tag} revenue ${Math.round(rev)} SEK is suspiciously high — possible scale misdetection (MSEK not applied?)`)
        }
      }
    }
    // Annual_lines vs periods cross-check
    const periodsSum = (p.periods ?? []).reduce((s: number, pp: any) => s + (Number(pp?.rollup?.revenue) || 0), 0)
    const revLineSum = (p.annual_lines ?? [])
      .filter((l: any) => { const a = Number(l?.account) || 0; return a >= 3000 && a < 4000 })
      .reduce((s: number, l: any) => s + (Number(l?.amount) || 0), 0)
    if (periodsSum > 0 && revLineSum > 0) {
      const relDiff = Math.abs(periodsSum - revLineSum) / periodsSum
      if (relDiff > 0.05) {
        issues.push(`Revenue cross-check: periods sum ${Math.round(periodsSum)} vs 3xxx line-items ${Math.round(revLineSum)} (diff ${(relDiff * 100).toFixed(1)}%) — one side may be under-extracted`)
      }
    }
    return issues
  }

  function parseToolResponse(response: any): any {
    const toolBlock = (response.content ?? []).find((b: any) => b?.type === 'tool_use')
    if (toolBlock) return (toolBlock as any).input
    const raw = (response.content ?? []).map((b: any) => b?.type === 'text' ? b.text : '').join('').trim()
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const firstBrace = cleaned.indexOf('{')
    const lastBrace  = cleaned.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    try { return JSON.parse(cleaned) }
    catch {
      const stopReason = (response as any).stop_reason ?? 'unknown'
      throw new Error(`Sonnet returned neither tool_use nor parseable JSON (stop_reason: ${stopReason}). Preview: ${raw.slice(0, 400)}`)
    }
  }

  const baseMessages: any[] = [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
      { type: 'text', text: 'Extract this Fortnox PDF. Call the submit_extraction tool with the full structured extraction — do not reply in free text.' },
    ],
  }]

  // Sonnet 4.6 with extended thinking — based on Claude.ai's own reasoning on
  // this exact problem. tool_choice='auto' (Anthropic forbids thinking +
  // forced tool_choice); with a single relevant tool Sonnet picks it ~100%
  // of the time. Prompt caching on the system prompt cuts 90% off repeated
  // input cost.
  const response = await client.messages.create({
    model:      AI_MODELS.ANALYSIS,
    max_tokens: 16000,
    thinking:   { type: 'enabled', budget_tokens: 5000 },
    system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools:      [submitExtractionTool],
    tool_choice:{ type: 'auto' },
    messages:   baseMessages,
  } as any)

  await writeProgress({ phase: 'parsing', message: 'Validating extraction…', percent: 70 })

  let parsed: any = parseToolResponse(response)
  let totalInputTokens  = (response as any).usage?.input_tokens  ?? 0
  let totalOutputTokens = (response as any).usage?.output_tokens ?? 0
  let retried = false

  // ── Validation-failure retry loop ─────────────────────────────────────────
  // First pass found algebraic problems? Send them back to Claude with the
  // prior submission as context. ONE retry max — beyond that the issues are
  // probably structural (PDF layout we can't parse) and humans should review.
  // Pattern reference: arxiv 2511.10659 (LLM fiscal extraction with
  // hierarchical-sum validation) + Cognica's hierarchical recalculation
  // approach. See FIXES.md §0n.
  let validationWarnings = runValidation(parsed)
  if (validationWarnings.length) {
    await writeProgress({ phase: 'retrying', message: 'Validation failed — asking Claude to retry…', percent: 75 })
    const toolUseBlock = (response.content ?? []).find((b: any) => b?.type === 'tool_use')
    const retryMessages: any[] = [
      ...baseMessages,
      { role: 'assistant', content: response.content ?? [] },
      {
        role: 'user',
        content: [
          ...(toolUseBlock ? [{
            type: 'tool_result',
            tool_use_id: (toolUseBlock as any).id,
            content: 'Server-side validation flagged the following issues. Re-extract with these specific corrections in mind, then call submit_extraction again with the corrected values. Do not reply in free text.\n\n' + validationWarnings.map(w => `• ${w}`).join('\n'),
          }] : [{
            type: 'text',
            text: 'Server-side validation flagged the following issues. Re-extract with these specific corrections in mind, then call submit_extraction again with the corrected values. Do not reply in free text.\n\n' + validationWarnings.map(w => `• ${w}`).join('\n'),
          }]),
        ],
      },
    ]
    try {
      const retryResp = await client.messages.create({
        model:      AI_MODELS.ANALYSIS,
        max_tokens: 16000,
        thinking:   { type: 'enabled', budget_tokens: 5000 },
        system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        tools:      [submitExtractionTool],
        tool_choice:{ type: 'auto' },
        messages:   retryMessages,
      } as any)
      const retryParsed = parseToolResponse(retryResp)
      const retryIssues = runValidation(retryParsed)
      // Take the retry result if it improved things (fewer issues), otherwise
      // keep the first pass and surface the warnings.
      if (retryIssues.length < validationWarnings.length) {
        parsed = retryParsed
        validationWarnings = retryIssues
        retried = true
        totalInputTokens  += (retryResp as any).usage?.input_tokens  ?? 0
        totalOutputTokens += (retryResp as any).usage?.output_tokens ?? 0
        log.info('extract-worker validation retry improved result', {
          route: 'fortnox/extract-worker', upload_id: job.upload_id,
          before_issues: runValidation(parseToolResponse(response)).length,
          after_issues:  retryIssues.length,
        })
      }
    } catch (e: any) {
      // Retry itself failed — keep the first-pass result with warnings.
      console.warn('[extract-worker] validation retry failed:', e?.message)
    }
  }

  if (validationWarnings.length) {
    parsed.warnings = [...(parsed.warnings ?? []), ...validationWarnings]
    // Drop confidence one notch if math still didn't reconcile after retry.
    if (parsed.confidence === 'high') parsed.confidence = 'medium'
  }

  // tool_use forces a structured response so parsed is always non-null
  // unless the API itself failed (caught above). No fallback path needed.

  // annual_lines handling. PK Resultatrapport: one list of account rows
  // for the whole year. We need per-month line items so the Performance
  // page can show alcohol/food split on any single-month view.
  //
  // Strategy:
  //   - Single-period upload: attach all annual_lines to that period.
  //   - Multi-period (12-month) upload: distribute each line proportionally
  //     across the 12 periods based on each period's rollup share for
  //     that line's classified category. Imperfect (a line posted entirely
  //     in Dec would still show distributed) but honest given the source
  //     data shape, and lets every monthly view show the subcategory mix.
  const annualLines = Array.isArray(parsed?.annual_lines) ? parsed.annual_lines : []
  if (annualLines.length && Array.isArray(parsed?.periods) && parsed.periods.length) {
    if (parsed.periods.length === 1) {
      const target = parsed.periods[0]
      target.lines = Array.isArray(target.lines) && target.lines.length ? target.lines : annualLines
    } else {
      // Compute per-category category totals across all months.
      const catTotals: Record<string, number> = {
        revenue: 0, food_cost: 0, staff_cost: 0, other_cost: 0, depreciation: 0, financial: 0,
        alcohol_cost: 0, dine_in_revenue: 0, takeaway_revenue: 0, alcohol_revenue: 0,
      }
      for (const p of parsed.periods) {
        for (const cat of Object.keys(catTotals)) {
          catTotals[cat] += Math.abs(Number(p?.rollup?.[cat] ?? 0))
        }
      }
      // Classify each annual line once, then distribute proportionally.
      const classifiedLines = annualLines.map((l: any) => {
        const acct = Number.isFinite(Number(l?.account)) ? Number(l.account) : null
        const classification = classifyByAccount(acct) ?? classifyLabel(String(l?.label ?? ''))
        return { line: l, category: classification.category }
      })
      for (const p of parsed.periods) {
        p.lines = []
        for (const { line, category } of classifiedLines) {
          const catTotal   = catTotals[category] || 0
          const monthValue = Math.abs(Number(p?.rollup?.[category] ?? 0))
          if (catTotal <= 0) continue
          const share = monthValue / catTotal
          if (share === 0) continue
          p.lines.push({
            ...line,
            amount: Number(line.amount ?? 0) * share,
          })
        }
      }
    }
  }

  await writeProgress({ phase: 'normalising', message: 'Normalising line items…', percent: 85 })

  function enrichLines(raw: any[]): any[] {
    return (Array.isArray(raw) ? raw : []).map((l: any) => {
      const label   = String(l?.label ?? '').trim()
      const fromAI  = String(l?.category ?? '').trim()
      const amount  = Number(l?.amount ?? 0)
      const acctRaw = l?.fortnox_account ?? l?.account
      const fortnoxAccount = Number.isFinite(Number(acctRaw)) ? Number(acctRaw) : null

      // Category priority: account number (authoritative) → label-based
      // SPECIFIC match → AI hint → label-based fallback. Account number is
      // the only source that can't be wrong — a Fortnox 4010 is food cost
      // no matter what the AI called it (FIXES §0k). Label-based with a
      // specific match (subcategory set OR category != 'other_cost') beats
      // the AI hint because classifyLabel only returns specific matches
      // for known Swedish keywords like 'reklam' → marketing/other_cost.
      // Pre-2026-04-26 the AI override let "Reklam" land as
      // category='revenue' subcategory='marketing' (FIXES §0o postscript).
      const accountBased   = classifyByAccount(fortnoxAccount)
      const labelBased     = classifyLabel(label)
      const labelIsSpecific = labelBased.subcategory !== null || labelBased.category !== 'other_cost'
      const validAI         = ['revenue','food_cost','staff_cost','other_cost','depreciation','financial'].includes(fromAI)
      const category = accountBased?.category
        ?? (labelIsSpecific ? labelBased.category : (validAI ? fromAI : labelBased.category))

      // Subcategory priority for revenue + food_cost:
      //   VAT rate in label (e.g. "25% moms" = alcohol, "12% moms" = food)
      //   → specific label match (försäljning alkohol, dryckesinköp)
      //   → account-based generic (null for revenue, 'goods' for food_cost).
      // Only overrides when the VAT match actually discriminates — 25% on
      // a cost line isn't meaningful, so we restrict VAT-based override to
      // revenue + food_cost categories.
      const vatBased = (category === 'revenue' || category === 'food_cost')
        ? classifyByVat(label) : null
      const subcategory = vatBased?.subcategory
        ?? labelBased.subcategory
        ?? accountBased?.subcategory
        ?? null

      return { label_sv: label, category, subcategory, amount, fortnox_account: fortnoxAccount }
    }).filter((l: any) => l.label_sv && Number.isFinite(l.amount))
  }

  function emptyRollup() {
    return {
      revenue: 0, dine_in_revenue: 0, takeaway_revenue: 0, alcohol_revenue: 0,
      food_cost: 0, alcohol_cost: 0,
      staff_cost: 0, other_cost: 0,
      depreciation: 0, financial: 0,
      net_profit: 0,
    }
  }

  let periodsRaw: any[] = []
  if (Array.isArray(parsed?.periods) && parsed.periods.length) {
    periodsRaw = parsed.periods
  } else {
    periodsRaw = [{ year: parsed?.period?.year, month: parsed?.period?.month, rollup: parsed?.rollup ?? {}, lines: parsed?.lines ?? [] }]
  }

  const periods = periodsRaw
    .map((p: any) => {
      const year  = Number(p?.year) || null
      const month = p?.month == null ? null : (Number.isFinite(Number(p.month)) ? Number(p.month) : null)
      const lines = enrichLines(p?.lines)
      const rollupRaw = p?.rollup ?? {}
      // Server-side rollup repair: if the AI returned 0 for a category but
      // the enriched line items contain accounts in that category's range,
      // recompute from the lines. This catches the common failure mode on
      // multi-column PDFs (Period + Ackumulerat) where the AI correctly reads
      // revenue from the Period column but returns 0 for food_cost/staff_cost
      // while silently absorbing those costs into other_cost or net_profit.
      // Account classification here is authoritative (4xxx = food_cost, etc.)
      // so the repair can't introduce double-counting.
      function sumLinesForCategory(enriched: any[], cat: string): number {
        return enriched.filter((l: any) => l.category === cat).reduce((s: number, l: any) => s + Math.abs(Number(l.amount) || 0), 0)
      }
      // Sum a SUBSET of revenue lines by VAT-derived subcategory. Used to
      // back-fill dine_in/takeaway/alcohol revenue when the AI didn't
      // populate those rollup fields (older extractions, or it just missed).
      function sumRevenueSubset(enriched: any[], subMatch: (sub: string) => boolean): number {
        return enriched
          .filter((l: any) => l.category === 'revenue' && subMatch(String(l.subcategory ?? '').toLowerCase()))
          .reduce((s: number, l: any) => s + Math.abs(Number(l.amount) || 0), 0)
      }
      const aiRollup = {
        revenue:          Number(rollupRaw.revenue          ?? 0) || 0,
        // Revenue subsets (M029) — pass-through; back-filled below if AI
        // returned 0 but line items have the VAT-tagged subcategory.
        dine_in_revenue:  Number(rollupRaw.dine_in_revenue  ?? 0) || 0,
        takeaway_revenue: Number(rollupRaw.takeaway_revenue ?? 0) || 0,
        alcohol_revenue:  Number(rollupRaw.alcohol_revenue  ?? 0) || 0,
        food_cost:        Number(rollupRaw.food_cost        ?? 0) || 0,
        // alcohol_cost (M028) — subset of food_cost. Pass-through; the
        // M028 backfill + line-item fallback in projectRollup catches gaps.
        alcohol_cost:     Number(rollupRaw.alcohol_cost     ?? 0) || 0,
        staff_cost:       Number(rollupRaw.staff_cost       ?? 0) || 0,
        other_cost:       Number(rollupRaw.other_cost       ?? 0) || 0,
        depreciation:     Number(rollupRaw.depreciation     ?? 0) || 0,
        financial:        Number(rollupRaw.financial        ?? 0) || 0,
        net_profit:       Number(rollupRaw.net_profit       ?? 0) || 0,
      }
      // Only repair categories the AI left at 0 when line items disagree.
      // Revenue is intentionally excluded — the AI Period column read is
      // more accurate than summing Ackumulerat-column line items.
      const repaired = { ...aiRollup }
      for (const cat of ['food_cost', 'staff_cost', 'other_cost', 'depreciation'] as const) {
        if (aiRollup[cat] === 0 && lines.length > 0) {
          const lineSum = sumLinesForCategory(lines, cat)
          if (lineSum > 0) {
            repaired[cat] = lineSum
          }
        }
      }
      // Revenue-subset back-fill: only when the AI returned 0 for a subset
      // AND the line items have at least one row tagged for it. Each subset
      // clamped to total revenue so we never report subset > total.
      if (aiRollup.dine_in_revenue === 0) {
        const v = sumRevenueSubset(lines, sub => sub === 'food' || sub === 'dine_in')
        if (v > 0) repaired.dine_in_revenue = Math.min(v, repaired.revenue)
      }
      if (aiRollup.takeaway_revenue === 0) {
        const v = sumRevenueSubset(lines, sub => sub === 'takeaway')
        if (v > 0) repaired.takeaway_revenue = Math.min(v, repaired.revenue)
      }
      if (aiRollup.alcohol_revenue === 0) {
        const v = sumRevenueSubset(lines, sub => sub === 'alcohol' || sub === 'beverage' || sub === 'drinks')
        if (v > 0) repaired.alcohol_revenue = Math.min(v, repaired.revenue)
      }
      // Recompute net_profit if any cost category was repaired. Revenue
      // subset back-fills don't change net_profit (they're subsets of
      // revenue, not separate components).
      const anyRepaired = (['food_cost','staff_cost','other_cost','depreciation'] as const).some(c => repaired[c] !== aiRollup[c])
      if (anyRepaired) {
        repaired.net_profit = repaired.revenue - repaired.food_cost - repaired.staff_cost - repaired.other_cost - repaired.depreciation + repaired.financial
      }

      return { year, month, lines, rollup: repaired }
    })
    .filter((p: any) => p.year != null)
    .sort((a: any, b: any) => (a.year - b.year) || ((a.month ?? 0) - (b.month ?? 0)))

  let docType: string = parsed?.doc_type ?? 'pnl_monthly'
  if (periods.length > 1) docType = 'pnl_multi_month'
  else if (periods.length === 1 && (periods[0].month == null || periods[0].month === 0)) docType = 'pnl_annual'
  if (!['pnl_monthly','pnl_annual','pnl_multi_month','invoice','sales','vat'].includes(docType)) {
    docType = 'pnl_monthly'
  }

  const mainRollup = periods.length === 1
    ? periods[0].rollup
    : periods.reduce((acc: any, p: any) => ({
        revenue:          acc.revenue          + p.rollup.revenue,
        dine_in_revenue:  acc.dine_in_revenue  + p.rollup.dine_in_revenue,
        takeaway_revenue: acc.takeaway_revenue + p.rollup.takeaway_revenue,
        alcohol_revenue:  acc.alcohol_revenue  + p.rollup.alcohol_revenue,
        food_cost:        acc.food_cost        + p.rollup.food_cost,
        alcohol_cost:     acc.alcohol_cost     + p.rollup.alcohol_cost,
        staff_cost:       acc.staff_cost       + p.rollup.staff_cost,
        other_cost:       acc.other_cost       + p.rollup.other_cost,
        depreciation:     acc.depreciation     + p.rollup.depreciation,
        financial:        acc.financial        + p.rollup.financial,
        net_profit:       acc.net_profit       + p.rollup.net_profit,
      }), emptyRollup())
  const mainLines = periods.length === 1 ? periods[0].lines : []

  const pYear  = periods[0]?.year  ?? null
  const pMonth = periods.length > 1 ? null : (periods[0]?.month ?? null)

  const warnings = Array.isArray(parsed?.warnings) ? [...parsed.warnings] : []
  if (parsed?.confidence === 'low') warnings.unshift('Low-confidence extraction — double-check every row before applying.')

  const extraction = {
    doc_type:      docType,
    period:        { year: pYear, month: pMonth },
    periods,
    business_hint: parsed?.business_hint ?? null,
    rollup:        mainRollup,
    lines:         mainLines,
    confidence:    parsed?.confidence ?? 'medium',
    warnings,
    scale_detected: parsed?.scale_detected ?? 'sek',
  }

  const inputTokens  = totalInputTokens
  const outputTokens = totalOutputTokens
  const costKr = (inputTokens * 1e-6 + outputTokens * 5e-6) * 11

  try {
    await logAiRequest(db, {
      org_id:        job.org_id,
      request_type:  retried ? 'fortnox_extract_retried' : 'fortnox_extract',
      model:         AI_MODELS.AGENT,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      duration_ms:   Date.now() - started,
    })
  } catch { /* non-fatal */ }

  await writeProgress({ phase: 'finalising', message: 'Writing to database…', percent: 95 })

  // CRITICAL: surface .error explicitly. Previously we awaited this
  // without checking the return value, so if Postgres rejected the
  // update (e.g. doc_type enum violation, JSONB size, RLS unexpectedly
  // applying), the call silently no-op'd and the outer POST handler
  // then marked the job 'completed' against an un-extracted upload row.
  // The extraction job says it finished; the upload row says
  // "extracting" forever. We lose the extraction entirely.
  //
  // Now: capture .error, log with full context, throw so the outer
  // handler routes through the retry-with-backoff path instead of
  // marking the job completed.
  const { error: finalUpdateErr } = await db.from('fortnox_uploads').update({
    doc_type:           docType,
    period_year:        pYear,
    period_month:       pMonth,
    extracted_json:     extraction,
    extraction_model:   AI_MODELS.ANALYSIS,  // Sonnet 4.6 since 588c4bb
    extraction_cost_kr: Math.round(costKr * 100) / 100,
    status:             'extracted',
    extracted_at:       new Date().toISOString(),
    error_message:      extraction.confidence === 'low' ? 'Low confidence — review carefully' : null,
  }).eq('id', job.upload_id)

  if (finalUpdateErr) {
    // Include the exact error message + any row-size hints so next
    // time we know what's failing. Throwing triggers the retry path.
    const extractionSize = JSON.stringify(extraction).length
    throw new Error(`fortnox_uploads final update failed: ${finalUpdateErr.message} (code: ${finalUpdateErr.code ?? 'n/a'}, extracted_json size: ${extractionSize} chars, periods: ${periods.length}, lines: ${mainLines.length})`)
  }

  return {
    upload_id:      job.upload_id,
    doc_type:       docType,
    period:         { year: pYear, month: pMonth },
    line_count:     periods.reduce((n: number, p: any) => n + (p.lines?.length ?? 0), 0),
    input_tokens:   inputTokens,
    output_tokens:  outputTokens,
  }
}
