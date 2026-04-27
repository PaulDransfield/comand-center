// lib/stripe/config.ts
//
// PLAN DEFINITIONS — single source of truth for what each plan includes.
//
// 2026-04-23 repricing: list tiers renamed/repriced from starter/pro/group
// (499/799/1499) to solo/group/chain (1,995/4,995/9,995) + a time-limited
// founding tier (995 kr locked for 24 months for the first 10 customers).
// Free trial retired; new signups go straight to founding.
//
// Backwards-compat: `starter` and `pro` remain in PLANS as aliases to
// `solo` and `group` respectively so existing DB rows (plan='starter')
// still resolve to sane limits. New signups only use the new keys.

import { AI_MODELS } from '@/lib/ai/models'

export interface PlanLimits {
  businesses:       number
  documents:        number
  monthly_tokens:   number
  monthly_requests: number   // AI queries per month (daily limit * 30)
  team_members:     number
  notebooks:        number
  audio_overviews:  number
  export_schedules: number
  storage_mb:       number
}

export interface Plan {
  name:                    string
  price_sek:               number | null
  price_usd:               number | null
  stripe_price_env:        string | null   // monthly price ID env var
  stripe_price_annual_env: string | null   // annual price ID env var
  ai_queries_per_day:      number          // the number shown in UI
  limits:                  PlanLimits
  features:                string[]
  model:                   string
  badge:                   string | null
  legacy?:                 boolean         // backwards-compat alias, hide from UI
}

