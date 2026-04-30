// lib/overheads/review-worker.ts
//
// Detection worker for the overhead-review feature. Called from
// /api/fortnox/apply (waitUntil — best effort, doesn't block the apply
// response) once per applied period. No AI in PR 2 — pure rules.
// AI explanation pass lands in PR 4.
//
// Detection rules:
//   - new_supplier         → first time this line label appears (no history,
//                            no classification)
//   - price_spike          → essential supplier whose current amount is
//                            >15% above baseline_avg_sek (or, if no baseline
//                            yet, the 12-month non-zero average)
//   - dismissed_reappeared → owner previously dismissed this supplier; it
//                            still shows up in this period's books
//   - one_off_high         → ≥5% of monthly overhead total AND no prior
//                            occurrence in 12 months
//
// Idempotency: every insert uses the (business_id, source_upload_id,
// supplier_name_normalised, flag_type) UNIQUE constraint — re-running the
// worker on the same upload writes nothing new.
//
// Cleanup: when an upload is superseded, the new apply replaces line
// items via DELETE-by-source_upload_id (existing M028 logic). The
// ON DELETE CASCADE on overhead_flags.line_item_id auto-cleans the old
// flags. No app-side cleanup needed here.

import { normaliseSupplier, pickDisplayLabel } from './normalise'

const PRICE_SPIKE_THRESHOLD = 0.15  // 15% above baseline triggers re-flag
const ONE_OFF_HIGH_PCT      = 0.05  // single line ≥5% of monthly overheads
const VOLATILE_MULTIPLIER   = 2     // unclassified swing > 30% (PRICE_SPIKE × 2)
const MIN_FLAG_AMOUNT_SEK   = 500   // don't flag noise on tiny absolute amounts
const MIN_VOLATILE_DIFF_SEK = 1500  // volatility flag only if absolute change matters

export interface ReviewArgs {
  orgId:      string
  businessId: string
  year:       number
  month:      number
  uploadId?:  string | null
  db:         any  // Supabase admin client
  /** Categories to scan. Defaults to both — extension from M041 onwards.
   *  Existing callers don't supply this and get the full sweep. */
  categories?: Array<'other_cost' | 'food_cost'>
}

export interface ReviewResult {
  flags_written:        number
  suppliers_processed:  number
  skipped_essential:    number
  errors:               string[]
}

const DEFAULT_CATEGORIES: Array<'other_cost' | 'food_cost'> = ['other_cost', 'food_cost']

export async function runOverheadReview(args: ReviewArgs): Promise<ReviewResult> {
  const { orgId, businessId, year, month, uploadId, db } = args
  const categories = args.categories ?? DEFAULT_CATEGORIES
  const out: ReviewResult = {
    flags_written: 0, suppliers_processed: 0, skipped_essential: 0, errors: [],
  }

  // Run the detection sweep per category. Each category has its own
  // classification + history scoping (M041 added category to both natural
  // keys), so a "Konsultarvoden" classified essential as other_cost doesn't
  // accidentally suppress an unrelated Konsultarvoden line under food_cost.
  for (const category of categories) {
    const partial = await detectForCategory(db, orgId, businessId, year, month, uploadId ?? null, category)
    out.flags_written       += partial.flags_written
    out.suppliers_processed += partial.suppliers_processed
    out.skipped_essential   += partial.skipped_essential
    out.errors.push(...partial.errors)
  }

  // ── 6. AI explanation pass (PR 4) ───────────────────────────────────────
  // Single Sonnet call per period that fills ai_explanation + ai_confidence
  // for every flag we just wrote (or any pending flag still missing one).
  // Best-effort — if the AI call fails or times out, the flags stay
  // explanation-less and the rule reason is the only context the owner
  // sees. The `reason` field is already human-readable; the AI just adds
  // colour.
  try {
    await runExplanationPass(db, orgId, businessId, year, month)
  } catch (e: any) {
    console.warn('[overhead-review] explanation pass failed:', e?.message)
  }

  return out
}

