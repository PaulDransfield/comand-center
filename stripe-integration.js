/**
 * stripe-integration.js — Command Center complete Stripe implementation
 * All sections labelled with destination file path.
 */

// ── lib/stripe/config.js ─────────────────────────────────────────
export const PLANS = {
  trial: {
    name:'Free Trial', price_usd:0, duration_days:30,
    limits:{ businesses:2, documents:50, monthly_tokens:500_000, monthly_requests:200,
             team_members:1, notebooks:3, audio_overviews:3, export_schedules:1, storage_mb:100 },
    features:['2 restaurant locations','50 documents','500k AI tokens/month','PDF & Excel exports','Basic cost tracker'],
    model:'claude-haiku-4-5-20251001', badge:null,
  },
  starter: {
    name:'Starter', price_usd:29, stripe_price_env:'STRIPE_PRICE_STARTER',
    limits:{ businesses:5, documents:500, monthly_tokens:2_000_000, monthly_requests:1_000,
             team_members:3, notebooks:20, audio_overviews:20, export_schedules:5, storage_mb:2000 },
    features:['5 restaurant locations','500 documents','2M AI tokens/month','Fortnox integration','Scheduled reports','Team access (3 users)'],
    model:'claude-sonnet-4-6', badge:null,
  },
  pro: {
    name:'Pro', price_usd:79, stripe_price_env:'STRIPE_PRICE_PRO',
    limits:{ businesses:20, documents:5_000, monthly_tokens:10_000_000, monthly_requests:5_000,
             team_members:10, notebooks:100, audio_overviews:100, export_schedules:20, storage_mb:20000 },
    features:['20 restaurant locations','5,000 documents','10M AI tokens/month','All integrations','Priority support','BankID auth','Team access (10 users)'],
    model:'claude-sonnet-4-6', badge:'Most Popular',
  },
  enterprise: {
    name:'Enterprise', price_usd:null,
    limits:{ businesses:Infinity, documents:Infinity, monthly_tokens:Infinity, monthly_requests:Infinity,
             team_members:Infinity, notebooks:Infinity, audio_overviews:Infinity, export_schedules:Infinity, storage_mb:Infinity },
    features:['Unlimited everything','Dedicated support','Custom integrations','SLA guarantee','On-premise option'],
    model:'claude-sonnet-4-6', badge:'Custom',
  },
};
export const ANNUAL_DISCOUNT = 0.20;
export const getPlan   = (n) => PLANS[n] || PLANS.trial;
export const getLimits = (n) => getPlan(n).limits;

// ── lib/stripe/subscriptions.js ───────────────────────────────────
// Stripe SDK init + checkout/portal/cancel/status functions

// Singleton SDK client
import Stripe from 'stripe';
export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

export async function getOrCreateStripeCustomer(orgId, supabase) {
  const { data: org } = await supabase.from('organisations')
    .select('name, billing_email, stripe_customer_id').eq('id', orgId).single();
  if (!org) throw new Error(`Org ${orgId} not found`);
  if (org.stripe_customer_id) return org.stripe_customer_id;
  const customer = await stripe.customers.create({ name: org.name, email: org.billing_email||undefined, metadata:{ org_id:orgId }});
  await supabase.from('organisations').update({ stripe_customer_id: customer.id }).eq('id', orgId);
  return customer.id;
}

export async function createCheckoutSession(orgId, planName, options={}, supabase) {
  const plan    = PLANS[planName];
  const priceId = process.env[plan.stripe_price_env];
  if (!priceId) throw new Error(`Missing env: ${plan.stripe_price_env}`);
  const customerId = await getOrCreateStripeCustomer(orgId, supabase);
  const appUrl     = process.env.NEXT_PUBLIC_APP_URL;
  return stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: { org_id: orgId, plan: planName }, trial_period_days: options.extendTrial ? 7 : undefined },
    automatic_tax:     { enabled: true },
    tax_id_collection: { enabled: true },
    billing_address_collection: 'required',
    allow_promotion_codes: true,
    locale: 'sv',
    success_url: `${appUrl}/dashboard?upgrade=success&plan=${planName}`,
    cancel_url:  `${appUrl}/upgrade?cancelled=1`,
    metadata: { org_id: orgId, plan: planName },
  });
}

export async function createPortalSession(orgId, returnUrl, supabase) {
  const customerId = await getOrCreateStripeCustomer(orgId, supabase);
  const session    = await stripe.billingPortal.sessions.create({
    customer: customerId, return_url: returnUrl || `${process.env.NEXT_PUBLIC_APP_URL}/dashboard`,
  });
  return session.url;
}

