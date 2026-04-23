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

export const runtime     = 'nodejs'
export const maxDuration = 300      // Haiku on a 12-month PDF fits in 300 s with the compact schema

// ── Swedish label → internal subcategory lookup ──────────────────────
const SV_SUB = new Map<string, { category: string; subcategory: string }>([
  ['försäljning',             { category: 'revenue', subcategory: 'food' }],
  ['försäljning livsmedel',   { category: 'revenue', subcategory: 'food' }],
  ['försäljning dryck',       { category: 'revenue', subcategory: 'beverage' }],
  ['försäljning alkohol',     { category: 'revenue', subcategory: 'alcohol' }],
  ['övriga intäkter',         { category: 'revenue', subcategory: 'other' }],
  // Cost of goods / food. These labels vary a lot on real Fortnox P&Ls —
  // expanded 2026-04-23 after FIXES §0k found "Varuinköp" falling through
  // and being double-counted into overheads.
  ['råvaror',                    { category: 'food_cost', subcategory: 'raw_materials' }],
  ['råvaror och förnödenheter',  { category: 'food_cost', subcategory: 'raw_materials' }],
  ['handelsvaror',               { category: 'food_cost', subcategory: 'goods_for_resale' }],
  ['varuinköp',                  { category: 'food_cost', subcategory: 'goods' }],
  ['inköp varor',                { category: 'food_cost', subcategory: 'goods' }],
  ['inköp material och varor',   { category: 'food_cost', subcategory: 'goods' }],
  ['inköp av material och varor',{ category: 'food_cost', subcategory: 'goods' }],
  ['inköp livsmedel',            { category: 'food_cost', subcategory: 'food' }],
  ['inköp av livsmedel',         { category: 'food_cost', subcategory: 'food' }],
  ['livsmedel',                  { category: 'food_cost', subcategory: 'food' }],
  ['livsmedelsinköp',            { category: 'food_cost', subcategory: 'food' }],
  ['drycker',                    { category: 'food_cost', subcategory: 'beverages' }],
  ['dryckesinköp',               { category: 'food_cost', subcategory: 'beverages' }],
  ['kostnad sålda varor',        { category: 'food_cost', subcategory: 'cogs' }],
  ['kostnader för sålda varor',  { category: 'food_cost', subcategory: 'cogs' }],
  ['kostnad för sålda varor',    { category: 'food_cost', subcategory: 'cogs' }],
  ['personalkostnader',       { category: 'staff_cost', subcategory: 'salaries' }],
  ['löner',                   { category: 'staff_cost', subcategory: 'salaries' }],
  ['sociala avgifter',        { category: 'staff_cost', subcategory: 'payroll_tax' }],
  ['arbetsgivaravgifter',     { category: 'staff_cost', subcategory: 'payroll_tax' }],
  ['pensionskostnader',       { category: 'staff_cost', subcategory: 'pension' }],
  ['lokalhyra',               { category: 'other_cost', subcategory: 'rent' }],
  ['lokalkostnader',          { category: 'other_cost', subcategory: 'rent' }],
  ['el',                      { category: 'other_cost', subcategory: 'utilities' }],
  ['värme',                   { category: 'other_cost', subcategory: 'utilities' }],
  ['energikostnader',         { category: 'other_cost', subcategory: 'utilities' }],
  ['vatten',                  { category: 'other_cost', subcategory: 'utilities' }],
  ['städning',                { category: 'other_cost', subcategory: 'cleaning' }],
  ['reparationer',            { category: 'other_cost', subcategory: 'repairs' }],
  ['förbrukningsinventarier', { category: 'other_cost', subcategory: 'consumables' }],
  ['kontorsmaterial',         { category: 'other_cost', subcategory: 'office_supplies' }],
  ['telefon',                 { category: 'other_cost', subcategory: 'telecom' }],
  ['internet',                { category: 'other_cost', subcategory: 'telecom' }],
  ['porto',                   { category: 'other_cost', subcategory: 'postage' }],
  ['datorkostnader',          { category: 'other_cost', subcategory: 'software' }],
  ['programvaror',            { category: 'other_cost', subcategory: 'software' }],
  ['it-kostnader',            { category: 'other_cost', subcategory: 'software' }],
  ['reklam',                  { category: 'other_cost', subcategory: 'marketing' }],
  ['marknadsföring',          { category: 'other_cost', subcategory: 'marketing' }],
  ['representation',          { category: 'other_cost', subcategory: 'entertainment' }],
  ['bankavgifter',            { category: 'other_cost', subcategory: 'bank_fees' }],
  ['konsultarvoden',          { category: 'other_cost', subcategory: 'consulting' }],
  ['redovisning',             { category: 'other_cost', subcategory: 'accounting' }],
  ['revisorsarvoden',         { category: 'other_cost', subcategory: 'audit' }],
  ['försäkringar',            { category: 'other_cost', subcategory: 'insurance' }],
  ['frakter',                 { category: 'other_cost', subcategory: 'shipping' }],
  ['bilkostnader',            { category: 'other_cost', subcategory: 'vehicles' }],
  ['övriga externa kostnader',{ category: 'other_cost', subcategory: 'other' }],
  ['avskrivningar',           { category: 'depreciation', subcategory: 'depreciation' }],
  ['räntekostnader',          { category: 'financial', subcategory: 'interest' }],
  ['ränteintäkter',           { category: 'financial', subcategory: 'interest_income' }],
  ['finansiella poster',      { category: 'financial', subcategory: 'other' }],
])

