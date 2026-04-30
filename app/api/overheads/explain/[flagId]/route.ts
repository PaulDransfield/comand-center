// app/api/overheads/explain/[flagId]/route.ts
//
// On-demand "Explain this" endpoint for a single overhead flag. Re-runs
// the Sonnet pass for one flag with full context — 12-month history for
// the supplier, current benchmarks, business profile — and overwrites
// the persisted ai_explanation + ai_confidence.
//
// Used by the "Re-explain" button on /overheads/review when the owner
// wants fresh reasoning (e.g. after benchmarks have updated, or after
// they've made other decisions that change the savings landscape).
//
// Why a separate endpoint vs reusing the worker pass: the worker pass
// runs in a batch with no per-flag history. This one loads the supplier's
// 12-month line-item rows so Claude can see the trend, not just the
// current spike.
//
// POST /api/overheads/explain/<flagId>  → { ai_explanation, ai_confidence }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { explainOverheadFlags } from '@/lib/overheads/ai-explanation'
import { normaliseSupplier, pickDisplayLabel } from '@/lib/overheads/normalise'
import { requireFinanceAccess, requireBusinessAccess } from '@/lib/auth/require-role'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest, { params }: { params: { flagId: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  const finForbidden = requireFinanceAccess(auth); if (finForbidden) return finForbidden

  const { flagId } = params
  if (!flagId) return NextResponse.json({ error: 'flagId required' }, { status: 400 })

  const db = createAdminClient()

  // Load + scope the flag.
  const { data: flag, error: fErr } = await db
    .from('overhead_flags')
    .select('id, org_id, business_id, supplier_name, supplier_name_normalised, flag_type, reason, amount_sek, prior_avg_sek, period_year, period_month, resolution_status')
    .eq('id', flagId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (fErr)  return NextResponse.json({ error: fErr.message }, { status: 500 })
  if (!flag) return NextResponse.json({ error: 'flag not found in your org' }, { status: 404 })
  // M043: scope-check after load — manager assigned to specific businesses
  // can only re-explain flags for those.
  const bizForbidden = requireBusinessAccess(auth, flag.business_id); if (bizForbidden) return bizForbidden

  // Business profile for context.
  const { data: biz } = await db
    .from('businesses')
    .select('name')
    .eq('id', flag.business_id)
    .maybeSingle()

  const { data: rollup } = await db
    .from('tracker_data')
    .select('other_cost')
    .eq('org_id', auth.orgId)
    .eq('business_id', flag.business_id)
    .eq('period_year',  flag.period_year)
    .eq('period_month', flag.period_month)
    .maybeSingle()

  // Industry benchmarks (best-effort).
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
  } catch { /* benchmarks missing — fine */ }

  // 12-month history for the supplier — gives Claude a trend instead of a
  // single spike. Approx-match against label by normalised name.
  const supplierHistory: Array<{ year: number; month: number; amount: number }> = []
  try {
    const startYear  = flag.period_year - 1
    const { data: hist } = await db
      .from('tracker_line_items')
      .select('label_sv, label_en, amount, period_year, period_month, fortnox_account')
      .eq('org_id', auth.orgId)
      .eq('business_id', flag.business_id)
      .eq('category', 'other_cost')
      .gte('period_year', startYear)
      .lte('period_year', flag.period_year)
      .limit(2_000)
    for (const ln of (hist ?? []) as any[]) {
      const label = pickDisplayLabel(ln)
      const norm  = normaliseSupplier(label)
      if (norm !== flag.supplier_name_normalised) continue
      supplierHistory.push({
        year:   ln.period_year,
        month:  ln.period_month,
        amount: Number(ln.amount ?? 0),
      })
    }
  } catch { /* history failure — fall back to without */ }

  // Trim to most-recent 18 entries to fit the budget.
  const trimmedHistory = supplierHistory
    .sort((a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month))
    .slice(0, 18)

  // The AI function takes a flat list. Add a synthetic context line as a
  // pseudo-flag so the prompt picks up the history without the function
  // signature changing. (Kept compact — repurposing the rule_reason slot.)
  const historySummary = trimmedHistory.length > 0
    ? ` | history: ${trimmedHistory.map(h => `${h.year}-${String(h.month).padStart(2,'0')}=${Math.round(h.amount)}`).join(', ')}`
    : ''

  const explanations = await explainOverheadFlags({
    db,
    orgId: auth.orgId,
    flags: [{
      ...flag,
      reason: (flag.reason ?? '') + historySummary,
    }],
    business: {
      business_name:       biz?.name ?? 'this business',
      total_overheads_sek: rollup?.other_cost ? Number(rollup.other_cost) : undefined,
      benchmarks:          Object.keys(benchmarks).length > 0 ? benchmarks : undefined,
    },
  })

  if (explanations.length === 0) {
    return NextResponse.json({
      error: 'AI explain failed — try again in a moment',
    }, { status: 503 })
  }

  const ex = explanations[0]
  await db.from('overhead_flags')
    .update({ ai_explanation: ex.explanation, ai_confidence: ex.confidence })
    .eq('id', flagId)
    .eq('org_id', auth.orgId)

  return NextResponse.json({
    ai_explanation: ex.explanation,
    ai_confidence:  ex.confidence,
    history_points: trimmedHistory.length,
    used_benchmarks: Object.keys(benchmarks).length > 0,
  })
}
