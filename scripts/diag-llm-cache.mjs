#!/usr/bin/env node
// scripts/diag-llm-cache.mjs
//
// Diagnostic for the persistent cache_creation_input_tokens=0 problem on
// Piece 4 (lib/forecast/llm-adjust.ts). Three independent checks:
//
//   1. count_tokens against the EXACT system + tools we send, to learn
//      what Anthropic itself measures the cacheable prefix as. If under
//      2048 (Haiku 4.5 minimum), that's the answer.
//
//   2. A real Messages call to Haiku 4.5 with cache_control on a tiny
//      stub system prompt (~100 tokens) — expect cache miss with a
//      specific "min_cacheable_prompt_too_small" or silent skip. Tells
//      us whether silent-skip is Anthropic's behaviour below threshold.
//
//   3. A real Messages call against the FULL current llm-adjust system
//      prompt, sent twice in succession with cache_control. Looks at
//      cache_creation_input_tokens on call 1 and cache_read_input_tokens
//      on call 2. If both 0 here too, the bug is in the request itself
//      (not the deployment).
//
// Reads .env.local for ANTHROPIC_API_KEY. Never logs the key.

import { readFileSync } from 'node:fs'

function parseEnv(path) {
  try {
    return Object.fromEntries(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter(l => l.includes('=') && !l.trim().startsWith('#'))
        .map(l => {
          const i = l.indexOf('=')
          return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]
        })
    )
  } catch { return {} }
}
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
const KEY = env.ANTHROPIC_API_KEY
if (!KEY) { console.error('missing ANTHROPIC_API_KEY'); process.exit(1) }

const MODEL = 'claude-haiku-4-5-20251001'
const COMMON_HEADERS = {
  'content-type':      'application/json',
  'x-api-key':         KEY,
  'anthropic-version': '2023-06-01',
}

// ──────────────────────────────────────────────────────────────────────
// Reproduce the exact SYSTEM_PROMPT + tool definition from
// lib/forecast/llm-adjust.ts. Pasted here verbatim so this script is
// self-contained — if these drift, update both. (Not auto-importing
// because lib/ai/scope.ts pulls in @/ aliases that don't work outside
// the Next build.)
// ──────────────────────────────────────────────────────────────────────

const SCOPE_NOTE = `SCOPE RULES — DO NOT VIOLATE:

BUSINESS-WIDE data (cannot be attributed to a department):
- tracker_data fields: revenue (from Fortnox), food_cost, staff_cost, other_cost, depreciation, financial, net_profit, margin_pct
- tracker_line_items: every row (Fortnox P&L does not split by department)
- monthly_metrics, daily_metrics: aggregates over the whole business
- Personalkollen totals when not per-department

DEPARTMENT-LEVEL data (safe to cite per-department):
- department-tagged revenue (POS providers like pk_bella, pk_carne, pk_rosali_select)
- staff_logs rows assigned to a specific department
- the /api/departments endpoint aggregates these

When to USE business-wide data — encouraged:
- Forecasting the business as a whole (next month revenue, next quarter margin, year-end profit).  Business-wide history is the richest signal we have — use it fully.
- Seasonality and trend analysis at the business scope (month-over-month, year-over-year).
- Cost-trend analysis at the business scope (cost creep, subscription duplicates, rent vs. utilities share).
- Benchmarking the whole business against industry norms (labour % of revenue, food % of revenue, other_cost % of revenue).
- Budget recommendations that target the whole business.

When to AVOID business-wide data:
- Any answer scoped to a single department.  Don't slice business-wide numbers across departments.
- Cross-department comparisons that need food/overhead context — those costs don't exist per department.

Rules when answering:
1. When the user asks about a department, only cite department-level data.  Do not slice business-wide numbers across departments — the data does not support that split.
2. Department margin = department_revenue − department_staff_cost.  It does NOT include food cost, other_cost, depreciation, or financial — those only exist at the business level.
3. When a department-scoped question needs a business-wide figure to answer fully, say so explicitly: "Food cost is reported at the business level, not per department, so I can't split Bella's margin beyond labour."
4. When citing numbers, always be clear about the scope (whole business vs. a named department).
5. Fortnox-sourced figures are business-wide by definition.  A Fortnox line item labelled "Lokalhyra" is rent for the whole business — never assume a portion is a department's rent.
6. For forecasts, budgets, and long-range questions at the business level: lean into Fortnox history.  The point of capturing it is to improve prediction.

INVOICE-LEVEL DATA — out of context unless explicitly provided:
- Per-supplier-invoice voucher detail (individual amounts, dates, voucher rows) is NOT in your standard context window.  It is fetched on-demand via the overhead-review drill-down (live from Fortnox) only when the user explicitly clicks "Show invoices" on a flag card.
- Do NOT make claims about specific invoices — "this 950 kr Menigo invoice on the 11th", "the spike came from a single order" — unless invoice-level data has been explicitly included in the prompt.  Without it, you have only supplier-level totals for the period and must speak at that granularity.
- You MAY tell the user that drill-down exists when it would help.  When explaining a flag, point them at the "Show invoices" affordance below the flag card — it pulls the underlying supplier invoices live from Fortnox so they can confirm whether a spike is a one-off or a pricing change.  Frame it as a next step, not as data you've seen.`