function classifyLabel(label: string): { category: string; subcategory: string | null } {
  const key = label.trim().toLowerCase()
  if (SV_SUB.has(key)) return SV_SUB.get(key)!
  for (const [k, v] of SV_SUB.entries()) if (key.includes(k)) return v
  return { category: 'other_cost', subcategory: null }
}

// Swedish VAT rates are a reliable signal when a Fortnox label says e.g.
// "Försäljning varor 25% moms" / "Försäljning varor 12% moms":
//   25%  — alcohol, non-food drinks (standard rate)
//   12%  — food served dine-in or takeaway (restaurant-reduced rate)
//    6%  — reduced rate (books, transport — not restaurant)
// Applied AFTER classifyByAccount / classifyLabel so it can refine a
// generic revenue label into the specific food vs alcohol subcategory.
function classifyByVat(label: string): { subcategory: string | null } | null {
  const key = label.trim().toLowerCase()
  if (/\b25\s*%?\s*moms\b/.test(key))  return { subcategory: 'alcohol' }
  if (/\b12\s*%?\s*moms\b/.test(key))  return { subcategory: 'food' }
  if (/\b6\s*%?\s*moms\b/.test(key))   return { subcategory: 'food' }
  return null
}

// Swedish BAS chart-of-accounts ranges. The account number is the ONLY
// authoritative signal for category on a Fortnox P&L — label alone is
// ambiguous (e.g. "Inköp livsmedel" and "Varuinköp" both mean food cost
// but neither matches the 3 food-cost keys in SV_SUB, so they'd fall
// back to other_cost and double-count against tracker_data.food_cost).
// See FIXES.md §0k for the incident this prevents going forward.
function classifyByAccount(acct: number | null): { category: string; subcategory: string | null } | null {
  if (acct == null || !Number.isFinite(acct)) return null
  if (acct >= 3000 && acct <= 3999) return { category: 'revenue',      subcategory: null }
  if (acct >= 4000 && acct <= 4999) return { category: 'food_cost',    subcategory: 'goods' }
  if (acct >= 5000 && acct <= 6999) return { category: 'other_cost',   subcategory: null }
  if (acct >= 7000 && acct <= 7999) return { category: 'staff_cost',   subcategory: null }
  if (acct >= 8900 && acct <= 8999) return { category: 'depreciation', subcategory: 'depreciation' }
  if (acct >= 8000 && acct <= 8899) return { category: 'financial',    subcategory: 'other' }
  return null
}

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
  const base64      = Buffer.from(arrayBuffer).toString('base64')

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

LINE ITEMS ARE MANDATORY.  "annual_lines" MUST contain ONE entry per BAS account leaf row visible in the PDF — a Swedish restaurant Resultatrapport typically has 15–40 rows (revenue splits by VAT, food/drink accounts, salary + tax rows, rent, utilities, insurance, bank fees, etc). Do NOT submit an empty "annual_lines": the downstream pipeline depends on them for category/VAT-rate/subcategory classification and for the Performance page's food-vs-alcohol split. If you're unsure whether a row is a subtotal, err on the side of including it — the server de-dupes. Subtotal rows that clearly say "Summa", "S:a", "Totalt", "Bruttovinst", "Rörelseresultat" or "Resultat före/efter…" must NOT be emitted (they would double-count).

For each line, "label" = the row text exactly as printed (Swedish), "amount" = the Ack./year-total (always positive for costs, signed for financial items), "account" = the BAS account number (integer). If a row has no visible account number but a clear label, still emit it with account=0 and rely on label classification downstream.

