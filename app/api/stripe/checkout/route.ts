// @ts-nocheck
// app/api/stripe/checkout/route.ts
//
// Creates a Stripe Checkout Session for upgrading to a paid plan.
//
// Flow:
//   User clicks "Upgrade to Starter"
//   → POST /api/stripe/checkout  { plan: 'starter' }
//   → This route creates a Stripe Checkout Session
//   → Returns { url: 'https://checkout.stripe.com/...' }
//   → Frontend redirects user to that URL
//   → User pays on Stripe's hosted page
//   → Stripe redirects back to /dashboard?upgrade=success
//   → Stripe ALSO fires a webhook to /api/stripe/webhook
//   → Webhook updates the org's plan in our database

import { NextRequest, NextResponse } from 'next/server'
import Stripe                        from 'stripe'
import { getOrgFromRequest }         from '@/lib/auth/get-org'
import { createAdminClient }         from '@/lib/supabase/server'
import { rateLimit }                 from '@/lib/middleware/rate-limit'
import { orgRateLimit }              from '@/lib/middleware/org-rate-limit'
import { PLANS }                     from '@/lib/stripe/config'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-04-10',
})

export async function POST(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────
  const auth = await getOrgFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── 2. Rate limits ────────────────────────────────────────────
  // Two layers:
  //   - Per-user, in-memory: 20 attempts/hour. Guards against a UI bug
  //     or a single user hammering the button. Resets on cold start.
  //   - Per-org, persistent (DB-backed): 5 checkout sessions/hour and
  //     20/day. Guards against a compromised session or rogue script
  //     burning real money on stripe.customers.create + checkout.sessions.create.
  const limit = rateLimit(auth.userId, { windowMs: 60 * 60_000, max: 20 })
  if (!limit.allowed) return NextResponse.json({ error: 'Too many requests' }, { status: 429 })

  const orgHour = await orgRateLimit({ orgId: auth.orgId, bucket: 'stripe_checkout_hour', windowMs: 60 * 60_000, max: 5 })
  if (!orgHour.ok) {
    return NextResponse.json({
      error: 'Checkout attempt limit reached for this organisation. Try again in a few minutes.',
      retry_after_seconds: Math.ceil((orgHour.retryAfterMs ?? 0) / 1000),
    }, { status: 429 })
  }
  const orgDay = await orgRateLimit({ orgId: auth.orgId, bucket: 'stripe_checkout_day', windowMs: 24 * 60 * 60_000, max: 20 })
  if (!orgDay.ok) {
    return NextResponse.json({
      error: 'Daily checkout attempt limit reached for this organisation.',
      retry_after_seconds: Math.ceil((orgDay.retryAfterMs ?? 0) / 1000),
    }, { status: 429 })
  }

  // ── 3. Parse + validate plan ───────────────────────────────────
  const { plan, annual = false } = await req.json()

  const validPlans = ['founding', 'solo', 'group', 'chain', 'ai_addon', 'starter', 'pro']
  if (!validPlans.includes(plan)) {
    return NextResponse.json({ error: 'Invalid plan. Choose founding, solo, group, chain, or ai_addon.' }, { status: 400 })
  }

  // AI add-on is a separate product, not a plan in PLANS config
  const isAddon = plan === 'ai_addon'

  // Pick monthly or annual price ID based on billing toggle
  let priceEnvKey: string | null
  if (isAddon) {
    priceEnvKey = 'STRIPE_PRICE_AI_ADDON'
  } else {
    const planConfig = PLANS[plan]
    priceEnvKey = annual
      ? (planConfig.stripe_price_annual_env ?? planConfig.stripe_price_env)
      : planConfig.stripe_price_env
  }

  if (!priceEnvKey) {
    return NextResponse.json({ error: 'Plan not configured' }, { status: 500 })
  }

  const priceId = process.env[priceEnvKey]
  if (!priceId) {
    return NextResponse.json({
      error: `Stripe price not configured. Add ${priceEnvKey} to your environment variables.`,
    }, { status: 500 })
  }

  const supabase = createAdminClient()

  // ── 4. Get or create Stripe customer ───────────────────────────
  // We store the Stripe customer ID in our organisations table so we
  // never create duplicate customers for the same org.
  const { data: org } = await supabase
    .from('organisations')
    .select('name, billing_email, stripe_customer_id')
    .eq('id', auth.orgId)
    .single()

  let customerId = org?.stripe_customer_id

  if (!customerId) {
    // First time upgrading — create a Stripe customer
    const customer = await stripe.customers.create({
      name:     org?.name,
      email:    org?.billing_email || undefined,
      metadata: { org_id: auth.orgId },   // link back to our DB
    })
    customerId = customer.id

    // Save customer ID so we don't create a duplicate next time
    await supabase
      .from('organisations')
      .update({ stripe_customer_id: customerId })
      .eq('id', auth.orgId)
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL!

  // ── 5. Create Checkout Session ─────────────────────────────────
  try {
    const session = await stripe.checkout.sessions.create({
      customer:             customerId,
      mode:                 'subscription',
      payment_method_types: ['card'],

      line_items: [{
        price:    priceId,
        quantity: 1,
      }],

      subscription_data: {
        // Webhook reads these to know which org and product to activate
        metadata: {
          org_id:       auth.orgId,
          plan,
          product_type: isAddon ? 'ai_addon' : 'plan',
        },
      },

      // Swedish locale and automatic VAT (25% for Swedish B2B)
      locale:                     'sv',
      automatic_tax:              { enabled: true },
      tax_id_collection:          { enabled: true },
      billing_address_collection: 'required',
      allow_promotion_codes:      true,

      // Redirect URLs — add-on goes back to upgrade page, plan changes to dashboard
      success_url: isAddon
        ? `${appUrl}/upgrade?addon=success`
        : `${appUrl}/dashboard?upgrade=success&plan=${plan}`,
      cancel_url:  `${appUrl}/upgrade?cancelled=1`,

      metadata: {
        org_id:       auth.orgId,
        plan,
        annual:       String(annual),
        product_type: isAddon ? 'ai_addon' : 'plan',
      },
    })

    return NextResponse.json({ url: session.url })

  } catch (err: any) {
    console.error('Stripe checkout error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