export async function cancelSubscription(orgId, supabase) {
  const { data: org } = await supabase.from('organisations')
    .select('stripe_subscription_id').eq('id', orgId).single();
  if (!org?.stripe_subscription_id) return null;
  return stripe.subscriptions.update(org.stripe_subscription_id, { cancel_at_period_end: true });
}

export async function getSubscriptionStatus(orgId, supabase) {
  const { data: org } = await supabase.from('organisations')
    .select('stripe_subscription_id, plan, trial_end').eq('id', orgId).single();
  if (!org?.stripe_subscription_id) {
    return { status:'trial', plan: org?.plan||'trial', trialEnd: org?.trial_end,
      daysLeft: org?.trial_end ? Math.max(0, Math.ceil((new Date(org.trial_end)-new Date())/86400000)) : 0 };
  }
  const sub = await stripe.subscriptions.retrieve(org.stripe_subscription_id);
  return { status: sub.status, plan: org.plan,
    currentPeriodEnd: new Date(sub.current_period_end*1000).toISOString(),
    cancelAtPeriodEnd: sub.cancel_at_period_end };
}

// ── lib/stripe/enforcement.js ─────────────────────────────────────
// Check limits before every operation — throws UsageLimitError if exceeded

export class UsageLimitError extends Error {
  constructor({ reason, limitKey, used, limit, plan, upgradeHint }) {
    const msgs = {
      businesses:'Business limit reached', documents:'Document limit reached',
      monthly_tokens:'Monthly AI token limit reached', monthly_requests:'Monthly request limit reached',
      team_members:'Team member limit reached', audio_overviews:'Audio overview limit reached',
      trial_expired:'Your free trial has ended', account_inactive:'Account is inactive',
    };
    super(msgs[limitKey] || msgs[reason] || `${limitKey} limit reached`);
    Object.assign(this, { code:'USAGE_LIMIT', reason, limitKey, used, limit, plan, upgradeHint });
  }
}

export async function enforceLimit(orgId, limitKey, supabase) {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const { data: org } = await supabase.from('organisations')
    .select('plan, trial_end, is_active').eq('id', orgId).single();
  if (!org?.is_active) throw new UsageLimitError({ reason:'account_inactive', limitKey:'account', used:0, limit:0, plan:'none' });
  if (org.plan === 'trial' && org.trial_end && new Date(org.trial_end) < now)
    throw new UsageLimitError({ reason:'trial_expired', limitKey:'trial', used:0, limit:0, plan:'trial', upgradeHint:'Your free trial has ended. Upgrade to continue.' });

  const limit = getLimits(org.plan)[limitKey];
  if (limit === Infinity) return;

  let used = 0;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const q = (table, col='id') => supabase.from(table).select(col, {count:'exact',head:true});

  switch (limitKey) {
    case 'businesses':      used = (await q('businesses').eq('org_id',orgId).eq('is_active',true)).count||0; break;
    case 'documents':       used = (await q('notebook_documents').eq('org_id',orgId)).count||0; break;
    case 'team_members':    used = (await q('organisation_members').eq('org_id',orgId)).count||0; break;
    case 'audio_overviews': used = (await q('ai_request_log').eq('org_id',orgId).eq('request_type','audio_script').gte('created_at',monthStart)).count||0; break;
    case 'export_schedules':used = (await q('export_schedules').eq('org_id',orgId).eq('is_active',true)).count||0; break;
    case 'monthly_tokens':
    case 'monthly_requests': {
      const { data:u } = await supabase.from('ai_usage').select('total_tokens,total_requests')
        .eq('org_id',orgId).eq('month',month).maybeSingle();
      used = limitKey === 'monthly_tokens' ? (u?.total_tokens||0) : (u?.total_requests||0);
      break;
    }
    default: return;
  }

  if (used >= limit) {
    const planOrder = ['trial','starter','pro','enterprise'];
    const nextPlan  = planOrder[planOrder.indexOf(org.plan)+1] || 'enterprise';
    const nextLimit = getLimits(nextPlan)[limitKey];
    throw new UsageLimitError({ reason:`${limitKey}_limit`, limitKey, used, limit, plan:org.plan,
      upgradeHint: nextPlan === 'enterprise'
        ? `Contact us for enterprise with unlimited ${limitKey}.`
        : `Upgrade to ${PLANS[nextPlan].name} for ${nextLimit===Infinity?'unlimited':nextLimit} ${limitKey}.` });
  }
}

