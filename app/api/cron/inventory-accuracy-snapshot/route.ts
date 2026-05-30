// app/api/cron/inventory-accuracy-snapshot/route.ts
//
// Daily accuracy snapshot writer (D3 — LEARNING-LOOP-PHASE1-PLAN.md §4).
//
// Schedule (vercel.json): daily at 02:30 UTC — runs BEFORE the audit
// sampler at 03:15 so today's numbers are stable when sampling decisions
// are made.
//
// Per (org, business + a global row per org): fetch the raw counts over
// the trailing 30 days, compute rates via lib/inventory/accuracy.ts,
// compute the baseline (rolling-30-day median of prior snapshots ON OR
// AFTER the BASELINE_ANCHOR_DATE), run the §7.1 floor check, UPSERT one
// row into inventory_accuracy_snapshots.
//
// SEGMENTED — needs_review and audit_sample are computed separately; the
// floor only watches needs_review (§3b.1).
//
// WARM-UP — during the first 30 days post-anchor, real alerts get
// downgraded to 'informational' by accuracy-floor.ts.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { computeRates, countRebateNoise, type RawCounts, type AccuracySnapshot } from '@/lib/inventory/accuracy'
import { checkAgreementFloor, isInWarmup, BASELINE_ANCHOR_DATE } from '@/lib/inventory/accuracy-floor'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const WINDOW_DAYS = 30

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }

