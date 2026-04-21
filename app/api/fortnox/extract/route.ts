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
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const response = await client.messages.create({
      model:      AI_MODELS.ANALYSIS,
      // Annual reports have 50+ line items + the rollup — 4 000 tokens
      // sometimes truncates mid-JSON.  8 000 is still well under Sonnet's
      // 64k ceiling and costs ≈ $0.03 per call in the worst case.
      max_tokens: 8000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
          { type: 'text', text: prompt },
        ],
      }],
    })

    // Concatenate every text block (multi-block responses leave structured
    // output spread across blocks) and strip code fences.
    const raw = (response.content ?? [])
      .map((b: any) => (b?.type === 'text' ? b.text : ''))
      .join('')
      .trim()

    // Robust JSON extraction — Claude occasionally prepends "Here is the
    // extracted data:" or similar despite the "Return ONLY the JSON
    // object" instruction.  Find the first { and the last } and parse
    // the slice between them.
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    const firstBrace = cleaned.indexOf('{')
    const lastBrace  = cleaned.lastIndexOf('}')
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1)
    }

    // Detect truncation — stop_reason=max_tokens means Claude ran out
    // mid-response, so JSON will be unparseable.  Report explicitly.
    const truncated = (response as any).stop_reason === 'max_tokens'

    let parsed: any
    try { parsed = JSON.parse(cleaned) }
    catch (parseErr: any) {
      const snippet = raw.slice(0, 400).replace(/\s+/g, ' ')
      const errMsg  = truncated
        ? `Claude ran out of tokens on a long PDF — reached max_tokens before finishing JSON. Sample: ${snippet}`
        : `Claude returned non-JSON output. Parse error: ${parseErr?.message}. Sample: ${snippet}`
      console.error('[fortnox/extract]', errMsg)
      await db.from('fortnox_uploads').update({
        status:        'failed',
        error_message: errMsg.slice(0, 500),
      }).eq('id', upload_id)
      return NextResponse.json({ error: errMsg, raw: snippet }, { status: 500 })
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

    // Rough cost logging (Sonnet 4.6: $3/M input, $15/M output).  Kept as
    // a record in ai_usage_daily like other agents.
    const inputTokens  = response.usage?.input_tokens  ?? 0
    const outputTokens = response.usage?.output_tokens ?? 0
    const costKr = (inputTokens * 3e-6 + outputTokens * 15e-6) * 11  // rough USD→SEK

    try {
      await logAiRequest(db, {
        org_id:        auth.orgId,
        request_type:  'fortnox_extract',
        model:         AI_MODELS.ANALYSIS,
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
      extraction_model:   AI_MODELS.ANALYSIS,
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