export async function getFullUsage(orgId, supabase) {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const { data: org } = await supabase.from('organisations')
    .select('plan,trial_end,is_active,stripe_subscription_id').eq('id',orgId).single();
  const plan   = org?.plan || 'trial';
  const limits = getLimits(plan);
  const [bR,dR,uR,mR,aR,sR] = await Promise.all([
    supabase.from('businesses').select('id',{count:'exact',head:true}).eq('org_id',orgId).eq('is_active',true),
    supabase.from('notebook_documents').select('id',{count:'exact',head:true}).eq('org_id',orgId),
    supabase.from('ai_usage').select('total_tokens,total_requests,total_cost_usd').eq('org_id',orgId).eq('month',month).maybeSingle(),
    supabase.from('organisation_members').select('id',{count:'exact',head:true}).eq('org_id',orgId),
    supabase.from('ai_request_log').select('id',{count:'exact',head:true}).eq('org_id',orgId).eq('request_type','audio_script').gte('created_at',mStart),
    supabase.from('export_schedules').select('id',{count:'exact',head:true}).eq('org_id',orgId).eq('is_active',true),
  ]);
  const meter = (used,lim) => {
    const pct = lim===Infinity ? 0 : Math.min(100, Math.round(used/lim*100));
    return { used, limit:lim, pct, nearLimit:pct>=80, atLimit:used>=lim };
  };
  const u = uR.data;
  return {
    plan, trialEnd: org?.trial_end, hasSubscription: !!org?.stripe_subscription_id,
    trialDaysLeft: org?.trial_end ? Math.max(0,Math.ceil((new Date(org.trial_end)-now)/86400000)) : null,
    costUsdThisMonth: parseFloat(u?.total_cost_usd||0),
    meters: {
      businesses:      meter(bR.count||0, limits.businesses),
      documents:       meter(dR.count||0, limits.documents),
      monthly_tokens:  meter(u?.total_tokens||0, limits.monthly_tokens),
      monthly_requests:meter(u?.total_requests||0, limits.monthly_requests),
      team_members:    meter(mR.count||0, limits.team_members),
      audio_overviews: meter(aR.count||0, limits.audio_overviews),
      export_schedules:meter(sR.count||0, limits.export_schedules),
    },
  };
}

export const limitErrorResponse = (err) => Response.json({
  error:err.message, code:'USAGE_LIMIT', limitKey:err.limitKey,
  used:err.used, limit:err.limit, plan:err.plan, upgradeHint:err.upgradeHint, upgrade_url:'/upgrade',
}, { status:402 });

// ── pages/api/stripe/webhook.js ───────────────────────────────────
// CRITICAL: set bodyParser:false — Stripe needs raw body for signature verification
// Register this URL at: stripe.com → Developers → Webhooks → Add endpoint
// URL: https://yourapp.vercel.app/api/stripe/webhook
// Events to subscribe: all customer.subscription.*, invoice.payment_*, checkout.session.completed, charge.refunded

export const webhookConfig = { api: { bodyParser: false } };

