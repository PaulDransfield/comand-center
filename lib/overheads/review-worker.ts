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
}

export interface ReviewResult {
  flags_written:        number
  suppliers_processed:  number
  skipped_essential:    number
  errors:               string[]
}

export async function runOverheadReview(args: ReviewArgs): Promise<ReviewResult> {
  const { orgId, businessId, year, month, uploadId, db } = args
  const out: ReviewResult = {
    flags_written: 0, suppliers_processed: 0, skipped_essential: 0, errors: [],
  }

  // ── 1. Load this period's other_cost line items ─────────────────────────
  const { data: lines, error: linesErr } = await db
    .from('tracker_line_items')
    .select('id, label_sv, label_en, amount, fortnox_account')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('period_year',  year)
    .eq('period_month', month)
    .eq('category',     'other_cost')

  if (linesErr) {
    out.errors.push(`load lines: ${linesErr.message}`)
    return out
  }
  if (!lines || lines.length === 0) return out

  // ── 2. Group by normalised label, sum amounts, capture line ids ─────────
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
  const monthOverheadTotal = Array.from(grouped.values()).reduce((s, g) => s + g.amount, 0)

  // ── 3. Load classifications for this business (one round-trip) ──────────
  const { data: classifs, error: cErr } = await db
    .from('overhead_classifications')
    .select('supplier_name_normalised, status, baseline_avg_sek')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
  if (cErr) {
    out.errors.push(`load classifications: ${cErr.message}`)
    return out
  }
  const classMap = new Map<string, { status: string; baseline: number | null }>()
  for (const c of (classifs ?? []) as any[]) {
    classMap.set(c.supplier_name_normalised, {
      status:   c.status,
      baseline: c.baseline_avg_sek != null ? Number(c.baseline_avg_sek) : null,
    })
  }

  // ── 4. Load 13 months of history for baseline + history checks ──────────
  // Pull current year + prior, then filter in JS to the rolling 12-month
  // window ending at (year, month-1). Single query is cheaper than
  // composite-key range filtering through PostgREST.
  const { data: history, error: hErr } = await db
    .from('tracker_line_items')
    .select('label_sv, label_en, amount, period_year, period_month, fortnox_account')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('category', 'other_cost')
    .gte('period_year', year - 1)
    .lte('period_year', year)
    .limit(20_000)
  if (hErr) {
    out.errors.push(`load history: ${hErr.message}`)
    return out
  }

  // historyMap[normKey] = list of { year, month, amount } for rolling 12 mo.
  const historyMap = new Map<string, Array<{ year: number; month: number; amount: number }>>()
  for (const ln of (history ?? []) as any[]) {
    // Exclude the current period — that's what we're flagging against.
    if (ln.period_year === year && ln.period_month === month) continue
    // Keep only rows in the rolling 12-month window ending at (year, month-1).
    if (ln.period_year === year - 1 && ln.period_month < month) continue
    if (ln.period_year === year     && ln.period_month >= month) continue

    const display = pickDisplayLabel(ln)
    const key     = normaliseSupplier(display)
    if (!key) continue
    const list = historyMap.get(key) ?? []
    list.push({ year: ln.period_year, month: ln.period_month, amount: Number(ln.amount ?? 0) })
    historyMap.set(key, list)
  }

  // ── 5. Apply rules per supplier ─────────────────────────────────────────
  for (const [normKey, agg] of grouped) {
    // Skip refunds / credits / zero-amount lines — they're not overspend.
    if (agg.amount <= 0) continue
    // Skip noise on tiny lines (cleaning supplies for 50 kr that swing 200%
    // are not material to a restaurant's bottom line).
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
      // No prior decision — figure out which "first-look" flag fits best.
      if (nonZeroHist.length === 0) {
        // Truly new label or one-off
        if (agg.amount > monthOverheadTotal * ONE_OFF_HIGH_PCT) {
          flagType = 'one_off_high'
          reason   = `One-off charge ≥${Math.round(ONE_OFF_HIGH_PCT * 100)}% of overheads, no prior history.`
        } else {
          flagType = 'new_supplier'
          reason   = 'First time this line has appeared.'
        }
      } else if (
        priorAvg
        && Math.abs(agg.amount - priorAvg) / priorAvg > PRICE_SPIKE_THRESHOLD * VOLATILE_MULTIPLIER
        && Math.abs(agg.amount - priorAvg) >= MIN_VOLATILE_DIFF_SEK
      ) {
        // Recurring but volatile AND the absolute change is material — surface
        // it. The MIN_VOLATILE_DIFF_SEK floor stops "200 → 600 (+200%)" noise.
        flagType = 'price_spike'
        reason   = `Volatile cost: 12-mo avg ${Math.round(priorAvg)} kr vs ${Math.round(agg.amount)} kr now.`
      } else {
        // Recurring spend the owner has never decided about.
        flagType = 'new_supplier'
        reason   = 'Recurring spend not yet reviewed.'
      }
    } else if (classification.status === 'essential') {
      // Compare to the snapshot taken at decision time, falling back to history.
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
      // Owner planned to cancel; supplier still appearing.
      flagType = 'dismissed_reappeared'
      reason   = `Was marked plan-to-cancel; still in books at ${Math.round(agg.amount)} kr/mo.`
    }

    if (!flagType) continue

    const { error: insErr } = await db.from('overhead_flags').insert({
      org_id:                   orgId,
      business_id:              businessId,
      source_upload_id:         uploadId ?? null,
      line_item_id:             agg.lineIds[0],
      supplier_name:            agg.display,
      supplier_name_normalised: normKey,
      flag_type:                flagType,
      reason,
      amount_sek:               Math.round(agg.amount * 100) / 100,
      prior_avg_sek:            priorAvg != null ? Math.round(priorAvg * 100) / 100 : null,
      period_year:              year,
      period_month:             month,
    })
    if (insErr) {
      // Idempotent re-run: UNIQUE violation = already flagged. Swallow.
      if (insErr.code !== '23505') {
        out.errors.push(`insert ${normKey}: ${insErr.message}`)
      }
    } else {
      out.flags_written++
    }
  }

  return out
}
