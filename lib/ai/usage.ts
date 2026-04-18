// lib/ai/usage.ts
// Shared daily AI-query limit guard.
// Use from any API route that calls Claude (ask, budget generate, budget analyse, …)
// so every AI call counts against the org's daily plan limit uniformly.
//
// Flow:
//   1. const gate = await checkAiLimit(db, orgId, plan)
//      if (!gate.ok) return NextResponse.json({ ...gate.body }, { status: 429 })
//   2. call Claude
//   3. await incrementAiUsage(db, orgId)
//
// All schema: ai_usage_daily (org_id, date, query_count), upsert via RPC increment_ai_usage
// with manual upsert fallback.

import { getPlan } from '@/lib/stripe/config'

type Db = any  // the Supabase admin client — kept loose so we don't force an import here

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface LimitGateOk {
  ok: true
  limit: number
  used:  number
}
export interface LimitGateBlocked {
  ok: false
  status: 429
  body: {
    error:   string
    limit:   number
    used:    number
    plan:    string
    upgrade: true
  }
}
export type LimitGate = LimitGateOk | LimitGateBlocked

// Hard safety cap on "unlimited" plans (Group / Enterprise). The published
// promise is unlimited, but a single runaway script or bad prompt loop could
// burn hundreds of Sonnet calls in a minute. 500/day/org is 5× what a heavy
// user realistically needs and keeps worst-case cost bounded (~$6/day per
// org at Sonnet, ~$1 at Haiku).
const UNLIMITED_SAFETY_CAP_PER_DAY = 500

// Check whether this org can make another AI call today. Does NOT increment.
// Unlimited plans (Group / Enterprise / anything with ai_queries_per_day === Infinity)
// use the safety cap above rather than truly unlimited.
// If planKey is omitted, looks it up from organisations.plan.
export async function checkAiLimit(db: Db, orgId: string, planKey?: string): Promise<LimitGate> {
  let effectivePlanKey: string = planKey ?? 'trial'
  if (!planKey) {
    const { data } = await db.from('organisations').select('plan').eq('id', orgId).maybeSingle()
    effectivePlanKey = data?.plan ?? 'trial'
  }
  const plan        = getPlan(effectivePlanKey)
  const rawLimit    = plan.ai_queries_per_day
  const isUnlimited = !rawLimit || rawLimit === Infinity
  const limit       = isUnlimited ? UNLIMITED_SAFETY_CAP_PER_DAY : rawLimit

  const { data: usage } = await db
    .from('ai_usage_daily')
    .select('query_count')
    .eq('org_id', orgId)
    .eq('date', today())
    .maybeSingle()

  const used = usage?.query_count ?? 0

  if (used >= limit) {
    return {
      ok:     false,
      status: 429,
      body: {
        error:   'Daily AI query limit reached',
        limit,
        used,
        plan:    effectivePlanKey,
        upgrade: true,
      },
    }
  }

  return { ok: true, limit, used }
}

// Bump the daily counter. Safe to call after the AI call succeeds.
// Uses the increment_ai_usage RPC when available, falls back to manual upsert.
export async function incrementAiUsage(db: Db, orgId: string): Promise<void> {
  const d = today()
  try {
    const rpc = await db.rpc('increment_ai_usage', { p_org_id: orgId, p_date: d })
    if (!rpc.error) return
    // If the RPC errors (not deployed yet, or wrong signature), fall through to upsert
  } catch { /* fall through */ }

  // Manual fallback: try to increment an existing row, else insert a fresh one at 1.
  // Not strictly atomic, but daily-counter drift is acceptable.
  const { data: existing } = await db
    .from('ai_usage_daily')
    .select('id, query_count')
    .eq('org_id', orgId)
    .eq('date', d)
    .maybeSingle()

  if (existing) {
    await db.from('ai_usage_daily')
      .update({ query_count: (existing.query_count ?? 0) + 1 })
      .eq('id', existing.id)
  } else {
    await db.from('ai_usage_daily').insert({ org_id: orgId, date: d, query_count: 1 })
  }
}
