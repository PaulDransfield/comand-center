/**
 * stripe-checkout.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Two files in one — copy each section to the appropriate path:
 *
 *   Section A → pages/api/checkout/create-session.js
 *   Section B → pages/api/webhooks/stripe.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ════════════════════════════════════════════════════════════════════════════
// SECTION A: pages/api/checkout/create-session.js
// Creates a Stripe Checkout session and returns the URL to redirect to.
// ════════════════════════════════════════════════════════════════════════════

import Stripe from 'stripe';
import { checkTrial } from '@/lib/trial-middleware';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Your Stripe Price IDs — create these in the Stripe dashboard
// Dashboard → Products → Add product → Add price (recurring, monthly)
const PRICE_IDS = {
  starter:    process.env.STRIPE_PRICE_STARTER,    // e.g. price_1234567890
  pro:        process.env.STRIPE_PRICE_PRO,
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verify the user is authenticated (read-only check — even expired users can upgrade)
  const { orgId, userId } = await checkTrial(req, res, { allowReadOnly: true });
  if (!orgId) return; // response already sent

  const { plan = 'starter' } = req.body;
  const priceId = PRICE_IDS[plan];
  if (!priceId) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode:                 'subscription',
      payment_method_types: ['card'],
      line_items: [{
        price:    priceId,
        quantity: 1,
      }],
      // Pass org_id and plan through to the webhook
      metadata: {
        org_id: orgId,
        user_id: userId,
        plan,
      },
      // These URLs are where Stripe redirects after payment
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/dashboard?upgraded=true`,
      cancel_url:  `${process.env.NEXT_PUBLIC_APP_URL}/upgrade?cancelled=true`,
      // Pre-fill email if we have it
      customer_email: req.body.email || undefined,
      // Show trial info in the checkout
      subscription_data: {
        metadata: { org_id: orgId, plan },
      },
      // Allow promotion codes
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
}


// ════════════════════════════════════════════════════════════════════════════
// SECTION B: pages/api/webhooks/stripe.js
// Receives events from Stripe (payment success, cancellation, etc.)
// IMPORTANT: This route must disable body parsing — Stripe needs the raw body
// ════════════════════════════════════════════════════════════════════════════

import { buffer } from 'micro';
import { handleStripeWebhook } from '@/lib/trial-middleware';

// Disable Next.js body parsing — Stripe needs raw bytes for signature verification
export const config = { api: { bodyParser: false } };

export default async function stripeWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const sig       = req.headers['stripe-signature'];
  const rawBody   = await buffer(req);
  const stripe_wh = new Stripe(process.env.STRIPE_SECRET_KEY);

  let event;
  try {
    // Verify the webhook is actually from Stripe (not a spoofed request)
    event = stripe_wh.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET   // get from Stripe Dashboard → Webhooks
    );
  } catch (err) {
    console.error('Stripe webhook signature invalid:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    await handleStripeWebhook(event);
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
}