// ── Per-category detection ──────────────────────────────────────────────────
// One pass through tracker_line_items for a single category, applying the
// rule engine and writing flags tagged with that category. Same logic that
// pre-M041 ran inline against 'other_cost'; now parameterised so 'food_cost'
// gets the same treatment.
async function detectForCategory(
  db:          any,
  orgId:       string,
  businessId:  string,
  year:        number,
  month:       number,
  uploadId:    string | null,
  category:    'other_cost' | 'food_cost',
): Promise<ReviewResult> {
  const out: ReviewResult = {
    flags_written: 0, suppliers_processed: 0, skipped_essential: 0, errors: [],
  }

  // 1. Load this period's line items for the category.
  const { data: lines, error: linesErr } = await db
    .from('tracker_line_items')
    .select('id, label_sv, label_en, amount, fortnox_account')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('period_year',  year)
    .eq('period_month', month)
    .eq('category',     category)
  if (linesErr) {
    out.errors.push(`[${category}] load lines: ${linesErr.message}`)
    return out
  }
  if (!lines || lines.length === 0) return out

  // 2. Group by normalised label, sum, capture line ids.
  type SupplierAgg = { display: string; amount: number; lineIds: string[] }
  const grouped = new Map<string, SupplierAgg>()
  for (const ln of lines as any[]) {
    const display = pickDisplayLabel(ln)
    const key     = normaliseSupplier(display)
    if (!key) continue
    const cur = grouped.get(key) ?? { display, amount: 0, lineIds: [] }
    cur.amount += Number(ln.amount ?? 0)
    cur.lineIds.push(ln.id)
    grouped.set(key, cur)
  }
  out.suppliers_processed = grouped.size
  if (grouped.size === 0) return out
  const monthCategoryTotal = Array.from(grouped.values()).reduce((s, g) => s + g.amount, 0)

  // 3. Classifications scoped to this category.
  const { data: classifs, error: cErr } = await db
    .from('overhead_classifications')
    .select('supplier_name_normalised, status, baseline_avg_sek')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('category', category)
  if (cErr) {
    out.errors.push(`[${category}] load classifications: ${cErr.message}`)
    return out
  }
  const classMap = new Map<string, { status: string; baseline: number | null }>()
  for (const c of (classifs ?? []) as any[]) {
    classMap.set(c.supplier_name_normalised, {
      status:   c.status,
      baseline: c.baseline_avg_sek != null ? Number(c.baseline_avg_sek) : null,
    })
  }

  // 4. Rolling 12-month history for baseline checks (this category only).
  const { data: history, error: hErr } = await db
    .from('tracker_line_items')
    .select('label_sv, label_en, amount, period_year, period_month, fortnox_account')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('category', category)
    .gte('period_year', year - 1)
    .lte('period_year', year)
    .limit(20_000)
  if (hErr) {
    out.errors.push(`[${category}] load history: ${hErr.message}`)
    return out
  }

  const historyMap = new Map<string, Array<{ year: number; month: number; amount: number }>>()
  for (const ln of (history ?? []) as any[]) {
    if (ln.period_year === year && ln.period_month === month) continue
    if (ln.period_year === year - 1 && ln.period_month < month) continue
    if (ln.period_year === year     && ln.period_month >= month) continue
    const display = pickDisplayLabel(ln)
    const key     = normaliseSupplier(display)
    if (!key) continue
    const list = historyMap.get(key) ?? []
    list.push({ year: ln.period_year, month: ln.period_month, amount: Number(ln.amount ?? 0) })
    historyMap.set(key, list)
  }

  // 5. Apply rules per supplier.
  for (const [normKey, agg] of grouped) {
    if (agg.amount <= 0) continue
    if (agg.amount < MIN_FLAG_AMOUNT_SEK) continue

    const classification = classMap.get(normKey)
    const histRows       = historyMap.get(normKey) ?? []
    const nonZeroHist    = histRows.filter(h => h.amount > 0)
    const priorAvg       = nonZeroHist.length > 0
      ? nonZeroHist.reduce((s, h) => s + h.amount, 0) / nonZeroHist.length
      : null

    let flagType: string | null = null
    let reason   = ''

    if (!classification) {
      if (nonZeroHist.length === 0) {
        if (agg.amount > monthCategoryTotal * ONE_OFF_HIGH_PCT) {
          flagType = 'one_off_high'
          reason   = `One-off charge ≥${Math.round(ONE_OFF_HIGH_PCT * 100)}% of ${category === 'food_cost' ? 'food costs' : 'overheads'}, no prior history.`
        } else {
          flagType = 'new_supplier'
          reason   = 'First time this line has appeared.'
        }
      } else if (
        priorAvg
        && Math.abs(agg.amount - priorAvg) / priorAvg > PRICE_SPIKE_THRESHOLD * VOLATILE_MULTIPLIER
        && Math.abs(agg.amount - priorAvg) >= MIN_VOLATILE_DIFF_SEK
      ) {
        flagType = 'price_spike'
        reason   = `Volatile cost: 12-mo avg ${Math.round(priorAvg)} kr vs ${Math.round(agg.amount)} kr now.`
      } else {
        flagType = 'new_supplier'
        reason   = 'Recurring spend not yet reviewed.'
      }
    } else if (classification.status === 'essential') {
      const baseline = classification.baseline ?? priorAvg
      if (baseline && agg.amount > baseline * (1 + PRICE_SPIKE_THRESHOLD)
                   && (agg.amount - baseline) >= MIN_VOLATILE_DIFF_SEK) {
        const pct = Math.round(((agg.amount - baseline) / baseline) * 100)
        flagType = 'price_spike'
        reason   = `Up ${pct}% vs baseline (${Math.round(baseline)} kr).`
      } else {
        out.skipped_essential++
      }
    } else if (classification.status === 'dismissed') {
      flagType = 'dismissed_reappeared'
      reason   = `Was marked plan-to-cancel; still in books at ${Math.round(agg.amount)} kr/mo.`
    }

    if (!flagType) continue

    const { error: insErr } = await db.from('overhead_flags').insert({
      org_id:                   orgId,
      business_id:              businessId,
      source_upload_id:         uploadId,
      line_item_id:             agg.lineIds[0],
      supplier_name:            agg.display,
      supplier_name_normalised: normKey,
      category,
      flag_type:                flagType,
      reason,
      amount_sek:               Math.round(agg.amount * 100) / 100,
      prior_avg_sek:            priorAvg != null ? Math.round(priorAvg * 100) / 100 : null,
      period_year:              year,
      period_month:             month,
    })
    if (insErr) {
      if (insErr.code !== '23505') {
        out.errors.push(`[${category}] insert ${normKey}: ${insErr.message}`)
      }
    } else {
      out.flags_written++
    }
  }

  return out
}

