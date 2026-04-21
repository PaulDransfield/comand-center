// app/api/fortnox/extract-worker/route.ts
//
// Background worker for Fortnox extraction jobs.
//
// Invoked by either the dispatcher (/api/fortnox/extract) for fast-path
// processing, or the sweeper cron (/api/cron/extraction-sweeper) for
// retry/resilience. Authed via CRON_SECRET bearer token — not exposed
// to the browser.
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
  ['råvaror',                 { category: 'food_cost', subcategory: 'raw_materials' }],
  ['handelsvaror',            { category: 'food_cost', subcategory: 'goods_for_resale' }],
  ['råvaror och förnödenheter', { category: 'food_cost', subcategory: 'raw_materials' }],
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

  await writeProgress({ phase: 'extracting', message: 'Extracting with Haiku…', percent: 20 })

  const prompt = `You are extracting a Swedish Fortnox accounting report into structured JSON.

SCALE / UNIT.  Swedish reports are printed in SEK, KSEK (tkr / thousands) or MSEK (mkr / millions). Detect it from the header. Then convert EVERYTHING to full SEK:
  • SEK: as-is
  • KSEK / tkr: × 1 000
  • MSEK / mkr: × 1 000 000

A restaurant's monthly revenue is typically 200 000 – 3 000 000 SEK. If the numbers would be absurd in SEK (e.g. revenue 1 023 for a restaurant), the scale is NOT SEK — reconvert.

MULTI-PERIOD.  If the PDF has one row per BAS account with multiple monthly columns (Jan–Dec), emit ONE "periods" entry per month with JUST a rollup (no lines per month — line-item detail goes into the single "annual_lines" array at the top level from the year-total / "Ack." column). This keeps the output compact.

If the PDF is a single-month or single-year report, emit ONE period with the rollup AND put all its line items into "annual_lines".

Return ONLY valid JSON with this shape, nothing else:

{
  "doc_type":       "pnl_monthly" | "pnl_annual" | "pnl_multi_month" | "invoice" | "sales" | "vat",
  "business_hint":  "Company name" | null,
  "scale_detected": "sek" | "ksek" | "msek",
  "confidence":     "high" | "medium" | "low",
  "warnings":       [],

  "periods": [
    {
      "year":  2025,
      "month": 1,
      "rollup": { "revenue": 0, "food_cost": 0, "staff_cost": 0, "other_cost": 0, "depreciation": 0, "financial": 0, "net_profit": 0 }
    }
  ],

  "annual_lines": [
    { "label": "Bankavgifter", "amount": 4080, "account": 6570 }
  ]
}

Rules:
- Monthly revenue ranges per-business 200 000 – 3 000 000 SEK — sanity-check before returning.
- All costs positive; revenue positive; financial items signed.
- Swedish decimal marker is comma. "1,5" in an MSEK report = 1 500 000 SEK.
- Skip "Summa…" / "Total…" subtotal rows.
- annual_lines contains the year-total amounts for every line account (not per-month lines).

Return ONLY the JSON object.`

  const started = Date.now()
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const response = await client.messages.create({
    model:      AI_MODELS.AGENT,
    max_tokens: 8000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
        { type: 'text', text: prompt },
      ],
    }],
  })

  await writeProgress({ phase: 'parsing', message: 'Parsing Haiku output…', percent: 70 })

  const raw = (response.content ?? []).map((b: any) => b?.type === 'text' ? b.text : '').join('').trim()
  let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  const firstBrace = cleaned.indexOf('{')
  const lastBrace  = cleaned.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1)

  let parsed: any
  try { parsed = JSON.parse(cleaned) }
  catch (e: any) {
    const snippet = raw.slice(0, 400).replace(/\s+/g, ' ')
    const truncated = (response as any).stop_reason === 'max_tokens'
    throw new Error(truncated
      ? `Haiku ran out of tokens before finishing JSON. Sample: ${snippet}`
      : `Haiku returned non-JSON output (${e.message}). Sample: ${snippet}`)
  }

  // Attach annual_lines to the latest period so the apply route can
  // write them into tracker_line_items via the existing annual path.
  const annualLines = Array.isArray(parsed?.annual_lines) ? parsed.annual_lines : []
  if (annualLines.length && Array.isArray(parsed?.periods) && parsed.periods.length) {
    const target = parsed.periods[parsed.periods.length - 1]
    target.lines = Array.isArray(target.lines) && target.lines.length ? target.lines : annualLines
  }

  await writeProgress({ phase: 'normalising', message: 'Normalising line items…', percent: 85 })

  function enrichLines(raw: any[]): any[] {
    return (Array.isArray(raw) ? raw : []).map((l: any) => {
      const label   = String(l?.label ?? '').trim()
      const fromAI  = String(l?.category ?? '').trim()
      const amount  = Number(l?.amount ?? 0)
      const looked  = classifyLabel(label)
      const category = ['revenue','food_cost','staff_cost','other_cost','depreciation','financial'].includes(fromAI)
        ? fromAI : looked.category
      const acctRaw = l?.fortnox_account ?? l?.account
      const fortnoxAccount = Number.isFinite(Number(acctRaw)) ? Number(acctRaw) : null
      return { label_sv: label, category, subcategory: looked.subcategory, amount, fortnox_account: fortnoxAccount }
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

  await db.from('fortnox_uploads').update({
    doc_type:           docType,
    period_year:        pYear,
    period_month:       pMonth,
    extracted_json:     extraction,
    extraction_model:   AI_MODELS.AGENT,
    extraction_cost_kr: Math.round(costKr * 100) / 100,
    status:             'extracted',
    extracted_at:       new Date().toISOString(),
    error_message:      extraction.confidence === 'low' ? 'Low confidence — review carefully' : null,
  }).eq('id', job.upload_id)

  return {
    upload_id:      job.upload_id,
    doc_type:       docType,
    period:         { year: pYear, month: pMonth },
    line_count:     periods.reduce((n: number, p: any) => n + (p.lines?.length ?? 0), 0),
    input_tokens:   inputTokens,
    output_tokens:  outputTokens,
  }
}
