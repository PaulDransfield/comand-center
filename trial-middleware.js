/**
 * trial-middleware.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Drop this into your Next.js /lib folder.
 * Import and call checkTrial(req) at the top of every API route that needs
 * to enforce trial restrictions.
 *
 * Usage in an API route:
 *   import { checkTrial } from '@/lib/trial-middleware';
 *   export default async function handler(req, res) {
 *     const trial = await checkTrial(req, res);
 *     if (!trial.allowed) return; // response already sent
 *     // ... your route logic
 *   }
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js';

// ── CONSTANTS ────────────────────────────────────────────────────────────────
export const TRIAL_DAYS          = 30;
export const GRACE_PERIOD_DAYS   = 7;
export const TRIAL_MAX_BUSINESSES = 2;
export const TRIAL_MAX_DOCUMENTS  = 50;

// Plans and what they unlock
export const PLANS = {
  trial:      { businesses: 2,         documents: 50,        label: 'Trial'      },
  starter:    { businesses: 3,         documents: 500,       label: 'Starter'    },
  pro:        { businesses: 10,        documents: 5000,      label: 'Pro'        },
  enterprise: { businesses: Infinity,  documents: Infinity,  label: 'Enterprise' },
};

// ── SUPABASE CLIENT (server-side) ────────────────────────────────────────────
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service role — full DB access, server only
);

// ── CORE TRIAL CHECK ─────────────────────────────────────────────────────────

/**
 * getTrialStatus(orgId)
 * Returns a rich status object describing the org's trial/subscription state.
 * Call this anywhere — API routes, server components, middleware.
 */
export async function getTrialStatus(orgId) {
  const { data: org, error } = await supabase
    .from('organisations')
    .select('id, name, plan, trial_start, trial_end, is_active, stripe_subscription_id')
    .eq('id', orgId)
    .single();

  if (error || !org) {
    return { status: 'error', allowed: false, error: 'Organisation not found' };
  }

  const now          = new Date();
  const trialEnd     = org.trial_end ? new Date(org.trial_end) : null;
  const graceEnd     = trialEnd ? new Date(trialEnd.getTime() + GRACE_PERIOD_DAYS * 86400000) : null;
  const daysLeft     = trialEnd ? Math.ceil((trialEnd - now) / 86400000) : null;
  const graceDaysLeft= graceEnd ? Math.ceil((graceEnd - now) / 86400000) : null;

  // ── Paid subscriber ──────────────────────────────────────────────────────
  if (org.plan !== 'trial' && org.is_active) {
    return {
      status:        'paid',
      allowed:       true,
      readOnly:      false,
      plan:          org.plan,
      limits:        PLANS[org.plan] || PLANS.starter,
      daysLeft:      null,
      graceDaysLeft: null,
      trialEnd:      null,
      message:       null,
    };
  }

  // ── Active trial ─────────────────────────────────────────────────────────
  if (org.plan === 'trial' && trialEnd && now < trialEnd) {
    return {
      status:        'trial_active',
      allowed:       true,
      readOnly:      false,
      plan:          'trial',
      limits:        PLANS.trial,
      daysLeft,
      graceDaysLeft: null,
      trialEnd:      trialEnd.toISOString(),
      message:       daysLeft <= 7
        ? `Your trial ends in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}. Upgrade to keep full access.`
        : `${daysLeft} days remaining in your trial.`,
      showUrgent:    daysLeft <= 3,
    };
  }

  // ── Grace period (trial ended, not yet paid) ──────────────────────────────
  if (org.plan === 'trial' && trialEnd && now >= trialEnd && graceEnd && now < graceEnd) {
    return {
      status:        'grace_period',
      allowed:       true,
      readOnly:      true,   // READ ONLY during grace
      plan:          'trial',
      limits:        PLANS.trial,
      daysLeft:      0,
      graceDaysLeft,
      trialEnd:      trialEnd.toISOString(),
      message:       `Your trial ended. You have ${graceDaysLeft} day${graceDaysLeft !== 1 ? 's' : ''} to upgrade before your data is locked.`,
      showUrgent:    true,
    };
  }

  // ── Fully expired ────────────────────────────────────────────────────────
  return {
    status:        'expired',
    allowed:       false,
    readOnly:      true,
    plan:          'trial',
    limits:        PLANS.trial,
    daysLeft:      0,
    graceDaysLeft: 0,
    trialEnd:      trialEnd?.toISOString(),
    message:       'Your trial has expired. Please upgrade to continue.',
    showUrgent:    true,
  };
}

/**
 * checkTrial(req, res, options)
 * Use this at the top of API route handlers.
 * Returns the trial status object, or sends a 402/403 response and returns null.
 *
 * options.allowReadOnly — if true, grace period (read-only) requests are allowed
 * options.action — 'read' | 'write' | 'admin' — controls what's checked
 */
