// @ts-nocheck
// app/api/stripe/checkout/route.ts
//
// Creates a Stripe Checkout Session for upgrading to a paid plan.
//
// Flow:
//   User clicks "Upgrade to Starter"
//   â†’ POST /api/stripe/checkout  { plan: 'starter' }
//   â†’ This route creates a Stripe Checkout Session
//   â†’ Returns { url: 'https://checkout.stripe.com/...' }
//   â†’ Frontend redirects user to that URL
//   â†’ User pays on Stripe's hosted page
//   â†’ Stripe redirects back to /dashboard?upgrade=success
//   â†’ Stripe ALSO fires a webhook to /api/stripe/webhook
//   â†’ Webhook updates the org's plan in our database

import { NextRequest, NextResponse } from 'next/server'
import Stripe                        from 'stripe'
import { getOrgFromRequest }         from '@/lib/auth/get-org'
import { createAdminClient }         from '@/lib/supabase/server'
import { rateLimit }                 from '@/lib/middleware/rate-limit'
import { PLANS }                     from '@/lib/stripe/config'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-04-10',
})

export async function POST(req: NextRequest) {
  // â”€â”€ 1. Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const auth = await getOrgFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // â”€â”€ 2. Rate limit (general â€” not AI) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const limit = await rateLimit(req, auth, 'general')
  if (!limit.ok) return limit.response!

  // â”€â”€ 3. Parse + validate plan â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const { plan, annual = false } = await req.json()

  if (!['starter', 'pro'].includes(plan)) {
    return NextResponse.json({ error: 'Invalid plan. Choose starter or pro.' }, { status: 400 })
  }

  if (plan === 'enterprise') {
    // Enterprise doesn't go through self-serve checkout â€” direct to contact
    return NextResponse.json({
      url: `${process.env.NEXT_PUBLIC_APP_URL}/contact?plan=enterprise&org=${auth.orgId}`,
    })
  }

  const planConfig = PLANS[plan]
  const priceEnvKey = planConfig.stripe_price_env
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

  // â”€â”€ 4. Get or create Stripe customer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // We store the Stripe customer ID in our organisations table so we
  // never create duplicate customers for the same org.
  const { data: org } = await supabase
    .from('organisations')
    .select('name, billing_email, stripe_customer_id')
    .eq('id', auth.orgId)
    .single()

  let customerId = org?.stripe_customer_id

  if (!customerId) {
    // First time upgrading â€” create a Stripe customer
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

  // â”€â”€ 5. Create Checkout Session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // Pass metadata so our webhook knows which org to update
        metadata: {
          org_id: auth.orgId,
          plan,
        },
      },

      // Swedish locale and automatic VAT (25% for Swedish B2B)
      locale:                     'sv',
      automatic_tax:              { enabled: true },
      tax_id_collection:          { enabled: true },   // collects org number for VAT
      billing_address_collection: 'required',
      allow_promotion_codes:      true,

      // Redirect URLs
      success_url: `${appUrl}/dashboard?upgrade=success&plan=${plan}`,
      cancel_url:  `${appUrl}/upgrade?cancelled=1`,

      // So we can link the checkout to the org even before subscription is created
      metadata: {
        org_id: auth.orgId,
        plan,
        annual: String(annual),
      },
    })

    return NextResponse.json({ url: session.url })

  } catch (err: any) {
    console.error('Stripe checkout error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