// ⚠ Keep this file in sync with lib/forecast/llm-adjust.ts. The intent is to
// measure the deployed prompt — if these strings drift, the diagnostic
// stops being authoritative. Most recent sync: 2026-05-11 (post bulk-up
// to clear Haiku 4.5's ~4,096-token cacheable minimum).

const ROLE_AND_RULES = `You are a forecast review agent for a Swedish restaurant business intelligence product (CommandCenter). Each call hands you ONE deterministic daily revenue forecast — a number with a structured snapshot of how it was computed (weekday baseline, weather lift, holiday flag, klämdag detection, school-holiday flag, salary cycle, this-week scaler, anomaly contamination check, and a data-quality-flags list). Your job is to decide whether the deterministic prediction needs adjustment based on context the deterministic signals cannot see.

${SCOPE_NOTE}

WHEN TO ADJUST (factor ≠ 1.0):
- The data_quality_flags list contains a flag the deterministic forecaster cannot itself correct (e.g. 'short_history_mode_4w_unweighted' on a January date — the recency window may be anchoring on December peak even though the seasonal pattern is reset).
- A signal is "available: false" with a reason that suggests systematic bias.
- The this_week_scaler is clamped at floor or ceil.
- The salary_cycle phase is 'around_payday' but the deterministic factor is near 1.0.

WHEN NOT TO ADJUST (return factor = 1.0):
- All signals look complete, factors are within normal range, no data_quality_flags.
- You do not have specific contextual evidence that overrides a signal.
- The deterministic forecast is already aware of and applying the same lift you would propose.
- ALWAYS prefer 1.0 over a small adjustment.
- ASYMMETRIC GUARDRAIL: if this_week_scaler is clamped at FLOOR AND weekday_baseline thin, default to 1.0.
- HOLIDAY-FILTER GUARDRAIL: when data_quality_flags contains 'cold_start_holiday_samples_excluded', defer to 1.0.

CLAMP RULES:
- adjustment_factor MUST be in [0.5, 1.5]. The runtime will clamp regardless.
- Lifts > 1.10 require a strong signal. Dampening < 0.90 same standard.
- "I'm not sure" → 1.0 with confidence='low'.

OUTPUT VIA TOOL:
- You MUST submit the result via the submit_revenue_adjustment tool.
- reasoning ≤400 chars.
- confidence='high' only when the snapshot itself contains the evidence.`

const SCHEMA_AND_EXAMPLES = `INPUT SHAPE — every call you receive a JSON payload with these top-level keys:
  forecast_date, predicted_revenue, baseline_revenue, components, confidence,
  inputs_snapshot (which contains weekday_baseline, weather_lift, holiday, klamdag,
  school_holiday, salary_cycle, this_week_scaler, anomaly_contamination, data_quality_flags),
  business_country, weekday_name, is_weekend.

Focus on inputs_snapshot.data_quality_flags and .available=false branches first.

WORKED EXAMPLES (do not echo, just for calibration):

  Example A — January, short_history_mode + holiday filter ACTIVE:
    Input: data_quality_flags=['short_history_mode_4w_unweighted','cold_start_holiday_samples_excluded']
    Output: factor=1.0, confidence='medium'

  Example A2 — January, holiday filter FELL BACK (too few samples):
    Input: data_quality_flags=['short_history_mode_4w_unweighted','cold_start_holiday_filter_fellback_too_few_samples']
    Output: factor=0.85, confidence='high'

  Example B — normal Tuesday in May, all signals present:
    Input: no data_quality_flags, all components within ±5% of 1.0
    Output: factor=1.0, confidence='high'

  Example C — this_week_scaler clamped at ceil with salary 'around_payday':
    Input: scaler.clamped_at_max=true
    Output: factor=1.05, confidence='medium'

  Example D — this_week_scaler clamped at FLOOR with thin baseline:
    Input: scaler.clamped_at_min=true, weekday_baseline.recent_28d_samples=3
    Output: factor=1.0, confidence='medium'`

const SYSTEM_PROMPT = ROLE_AND_RULES + '\n\n' + SCHEMA_AND_EXAMPLES

const submitAdjustmentTool = {
  name: 'submit_revenue_adjustment',
  description:
    'Submit a multiplicative adjustment to the deterministic revenue forecast. ' +
    'Use 1.0 to leave the forecast unchanged.',
  input_schema: {
    type: 'object',
    properties: {
      adjustment_factor: {
        type: 'number',
        description: 'Multiplicative factor in [0.5, 1.5]. 1.0 = no change.',
      },
      reasoning: {
        type: 'string',
        description: 'One paragraph (≤400 chars) explaining the adjustment.',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'Your confidence in the adjustment direction.',
      },
    },
    required: ['adjustment_factor', 'reasoning', 'confidence'],
  },
}

// ──────────────────────────────────────────────────────────────────────
// Step 1: count_tokens — what does Anthropic think the cacheable
// prefix is? We send system + tools + one tiny user message. The
// API returns the total. Subtracting the user message gives us the
// system+tools count.
// ──────────────────────────────────────────────────────────────────────

