// @ts-nocheck
// lib/stripe/config.ts
//
// PLAN DEFINITIONS â€” the single source of truth for what each plan includes.
//
// Every part of the app that enforces limits imports from here.
// To change a plan limit, change it once here and it propagates everywhere.

export interface PlanLimits {
  businesses:        number
  documents:         number
  monthly_tokens:    number
  monthly_requests:  number
  team_members:      number
  notebooks:         number
  audio_overviews:   number
  export_schedules:  number
  storage_mb:        number
}

export interface Plan {
  name:             string
  price_sek:        number | null
  price_usd:        number | null
  stripe_price_env: string | null
  limits:           PlanLimits
  features:         string[]
  model:            string
  badge:            string | null
}

export const PLANS: Record<string, Plan> = {
  trial: {
    name:             'Free Trial',
    price_sek:        0,
    price_usd:        0,
    stripe_price_env: null,
    limits: {
      businesses:       2,
      documents:        50,
      monthly_tokens:   500_000,
      monthly_requests: 200,
      team_members:     1,
      notebooks:        3,
      audio_overviews:  3,
      export_schedules: 1,
      storage_mb:       100,
    },
    features: [
      '2 restaurant locations',
      '50 documents',
      '500k AI tokens / month',
      'PDF & Excel exports',
      'Basic cost tracker',
    ],
    model: 'claude-haiku-4-5-20251001',
    badge: null,
  },

  starter: {
    name:             'Starter',
    price_sek:        499,
    price_usd:        29,
    stripe_price_env: 'STRIPE_PRICE_STARTER',
    limits: {
      businesses:       5,
      documents:        500,
      monthly_tokens:   2_000_000,
      monthly_requests: 1_000,
      team_members:     3,
      notebooks:        20,
      audio_overviews:  20,
      export_schedules: 5,
      storage_mb:       2_000,
    },
    features: [
      '5 restaurant locations',
      '500 documents',
      '2M AI tokens / month',
      'Fortnox integration',
      'Scheduled reports',
      'Team access (3 users)',
    ],
    model: 'claude-sonnet-4-6',
    badge: null,
  },

  pro: {
    name:             'Pro',
    price_sek:        999,
    price_usd:        79,
    stripe_price_env: 'STRIPE_PRICE_PRO',
    limits: {
      businesses:       20,
      documents:        5_000,
      monthly_tokens:   10_000_000,
      monthly_requests: 5_000,
      team_members:     10,
      notebooks:        100,
      audio_overviews:  100,
      export_schedules: 20,
      storage_mb:       20_000,
    },
    features: [
      '20 restaurant locations',
      '5 000 documents',
      '10M AI tokens / month',
      'All integrations',
      'Priority support',
      'BankID authentication',
      'Team access (10 users)',
    ],
    model: 'claude-sonnet-4-6',
    badge: 'Most Popular',
  },

  past_due: {
    // past_due is a temporary state when a payment fails.
    // Copy starter limits â€” access is restricted by the UI, not by changing limits.
    name:             'Payment failed',
    price_sek:        null,
    price_usd:        null,
    stripe_price_env: null,
    limits: {
      businesses:       5,
      documents:        500,
      monthly_tokens:   0,          // no AI until payment is sorted
      monthly_requests: 0,
      team_members:     3,
      notebooks:        20,
      audio_overviews:  0,
      export_schedules: 0,
      storage_mb:       2_000,
    },
    features: [],
    model: 'claude-haiku-4-5-20251001',
    badge: null,
  },

  enterprise: {
    name:             'Enterprise',
    price_sek:        null,
    price_usd:        null,
    stripe_price_env: null,
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
      'Unlimited documents',
      'Unlimited AI usage',
      'Dedicated support',
      'Custom integrations',
      'SLA guarantee',
    ],
    model: 'claude-sonnet-4-6',
    badge: 'Custom',
  },
}

export function getPlan(planName: string): Plan {
  return PLANS[planName] ?? PLANS.trial
}

export function getLimits(planName: string): PlanLimits {
  return getPlan(planName).limits
}
