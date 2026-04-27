// @ts-nocheck
// app/api/stripe/webhook/route.ts
//
// STRIPE WEBHOOK HANDLER — receives events from Stripe and updates our database.
//
// CRITICAL: This route MUST read the raw request body (not parsed JSON).
// Stripe signs each webhook with a signature we verify using the raw bytes.
//
// Two correctness invariants this handler now enforces:
//
//   1. **Idempotency via event-id dedup.** Stripe may re-deliver the same
//      event if we time out or 5xx. We record the event id in the
//      `stripe_processed_events` table inside the same write as our
//      domain mutation — a replay no-ops instead of double-writing.
//
//   2. **Fail-open on real DB errors.** If our DB write fails, we return
//      5xx so Stripe retries. Previously we returned 200 in all cases,
//      which masked failures — subscription state silently drifted from
//      Stripe's source of truth.
//
// Register this URL in your Stripe Dashboard:
//   Developers → Webhooks → Add endpoint
//   URL: https://yourapp.vercel.app/api/stripe/webhook
//   Events: all "customer.subscription.*", "invoice.*", "checkout.session.*", "charge.refunded"
// Copy the "Signing secret" from Stripe and add it to .env as STRIPE_WEBHOOK_SECRET

import { NextRequest, NextResponse } from 'next/server'
import Stripe                        from 'stripe'
import { createAdminClient }         from '@/lib/supabase/server'
import { log }                       from '@/lib/log/structured'
import { planFromPriceId }           from '@/lib/stripe/config'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' })

export const dynamic     = 'force-dynamic'
export const runtime     = 'nodejs'
export const maxDuration = 30

export async function POST(req: NextRequest) {
  // ── 1. Read raw body ─────────────────────────────────────────────
  const body      = await req.text()
  const signature = req.headers.get('stripe-signature')

  if (!signature) {
    return NextResponse.json({ error: 'Missing Stripe signature' }, { status: 400 })
  }

  // ── 2. Verify signature ──────────────────────────────────────────
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(
      body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    )
  } catch (err: any) {
    console.error('[stripe-webhook] signature verification failed:', err.message)
    return NextResponse.json({ error: `Webhook error: ${err.message}` }, { status: 400 })
  }

  const supabase = createAdminClient()

  // ── 3. Dedup check ───────────────────────────────────────────────
  // Insert the event id first. If it already exists (409/duplicate),
  // this is a replay — we already processed it, so acknowledge with
  // 200 without doing the work again.
  const { error: dedupErr } = await supabase
    .from('stripe_processed_events')
    .insert({ event_id: event.id, event_type: event.type })

  if (dedupErr) {
    if (dedupErr.code === '23505' || /duplicate key/i.test(dedupErr.message ?? '')) {
      log.info('stripe-webhook duplicate event skipped', {
        route:      'stripe/webhook',
        event_id:   event.id,
        event_type: event.type,
        status:     'duplicate',
      })
      return NextResponse.json({ received: true, duplicate: true, type: event.type })
    }
    log.error('stripe-webhook dedup insert failed', {
      route:      'stripe/webhook',
      event_id:   event.id,
      event_type: event.type,
      error:      dedupErr.message,
      status:     'error',
    })
    return NextResponse.json({ error: `DB error: ${dedupErr.message}` }, { status: 500 })
  }

  // ── 4. Process ───────────────────────────────────────────────────
  const started = Date.now()
  try {
    await handleEvent(event, supabase)
    log.info('stripe-webhook processed', {
      route:       'stripe/webhook',
      duration_ms: Date.now() - started,
      event_id:    event.id,
      event_type:  event.type,
      status:      'success',
    })
    return NextResponse.json({ received: true, type: event.type })
  } catch (err: any) {
    await supabase.from('stripe_processed_events').delete().eq('event_id', event.id)
    log.error('stripe-webhook handler failed', {
      route:       'stripe/webhook',
      duration_ms: Date.now() - started,
      event_id:    event.id,
      event_type:  event.type,
      error:       err?.message ?? 'handler error',
      status:      'error',
    })
    return NextResponse.json({ error: err?.message ?? 'handler error' }, { status: 500 })
  }
}

// ── Event handlers ──────────────────────────────────────────────────

