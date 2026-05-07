// lib/ai/usage.ts
// Shared daily AI-query limit guard.
// Use from any API route that calls Claude (ask, budget generate, budget analyse, …)
// so every AI call counts against the org's daily plan limit uniformly.
//
// Two flows live here:
//
//   Burst-sensitive callers (any user-triggered endpoint — /api/ask, budget,
//   tracker narrative, …) MUST use checkAndIncrementAiLimit():
//     const gate = await checkAndIncrementAiLimit(db, orgId, plan)
//     if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status })
//     // call Claude
//     // logAiRequest()
//   It runs an atomic INSERT … ON CONFLICT DO UPDATE via RPC, so 100 parallel
//   tabs cannot all pass the gate before any increment lands. Decrements on
//   over-limit so the rejected attempt doesn't tick the counter.
//
//   Cron-driven AI agents (anomaly explainer, weekly digest, monthly forecast
//   calibration) can keep using the legacy two-step:
//     const gate = await checkAiLimit(db, orgId, plan)   // @deprecated
//     if (!gate.ok) return …
//     // call Claude
//     await incrementAiUsage(db, orgId)
//   They run serially from a cron lock, so TOCTOU isn't an attack surface.
//
// Schema: ai_usage_daily (org_id, date, query_count) with UNIQUE (org_id, date).
// Atomic path: RPC increment_ai_usage_checked (M033). Global kill-switch
// SUM uses RPC ai_spend_24h_global_usd (also M033) instead of the prior
// table-scan-and-sum-in-JS that fell over above ~50 customers.

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
  /**
   * Daily-cap warning ladder:
   *   severity='info' — used ≥ 50% (soft nudge)
   *   severity='warn' — used ≥ 80% (near cap + email on first crossing)
   */
  warning?: {
    used:     number
    limit:    number
    percent:  number
    severity: 'info' | 'warn'
  }
  /**
   * Monthly cost-ceiling warning ladder:
   *   severity='info' — used ≥ 70% of monthly SEK ceiling
   *   severity='warn' — used ≥ 90% (email on first crossing)
   */
  monthly_warning?: {
    used_sek:    number
    ceiling_sek: number
    percent:     number
    severity:    'info' | 'warn'
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
// Reviewed against pricing sheet 2026-05-07 (post-2026-04-23 reprice).
//
// Sizing rule: ~1.5–2× the expected Sonnet-heavy COGS for the plan's daily
// cap, so a normal heavy-usage month doesn't trip but a runaway 2× spike
// does. founding/solo share the 30 q/day cap so share the same ceiling;
// chain mirrors enterprise since both run on the 500/day safety cap.
const MONTHLY_COST_CEILING_SEK: Record<string, number> = {
  trial:       30,
  founding:   150,
  solo:       150,
  group:      500,
  chain:     1500,
  enterprise:1500,
  // Legacy aliases — kept so any old DB rows on the pre-2026-04-23 plans
  // still resolve. Sized for the OLD daily caps (starter 20/day, pro 50/day);
  // new equivalents are solo and group above.
  starter:    60,
  pro:       150,
}
function monthlyCeilingFor(planKey: string): number {
  return MONTHLY_COST_CEILING_SEK[planKey] ?? MONTHLY_COST_CEILING_SEK.trial
}
// Exported so /admin/overview and other cross-org surfaces can apply the
// same ceiling logic without re-defining the map.
export function getMonthlyCeilingSek(planKey: string): number {
  return monthlyCeilingFor(planKey)
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

// Approaching-limit warning ladders. Daily: 50% info → 80% warn → block at
// 100%. Monthly (cost ceiling): 70% info → 90% warn → block at 100%.
// Email dedup via ai_usage_notifications (M025) — exactly one email per
// (org, period, level).
const DAILY_INFO_THRESHOLD = 0.50
const DAILY_WARN_THRESHOLD = 0.80
const MONTHLY_INFO_THRESHOLD = 0.70
const MONTHLY_WARN_THRESHOLD = 0.90

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
//
// @deprecated for user-facing endpoints — use checkAndIncrementAiLimit() so the
// gate is atomic against burst (100 parallel /api/ask tabs). This two-step
// version is still fine for cron-triggered AI agents that run serially.
export async function checkAiLimit(db: Db, orgId: string, planKey?: string): Promise<LimitGate> {
  let effectivePlanKey: string = planKey ?? 'trial'
  if (!planKey) {
    const { data } = await db.from('organisations').select('plan').eq('id', orgId).maybeSingle()
    effectivePlanKey = data?.plan ?? 'trial'
  }

  // Gate 1 — global kill-switch. Stops all AI company-wide when 24 h spend
  // exceeds MAX_DAILY_GLOBAL_USD. Cheapest check, run first.
  // M033 (FIXES §0w): replaced the prior full table scan + sum-in-JS with
  // an RPC that does the SUM in Postgres against idx_ai_request_log_created_at.
  // The old path fetched every row in the last 24 h on every AI call, which
  // was O(N customers × calls/day) per request — fine at 2 paying customers,
  // would have fallen over before 50.
  const { data: globalSpendRpc, error: globalSpendErr } = await db.rpc('ai_spend_24h_global_usd')
  let globalSpend = Number(globalSpendRpc ?? 0)
  if (globalSpendErr) {
    // RPC missing (M033 not applied yet) — fail OPEN so a missing migration
    // doesn't block every AI call. The per-org daily cap still gates abuse.
    console.warn('[ai] ai_spend_24h_global_usd RPC unavailable — kill-switch open:', globalSpendErr.message)
    globalSpend = 0
  }
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

  // Daily ladder
  const dailyPct = limit > 0 ? used / limit : 0
  let warning: LimitGateOk['warning']
  if (dailyPct >= DAILY_WARN_THRESHOLD) {
    warning = { used, limit, percent: Math.round(dailyPct * 100), severity: 'warn' }
  } else if (dailyPct >= DAILY_INFO_THRESHOLD) {
    warning = { used, limit, percent: Math.round(dailyPct * 100), severity: 'info' }
  }

  // Monthly ladder
  const monthlyPct = monthCeiling > 0 ? monthSpendSek / monthCeiling : 0
  let monthly_warning: LimitGateOk['monthly_warning']
  if (monthlyPct >= MONTHLY_WARN_THRESHOLD) {
    monthly_warning = {
      used_sek:    Math.round(monthSpendSek * 100) / 100,
      ceiling_sek: monthCeiling,
      percent:     Math.round(monthlyPct * 100),
      severity:    'warn',
    }
  } else if (monthlyPct >= MONTHLY_INFO_THRESHOLD) {
    monthly_warning = {
      used_sek:    Math.round(monthSpendSek * 100) / 100,
      ceiling_sek: monthCeiling,
      percent:     Math.round(monthlyPct * 100),
      severity:    'info',
    }
  }

  // Fire email notifications on FIRST crossing of 'warn' severity.
  // Dedup via ai_usage_notifications (unique on org_id, level, period_key).
  // Non-fatal — an insert conflict or missing table never blocks the gate.
  if (warning?.severity === 'warn') {
    notifyThreshold(db, orgId, 'daily_80', today()).catch(() => {})
  }
  if (monthly_warning?.severity === 'warn') {
    const monthKey = today().slice(0, 7)   // 'YYYY-MM'
    notifyThreshold(db, orgId, 'monthly_90', monthKey).catch(() => {})
  }

  return {
    ok: true,
    limit,
    used,
    booster,
    monthly_used_sek:    Math.round(monthSpendSek * 100) / 100,
    monthly_ceiling_sek: monthCeiling,
    warning,
    monthly_warning,
  }
}

/**
 * Atomic check + increment for the per-org daily AI cap.
 *
 * Why this exists (FIXES §0w):
 *   The legacy two-step (checkAiLimit → call Claude → incrementAiUsage) is
 *   TOCTOU-prone: 100 parallel /api/ask requests all pass the SELECT before
 *   any UPDATE lands, blowing the daily cap by the burst factor and
 *   uncapping cost in the worst case.
 *
 * Flow:
 *   1. Run gate 1 (global kill-switch) and gate 2 (monthly cost ceiling)
 *      using the same logic as checkAiLimit. These are not burst-sensitive
 *      — they're org-wide rolling sums, so a few extra calls past the
 *      ceiling on race are acceptable. Doing them BEFORE the increment
 *      means an org over its monthly ceiling doesn't burn its daily quota.
 *   2. Resolve the effective daily limit (plan + active boosters).
 *   3. Call increment_ai_usage_checked(orgId, today, limit) RPC. This does
 *      INSERT … ON CONFLICT DO UPDATE in one statement and returns the
 *      post-increment count + an `allowed` flag.
 *   4. If !allowed, decrement so the rejected attempt doesn't tick the
 *      counter — only the first request that crosses the cap pays.
 *      Without this, a burst of 100 rejected requests would lock the org
 *      out of legitimate calls until midnight.
 *
 * Returns the same LimitGate shape as checkAiLimit so callers can swap
 * with no other changes. On `ok: true`, the increment has already happened
 * — DO NOT also call incrementAiUsage().
 */
export async function checkAndIncrementAiLimit(
  db: Db,
  orgId: string,
  planKey?: string,
): Promise<LimitGate> {
  let effectivePlanKey: string = planKey ?? 'trial'
  if (!planKey) {
    const { data } = await db.from('organisations').select('plan').eq('id', orgId).maybeSingle()
    effectivePlanKey = data?.plan ?? 'trial'
  }

  // Gate 1 — global kill-switch (same RPC as checkAiLimit).
  const { data: globalSpendRpc, error: globalSpendErr } = await db.rpc('ai_spend_24h_global_usd')
  let globalSpend = Number(globalSpendRpc ?? 0)
  if (globalSpendErr) {
    console.warn('[ai] ai_spend_24h_global_usd RPC unavailable — kill-switch open:', globalSpendErr.message)
    globalSpend = 0
  }
  const globalCap = globalDailyCapUsd()
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

  // Gate 2 — per-plan monthly cost ceiling.
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

  // Gate 3 — atomic per-day query cap via RPC.
  const { total: limit, booster } = await getEffectiveDailyLimit(db, orgId, effectivePlanKey)
  const d = today()

  let postCount: number = 0
  let allowed:   boolean = true
  try {
    const { data: rpcRows, error: rpcErr } = await db.rpc('increment_ai_usage_checked', {
      p_org_id: orgId,
      p_date:   d,
      p_limit:  limit,
    })
    if (rpcErr) throw rpcErr
    // Postgres RETURNS TABLE comes back as an array of rows.
    const row = Array.isArray(rpcRows) ? rpcRows[0] : rpcRows
    postCount = Number(row?.new_count ?? 0)
    allowed   = Boolean(row?.allowed)
  } catch (e: any) {
    // RPC missing (M033 not applied yet) — fall back to the legacy two-step
    // so an unmigrated environment still rate-limits, just non-atomically.
    if (!(globalThis as any).__aiCheckedRpcWarned) {
      console.warn('[ai] increment_ai_usage_checked RPC unavailable, falling back to non-atomic gate:', e?.message || e)
      ;(globalThis as any).__aiCheckedRpcWarned = true
    }
    const { data: usage } = await db
      .from('ai_usage_daily')
      .select('query_count')
      .eq('org_id', orgId)
      .eq('date', d)
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
    await incrementAiUsage(db, orgId)
    postCount = used + 1
    allowed   = true
  }

  if (!allowed) {
    // Burst-rejected — undo the increment so we don't starve legitimate
    // calls for the rest of the day. Only the first request that crosses
    // the cap should count against the quota.
    try {
      await db.from('ai_usage_daily')
        .update({ query_count: Math.max(0, postCount - 1) })
        .eq('org_id', orgId)
        .eq('date', d)
    } catch (e: any) {
      console.warn('[ai] post-reject decrement failed:', e?.message || e)
    }
    return {
      ok:     false,
      status: 429,
      body: {
        error:   'Daily AI query limit reached',
        reason:  'daily_cap',
        limit,
        used:    Math.max(0, postCount - 1),
        plan:    effectivePlanKey,
        booster,
        upgrade: true,
      },
    }
  }

  // Allowed — surface the same warning ladders as checkAiLimit so the UI
  // can render the approaching-cap nudge.
  const used = postCount
  const dailyPct = limit > 0 ? used / limit : 0
  let warning: LimitGateOk['warning']
  if (dailyPct >= DAILY_WARN_THRESHOLD) {
    warning = { used, limit, percent: Math.round(dailyPct * 100), severity: 'warn' }
  } else if (dailyPct >= DAILY_INFO_THRESHOLD) {
    warning = { used, limit, percent: Math.round(dailyPct * 100), severity: 'info' }
  }

  const monthlyPct = monthCeiling > 0 ? monthSpendSek / monthCeiling : 0
  let monthly_warning: LimitGateOk['monthly_warning']
  if (monthlyPct >= MONTHLY_WARN_THRESHOLD) {
    monthly_warning = {
      used_sek:    Math.round(monthSpendSek * 100) / 100,
      ceiling_sek: monthCeiling,
      percent:     Math.round(monthlyPct * 100),
      severity:    'warn',
    }
  } else if (monthlyPct >= MONTHLY_INFO_THRESHOLD) {
    monthly_warning = {
      used_sek:    Math.round(monthSpendSek * 100) / 100,
      ceiling_sek: monthCeiling,
      percent:     Math.round(monthlyPct * 100),
      severity:    'info',
    }
  }

  if (warning?.severity === 'warn') {
    notifyThreshold(db, orgId, 'daily_80', d).catch(() => {})
  }
  if (monthly_warning?.severity === 'warn') {
    const monthKey = d.slice(0, 7)
    notifyThreshold(db, orgId, 'monthly_90', monthKey).catch(() => {})
  }

  return {
    ok: true,
    limit,
    used,
    booster,
    monthly_used_sek:    Math.round(monthSpendSek * 100) / 100,
    monthly_ceiling_sek: monthCeiling,
    warning,
    monthly_warning,
  }
}

// One email per (org, level, period). Second call for the same period
// hits the unique constraint and silently skips — by design.
async function notifyThreshold(
  db: Db,
  orgId: string,
  level: 'daily_80' | 'monthly_90',
  periodKey: string,
) {
  // Pre-check — avoid doing the owner-lookup + email work if we already
  // sent this notification. The unique constraint is the source of truth,
  // this is just a fast-path.
  try {
    const { data: existing } = await db.from('ai_usage_notifications')
      .select('id').eq('org_id', orgId).eq('level', level).eq('period_key', periodKey)
      .maybeSingle()
    if (existing) return
  } catch { /* table may not exist yet — keep going, insert will fail silently */ }

  // Resolve owner email.
  let ownerEmail: string | null = null
  try {
    const { data: member } = await db.from('organisation_members')
      .select('user_id').eq('org_id', orgId).eq('role', 'owner').maybeSingle()
    if (member?.user_id) {
      const { data: userRow } = await db.auth.admin.getUserById(member.user_id)
      ownerEmail = userRow?.user?.email ?? null
    }
  } catch { /* no-op */ }

  // Insert the dedup row FIRST. If it conflicts, another request already
  // sent this notification — bail so we don't double-send.
  try {
    const { error } = await db.from('ai_usage_notifications').insert({
      org_id:     orgId,
      level,
      period_key: periodKey,
      email_to:   ownerEmail,
    })
    if (error) return   // unique violation or table missing — either way, skip
  } catch { return }

  if (!ownerEmail) return

  try {
    const { sendEmail } = await import('@/lib/email/send')
    const isMonthly = level === 'monthly_90'
    await sendEmail({
      from:    'CommandCenter <alerts@comandcenter.se>',
      to:      ownerEmail,
      subject: isMonthly
        ? `Heads up — you're at 90% of this month's AI budget`
        : `Heads up — you're at 80% of today's AI queries`,
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;color:#1a1f2e">
          <h1 style="font-size:18px;margin:0 0 10px;font-weight:600">
            ${isMonthly
              ? 'Your AI spend this month is at 90% of the ceiling.'
              : "You've used 80% of today's AI queries."}
          </h1>
          <p style="font-size:14px;color:#374151;line-height:1.6">
            ${isMonthly
              ? 'Once you hit 100%, CommandCenter pauses AI calls on your account until next month to prevent surprise costs. Upgrade your plan or contact us if this should keep going.'
              : "You have a little headroom left today. The quota resets tomorrow at midnight Stockholm time — or you can upgrade / buy a Booster to extend today's limit."}
          </p>
          <a href="https://comandcenter.se/upgrade?focus=ai"
             style="display:inline-block;padding:10px 18px;background:#1a1f2e;color:#fff;border-radius:8px;text-decoration:none;font-size:14px;margin-top:14px">
            Review usage
          </a>
          <p style="margin-top:24px;font-size:12px;color:#9ca3af">
            We only send this email once per ${isMonthly ? 'month' : 'day'} — not every query.
          </p>
        </div>
      `,
      context: { kind: 'ai_usage_threshold', org_id: orgId, level, period_key: periodKey },
    })
  } catch { /* email is best-effort */ }
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
      cost_usd,
      cost_sek,
      duration_ms:      params.duration_ms ?? null,
    })
  } catch (e: any) {
    console.error('[ai] log insert failed:', e?.message || e)
    try {
      const { captureError } = await import('@/lib/monitoring/sentry')
      captureError(e, {
        route:        'lib/ai/usage',
        phase:        'ai_request_log insert',
        org_id:       params.org_id,
        user_id:      params.user_id,
        request_type: params.request_type,
        model:        params.model,
      })
    } catch { /* monitoring must never break the request */ }
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
      try {
        const { captureError } = await import('@/lib/monitoring/sentry')
        captureError(e, {
          route:   'lib/ai/usage',
          phase:   'ai_usage_daily_by_user update',
          org_id:  params.org_id,
          user_id: params.user_id,
        })
      } catch { /* monitoring must never break the request */ }
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
    try {
      const { captureError } = await import('@/lib/monitoring/sentry')
      captureError(selErr, {
        route:  'lib/ai/usage',
        phase:  'ai_usage_daily select',
        org_id: orgId,
        date:   d,
      })
    } catch {}
    return
  }

  if (existing) {
    const { error } = await db.from('ai_usage_daily')
      .update({ query_count: (existing.query_count ?? 0) + 1 })
      .eq('id', existing.id)
    if (error) {
      console.error('[ai] ai_usage_daily update failed', { orgId, date: d, error: error.message })
      try {
        const { captureError } = await import('@/lib/monitoring/sentry')
        captureError(error, {
          route:  'lib/ai/usage',
          phase:  'ai_usage_daily update',
          org_id: orgId,
          date:   d,
        })
      } catch {}
    }
  } else {
    const { error } = await db.from('ai_usage_daily').insert({ org_id: orgId, date: d, query_count: 1 })
    if (error) {
      console.error('[ai] ai_usage_daily insert failed', { orgId, date: d, error: error.message })
      try {
        const { captureError } = await import('@/lib/monitoring/sentry')
        captureError(error, {
          route:  'lib/ai/usage',
          phase:  'ai_usage_daily insert',
          org_id: orgId,
          date:   d,
        })
      } catch {}
    }
  }
}
