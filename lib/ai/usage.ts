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
import { calcCostUsd, usdToSek } from '@/lib/ai/cost'

type Db = any  // the Supabase admin client — kept loose so we don't force an import here

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export interface LimitGateOk {
  ok: true
  limit:    number
  used:     number
  booster:  number   // extra queries unlocked by active AI Boosters
  warning?: {         // present when used is ≥ 80 % of limit
    used:    number
    limit:   number
    percent: number
  }
}
export interface LimitGateBlocked {
  ok: false
  status: 429
  body: {
    error:   string
    limit:   number
    used:    number
    plan:    string
    booster: number
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

// Approaching-limit warning threshold — we return a warning (not a block) when
// used/limit reaches this fraction. UI can show a banner.
const WARNING_THRESHOLD = 0.80

// Compute the org's effective daily limit including any active AI Boosters.
// Returns { base, booster, total } so the response can attribute the extra
// capacity to the Booster purchase (useful for admin visibility).
export async function getEffectiveDailyLimit(
  db:    Db,
  orgId: string,
  planKey: string,
): Promise<{ base: number; booster: number; total: number; isUnlimited: boolean }> {
  const plan        = getPlan(planKey)
  const rawLimit    = plan.ai_queries_per_day
  const isUnlimited = !rawLimit || rawLimit === Infinity
  const base        = isUnlimited ? UNLIMITED_SAFETY_CAP_PER_DAY : rawLimit

  // Sum every active booster whose period covers today.
  const d = today()
  const { data: boosters } = await db
    .from('ai_booster_purchases')
    .select('extra_queries_per_day')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .lte('period_start', d)
    .gte('period_end',   d)

  const booster = (boosters ?? []).reduce((s: number, b: any) => s + (b.extra_queries_per_day ?? 0), 0)

  return { base, booster, total: base + booster, isUnlimited }
}

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

  const { total: limit, booster } = await getEffectiveDailyLimit(db, orgId, effectivePlanKey)

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
        booster,
        upgrade: true,
      },
    }
  }

  const warning = (used / limit) >= WARNING_THRESHOLD
    ? { used, limit, percent: Math.round((used / limit) * 100) }
    : undefined

  return { ok: true, limit, used, booster, warning }
}

/**
 * Log a single Claude request — tokens in/out, model, page, duration, cost.
 * Source of truth for per-query auditing and cost analysis.
 * Non-fatal: logs to console if insert fails, never throws.
 *
 * Also increments ai_usage_daily_by_user so admin can see per-user attribution.
 */
export async function logAiRequest(db: Db, params: {
  org_id:            string
  user_id?:          string
  request_type:      string     // 'ask' | 'budget_generate' | 'budget_analyse' | 'anomaly_explain' | agent name
  model:             string
  tier?:             string     // 'light' | 'full' for /api/ask, else omit
  page?:             string
  question_preview?: string     // first 100 chars, NOT the full question
  input_tokens:      number
  output_tokens:     number
  duration_ms?:      number
}): Promise<void> {
  const input  = params.input_tokens  || 0
  const output = params.output_tokens || 0
  const cost_usd = calcCostUsd(params.model, input, output)
  const cost_sek = usdToSek(cost_usd)

  try {
    await db.from('ai_request_log').insert({
      org_id:           params.org_id,
      user_id:          params.user_id ?? null,
      request_type:     params.request_type,
      model:            params.model,
      tier:             params.tier ?? null,
      page:             params.page ?? null,
      question_preview: params.question_preview ? params.question_preview.slice(0, 100) : null,
      input_tokens:     input,
      output_tokens:    output,
      total_cost_usd:   cost_usd,
      cost_sek,
      duration_ms:      params.duration_ms ?? null,
    })
  } catch (e: any) {
    console.error('[ai] log insert failed:', e?.message || e)
  }

  // Per-user daily aggregate (optional — only if user_id supplied)
  if (params.user_id) {
    const d = today()
    try {
      const { data: existing } = await db
        .from('ai_usage_daily_by_user')
        .select('id, query_count, cost_usd, cost_sek')
        .eq('org_id', params.org_id)
        .eq('user_id', params.user_id)
        .eq('date', d)
        .maybeSingle()

      if (existing) {
        await db.from('ai_usage_daily_by_user').update({
          query_count: (existing.query_count ?? 0) + 1,
          cost_usd:    Number(existing.cost_usd ?? 0) + cost_usd,
          cost_sek:    Number(existing.cost_sek ?? 0) + cost_sek,
          updated_at:  new Date().toISOString(),
        }).eq('id', existing.id)
      } else {
        await db.from('ai_usage_daily_by_user').insert({
          org_id:      params.org_id,
          user_id:     params.user_id,
          date:        d,
          query_count: 1,
          cost_usd,
          cost_sek,
        })
      }
    } catch (e: any) {
      console.error('[ai] per-user usage update failed:', e?.message || e)
    }
  }
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
