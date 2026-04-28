// app/api/admin/v2/customers/[orgId]/billing/route.ts
// READ-ONLY billing data for the Billing sub-tab.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const [orgRes, eventsRes] = await Promise.all([
    db.from('organisations')
      .select('id, name, plan, is_active, stripe_customer_id, stripe_subscription_id, trial_end, billing_email')
      .eq('id', orgId)
      .maybeSingle(),
    db.from('billing_events')
      .select('id, event_type, plan, amount_sek, stripe_event_id, metadata, created_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  if (!orgRes.data) return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  const stripePortalUrl = orgRes.data.stripe_customer_id
    ? `https://billing.stripe.com/p/login/test_8wMcQB2Fk6dB0QLerXdQI00?prefilled_email=${encodeURIComponent(orgRes.data.billing_email ?? '')}`
    : null

  return NextResponse.json({
    org:    orgRes.data,
    events: eventsRes.data ?? [],
    stripe_portal_url: stripePortalUrl,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