BAS CATEGORIES.  Sum accounts into rollup categories:
  revenue       = 3xxx (all operating revenue)
  food_cost     = 4xxx (cost of goods)
  staff_cost    = 7xxx (salaries + payroll tax + pension — 7000-7699 all go here)
  other_cost    = 5xxx + 6xxx (rent, utilities, admin, bank fees, insurance, consulting, marketing, software)
  depreciation  = 78xx (avskrivningar)
  financial     = 8xxx (interest + financial items — signed; interest expense negative)
  net_profit    = revenue − food_cost − staff_cost − other_cost − depreciation + financial

SIGN CONVENTION.  Costs positive, revenue positive, financial items signed (negative for interest expense, positive for interest income). Swedish decimal marker is comma: "1,5" in an MSEK report = 1 500 000 SEK.

VALIDATION.  Before submitting:
  1. SUM(all line items whose BAS account ∈ revenue range) must equal rollup.revenue within 2% — otherwise raise confidence='medium' and add warning
  2. For each monthly rollup, net_profit = revenue − food − staff − other − depreciation + financial. Compute yourself and compare; fix sign errors before submitting.
  3. Skip "Summa…" / "Total…" / "S:a" subtotal rows when listing line items (they'd double-count).
  4. Monthly revenue under 10 000 SEK or over 100 000 000 SEK almost always means scale misread — re-check the header before submitting.`

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
                  revenue:      { type: 'number' },
                  food_cost:    { type: 'number' },
                  staff_cost:   { type: 'number' },
                  other_cost:   { type: 'number' },
                  depreciation: { type: 'number' },
                  financial:    { type: 'number' },
                  net_profit:   { type: 'number' },
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

  // Sonnet 4.6 with extended thinking — based on Claude.ai's own
  // reasoning on this exact problem. The thinking budget gives Sonnet
  // room to do BAS-category aggregation + scale validation + sum-to-
  // rollup reconciliation mentally before emitting the tool call,
  // which is what the web version of Claude was doing implicitly.
  //
  // Prompt caching on the system prompt cuts 90% off the repeated
  // input cost across every subsequent extraction.
  const response = await client.messages.create({
    model:      AI_MODELS.ANALYSIS,   // claude-sonnet-4-6
    max_tokens: 16000,
    // Anthropic's API forbids thinking + forced tool_choice together
    // ("Thinking may not be enabled when tool_choice forces tool use").
    // Solution: tool_choice='auto' lets the model decide; with a single
    // relevant tool + a clear prompt, Sonnet picks it ~100% of the time.
    // Text-JSON fallback below catches the rare text-response case.
    thinking:   { type: 'enabled', budget_tokens: 5000 },
    system:     [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
    tools:      [submitExtractionTool],
    tool_choice:{ type: 'auto' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'Extract this Fortnox PDF. Call the submit_extraction tool with the full structured extraction — do not reply in free text.' },
      ],
    }],
  } as any)

  await writeProgress({ phase: 'parsing', message: 'Validating extraction…', percent: 70 })

  // Prefer the tool_use block (Claude's normal response mode with
  // tool_choice='auto'); fall back to parsing a text response as JSON
  // if for any reason the model chose to reply in text.
  let parsed: any = null
  const toolBlock = (response.content ?? []).find((b: any) => b?.type === 'tool_use')
  if (toolBlock) {
    parsed = (toolBlock as any).input
  } else {
    const raw = (response.content ?? []).map((b: any) => b?.type === 'text' ? b.text : '').join('').trim()
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const firstBrace = cleaned.indexOf('{')
    const lastBrace  = cleaned.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    try { parsed = JSON.parse(cleaned) }
    catch (e: any) {
      const stopReason = (response as any).stop_reason ?? 'unknown'
      throw new Error(`Sonnet returned neither tool_use nor parseable JSON (stop_reason: ${stopReason}). Preview: ${raw.slice(0, 400)}`)
    }
  }

  // Server-side validation — rollup reconciliation + sanity checks.
  // This is the "the model said something, but is it mathematically
  // consistent?" layer. Raises confidence floor or appends warnings
  // so the review UI surfaces low-confidence rows for human check.
  const validationWarnings: string[] = []
  try {
    for (const p of parsed?.periods ?? []) {
      const r = p.rollup ?? {}
      const computedNet = (Number(r.revenue) || 0) - (Number(r.food_cost) || 0) - (Number(r.staff_cost) || 0) - (Number(r.other_cost) || 0) - (Number(r.depreciation) || 0) + (Number(r.financial) || 0)
      const declaredNet = Number(r.net_profit) || 0
      // 2% tolerance OR 1000 SEK absolute (whichever wider) — catches
      // real arithmetic errors without tripping on rounding jitter.
      const tolerance = Math.max(Math.abs(computedNet) * 0.02, 1000)
      if (Math.abs(computedNet - declaredNet) > tolerance) {
        validationWarnings.push(`${p.year}-${String(p.month).padStart(2,'0')} net_profit math: declared ${declaredNet} vs computed ${Math.round(computedNet)} (diff ${Math.round(computedNet - declaredNet)})`)
      }

      // Restaurant revenue sanity band — flag outside 10k–100M SEK/month
      const rev = Number(r.revenue) || 0
      if (p.month && p.month >= 1 && p.month <= 12) {
        if (rev > 0 && rev < 10_000) {
          validationWarnings.push(`${p.year}-${String(p.month).padStart(2,'0')} revenue ${Math.round(rev)} SEK is suspiciously low — possible scale misdetection`)
        }
        if (rev > 100_000_000) {
          validationWarnings.push(`${p.year}-${String(p.month).padStart(2,'0')} revenue ${Math.round(rev)} SEK is suspiciously high — possible scale misdetection (MSEK not applied?)`)
        }
      }
    }

    // Annual_lines reconcile against summed rollup revenue if we have both.
    const periodsSum = (parsed?.periods ?? []).reduce((s: number, p: any) => s + (Number(p?.rollup?.revenue) || 0), 0)
    const revLineSum = (parsed?.annual_lines ?? [])
      .filter((l: any) => {
        const acct = Number(l?.account) || 0
        return acct >= 3000 && acct < 4000
      })
      .reduce((s: number, l: any) => s + (Number(l?.amount) || 0), 0)

    if (periodsSum > 0 && revLineSum > 0) {
      const relDiff = Math.abs(periodsSum - revLineSum) / periodsSum
      if (relDiff > 0.05) {
        validationWarnings.push(`Revenue cross-check: periods sum ${Math.round(periodsSum)} vs 3xxx line-items ${Math.round(revLineSum)} (diff ${(relDiff * 100).toFixed(1)}%) — one side may be under-extracted`)
      }
    }

    if (validationWarnings.length) {
      parsed.warnings = [...(parsed.warnings ?? []), ...validationWarnings]
      // Drop confidence one notch if the model said 'high' but math didn't reconcile.
      if (parsed.confidence === 'high') parsed.confidence = 'medium'
    }
  } catch (e: any) {
    console.warn('[extract-worker] validation threw:', e?.message)
    // Validation failures shouldn't block extraction — just no extra warnings.
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

      // Category priority: account number (authoritative) → AI hint (if
      // valid) → label lookup → other_cost fallback. Account number is the
      // ONLY source that can't be wrong — a Fortnox 4010 is food cost no
      // matter what the AI called it. Prevents the double-counting bug
      // captured in FIXES.md §0k.
      const accountBased = classifyByAccount(fortnoxAccount)
      const labelBased   = classifyLabel(label)
      const validAI      = ['revenue','food_cost','staff_cost','other_cost','depreciation','financial'].includes(fromAI)
      const category     = accountBased?.category ?? (validAI ? fromAI : labelBased.category)

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
    return { revenue: 0, food_cost: 0, staff_cost: 0, other_cost: 0, depreciation: 0, financial: 0, net_profit: 0 }
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
      return {
        year, month, lines,
        rollup: {
          revenue:      Number(rollupRaw.revenue     ?? 0) || 0,
          food_cost:    Number(rollupRaw.food_cost   ?? 0) || 0,
          staff_cost:   Number(rollupRaw.staff_cost  ?? 0) || 0,
          other_cost:   Number(rollupRaw.other_cost  ?? 0) || 0,
          depreciation: Number(rollupRaw.depreciation?? 0) || 0,
          financial:    Number(rollupRaw.financial   ?? 0) || 0,
          net_profit:   Number(rollupRaw.net_profit  ?? 0) || 0,
        },
      }
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
        revenue:      acc.revenue      + p.rollup.revenue,
        food_cost:    acc.food_cost    + p.rollup.food_cost,
        staff_cost:   acc.staff_cost   + p.rollup.staff_cost,
        other_cost:   acc.other_cost   + p.rollup.other_cost,
        depreciation: acc.depreciation + p.rollup.depreciation,
        financial:    acc.financial    + p.rollup.financial,
        net_profit:   acc.net_profit   + p.rollup.net_profit,
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

  const inputTokens  = (response as any).usage?.input_tokens  ?? 0
  const outputTokens = (response as any).usage?.output_tokens ?? 0
  const costKr = (inputTokens * 1e-6 + outputTokens * 5e-6) * 11

  try {
    await logAiRequest(db, {
      org_id:        job.org_id,
      request_type:  'fortnox_extract',
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
