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
export const maxDuration = 90

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

Return ONLY valid JSON with this exact shape and nothing else:

{
  "doc_type": "pnl_monthly" | "pnl_annual" | "invoice" | "sales" | "vat",
  "period": { "year": 2025, "month": 5 },           // month null for pnl_annual
  "business_hint": "Vero Italiano" | null,          // name on the report if any
  "rollup": {
    "revenue":     0,                                // sum of all revenue lines, positive
    "food_cost":   0,                                // raw materials, goods for resale — positive number (we store as cost)
    "staff_cost":  0,                                // salaries + social contributions + pension — positive
    "other_cost":  0,                                // övriga externa kostnader — positive
    "depreciation":0,                                // avskrivningar — positive
    "financial":   0,                                // interest net — signed
    "net_profit":  0                                 // revenue − all costs − depreciation ± financial — signed
  },
  "lines": [
    {
      "label":           "Bankavgifter",             // exact label on the Fortnox row
      "category":        "revenue" | "food_cost" | "staff_cost" | "other_cost" | "depreciation" | "financial",
      "amount":          340,                        // always POSITIVE for cost lines; positive for revenue lines
      "fortnox_account": 6570,                       // BAS kontoplan code if printed (3xxx=revenue, 4xxx=food, 5xxx/6xxx=other, 7xxx=staff, 8xxx=financial). null otherwise.
      "note":            null
    }
  ],
  "confidence": "high" | "medium" | "low",
  "warnings":   []
}

Rules:
- Store all cost amounts as POSITIVE numbers.  The rollup already separates them by category.
- Include EVERY line item on the report, even small ones.  Do not roll up subtotals.
- "doc_type": if the report is "Resultaträkning" covering a single month → "pnl_monthly".  If it covers a full year (or year-to-date with no monthly detail) → "pnl_annual".  If it's a "Leverantörsfaktura" → "invoice".  If it's "Försäljningsrapport" → "sales".  If "Momsrapport" → "vat".
- "period": take the period stated on the report.  If the range is a full year, set year and month=null.  If the range is e.g. "2025-05-01 to 2025-05-31", use year=2025, month=5.
- Be exhaustive on line items — this is the primary signal the AI uses to find hidden costs.
- If a line looks like a subtotal ("Summa…", "Total…"), skip it.  We re-derive the rollup from the line items.

Return ONLY the JSON object.`

  const started = Date.now()
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const response = await client.messages.create({
      model:      AI_MODELS.ANALYSIS,
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } } as any,
          { type: 'text', text: prompt },
        ],
      }],
    })

    const raw = (response.content?.[0] as any)?.text?.trim() ?? ''
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()

    let parsed: any
    try { parsed = JSON.parse(clean) }
    catch {
      await db.from('fortnox_uploads').update({
        status:        'failed',
        error_message: 'Claude returned non-JSON output',
      }).eq('id', upload_id)
      return NextResponse.json({ error: 'Extraction returned invalid JSON', raw: clean.slice(0, 500) }, { status: 500 })
    }

    // Normalise + enrich lines with our subcategory lookup.
    const lines = Array.isArray(parsed?.lines) ? parsed.lines : []
    const enriched = lines.map((l: any) => {
      const label   = String(l?.label ?? '').trim()
      const fromAI  = String(l?.category ?? '').trim()
      const amount  = Number(l?.amount ?? 0)
      const looked  = classifyLabel(label)
      // Trust Claude's category when it's one of our enum values; otherwise use lookup.
      const category = ['revenue','food_cost','staff_cost','other_cost','depreciation','financial'].includes(fromAI)
        ? fromAI
        : looked.category
      const subcategory = looked.subcategory                      // always via lookup for stable naming
      const fortnoxAccount = Number.isFinite(Number(l?.fortnox_account)) ? Number(l.fortnox_account) : null
      return { label_sv: label, category, subcategory, amount, fortnox_account: fortnoxAccount }
    }).filter((l: any) => l.label_sv && Number.isFinite(l.amount))

    const docType = ['pnl_monthly','pnl_annual','invoice','sales','vat'].includes(parsed?.doc_type)
      ? parsed.doc_type
      : 'pnl_monthly'
    const pYear  = Number(parsed?.period?.year)  || null
    const pMonth = docType === 'pnl_annual' ? null : (Number(parsed?.period?.month) || null)

    const extraction = {
      doc_type:      docType,
      period:        { year: pYear, month: pMonth },
      business_hint: parsed?.business_hint ?? null,
      rollup:        {
        revenue:      Number(parsed?.rollup?.revenue     ?? 0) || 0,
        food_cost:    Number(parsed?.rollup?.food_cost   ?? 0) || 0,
        staff_cost:   Number(parsed?.rollup?.staff_cost  ?? 0) || 0,
        other_cost:   Number(parsed?.rollup?.other_cost  ?? 0) || 0,
        depreciation: Number(parsed?.rollup?.depreciation?? 0) || 0,
        financial:    Number(parsed?.rollup?.financial   ?? 0) || 0,
        net_profit:   Number(parsed?.rollup?.net_profit  ?? 0) || 0,
      },
      lines:        enriched,
      confidence:   parsed?.confidence ?? 'medium',
      warnings:     Array.isArray(parsed?.warnings) ? parsed.warnings : [],
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
