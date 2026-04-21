// app/api/fortnox/extract/route.ts
//
// Sonnet reads a single Fortnox PDF and returns structured JSON: the
// document type (annual vs monthly P&L vs invoice), the period it covers,
// rollup totals, and every line item with a suggested internal
// subcategory. The client calls this per-upload after the bulk upload
// endpoint has landed the files; running it per-PDF keeps each request
// bounded and lets the UI show per-row status as extractions finish.
//
// Cost: ~$0.01–0.03 per PDF (Sonnet input + ~1k output tokens).
// Rate limit: 60/hour per user (lets a shop process a quarterly batch).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS } from '@/lib/ai/models'
import { logAiRequest } from '@/lib/ai/usage'
import { rateLimit } from '@/lib/middleware/rate-limit'

export const runtime     = 'nodejs'
// Sonnet reading a dense multi-month Resultatrapport (12 columns × ~40
// line items) with max_tokens=8000 can push past 90s. Vercel's 300s
// default gives comfortable headroom without changing model behaviour.
export const maxDuration = 300

// Swedish label → internal subcategory lookup.  Bootstrap list covering
// the common Fortnox BAS chart rows seen in restaurant P&Ls.  Anything
// outside the lookup lands with subcategory=null for manual tagging.
const SV_SUB = new Map<string, { category: string; subcategory: string }>([
  // Revenue / intäkter
  ['försäljning',             { category: 'revenue', subcategory: 'food' }],
  ['försäljning livsmedel',   { category: 'revenue', subcategory: 'food' }],
  ['försäljning dryck',       { category: 'revenue', subcategory: 'beverage' }],
  ['försäljning alkohol',     { category: 'revenue', subcategory: 'alcohol' }],
  ['övriga intäkter',         { category: 'revenue', subcategory: 'other' }],
  // Food costs
  ['råvaror',                 { category: 'food_cost', subcategory: 'raw_materials' }],
  ['handelsvaror',            { category: 'food_cost', subcategory: 'goods_for_resale' }],
  ['råvaror och förnödenheter', { category: 'food_cost', subcategory: 'raw_materials' }],
  // Staff
  ['personalkostnader',       { category: 'staff_cost', subcategory: 'salaries' }],
  ['löner',                   { category: 'staff_cost', subcategory: 'salaries' }],
  ['sociala avgifter',        { category: 'staff_cost', subcategory: 'payroll_tax' }],
  ['arbetsgivaravgifter',     { category: 'staff_cost', subcategory: 'payroll_tax' }],
  ['pensionskostnader',       { category: 'staff_cost', subcategory: 'pension' }],
  // Other external costs — the "hidden costs" bucket the AI hunts
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
  // Depreciation + financial
  ['avskrivningar',           { category: 'depreciation', subcategory: 'depreciation' }],
  ['räntekostnader',          { category: 'financial', subcategory: 'interest' }],
  ['ränteintäkter',           { category: 'financial', subcategory: 'interest_income' }],
  ['finansiella poster',      { category: 'financial', subcategory: 'other' }],
])