// Full webhook handler — paste this as your entire webhook route
export const webhookHandler = `
import { buffer }          from 'micro';
import Stripe              from 'stripe';
import { createAdminClient } from '@/lib/supabase/server';

export const config = { api: { bodyParser: false } };

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-04-10' });

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  let event;
  try {
    const raw = await buffer(req);
    event = stripe.webhooks.constructEvent(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe signature failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  const supabase = createAdminClient();

  // Helper: get org_id from stripe customer_id
  async function orgFromCustomer(customerId) {
    const { data } = await supabase.from('organisations').select('id,plan').eq('stripe_customer_id', customerId).maybeSingle();
    return data;
  }

  async function updateOrg(orgId, patch) {
    await supabase.from('organisations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', orgId);
  }

  async function logEvent(orgId, type, plan, amountOre, stripeRef) {
    await supabase.from('billing_events').insert({ org_id:orgId, event_type:type, plan, amount_ore:amountOre||null, stripe_event_id:stripeRef||null }).catch(console.error);
  }

  try {
    switch (event.type) {

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub   = event.data.object;
        const orgId = sub.metadata?.org_id;
        const plan  = sub.metadata?.plan || 'starter';
        if (!orgId) break;
        await updateOrg(orgId, {
          plan,
          stripe_subscription_id: sub.id,
          is_active: ['active','trialing'].includes(sub.status),
        });
        await logEvent(orgId, event.type, plan, null, sub.id);
        break;
      }

      case 'checkout.session.completed': {
        const s     = event.data.object;
        const orgId = s.metadata?.org_id;
        const plan  = s.metadata?.plan;
        if (!orgId || s.mode !== 'subscription') break;
        await updateOrg(orgId, { plan, is_active:true, billing_email: s.customer_email||undefined });
        await logEvent(orgId, 'checkout_completed', plan);
        // TODO: send welcome email via Resend
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const org = await orgFromCustomer(inv.customer);
        if (!org) break;
        await updateOrg(org.id, { is_active:true });
        await logEvent(org.id, 'payment_succeeded', org.plan, inv.amount_paid, inv.id);
        break;
      }

      case 'invoice.payment_failed': {
        const inv  = event.data.object;
        const org  = await orgFromCustomer(inv.customer);
        if (!org) break;
        // Downgrade access but keep data — Stripe will retry payment
        await updateOrg(org.id, { plan:'past_due' });
        await logEvent(org.id, 'payment_failed', org.plan, inv.amount_due);
        // TODO: send payment failed email
        break;
      }

      case 'customer.subscription.deleted': {
        const sub   = event.data.object;
        const orgId = sub.metadata?.org_id || (await orgFromCustomer(sub.customer))?.id;
        if (!orgId) break;
        await updateOrg(orgId, { plan:'trial', stripe_subscription_id:null, is_active:false });
        await logEvent(orgId, 'subscription_cancelled');
        // TODO: send cancellation email
        break;
      }

      case 'customer.subscription.trial_will_end': {
        const sub   = event.data.object;
        const orgId = sub.metadata?.org_id;
        if (!orgId) break;
        // TODO: send trial ending email with upgrade CTA
        console.log('Trial ending soon for org:', orgId, 'ends:', new Date(sub.trial_end*1000));
        break;
      }

      case 'charge.refunded': {
        const ch  = event.data.object;
        const org = await orgFromCustomer(ch.customer);
        if (org) await logEvent(org.id, 'refund_issued', org.plan, -ch.amount_refunded);
        break;
      }
    }

    res.json({ received: true, type: event.type });
  } catch (err) {
    console.error('Webhook handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
`;

// ── pages/api/stripe/checkout.js ─────────────────────────────────
export const checkoutRoute = `
import { createCheckoutSession } from '@/lib/stripe/subscriptions';
import { createAdminClient }     from '@/lib/supabase/server';
import { getOrgFromRequest }     from '@/lib/auth/get-org';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const auth = await getOrgFromRequest(req);
  if (!auth) return res.status(401).json({ error:'Not authenticated' });
  const { plan, annual=false } = req.body;
  if (!['starter','pro'].includes(plan)) return res.status(400).json({ error:'Invalid plan' });
  if (plan === 'enterprise') return res.json({ url: process.env.NEXT_PUBLIC_APP_URL+'/contact?plan=enterprise' });
  try {
    const supabase = createAdminClient();
    const session  = await createCheckoutSession(auth.orgId, plan, { annual }, supabase);
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
`;

// ── pages/api/stripe/portal.js ────────────────────────────────────
export const portalRoute = `
import { createPortalSession } from '@/lib/stripe/subscriptions';
import { createAdminClient }   from '@/lib/supabase/server';
import { getOrgFromRequest }   from '@/lib/auth/get-org';
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const auth = await getOrgFromRequest(req);
  if (!auth) return res.status(401).json({ error:'Not authenticated' });
  try {
    const supabase = createAdminClient();
    const url      = await createPortalSession(auth.orgId, req.body.returnUrl, supabase);
    res.json({ url });
  } catch (err) { res.status(500).json({ error: err.message }); }
}
`;

// ── pages/api/stripe/usage.js ─────────────────────────────────────
export const usageRoute = `
import { getFullUsage }      from '@/lib/stripe/enforcement';
import { createAdminClient } from '@/lib/supabase/server';
import { getOrgFromRequest } from '@/lib/auth/get-org';
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  const auth = await getOrgFromRequest(req);
  if (!auth) return res.status(401).json({ error:'Not authenticated' });
  const supabase = createAdminClient();
  const usage    = await getFullUsage(auth.orgId, supabase);
  res.json(usage);
}
`;