export const PLANS: Record<string, Plan> = {

  // Deprecated: retained so org_members with plan='trial' don't break, but
  // new signups flow straight to founding (no free trial anymore).
  trial: {
    name:                    'Free Trial',
    price_sek:               0,
    price_usd:               0,
    stripe_price_env:        null,
    stripe_price_annual_env: null,
    ai_queries_per_day:      20,
    limits: {
      businesses:       1,
      documents:        50,
      monthly_tokens:   500_000,
      monthly_requests: 600,
      team_members:     1,
      notebooks:        3,
      audio_overviews:  3,
      export_schedules: 1,
      storage_mb:       100,
    },
    features: [
      '1 restaurant location',
      '20 AI queries per day',
      'Dashboard & staff analytics',
      'PDF exports',
    ],
    model:  AI_MODELS.AGENT,
    badge:  null,
    legacy: true,
  },

  founding: {
    name:                    'Founding Customer',
    price_sek:               995,
    price_usd:               99,
    stripe_price_env:        'STRIPE_PRICE_FOUNDING',
    stripe_price_annual_env: 'STRIPE_PRICE_FOUNDING_ANNUAL',
    ai_queries_per_day:      50,
    limits: {
      businesses:       3,           // enough for a small group
      documents:        5_000,
      monthly_tokens:   10_000_000,
      monthly_requests: 1_500,
      team_members:     10,
      notebooks:        100,
      audio_overviews:  100,
      export_schedules: 20,
      storage_mb:       20_000,
    },
    features: [
      'Locked for 24 months',
      'Up to 3 restaurants',
      'Full Solo + partial Group features',
      'Fortnox PDF extraction',
      'Nightly anomaly alerts + Monday Memo',
      '50 AI queries per day',
      'Case-study partnership with founder',
      'Direct line to the team',
    ],
    model:  AI_MODELS.ASSISTANT,
    badge:  '10 spots only',
  },

  solo: {
    name:                    'Solo',
    price_sek:               1_995,
    price_usd:               199,
    stripe_price_env:        'STRIPE_PRICE_SOLO',
    stripe_price_annual_env: 'STRIPE_PRICE_SOLO_ANNUAL',
    ai_queries_per_day:      30,
    limits: {
      businesses:       1,
      documents:        1_500,
      monthly_tokens:   5_000_000,
      monthly_requests: 900,
      team_members:     5,
      notebooks:        50,
      audio_overviews:  50,
      export_schedules: 10,
      storage_mb:       5_000,
    },
    features: [
      '1 restaurant location',
      'Fortnox PDF + Personalkollen integration',
      'All core AI agents (anomaly, cost, onboarding, Monday Memo)',
      'P&L tracker, budget, forecast, overheads, revenue, staff',
      '30 AI queries per day',
      'Email support',
      'Team access (5 users)',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: null,
  },

  group: {
    name:                    'Group',
    price_sek:               4_995,
    price_usd:               499,
    stripe_price_env:        'STRIPE_PRICE_GROUP',
    stripe_price_annual_env: 'STRIPE_PRICE_GROUP_ANNUAL',
    ai_queries_per_day:      100,
    limits: {
      businesses:       5,
      documents:        10_000,
      monthly_tokens:   25_000_000,
      monthly_requests: 3_000,
      team_members:     25,
      notebooks:        500,
      audio_overviews:  500,
      export_schedules: 50,
      storage_mb:       50_000,
    },
    features: [
      '2–5 restaurants',
      'Everything in Solo',
      'Multi-location rollup + Departments view',
      'Weekly scheduling optimisation agent',
      'Supplier price-creep agent',
      'Priority support (24h SLA)',
      'Quarterly review call',
      'Team access (25 users)',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: 'Most Popular',
  },

  chain: {
    name:                    'Chain',
    price_sek:               9_995,
    price_usd:               999,
    stripe_price_env:        'STRIPE_PRICE_CHAIN',
    stripe_price_annual_env: 'STRIPE_PRICE_CHAIN_ANNUAL',
    ai_queries_per_day:      Infinity,
    limits: {
      businesses:       Infinity,
      documents:        Infinity,
      monthly_tokens:   Infinity,
      monthly_requests: Infinity,
      team_members:     Infinity,
      notebooks:        Infinity,
      audio_overviews:  Infinity,
      export_schedules: Infinity,
      storage_mb:       Infinity,
    },
    features: [
      '6+ restaurants',
      'Everything in Group',
      'Dedicated onboarding',
      'Custom Fortnox OAuth setup',
      'API access (when available)',
      'Unlimited AI usage',
      'Unlimited team members',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: null,
  },

  // past_due is a temporary state after payment failure.
  past_due: {
    name:                    'Payment failed',
    price_sek:               null,
    price_usd:               null,
    stripe_price_env:        null,
    stripe_price_annual_env: null,
    ai_queries_per_day:      0,
    limits: {
      businesses:       1,
      documents:        500,
      monthly_tokens:   0,
      monthly_requests: 0,
      team_members:     3,
      notebooks:        20,
      audio_overviews:  0,
      export_schedules: 0,
      storage_mb:       2_000,
    },
    features: [],
    model: AI_MODELS.AGENT,
    badge: null,
  },

  enterprise: {
    name:                    'Enterprise',
    price_sek:               null,
    price_usd:               null,
    stripe_price_env:        null,
    stripe_price_annual_env: null,
    ai_queries_per_day:      Infinity,
    limits: {
      businesses:       Infinity,
      documents:        Infinity,
      monthly_tokens:   Infinity,
      monthly_requests: Infinity,
      team_members:     Infinity,
      notebooks:        Infinity,
      audio_overviews:  Infinity,
      export_schedules: Infinity,
      storage_mb:       Infinity,
    },
    features: [
      'Unlimited locations',
      'Unlimited AI usage',
      'Custom integrations',
      'SLA guarantee',
      'Dedicated account manager',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: 'Custom',
  },

  // ────────────────────────────────────────────────────────────────
  // Legacy aliases — retained so existing DB rows with plan='starter'
  // or plan='pro' still resolve. Hidden from pricing/upgrade UIs.
  // ────────────────────────────────────────────────────────────────
  starter: {
    name:                    'Starter (legacy)',
    price_sek:               1_995,
    price_usd:               199,
    stripe_price_env:        'STRIPE_PRICE_SOLO',
    stripe_price_annual_env: 'STRIPE_PRICE_SOLO_ANNUAL',
    ai_queries_per_day:      30,
    limits: {
      businesses:       1, documents: 1_500, monthly_tokens: 5_000_000,
      monthly_requests: 900, team_members: 5, notebooks: 50, audio_overviews: 50,
      export_schedules: 10, storage_mb: 5_000,
    },
    features: [],
    model:  AI_MODELS.ASSISTANT,
    badge:  null,
    legacy: true,
  },

  pro: {
    name:                    'Pro (legacy)',
    price_sek:               4_995,
    price_usd:               499,
    stripe_price_env:        'STRIPE_PRICE_GROUP',
    stripe_price_annual_env: 'STRIPE_PRICE_GROUP_ANNUAL',
    ai_queries_per_day:      100,
    limits: {
      businesses:       5, documents: 10_000, monthly_tokens: 25_000_000,
      monthly_requests: 3_000, team_members: 25, notebooks: 500, audio_overviews: 500,
      export_schedules: 50, storage_mb: 50_000,
    },
    features: [],
    model:  AI_MODELS.ASSISTANT,
    badge:  null,
    legacy: true,
  },
}

// Ordered list of plans that render in pricing/upgrade UIs (legacy hidden).
export const VISIBLE_PLAN_ORDER = ['founding', 'solo', 'group', 'chain'] as const
export type VisiblePlanKey = typeof VISIBLE_PLAN_ORDER[number]

export function getPlan(planName: string): Plan {
  return PLANS[planName] ?? PLANS.solo
}

export function getLimits(planName: string): PlanLimits {
  return getPlan(planName).limits
}

/**
 * Boot-time check that every active plan has both env vars wired up.
 * Safe to call from any server module; only logs (never throws). Use
 * from a route's first request or a startup-time check. Returns the
 * list of missing env var names so callers can decide what to do.
 *
 * FIXES §0ii (Sprint 2 follow-up): the upgrade flow used to silently
 * fall back to a 500 only when a user actually clicked "Upgrade". This
 * surfaces the misconfig at first request instead.
 */
export function checkStripePriceEnvs(): string[] {
  const missing: string[] = []
  for (const [key, plan] of Object.entries(PLANS)) {
    if (plan.legacy) continue                 // skip starter/pro aliases
    if (key === 'trial' || key === 'past_due' || key === 'enterprise') continue
    if (plan.stripe_price_env && !process.env[plan.stripe_price_env]) {
      missing.push(plan.stripe_price_env)
    }
    if (plan.stripe_price_annual_env && !process.env[plan.stripe_price_annual_env]) {
      missing.push(plan.stripe_price_annual_env)
    }
  }
  if (!process.env.STRIPE_PRICE_AI_ADDON) missing.push('STRIPE_PRICE_AI_ADDON')
  return missing
}

/**
 * Reverse-lookup a plan key from a Stripe price ID.
 *
 * Why: the webhook used to do `sub.metadata?.plan || 'solo'` — wrong on
 * two fronts. (1) `'solo'` is a real plan tier, so any subscription
 * missing metadata silently became Solo regardless of what was actually
 * paid for. (2) The metadata is set client-side at checkout-session
 * creation; if a future flow forgets to set it (or the SDK strips it on
 * a webhook replay), every subscription downgrades. Stripe's price.id
 * is server-controlled and cannot drift — that's the safer source of truth.
 *
 * Walks PLANS, resolves each `stripe_price_env` / `stripe_price_annual_env`
 * via `process.env[name]`, and matches against the supplied price ID.
 * Returns null if no plan owns this price (caller decides whether to
 * fall back to metadata or warn loudly).
 *
 * FIXES §0gg (Sprint 2 Task 7).
 */
export function planFromPriceId(priceId: string | null | undefined): string | null {
  if (!priceId) return null
  for (const [planKey, plan] of Object.entries(PLANS)) {
    const monthly = plan.stripe_price_env ? process.env[plan.stripe_price_env] : null
    const annual  = plan.stripe_price_annual_env ? process.env[plan.stripe_price_annual_env] : null
    if (monthly && monthly === priceId) return planKey
    if (annual  && annual  === priceId) return planKey
  }
  return null
}

// Annual pricing: 10 months price for 12 months (2 months free = ~17% off)
export function annualPrice(plan: Plan): number | null {
  if (!plan.price_sek) return null
  return plan.price_sek * 10
}

export function annualMonthlyEquivalent(plan: Plan): number | null {
  if (!plan.price_sek) return null
  return Math.round(plan.price_sek * 10 / 12)
}