function classifyLabel(label: string): { category: string; subcategory: string | null } {
  const key = label.trim().toLowerCase()
  // Direct hit
  if (SV_SUB.has(key)) return SV_SUB.get(key)!
  // Partial match — "Lokalhyra Gröndal" still maps to rent
  for (const [k, v] of SV_SUB.entries()) {
    if (key.includes(k)) return v
  }
  return { category: 'other_cost', subcategory: null }
}

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const gate = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 60 })
  if (!gate.allowed) return NextResponse.json({ error: 'Too many extractions — try later' }, { status: 429 })

  const { upload_id } = await req.json().catch(() => ({} as any))
  if (!upload_id) return NextResponse.json({ error: 'upload_id required' }, { status: 400 })

  const db = createAdminClient()

  const { data: upload, error: getErr } = await db
    .from('fortnox_uploads')
    .select('id, org_id, business_id, pdf_storage_path, status')
    .eq('id', upload_id)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (getErr || !upload) return NextResponse.json({ error: 'Upload not found' }, { status: 404 })
  if (upload.status === 'applied') {
    return NextResponse.json({ error: 'Already applied — extraction not re-runnable' }, { status: 400 })
  }

  // Flip to 'extracting' before the Claude call so the UI shows progress.
  await db.from('fortnox_uploads').update({ status: 'extracting', error_message: null }).eq('id', upload_id)

  // Pull the PDF bytes from private storage.
  const { data: blob, error: dlErr } = await db.storage.from('fortnox-pdfs').download(upload.pdf_storage_path)
  if (dlErr || !blob) {
    await db.from('fortnox_uploads').update({ status: 'failed', error_message: `Storage download failed: ${dlErr?.message ?? 'no blob'}` }).eq('id', upload_id)
    return NextResponse.json({ error: 'Download failed' }, { status: 500 })
  }

  const arrayBuffer = await blob.arrayBuffer()
  const base64      = Buffer.from(arrayBuffer).toString('base64')

  // ── Peek call ─────────────────────────────────────────────────────────
  // Small (<500 tokens out) Haiku call that only has to detect the scale,
  // doc_type, and the list of (year, month) periods covered. Primes the
  // prompt cache for the PDF so the per-period fill calls that follow can
  // hit the cache at 10% cost. Typical wall time: 2–4s.
  //
  // When the PDF covers a single period, we skip the fill fan-out and
  // fall through to the one-shot prompt path below (legacy behaviour).
  const peekPrompt = `You are scanning a Swedish accounting PDF (Fortnox Resultatrapport / invoice / VAT report) to identify WHAT it covers. DO NOT extract line items.

Detect:
  • scale_detected — the unit the amounts are printed in: "sek" | "ksek" | "msek". Look for "(kr)" vs "(tkr)" / "Belopp i kkr" / "MSEK". If none is labelled, guess from the magnitudes (a restaurant's monthly revenue is 200k–3M SEK).
  • doc_type       — "pnl_monthly" | "pnl_annual" | "pnl_multi_month" | "invoice" | "sales" | "vat".
  • business_hint  — legal name of the company if visible, else null.
  • periods        — list every distinct (year, month) column/period present. For a multi-column Resultatrapport with Jan–Dec 2025, emit 12 entries. For a single-month P&L, emit one. For a year-only summary with no monthly split, emit one entry with month=0. Do NOT include "Ack."/"Totalt"/"Året" summary columns — only the individual period columns.

Return ONLY JSON, nothing else:
{
  "doc_type":       "pnl_monthly" | "pnl_annual" | "pnl_multi_month" | "invoice" | "sales" | "vat",
  "scale_detected": "sek" | "ksek" | "msek",
  "business_hint":  "string" | null,
  "confidence":     "high" | "medium" | "low",
  "warnings":       [],
  "periods":        [{ "year": 2025, "month": 1 }]
}`

  async function runClaude(args: {
    prompt:     string
    maxTokens:  number
    cachePdf?:  boolean   // tag the document with cache_control so parallel calls share it
  }) {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const doc: any  = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    if (args.cachePdf) doc.cache_control = { type: 'ephemeral' }
    // Retry once on 429 with a 3-second backoff — Anthropic's concurrent-
    // connection ceiling trips the whole fan-out if we fire too many at
    // once.  The concurrency limiter below caps this at 4, but a retry
    // here protects against transient spikes.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await client.messages.create({
          model:      AI_MODELS.AGENT,
          max_tokens: args.maxTokens,
          messages: [{ role: 'user', content: [ doc, { type: 'text', text: args.prompt } ] }],
        })
      } catch (e: any) {
        const is429 = e?.status === 429 || /rate_limit|concurrent/i.test(e?.message ?? '')
        if (is429 && attempt === 0) { await new Promise(r => setTimeout(r, 3000)); continue }
        throw e
      }
    }
    throw new Error('unreachable')
  }

  // Concurrency pool — caps the number of simultaneous Anthropic calls so
  // we don't trip the concurrent-connection rate limit.  4 seems to be a
  // safe number on lower Anthropic tiers; it can be tuned up later when
  // we upgrade plans.
  async function runPooled<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length)
    let cursor = 0
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = cursor++
        if (i >= items.length) return
        out[i] = await fn(items[i], i)
      }
    })
    await Promise.all(workers)
    return out
  }

  function parseJsonFromResponse(resp: any): any | null {
    const raw = (resp?.content ?? [])
      .map((b: any) => (b?.type === 'text' ? b.text : ''))
      .join('')
      .trim()
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const firstBrace = cleaned.indexOf('{')
    const lastBrace  = cleaned.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    try { return JSON.parse(cleaned) } catch { return null }
  }

  const prompt = `You are extracting a Swedish accounting report (Fortnox export) into structured JSON.

CRITICAL RULE #1 — SCALE / UNIT.  Swedish accounting reports are printed in one of three scales:
  • SEK    — full kronor, e.g. "1 234 567"
  • KSEK / tkr   — thousands of kronor, e.g. "1 234" means 1 234 000 SEK
  • MSEK / mkr   — millions of kronor, e.g. "1,234" means 1 234 000 SEK

Before you extract anything, DETECT THE SCALE.  Look at the header, column headings, or a note near the top — it will usually say "(tkr)", "(ksek)", "(kr)", "Belopp i kkr", "Alla belopp i tusentals kronor", "Mkr", etc.  A Swedish restaurant doing 50k covers/year will have monthly revenue in the 600 000 – 1 500 000 kr range.  If the numbers you are seeing would be absurd in SEK (revenue of 1 023 for a restaurant with 3 staff is impossible), the scale is NOT SEK — look again for the unit label.

ALL AMOUNTS YOU RETURN MUST BE IN FULL SEK (no thousands, no millions).  Convert internally:
  • SEK values: return as-is
  • KSEK / tkr: multiply every number by 1 000
  • MSEK / mkr: multiply every number by 1 000 000

Put the detected scale into the "scale_detected" field ("sek" | "ksek" | "msek").  If the scale is genuinely ambiguous, set scale_detected="sek" AND add a warning string "Scale ambiguous — verify numbers against the source PDF before applying."

CRITICAL RULE #2 — MULTI-PERIOD.  Many Fortnox "Resultatrapport" exports show one row per BAS account with multiple monthly columns (Jan, Feb, Mar, …) plus a year-total column.  Detect this and emit ONE entry in "periods" per month.  Do NOT collapse monthly columns into a single annual rollup.

Return ONLY valid JSON with this exact shape and nothing else:

{
  "doc_type": "pnl_monthly" | "pnl_annual" | "pnl_multi_month" | "invoice" | "sales" | "vat",
  "business_hint":   "Vero Italiano" | null,
  "scale_detected":  "sek" | "ksek" | "msek",
  "confidence":      "high" | "medium" | "low",
  "warnings":        [],

  "periods": [
    {
      "year":  2025,
      "month": 5,                                    // 1..12; use 0 for a year-total column only
      "rollup": {
        "revenue":      0,                           // IN FULL SEK — already converted if source was ksek/msek
        "food_cost":    0,
        "staff_cost":   0,
        "other_cost":   0,
        "depreciation": 0,
        "financial":    0,                           // signed
        "net_profit":   0
      },
      "lines": [
        {
          "label":           "Bankavgifter",
          "category":        "revenue" | "food_cost" | "staff_cost" | "other_cost" | "depreciation" | "financial",
          "amount":          340,                    // FULL SEK — positive for cost lines and revenue
          "fortnox_account": 6570,
          "note":            null
        }
      ]
    }
  ]
}

Rules:
- When the PDF is clearly a single period (one month or one year-end summary), emit ONE entry in "periods".  Use month=1..12 for monthly, or month=0 for an annual summary with no monthly split.
- When the PDF shows monthly columns (common Fortnox "Resultatrapport" with "Denna period / Föregående / Ack.", or a row-per-account × 12-month grid), emit ONE period per month.
- Include EVERY line item per period.  Skip subtotals ("Summa…", "Total…") — the rollup is re-derived from the lines.
- Store ALL cost amounts as POSITIVE numbers in FULL SEK.
- Swedish decimal marker is comma.  "1,234" in a KSEK report = 1 234 × 1 000 = 1 234 000 SEK (not 1.234).  "1,5" in an MSEK report = 1 500 000 SEK.
- Negatives in Fortnox are shown in parentheses or with a leading minus — preserve the sign on financial items, flip to positive for cost lines, keep positive for revenue.
- SANITY CHECK before you return:  a restaurant's MONTHLY revenue is typically 200 000 – 3 000 000 SEK.  If any month's revenue is under 10 000 or over 100 000 000, you've almost certainly missed the scale — re-check the unit in the PDF header and convert.

Return ONLY the JSON object.`

  const started = Date.now()
  let totalInputTokens  = 0
  let totalOutputTokens = 0

  // Progress writer — updates error_message with a phase string so the
  // UI can show "Peeking…" → "Extracting month 4/12…" → success. Using
  // error_message because it's already a text column and not semantically
  // load-bearing while status='extracting'.
  const writeProgress = async (msg: string) => {
    try { await db.from('fortnox_uploads').update({ error_message: msg }).eq('id', upload_id) }
    catch { /* non-fatal */ }
  }

  try {
    await writeProgress('Peeking at PDF structure…')
    // ── Peek first ─────────────────────────────────────────────────────
    // Identify periods + scale + confidence in one small call. The PDF
    // is marked cache_control=ephemeral so the follow-up fill calls (if
    // any) read it from cache at 10% cost and much lower latency.
    const peekResp = await runClaude({ prompt: peekPrompt, maxTokens: 600, cachePdf: true })
    totalInputTokens  += (peekResp as any).usage?.input_tokens  ?? 0
    totalOutputTokens += (peekResp as any).usage?.output_tokens ?? 0
    const peek = parseJsonFromResponse(peekResp)
    const peekPeriods: Array<{ year: number; month: number }> = Array.isArray(peek?.periods)
      ? peek.periods
          .map((p: any) => ({ year: Number(p?.year), month: Number(p?.month) }))
          .filter((p: { year: number; month: number }) => Number.isFinite(p.year))
      : []
    const detectedScale   = String(peek?.scale_detected ?? 'sek').toLowerCase()
    const peekDocType     = String(peek?.doc_type ?? 'pnl_monthly')
    const peekBizHint     = peek?.business_hint ?? null
    const peekConfidence  = String(peek?.confidence ?? 'medium')
    const peekWarnings    = Array.isArray(peek?.warnings) ? peek.warnings : []

    // ── Decide single-call vs parallel fill ────────────────────────────
    // If the peek call failed to return periods, or only a single period
    // was detected, fall through to the one-shot path (existing prompt)
    // because the overhead of fanning out isn't worth it.
    let parsed: any
    const useParallel = peekPeriods.length > 1

    if (useParallel) {
      // Parallel per-month fill calls. Each Haiku call extracts ONE month
      // only so its output runs ~1.5–2k tokens — fast. They run
      // concurrently and all hit the cached PDF primed by the peek call.
      const scaleHint = detectedScale === 'ksek'
        ? 'PDF values are printed in KSEK (thousands of kr) — multiply every number by 1000 before returning.'
        : detectedScale === 'msek'
          ? 'PDF values are printed in MSEK (millions of kr) — multiply every number by 1000000 before returning.'
          : 'PDF values are in full SEK — return them as-is.'

      const monthPromptFor = (p: { year: number; month: number }) =>
        `You are extracting ONE month's column from a Swedish Fortnox Resultatrapport.

Extract ONLY the ${p.year}-${String(p.month).padStart(2, '0')} column (month = ${p.month}). Ignore every other month column, ignore the "Ack." and year-total columns, ignore prior-year comparison columns.

${scaleHint}  ALL amounts you return MUST be in FULL SEK.

Every cost amount is POSITIVE. Revenue is positive. Financial items keep their sign (interest expense negative).

Return ONLY JSON:
{
  "rollup": {
    "revenue":      0,
    "food_cost":    0,
    "staff_cost":   0,
    "other_cost":   0,
    "depreciation": 0,
    "financial":    0,
    "net_profit":   0
  },
  "lines": [
    { "label": "Bankavgifter", "category": "other_cost", "amount": 340, "fortnox_account": 6570 }
  ]
}`

      await writeProgress(`Peek detected ${peekPeriods.length} months — extracting 0/${peekPeriods.length}…`)
      let completed = 0
      // Cap concurrency at 4 — Anthropic's concurrent-connection ceiling
      // trips at 5+ on lower tiers.  12 months / 4 concurrent × ~15 s
      // per call ≈ 45 s wall time, still a 3x win over the serial path.
      const fillResps = await runPooled(peekPeriods, 4, async (p) => {
        const r = await runClaude({ prompt: monthPromptFor(p), maxTokens: 4000, cachePdf: true })
        completed++
        writeProgress(`Extracting ${completed}/${peekPeriods.length} months…`).catch(() => {})
        return r
      })
      const filled: any[] = fillResps.map((resp: any, i: number) => {
        totalInputTokens  += resp.usage?.input_tokens  ?? 0
        totalOutputTokens += resp.usage?.output_tokens ?? 0
        const data = parseJsonFromResponse(resp) ?? { rollup: {}, lines: [] }
        return { year: peekPeriods[i].year, month: peekPeriods[i].month, ...data }
      })

      parsed = {
        doc_type:       peekDocType,
        scale_detected: detectedScale,
        business_hint:  peekBizHint,
        confidence:     peekConfidence,
        warnings:       peekWarnings,
        periods:        filled,
      }
    } else {
      // Single-shot fallback path — the original prompt, for single-period
      // PDFs or when peek failed to enumerate periods.
      const response = await runClaude({ prompt, maxTokens: 32000, cachePdf: false })
      totalInputTokens  += (response as any).usage?.input_tokens  ?? 0
      totalOutputTokens += (response as any).usage?.output_tokens ?? 0

      const truncated = (response as any).stop_reason === 'max_tokens'
      parsed = parseJsonFromResponse(response)
      if (!parsed) {
        const raw = ((response as any).content ?? [])
          .map((b: any) => (b?.type === 'text' ? b.text : ''))
          .join('')
          .trim()
        const snippet = raw.slice(0, 400).replace(/\s+/g, ' ')
        const errMsg  = truncated
          ? `Claude ran out of tokens on a long PDF — reached max_tokens before finishing JSON. Sample: ${snippet}`
          : `Claude returned non-JSON output. Sample: ${snippet}`
        console.error('[fortnox/extract]', errMsg)
        await db.from('fortnox_uploads').update({
          status:        'failed',
          error_message: errMsg.slice(0, 500),
        }).eq('id', upload_id)
        return NextResponse.json({ error: errMsg, raw: snippet }, { status: 500 })
      }
    }

    // Helper — normalise + enrich lines with our subcategory lookup.
    function enrichLines(raw: any[]): any[] {
      return (Array.isArray(raw) ? raw : []).map((l: any) => {
        const label   = String(l?.label ?? '').trim()
        const fromAI  = String(l?.category ?? '').trim()
        const amount  = Number(l?.amount ?? 0)
        const looked  = classifyLabel(label)
        const category = ['revenue','food_cost','staff_cost','other_cost','depreciation','financial'].includes(fromAI)
          ? fromAI
          : looked.category
        const subcategory = looked.subcategory
        const fortnoxAccount = Number.isFinite(Number(l?.fortnox_account)) ? Number(l.fortnox_account) : null
        return { label_sv: label, category, subcategory, amount, fortnox_account: fortnoxAccount }
      }).filter((l: any) => l.label_sv && Number.isFinite(l.amount))
    }

    function emptyRollup() {
      return { revenue: 0, food_cost: 0, staff_cost: 0, other_cost: 0, depreciation: 0, financial: 0, net_profit: 0 }
    }

    // Build a consistent periods[] array regardless of which shape Claude
    // returned.  Newer prompt asks for "periods": [...].  Legacy shape is
    // a single "period" + "rollup" + "lines".  Wrap legacy into a single-
    // entry periods array so downstream code only has to handle one shape.
    let periodsRaw: any[] = []
    if (Array.isArray(parsed?.periods) && parsed.periods.length) {
      periodsRaw = parsed.periods
    } else {
      periodsRaw = [{
        year:   parsed?.period?.year,
        month:  parsed?.period?.month,
        rollup: parsed?.rollup ?? {},
        lines:  parsed?.lines  ?? [],
      }]
    }

    const periods = periodsRaw
      .map((p: any) => {
        const year  = Number(p?.year)  || null
        const month = p?.month == null ? null : (Number.isFinite(Number(p.month)) ? Number(p.month) : null)
        const lines = enrichLines(p?.lines)
        const rollupRaw = p?.rollup ?? {}
        const rollup = {
          revenue:      Number(rollupRaw.revenue     ?? 0) || 0,
          food_cost:    Number(rollupRaw.food_cost   ?? 0) || 0,
          staff_cost:   Number(rollupRaw.staff_cost  ?? 0) || 0,
          other_cost:   Number(rollupRaw.other_cost  ?? 0) || 0,
          depreciation: Number(rollupRaw.depreciation?? 0) || 0,
          financial:    Number(rollupRaw.financial   ?? 0) || 0,
          net_profit:   Number(rollupRaw.net_profit  ?? 0) || 0,
        }
        return { year, month, rollup, lines }
      })
      .filter((p: any) => p.year != null)
      .sort((a: any, b: any) => (a.year - b.year) || ((a.month ?? 0) - (b.month ?? 0)))

    // Derive doc_type if Claude didn't set it, or promote to multi-month.
    let docType: string = parsed?.doc_type ?? 'pnl_monthly'
    if (periods.length > 1) docType = 'pnl_multi_month'
    else if (periods.length === 1 && (periods[0].month == null || periods[0].month === 0)) docType = 'pnl_annual'
    if (!['pnl_monthly','pnl_annual','pnl_multi_month','invoice','sales','vat'].includes(docType)) {
      docType = 'pnl_monthly'
    }

    // Back-compat: also emit the legacy single-period fields so any
    // existing consumer that reads extraction.rollup / extraction.lines
    // still works during rollout.  Pick the "main" period — for
    // multi-month reports, a synthesised year-total; otherwise the only
    // period.
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
    const mainLines = periods.length === 1 ? periods[0].lines : []   // multi-month lines live only inside periods[]

    // Top-level period reflects the earliest month we saw — used for the
    // fortnox_uploads.period_year / period_month columns which drive the
    // display label in the uploads list.
    const pYear  = periods[0]?.year  ?? null
    const pMonth = periods.length > 1 ? null : (periods[0]?.month ?? null)

    const extraction = {
      doc_type:      docType,
      period:        { year: pYear, month: pMonth },
      periods,                                              // ← new canonical shape
      business_hint: parsed?.business_hint ?? null,
      rollup:        mainRollup,
      lines:         mainLines,
      confidence:    parsed?.confidence ?? 'medium',
      warnings:      Array.isArray(parsed?.warnings) ? parsed.warnings : [],
    }

    // Rough cost logging (Haiku 4.5: $1/M input, $5/M output). Sum across
    // peek + per-month fill calls. Prompt caching on the document reduces
    // the real input cost below this estimate but the usage numbers we
    // log here are the uncached ones Anthropic returned.
    const inputTokens  = totalInputTokens
    const outputTokens = totalOutputTokens
    const costKr = (inputTokens * 1e-6 + outputTokens * 5e-6) * 11  // rough USD→SEK

    try {
      await logAiRequest(db, {
        org_id:        auth.orgId,
        request_type:  'fortnox_extract',
        model:         AI_MODELS.AGENT,
        input_tokens:  inputTokens,
        output_tokens: outputTokens,
        duration_ms:   Date.now() - started,
      })
    } catch { /* non-fatal */ }

    // Attach an explicit warning when Claude reports low confidence so the
    // review UI can refuse auto-apply and surface it clearly.  We don't
    // block the extracted_json — low-confidence data still beats no data
    // and a human reviewer can fix it.
    const warnings = Array.isArray(extraction.warnings) ? [...extraction.warnings] : []
    if (extraction.confidence === 'low') {
      warnings.unshift('Low-confidence extraction — double-check every row before applying.')
    }
    extraction.warnings = warnings

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
    }).eq('id', upload_id)

    return NextResponse.json({ ok: true, extraction })
  } catch (e: any) {
    console.error('[fortnox/extract] Claude call failed:', e.message)
    await db.from('fortnox_uploads').update({
      status:        'failed',
      error_message: `Extraction failed: ${e.message}`,
    }).eq('id', upload_id)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
