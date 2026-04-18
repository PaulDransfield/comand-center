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
  limit:        number
  used:         number
  booster:      number
  monthly_used_sek?: number
  monthly_ceiling_sek?: number
  warning?: {         // present when used is ≥ 80 % of daily limit
    used:    number
    limit:   number
    percent: number
  }
}
// Three distinct block reasons so the UI can give the right call-to-action.
export interface LimitGateBlocked {
  ok: false
  status: 429 | 503
  body: {
    error:        string
    reason:       'daily_cap' | 'monthly_ceiling' | 'global_kill_switch'
    // daily_cap: user hit their per-day quota — CTA: Upgrade or buy Booster
    // monthly_ceiling: org hit per-plan monthly cost ceiling — CTA: contact support
    // global_kill_switch: every AI call paused company-wide — CTA: try later
    limit?:       number
    used?:        number
    plan?:        string
    booster?:     number
    upgrade?:     boolean
    contact_support?: boolean
  }
}
export type LimitGate = LimitGateOk | LimitGateBlocked

// ── Monthly cost ceilings per plan, in SEK ───────────────────────────────────
// Set above a typical-month COGS so only runaway usage trips them. Acts as
// a backstop when the daily cap + model tiering aren't enough.
// Reviewed against pricing sheet 2026-04-18.
const MONTHLY_COST_CEILING_SEK: Record<string, number> = {
  trial:      30,
  starter:    60,
  pro:       150,
  group:     500,
  enterprise: 1500,
}
function monthlyCeilingFor(planKey: string): number {
  return MONTHLY_COST_CEILING_SEK[planKey] ?? MONTHLY_COST_CEILING_SEK.trial
}

// ── Global daily kill-switch ─────────────────────────────────────────────────
// If total Claude spend across ALL orgs in the last 24 h exceeds this cap,
// every AI call is blocked until the rolling window drops back below. Covers
// exploited endpoints, runaway scripts, prompt injection attacks. Env-configurable.
function globalDailyCapUsd(): number {
  const raw = parseFloat(process.env.MAX_DAILY_GLOBAL_USD ?? '50')
  return Number.isFinite(raw) && raw > 0 ? raw : 50
}

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

  // Gate 1 — global kill-switch. Stops all AI company-wide when 24 h spend
  // exceeds MAX_DAILY_GLOBAL_USD. Cheapest check, run first.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: globalRows } = await db
    .from('ai_request_log')
    .select('total_cost_usd')
    .gte('created_at', since)
  const globalSpend = (globalRows ?? []).reduce((s: number, r: any) => s + Number(r.total_cost_usd ?? 0), 0)
  const globalCap   = globalDailyCapUsd()
  if (globalSpend >= globalCap) {
    return {
      ok:     false,
      status: 503,
      body: {
        error:           'AI temporarily paused across CommandCenter — please try again shortly.',
        reason:          'global_kill_switch',
        contact_support: true,
      },
    }
  }

  // Gate 2 — per-plan monthly cost ceiling. Sum cost_sek for the current
  // calendar month; if over, block with a contact-support message.
  const monthStart = new Date()
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0)
  const { data: monthRows } = await db
    .from('ai_request_log')
    .select('cost_sek')
    .eq('org_id', orgId)
    .gte('created_at', monthStart.toISOString())
  const monthSpendSek = (monthRows ?? []).reduce((s: number, r: any) => s + Number(r.cost_sek ?? 0), 0)
  const monthCeiling  = monthlyCeilingFor(effectivePlanKey)
  if (monthSpendSek >= monthCeiling) {
    return {
      ok:     false,
      status: 429,
      body: {
        error:           'Monthly AI cost ceiling reached. Please contact support to review usage.',
        reason:          'monthly_ceiling',
        plan:            effectivePlanKey,
        used:            Math.round(monthSpendSek),
        limit:           monthCeiling,
        contact_support: true,
      },
    }
  }

  // Gate 3 — per-day query cap (the normal "you've used your quota" gate).
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
        reason:  'daily_cap',
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

  return {
    ok: true,
    limit,
    used,
    booster,
    monthly_used_sek:    Math.round(monthSpendSek * 100) / 100,
    monthly_ceiling_sek: monthCeiling,
    warning,
  }
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

  // Respect the per-org log_ai_questions opt-out. If false, the question
  // preview is not persisted — only the metadata (tokens, cost, model, tier).
  // Failure to read the flag defaults to the safer path (don't log the
  // question), not the default-true behaviour.
  let storeQuestion = true
  try {
    const { data: org } = await db
      .from('organisations')
      .select('log_ai_questions')
      .eq('id', params.org_id)
      .maybeSingle()
    if (org && org.log_ai_questions === false) storeQuestion = false
  } catch { storeQuestion = false }

  try {
    await db.from('ai_request_log').insert({
      org_id:           params.org_id,
      user_id:          params.user_id ?? null,
      request_type:     params.request_type,
      model:            params.model,
      tier:             params.tier ?? null,
      page:             params.page ?? null,
      question_preview: storeQuestion && params.question_preview
        ? params.question_preview.slice(0, 100)
        : null,
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
// Logs errors loudly — silent counter failures caused "AI says 0 / 20 after 5
// questions" on 2026-04-18.
export async function incrementAiUsage(db: Db, orgId: string): Promise<void> {
  const d = today()

  // Try RPC first (atomic on the DB side if deployed).
  try {
    const rpc = await db.rpc('increment_ai_usage', { p_org_id: orgId, p_date: d })
    if (!rpc.error) return
    // Common: RPC not deployed yet. Only log once per cold-start to avoid spam.
    if (!(globalThis as any).__aiRpcWarned) {
      console.warn('[ai] increment_ai_usage RPC unavailable, falling back to manual upsert:', rpc.error.message)
      ;(globalThis as any).__aiRpcWarned = true
    }
  } catch (e: any) {
    console.warn('[ai] RPC call threw, falling back to manual upsert:', e?.message || e)
  }

  // Manual fallback — select + update or insert.
  const { data: existing, error: selErr } = await db
    .from('ai_usage_daily')
    .select('id, query_count')
    .eq('org_id', orgId)
    .eq('date', d)
    .maybeSingle()

  if (selErr) {
    console.error('[ai] ai_usage_daily select failed', { orgId, date: d, error: selErr.message })
    return
  }

  if (existing) {
    const { error } = await db.from('ai_usage_daily')
      .update({ query_count: (existing.query_count ?? 0) + 1 })
      .eq('id', existing.id)
    if (error) console.error('[ai] ai_usage_daily update failed', { orgId, date: d, error: error.message })
  } else {
    const { error } = await db.from('ai_usage_daily').insert({ org_id: orgId, date: d, query_count: 1 })
    if (error) console.error('[ai] ai_usage_daily insert failed', { orgId, date: d, error: error.message })
  }
}
