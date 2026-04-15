// @ts-nocheck
// app/api/stripe/webhook/route.ts
//
// STRIPE WEBHOOK HANDLER â€” receives events from Stripe and updates our database.
//
// âš ï¸  CRITICAL: This route MUST read the raw request body (not parsed JSON).
//     Stripe signs each webhook with a signature we verify using the raw bytes.
//     If the body is parsed/transformed, verification fails and we reject the event.
//
// Register this URL in your Stripe Dashboard:
//   Developers â†’ Webhooks â†’ Add endpoint
//   URL: https://yourapp.vercel.app/api/stripe/webhook
//   Events to subscribe: all "customer.subscription.*", "invoice.*", "checkout.session.*", "charge.refunded"
//
// Copy the "Signing secret" from Stripe and add it to .env as STRIPE_WEBHOOK_SECRET

import { NextRequest, NextResponse } from 'next/server'
import Stripe                        from 'stripe'
import { createAdminClient }         from '@/lib/supabase/server'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' })

// Tell Next.js NOT to parse the body â€” we need the raw bytes for signature verification
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // â”€â”€ 1. Read raw body â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const body      = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing Stripe signature' }, { status: 400 })
  }

  // â”€â”€ 2. Verify signature â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // This proves the event came from Stripe, not from someone else hitting our endpoint
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    )
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message)
    return NextResponse.json({ error: `Webhook error: ${err.message}` }, { status: 400 })
  }

  // â”€â”€ 3. Handle event â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const supabase = createAdminClient()

  try {
    await handleEvent(event, supabase)
    // Always return 200 â€” Stripe retries on anything else
    return NextResponse.json({ received: true, type: event.type })
  } catch (err: any) {
    console.error(`Webhook handler failed for ${event.type}:`, err)
    // Return 200 anyway â€” the error is logged, retrying won't help
    return NextResponse.json({ received: true, error: err.message })
  }
}

// â”€â”€ Event handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function handleEvent(event: Stripe.Event, supabase: any) {
  switch (event.type) {

    // â”€â”€ Subscription created or changed (upgrade, downgrade) â”€â”€â”€â”€â”€
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.org_id
      const plan  = sub.metadata?.plan || 'starter'

      if (!orgId) {
        console.warn(`Subscription ${sub.id} has no org_id metadata â€” skipping`)
        return
      }

      await updateOrg(supabase, orgId, {
        plan,
        stripe_subscription_id: sub.id,
        is_active: ['active', 'trialing'].includes(sub.status),
      })

      await logBillingEvent(supabase, orgId, event.type, plan)
      console.log(`Org ${orgId} â†’ plan: ${plan}, status: ${sub.status}`)
      break
    }

    // â”€â”€ Checkout completed (first payment) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const orgId   = session.metadata?.org_id
      const plan    = session.metadata?.plan

      if (!orgId || session.mode !== 'subscription') return

      await updateOrg(supabase, orgId, {
        plan,
        billing_email: session.customer_email || undefined,
        is_active:     true,
      })

      await logBillingEvent(supabase, orgId, 'checkout_completed', plan)
      // TODO: send welcome email via Resend
      break
    }

    // â”€â”€ Payment succeeded (recurring) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice
      const orgId   = await orgFromCustomer(supabase, invoice.customer as string)
      if (!orgId) return

      // Ensure account is active (it may have been past_due)
      await updateOrg(supabase, orgId, { is_active: true })
      await logBillingEvent(supabase, orgId, 'payment_succeeded', null, invoice.amount_paid)
      break
    }

    // â”€â”€ Payment failed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Stripe retries automatically. We restrict access but keep all data.
    case 'invoice.payment_failed': {
      const invoice    = event.data.object as Stripe.Invoice
      const orgId      = await orgFromCustomer(supabase, invoice.customer as string)
      if (!orgId) return

      await updateOrg(supabase, orgId, { plan: 'past_due' })
      await logBillingEvent(supabase, orgId, 'payment_failed', null, invoice.amount_due)
      // TODO: send payment failed email via Resend
      console.warn(`Payment failed for org ${orgId}. Amount: ${invoice.amount_due}`)
      break
    }

    // â”€â”€ Subscription cancelled (by user or after multiple failed payments) â”€â”€
    case 'customer.subscription.deleted': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.org_id ?? await orgFromCustomer(supabase, sub.customer as string)
      if (!orgId) return

      // Downgrade to trial â€” they lose paid features but keep their data
      await updateOrg(supabase, orgId, {
        plan:                   'trial',
        stripe_subscription_id: null,
        is_active:              false,
      })
      await logBillingEvent(supabase, orgId, 'subscription_cancelled')
      // TODO: send cancellation email via Resend
      break
    }

    // â”€â”€ Trial ending in 3 days â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'customer.subscription.trial_will_end': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.org_id
      if (!orgId) return
      // TODO: send trial-ending email via Resend with upgrade CTA
      console.log(`Trial ending soon for org ${orgId}`)
      break
    }

    // â”€â”€ Refund issued â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      const orgId  = await orgFromCustomer(supabase, charge.customer as string)
      if (orgId) await logBillingEvent(supabase, orgId, 'refund_issued', null, -(charge.amount_refunded))
      break
    }

    default:
      // Unhandled event type â€” not an error, Stripe sends many event types
      break
  }
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function updateOrg(supabase: any, orgId: string, patch: Record<string, any>) {
  const { error } = await supabase
    .from('organisations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', orgId)
  if (error) console.error('updateOrg failed:', error)
}

async function orgFromCustomer(supabase: any, customerId: string): Promise<string | null> {
  const { data } = await supabase
    .from('organisations')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  return data?.id ?? null
}

async function logBillingEvent(
  supabase:   any,
  orgId:      string,
  eventType:  string,
  plan?:      string | null,
  amountOre?: number
) {
  await supabase.from('billing_events').insert({
    org_id:     orgId,
    event_type: eventType,
    plan:       plan ?? null,
    amount_ore: amountOre ?? null,
  }).then(({ error }: any) => {
    if (error) console.error('logBillingEvent failed:', error)
  })
}