// ── AI explanation pass ─────────────────────────────────────────────────────
async function runExplanationPass(
  db: any,
  orgId: string,
  businessId: string,
  year: number,
  month: number,
): Promise<void> {
  // Find pending flags for this period that don't have an explanation yet.
  const { data: needsExplanation, error: fErr } = await db
    .from('overhead_flags')
    .select('id, supplier_name, flag_type, reason, amount_sek, prior_avg_sek, period_year, period_month')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('period_year',  year)
    .eq('period_month', month)
    .eq('resolution_status', 'pending')
    .is('ai_explanation', null)
    .limit(50)
  if (fErr || !needsExplanation || needsExplanation.length === 0) return

  // Pull business name + monthly overhead total for context.
  const { data: biz } = await db
    .from('businesses')
    .select('name')
    .eq('id', businessId)
    .maybeSingle()

  const { data: rollup } = await db
    .from('tracker_data')
    .select('other_cost')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('period_year',  year)
    .eq('period_month', month)
    .maybeSingle()

  // Load industry benchmarks (anonymised peer medians per subcategory) so
  // the AI can say "Lokalhyra at 250k is 40% above the Stockholm median"
  // when relevant. Best-effort: if the table doesn't exist or is empty
  // we just skip benchmark context.
  let benchmarks: Record<string, { median_kr: number; sample_size: number }> = {}
  try {
    const { data: benchRows } = await db
      .from('industry_benchmarks')
      .select('subcategory, median_kr, sample_size')
    for (const b of (benchRows ?? []) as any[]) {
      if (b?.subcategory && Number.isFinite(Number(b.median_kr))) {
        benchmarks[b.subcategory] = {
          median_kr:   Number(b.median_kr),
          sample_size: Number(b.sample_size ?? 0),
        }
      }
    }
  } catch { /* table missing — fine */ }

  const { explainOverheadFlags } = await import('./ai-explanation')
  const { resolveLocaleForOrg }  = await import('@/lib/ai/locale')
  // Worker context — no request cookie, so look up the owner's saved
  // locale from organisation_members. Falls through to en-GB if absent.
  const ownerLocale = await resolveLocaleForOrg(db, orgId)
  const explanations = await explainOverheadFlags({
    db,
    orgId,
    flags:    needsExplanation,
    business: {
      business_name:        biz?.name ?? 'this business',
      total_overheads_sek:  rollup?.other_cost ? Number(rollup.other_cost) : undefined,
      benchmarks:           Object.keys(benchmarks).length > 0 ? benchmarks : undefined,
    },
    locale:   ownerLocale,
  })
  if (explanations.length === 0) return

  // Apply each explanation. Sequential is fine — there are <= 50 of them.
  for (const ex of explanations) {
    await db.from('overhead_flags')
      .update({
        ai_explanation: ex.explanation,
        ai_confidence:  ex.confidence,
      })
      .eq('id', ex.flag_id)
      .eq('org_id', orgId)
      .is('ai_explanation', null)   // don't overwrite a manual edit
  }
}