async function handleEvent(event: Stripe.Event, supabase: any) {
  switch (event.type) {

    // ── Subscription created or changed (upgrade, downgrade) ──────
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.org_id

      if (!orgId) {
        console.warn(`Subscription ${sub.id} has no org_id metadata — skipping`)
        return
      }

      // FIXES §0gg (Sprint 2 Task 7): resolve plan from price.id, not
      // metadata. The previous `sub.metadata?.plan || 'solo'` silently
      // downgraded any subscription missing metadata to Solo regardless
      // of what was actually paid for. price.id is server-controlled and
      // can't drift, so it's the source of truth. Metadata stays as the
      // fallback for old test subs from before the price-env vars were
      // wired up; if both are absent we abort instead of guessing.
      const priceId = sub.items?.data?.[0]?.price?.id ?? null
      const planFromPrice = planFromPriceId(priceId)
      const plan = planFromPrice ?? sub.metadata?.plan ?? null

      if (!plan) {
        console.error(`Subscription ${sub.id} price ${priceId} matches no known plan and metadata.plan is unset — refusing to write`)
        return
      }
      if (planFromPrice && sub.metadata?.plan && planFromPrice !== sub.metadata.plan) {
        console.warn(`Subscription ${sub.id}: price.id maps to "${planFromPrice}" but metadata.plan says "${sub.metadata.plan}" — trusting price.id`)
      }

      await updateOrg(supabase, orgId, {
        plan,
        stripe_subscription_id: sub.id,
        is_active: ['active', 'trialing'].includes(sub.status),
      })

      await logBillingEvent(supabase, orgId, event.type, plan)
      console.log(`Org ${orgId} → plan: ${plan}, status: ${sub.status}`)
      break
    }

    // ── Checkout completed (first payment) ─────────────────────────
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const orgId   = session.metadata?.org_id
      const plan    = session.metadata?.plan

      if (!orgId || session.mode !== 'subscription') return

      const isAddon = plan === 'ai_addon' ||
        session.metadata?.product_type === 'ai_addon' ||
        String(process.env.STRIPE_PRICE_AI_ADDON) === (session as any).line_items?.data?.[0]?.price?.id

      if (isAddon) {
        await updateOrg(supabase, orgId, { ai_addon: true })
        await logBillingEvent(supabase, orgId, 'addon_activated', 'ai_addon')
      } else {
        await updateOrg(supabase, orgId, {
          plan,
          billing_email: session.customer_email || undefined,
          is_active:     true,
        })
        await logBillingEvent(supabase, orgId, 'checkout_completed', plan)
      }
      break
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice
      const orgId   = await orgFromCustomer(supabase, invoice.customer as string)
      if (!orgId) return
      await updateOrg(supabase, orgId, { is_active: true })
      await logBillingEvent(supabase, orgId, 'payment_succeeded', null, invoice.amount_paid)
      break
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice
      const orgId   = await orgFromCustomer(supabase, invoice.customer as string)
      if (!orgId) return
      await updateOrg(supabase, orgId, { plan: 'past_due' })
      await logBillingEvent(supabase, orgId, 'payment_failed', null, invoice.amount_due)
      console.warn(`Payment failed for org ${orgId}. Amount: ${invoice.amount_due}`)
      break
    }

    case 'customer.subscription.deleted': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.org_id ?? await orgFromCustomer(supabase, sub.customer as string)
      if (!orgId) return
      await updateOrg(supabase, orgId, {
        plan:                   'trial',
        stripe_subscription_id: null,
        is_active:              false,
      })
      await logBillingEvent(supabase, orgId, 'subscription_cancelled')
      break
    }

    case 'customer.subscription.trial_will_end': {
      const sub   = event.data.object as Stripe.Subscription
      const orgId = sub.metadata?.org_id
      if (!orgId) return
      console.log(`Trial ending soon for org ${orgId}`)
      break
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      const orgId  = await orgFromCustomer(supabase, charge.customer as string)
      if (orgId) await logBillingEvent(supabase, orgId, 'refund_issued', null, -(charge.amount_refunded))
      break
    }

    default:
      break
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
// These now THROW on error — the top-level handler catches, rolls back
// the dedup row, and 5xxs so Stripe retries. Silent failure is over.

async function updateOrg(supabase: any, orgId: string, patch: Record<string, any>) {
  const { error } = await supabase
    .from('organisations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', orgId)
  if (error) throw new Error(`updateOrg(${orgId}) failed: ${error.message}`)
}

async function orgFromCustomer(supabase: any, customerId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('organisations')
    .select('id')
    .eq('stripe_customer_id', customerId)
    .maybeSingle()
  if (error) throw new Error(`orgFromCustomer lookup failed: ${error.message}`)
  return data?.id ?? null
}

async function logBillingEvent(
  supabase:   any,
  orgId:      string,
  eventType:  string,
  plan?:      string | null,
  amountOre?: number,
) {
  const { error } = await supabase.from('billing_events').insert({
    org_id:     orgId,
    event_type: eventType,
    plan:       plan ?? null,
    amount_ore: amountOre ?? null,
  })
  if (error) throw new Error(`logBillingEvent failed: ${error.message}`)
}