async function countTokens(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify(body),
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`count_tokens ${r.status}: ${t.slice(0, 300)}`)
  return JSON.parse(t)
}

console.log('── Step 1: count_tokens ─────────────────────────────────────')

const minimalUser = [{ role: 'user', content: 'x' }]
const countFull = await countTokens({
  model: MODEL,
  system: [{ type: 'text', text: SYSTEM_PROMPT }],
  tools: [submitAdjustmentTool],
  messages: minimalUser,
})
const countNoTools = await countTokens({
  model: MODEL,
  system: [{ type: 'text', text: SYSTEM_PROMPT }],
  messages: minimalUser,
})
const countOnlyUser = await countTokens({
  model: MODEL,
  messages: minimalUser,
})
const systemTokens = countNoTools.input_tokens - countOnlyUser.input_tokens
const toolsTokens  = countFull.input_tokens   - countNoTools.input_tokens
const cacheablePrefixTokens = systemTokens + toolsTokens
console.log(`  user message only:           ${countOnlyUser.input_tokens} tokens`)
console.log(`  + system:                    +${systemTokens} = ${countNoTools.input_tokens}`)
console.log(`  + tools:                     +${toolsTokens} = ${countFull.input_tokens}`)
console.log(`  → cacheable prefix size:     ${cacheablePrefixTokens} tokens`)
console.log(`  Haiku 4.5 minimum cacheable: 2048 tokens`)
console.log(`  → above minimum?             ${cacheablePrefixTokens >= 2048 ? 'YES ✓' : 'NO ✗ — caching cannot fire'}`)

// ──────────────────────────────────────────────────────────────────────
// Step 2: Two real Messages calls with cache_control. First call should
// create the cache; second within 5min should hit it.
// ──────────────────────────────────────────────────────────────────────

console.log('\n── Step 2: real Messages call (×2, with cache_control) ─────')

async function sendOnce(label) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: COMMON_HEADERS,
    body: JSON.stringify({
      model:       MODEL,
      max_tokens:  64,
      tools:       [{ ...submitAdjustmentTool, cache_control: { type: 'ephemeral' } }],
      tool_choice: { type: 'tool', name: 'submit_revenue_adjustment' },
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [{ role: 'user', content: 'Return factor 1.0 with reasoning "diagnostic ping".' }],
    }),
  })
  const t = await r.text()
  if (!r.ok) throw new Error(`messages ${r.status}: ${t.slice(0, 500)}`)
  const j = JSON.parse(t)
  console.log(`  ${label}:`)
  console.log(`    input_tokens:                  ${j.usage?.input_tokens ?? '?'}`)
  console.log(`    cache_creation_input_tokens:   ${j.usage?.cache_creation_input_tokens ?? 0}`)
  console.log(`    cache_read_input_tokens:       ${j.usage?.cache_read_input_tokens ?? 0}`)
  if (j.usage?.cache_creation) {
    console.log(`    cache_creation.ephemeral_5m:   ${j.usage.cache_creation.ephemeral_5m_input_tokens}`)
    console.log(`    cache_creation.ephemeral_1h:   ${j.usage.cache_creation.ephemeral_1h_input_tokens}`)
  }
  return j.usage
}

const u1 = await sendOnce('Call 1 (should CREATE cache)')
const u2 = await sendOnce('Call 2 (should READ cache)')

console.log('\n── Verdict ──────────────────────────────────────────────────')
if (cacheablePrefixTokens < 2048) {
  console.log(`  Cacheable prefix is ${cacheablePrefixTokens} tokens — BELOW Haiku 4.5's 2048-token minimum.`)
  console.log(`  Caching will not fire until the system+tools prefix is bulked to ≥2048 tokens.`)
  console.log(`  Add ~${2048 - cacheablePrefixTokens + 200} more tokens of content (200-token buffer recommended).`)
} else if ((u1.cache_creation_input_tokens ?? 0) > 0) {
  console.log(`  Cache CREATED on call 1 (${u1.cache_creation_input_tokens} tokens).`)
  if ((u2.cache_read_input_tokens ?? 0) > 0) {
    console.log(`  Cache READ on call 2 (${u2.cache_read_input_tokens} tokens). All working.`)
    console.log(`  The production 0/0 must be an environment / config difference. Check Vercel env or deploy version.`)
  } else {
    console.log(`  Cache NOT read on call 2 — something invalidated it between calls. Unusual.`)
  }
} else {
  console.log(`  Cacheable prefix is ${cacheablePrefixTokens} tokens (above 2048) BUT cache still 0/0 here too.`)
  console.log(`  The cache_control is being silently dropped by the API. Possible causes:`)
  console.log(`  - Model doesn't actually support prompt caching (unlikely for Haiku 4.5)`)
  console.log(`  - Account tier issue (free tier excludes caching?)`)
  console.log(`  - cache_control format wrong despite passing validation`)
  console.log(`  - The total in body needs to be wrapped differently`)
  console.log(`  Try sending the body directly to https://docs.anthropic.com playground to compare.`)
}
