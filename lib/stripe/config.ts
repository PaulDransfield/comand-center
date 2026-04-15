// lib/stripe/config.ts
//
// PLAN DEFINITIONS — single source of truth for what each plan includes.
// Prices match SAAS_MANIFEST.md exactly.
// To change a plan limit, change it once here and it propagates everywhere.

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
}

export const PLANS: Record<string, Plan> = {

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
      monthly_requests: 600,       // 20/day * 30
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
    model: 'claude-haiku-4-5-20251001',
    badge: null,
  },

  starter: {
    name:                    'Starter',
    price_sek:               499,
    price_usd:               49,
    stripe_price_env:        'STRIPE_PRICE_STARTER',
    stripe_price_annual_env: 'STRIPE_PRICE_STARTER_ANNUAL',
    ai_queries_per_day:      20,
    limits: {
      businesses:       1,
      documents:        500,
      monthly_tokens:   2_000_000,
      monthly_requests: 600,       // 20/day * 30
      team_members:     3,
      notebooks:        20,
      audio_overviews:  20,
      export_schedules: 5,
      storage_mb:       2_000,
    },
    features: [
      '1 restaurant location',
      '20 AI queries per day',
      'Personalkollen integration',
      'Staff, revenue & department analytics',
      'Scheduled reports',
      'Team access (3 users)',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: null,
  },

  pro: {
    name:                    'Pro',
    price_sek:               799,
    price_usd:               79,
    stripe_price_env:        'STRIPE_PRICE_PRO',
    stripe_price_annual_env: 'STRIPE_PRICE_PRO_ANNUAL',
    ai_queries_per_day:      50,
    limits: {
      businesses:       5,
      documents:        5_000,
      monthly_tokens:   10_000_000,
      monthly_requests: 1_500,     // 50/day * 30
      team_members:     10,
      notebooks:        100,
      audio_overviews:  100,
      export_schedules: 20,
      storage_mb:       20_000,
    },
    features: [
      'Up to 5 restaurant locations',
      '50 AI queries per day',
      'All integrations (Personalkollen, Fortnox)',
      'Forecasting & budget tracking',
      'Priority support',
      'Team access (10 users)',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: 'Most Popular',
  },

  group: {
    name:                    'Group',
    price_sek:               1_499,
    price_usd:               149,
    stripe_price_env:        'STRIPE_PRICE_GROUP',
    stripe_price_annual_env: 'STRIPE_PRICE_GROUP_ANNUAL',
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
      'Unlimited restaurant locations',
      'Unlimited AI queries',
      'All integrations',
      'Custom reporting',
      'Dedicated support',
      'Unlimited team members',
    ],
    model: AI_MODELS.ASSISTANT,
    badge: 'Best Value',
  },

  // past_due is a temporary state after payment failure.
  // Access is restricted by the UI. Limits match starter so data stays intact.
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
}

export function getPlan(planName: string): Plan {
  return PLANS[planName] ?? PLANS.trial
}

export function getLimits(planName: string): PlanLimits {
  return getPlan(planName).limits
}

// Annual pricing: 10 months price for 12 months (2 months free)
export function annualPrice(plan: Plan): number | null {
  if (!plan.price_sek) return null
  return plan.price_sek * 10   // total annual amount in SEK
}

export function annualMonthlyEquivalent(plan: Plan): number | null {
  if (!plan.price_sek) return null
  return Math.round(plan.price_sek * 10 / 12)  // per-month equivalent when paying annually
}