export async function checkTrial(req, res, options = {}) {
  const { allowReadOnly = false, action = 'write' } = options;

  // Get org_id from JWT (Supabase sets this in the request)
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    res.status(401).json({ error: 'Not authenticated' });
    return { allowed: false };
  }

  // Verify JWT and extract org_id
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return { allowed: false };
  }

  // Get org membership
  const { data: membership } = await supabase
    .from('organisation_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .single();

  if (!membership) {
    res.status(403).json({ error: 'No organisation found' });
    return { allowed: false };
  }

  const trial = await getTrialStatus(membership.org_id);
  trial.orgId  = membership.org_id;
  trial.userId = user.id;
  trial.role   = membership.role;

  // ── Expired — block all requests ────────────────────────────────────────
  if (trial.status === 'expired') {
    res.status(402).json({
      error:          'trial_expired',
      message:        trial.message,
      upgrade_url:    '/upgrade',
    });
    return { allowed: false };
  }

  // ── Grace period — block write operations ────────────────────────────────
  if (trial.status === 'grace_period' && action === 'write' && !allowReadOnly) {
    res.status(402).json({
      error:          'grace_period_read_only',
      message:        trial.message,
      upgrade_url:    '/upgrade',
      grace_days_left: trial.graceDaysLeft,
    });
    return { allowed: false };
  }

  return { allowed: true, ...trial };
}

/**
 * checkLimit(orgId, limitType)
 * Check if an org has hit a usage limit before allowing an action.
 *
 * limitType: 'businesses' | 'documents'
 */
export async function checkLimit(orgId, limitType) {
  const trial  = await getTrialStatus(orgId);
  const limits = trial.limits || PLANS.trial;

  if (limitType === 'businesses') {
    const { count } = await supabase
      .from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId)
      .eq('is_active', true);

    return {
      current:   count || 0,
      limit:     limits.businesses,
      exceeded:  (count || 0) >= limits.businesses,
      message:   `You've reached the ${limits.businesses}-business limit on your ${trial.plan} plan. Upgrade to add more.`,
    };
  }

  if (limitType === 'documents') {
    const { count } = await supabase
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', orgId);

    return {
      current:   count || 0,
      limit:     limits.documents,
      exceeded:  (count || 0) >= limits.documents,
      message:   `You've reached the ${limits.documents}-document limit on your ${trial.plan} plan. Upgrade to upload more.`,
    };
  }

  return { exceeded: false };
}

// ── TRIAL CREATION (call at signup) ─────────────────────────────────────────

/**
 * initialiseTrial(orgId)
 * Call this immediately after creating a new organisation.
 * Sets trial_start, trial_end, and creates the onboarding_progress record.
 */
export async function initialiseTrial(orgId) {
  const now      = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DAYS * 86400000);

  const { error } = await supabase
    .from('organisations')
    .update({
      plan:        'trial',
      trial_start: now.toISOString(),
      trial_end:   trialEnd.toISOString(),
      is_active:   true,
      updated_at:  now.toISOString(),
    })
    .eq('id', orgId);

  if (error) throw new Error(`Failed to initialise trial: ${error.message}`);

  // Create onboarding progress record
  await supabase.from('onboarding_progress').upsert({
    org_id:          orgId,
    current_step:    1,
    steps_completed: [],
  });

  return { trial_start: now, trial_end: trialEnd };
}

// ── STRIPE WEBHOOK HANDLER ───────────────────────────────────────────────────

/**
 * handleStripeWebhook(event)
 * Call this from your /api/webhooks/stripe endpoint.
 * Activates, deactivates, or updates subscription based on Stripe events.
 */
export async function handleStripeWebhook(event) {
  const now = new Date().toISOString();

  switch (event.type) {

    case 'checkout.session.completed': {
      // Payment succeeded — activate subscription
      const session = event.data.object;
      const orgId   = session.metadata?.org_id;
      const plan    = session.metadata?.plan || 'starter';
      if (!orgId) break;

      await supabase.from('organisations').update({
        plan,
        is_active:               true,
        stripe_customer_id:      session.customer,
        stripe_subscription_id:  session.subscription,
        updated_at:              now,
      }).eq('id', orgId);

      // Log the activation
      await supabase.from('billing_events').insert({
        org_id:     orgId,
        event_type: 'subscription_activated',
        plan,
        stripe_event_id: event.id,
        created_at:      now,
      });
      break;
    }

    case 'customer.subscription.deleted': {
      // Subscription cancelled
      const sub   = event.data.object;
      const { data: org } = await supabase
        .from('organisations')
        .select('id')
        .eq('stripe_subscription_id', sub.id)
        .single();

      if (org) {
        await supabase.from('organisations').update({
          plan:       'trial',    // revert to trial (which is now expired)
          is_active:  false,
          updated_at: now,
        }).eq('id', org.id);
      }
      break;
    }

    case 'invoice.payment_failed': {
      // Payment failed — notify but don't immediately cut off
      const invoice = event.data.object;
      const { data: org } = await supabase
        .from('organisations')
        .select('id')
        .eq('stripe_customer_id', invoice.customer)
        .single();

      if (org) {
        await supabase.from('billing_events').insert({
          org_id:          org.id,
          event_type:      'payment_failed',
          stripe_event_id: event.id,
          created_at:      now,
        });
        // Stripe will retry automatically — we rely on subscription.deleted
        // to actually cut off access after all retries fail
      }
      break;
    }
  }
}