async function handle(req: NextRequest) {
  noStore()
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const windowStartIso = new Date(today.getTime() - WINDOW_DAYS * 86_400_000).toISOString()
  const snapshotsWritten: any[] = []

  // ── Pull org list (each org gets per-business rows + a global rollup row)
  const { data: orgs } = await db.from('organisations').select('id, name')
  if (!orgs || orgs.length === 0) {
    return NextResponse.json({ ok: true, ran_at: today.toISOString(), snapshots_written: 0, message: 'no orgs' })
  }

  for (const org of orgs) {
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name, is_active')
      .eq('org_id', org.id)
      .eq('is_active', true)

    // Collect per-business counts first; the global rollup is the SUM
    // across all per-business counts. Cleaner than per-table org-vs-biz
    // branching (product_aliases has no org_id column — see verdict §A4).
    const perBusinessCounts: Array<{ business_id: string; name: string; counts: RawCounts }> = []
    for (const b of (businesses ?? []) as any[]) {
      try {
        const c = await collectRawCounts(db, b.id, windowStartIso)
        perBusinessCounts.push({ business_id: b.id, name: b.name, counts: c })
      } catch (err: any) {
        snapshotsWritten.push({ org: org.name, scope: b.name, error: err?.message ?? String(err) })
      }
    }
    // Build the global rollup as a sum across per-business counts.
    const globalCounts: RawCounts = perBusinessCounts.reduce((acc, p) => {
      for (const k of Object.keys(acc) as Array<keyof RawCounts>) {
        acc[k] = (acc[k] ?? 0) + (p.counts[k] ?? 0)
      }
      return acc
    }, {
      needs_review_outcomes_total: 0, needs_review_outcomes_agreed: 0,
      audit_sample_outcomes_total: 0, audit_sample_outcomes_agreed: 0,
      audit_sample_confirmations: 0,  audit_sample_corrections: 0,
      needs_review_lines_count: 0,    total_lines_in_window: 0,
      demotions_in_window: 0,         active_aliases_window_start: 0,
      ai_create_new_count: 0,         owner_create_new_count: 0,
      rebate_noise_count: 0,
    })

    const targets: Array<{ business_id: string | null; name: string; counts: RawCounts }> = [
      ...perBusinessCounts.map(p => ({ business_id: p.business_id, name: p.name, counts: p.counts })),
      { business_id: null, name: `${org.name} (global)`, counts: globalCounts },
    ]

    for (const target of targets) {
      try {
        const counts = target.counts
        const rates  = computeRates(counts)

        // Baseline — median of prior post-anchor needs_review_agreement_pct
        // values for the same (org, business). Excludes today's row (we're
        // about to write it). business_id NULL needs `.is`; non-null needs `.eq`.
        let baselineQuery = db
          .from('inventory_accuracy_snapshots')
          .select('needs_review_agreement_pct')
          .eq('org_id', org.id)
          .eq('window_days', WINDOW_DAYS)
          .gte('snapshot_date', BASELINE_ANCHOR_DATE)
          .lt('snapshot_date', todayIso)
          .not('needs_review_agreement_pct', 'is', null)
          .order('snapshot_date', { ascending: false })
          .limit(WINDOW_DAYS)
        baselineQuery = target.business_id == null
          ? baselineQuery.is('business_id', null)
          : baselineQuery.eq('business_id', target.business_id)
        const { data: priors } = await baselineQuery

        const baselinePct = medianOrNull((priors ?? []).map((r: any) => r.needs_review_agreement_pct))

        const floor = checkAgreementFloor({
          snapshot_date:                todayIso,
          needs_review_agreement_pct:   rates.needs_review_agreement_pct,
          needs_review_outcomes_total:  rates.needs_review_outcomes_total,
          baseline_pct:                 baselinePct,
        })

        const snapshot: AccuracySnapshot = {
          org_id:        org.id,
          business_id:   target.business_id,
          snapshot_date: todayIso,
          window_days:   WINDOW_DAYS,
          ...rates,
          alert_level:               floor.alert_level,
          alert_reason:              floor.alert_reason,
          baseline_needs_review_pct: floor.baseline_needs_review_pct,
          delta_vs_baseline_pp:      floor.delta_vs_baseline_pp,
        }

        const { error: upErr } = await db
          .from('inventory_accuracy_snapshots')
          .upsert(snapshot, { onConflict: 'org_id,business_id,snapshot_date,window_days' })
        if (upErr) throw new Error(upErr.message)

        snapshotsWritten.push({
          org: org.name, scope: target.name,
          needs_review: rates.needs_review_agreement_pct,
          audit_sample: rates.audit_sample_agreement_pct,
          baseline:     baselinePct,
          alert:        floor.alert_level,
        })
      } catch (err: any) {
        snapshotsWritten.push({ org: org.name, scope: target.name, error: err?.message ?? String(err) })
      }
    }
  }

  return NextResponse.json({
    ok: true,
    ran_at: today.toISOString(),
    in_warmup: isInWarmup(todayIso),
    snapshots_written: snapshotsWritten.length,
    snapshots: snapshotsWritten,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function medianOrNull(values: Array<number | null>): number | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (nums.length === 0) return null
  const mid = Math.floor(nums.length / 2)
  return nums.length % 2 === 0 ? Math.round(((nums[mid - 1] + nums[mid]) / 2) * 10) / 10 : nums[mid]
}

async function collectRawCounts(
  db: any,
  businessId: string,
  windowStartIso: string,
): Promise<RawCounts> {
  // Per-business only. Global rollup is computed by summing per-business
  // counts in the caller — avoids cross-table org_id assumptions
  // (product_aliases has no org_id column per the M075 schema).

  // ── needs_review agreement ─────────────────────────────────────────
  const { data: nrAll } = await db
    .from('inventory_review_outcomes')
    .select('agreed,context,owner_action,ai_action')
    .eq('business_id', businessId)
    .eq('context', 'needs_review')
    .gte('created_at', windowStartIso)
    .limit(5000)
  const nrRows = (nrAll ?? []) as any[]
  const nrTotal  = nrRows.length
  const nrAgreed = nrRows.filter(r => r.agreed === true).length
  const ownerCreateNew = nrRows.filter(r => r.owner_action === 'create_new').length
  const aiCreateNewOnReviewed = nrRows.filter(r => r.ai_action === 'create_new').length

  // AI suggestion count: every AI 'create_new' suggestion in the window
  // (reviewed or not). Larger of (reviewed_subset, all_suggestions) so
  // the divergence calc doesn't artificially compress in the early days
  // when many suggestions are still pending review.
  const { data: aiSugAll } = await db
    .from('inventory_review_suggestions')
    .select('action')
    .eq('business_id', businessId)
    .eq('action', 'create_new')
    .gte('created_at', windowStartIso)
    .limit(5000)
  const aiCreateNewTotal = Math.max((aiSugAll ?? []).length, aiCreateNewOnReviewed)

  // ── audit_sample agreement + precision ─────────────────────────────
  const { data: asAll } = await db
    .from('inventory_review_outcomes')
    .select('agreed,context')
    .eq('business_id', businessId)
    .eq('context', 'audit_sample')
    .gte('created_at', windowStartIso)
    .limit(5000)
  const asRows = (asAll ?? []) as any[]
  const asTotal  = asRows.length
  const asAgreed = asRows.filter(r => r.agreed === true).length

  const { data: aqAll } = await db
    .from('inventory_audit_queue')
    .select('reviewer_decision,reviewed_at')
    .eq('business_id', businessId)
    .not('reviewed_at', 'is', null)
    .gte('reviewed_at', windowStartIso)
    .limit(5000)
  const aqRows = (aqAll ?? []) as any[]
  const asConfirms    = aqRows.filter(r => r.reviewer_decision === 'confirm').length
  const asCorrections = aqRows.filter(r => r.reviewer_decision === 'correct').length

  // ── needs_review queue depth / rate ────────────────────────────────
  const { data: silAll } = await db
    .from('supplier_invoice_lines')
    .select('match_status')
    .eq('business_id', businessId)
    .gte('created_at', windowStartIso)
    .limit(10000)
  const silRows = (silAll ?? []) as any[]
  const totalLines  = silRows.length
  const needsReview = silRows.filter(r => r.match_status === 'needs_review').length

  // ── demotion rate ──────────────────────────────────────────────────
  const { data: demRows } = await db
    .from('product_aliases')
    .select('id')
    .eq('business_id', businessId)
    .gte('deactivated_at', windowStartIso)
    .limit(5000)
  const demotions = (demRows ?? []).length
  const { count: activeNow } = await db
    .from('product_aliases')
    .select('id', { count: 'exact', head: true })
    .eq('business_id', businessId)
    .eq('is_active', true)
  // active_at_window_start = active_now + demotions (re-activations are
  // rare; acceptable v1 approximation per LEARNING-LOOP-PHASE1-PLAN.md §4.2)
  const activeStart = (activeNow ?? 0) + demotions

  // ── rebate noise count ─────────────────────────────────────────────
  const { data: descRows } = await db
    .from('product_aliases')
    .select('raw_description')
    .eq('business_id', businessId)
    .gte('first_seen_at', windowStartIso)
    .limit(5000)
  const rebateNoise = countRebateNoise(((descRows ?? []) as any[]).map(r => r.raw_description))

  return {
    needs_review_outcomes_total:  nrTotal,
    needs_review_outcomes_agreed: nrAgreed,
    audit_sample_outcomes_total:  asTotal,
    audit_sample_outcomes_agreed: asAgreed,
    audit_sample_confirmations:   asConfirms,
    audit_sample_corrections:     asCorrections,
    needs_review_lines_count:     needsReview,
    total_lines_in_window:        totalLines,
    demotions_in_window:          demotions,
    active_aliases_window_start:  activeStart,
    ai_create_new_count:          aiCreateNewTotal,
    owner_create_new_count:       ownerCreateNew,
    rebate_noise_count:           rebateNoise,
  }
}
