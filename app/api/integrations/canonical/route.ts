// app/api/integrations/canonical/route.ts
//
// Owner-facing toggle for "this provider is the canonical source for X".
// Today only one X exists: staff_cost (PK vs Fortnox). Future Xs (e.g.
// canonical-revenue when multiple POS connectors exist) plug into the
// same shape via the `field` body param.
//
// Stored on integrations.config — JSONB column that already exists.
// The aggregator reads config.canonical_for_staff_cost on every run
// and inverts the disagreement gate accordingly.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const runtime         = 'nodejs'
export const dynamic         = 'force-dynamic'
export const preferredRegion = 'fra1'

const ALLOWED_PROVIDERS = ['personalkollen']
const ALLOWED_FIELDS    = ['canonical_for_staff_cost']

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const { provider, business_id, field, value } = body as {
    provider?:    string
    business_id?: string
    field?:       string
    value?:       boolean
  }

  if (!provider || !ALLOWED_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: `Provider must be one of: ${ALLOWED_PROVIDERS.join(', ')}` }, { status: 400 })
  }
  if (!field || !ALLOWED_FIELDS.includes(field)) {
    return NextResponse.json({ error: `Field must be one of: ${ALLOWED_FIELDS.join(', ')}` }, { status: 400 })
  }
  if (!business_id) {
    return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  }
  if (typeof value !== 'boolean') {
    return NextResponse.json({ error: 'value must be a boolean' }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify the business belongs to the auth'd org and the integration row exists.
  const { data: integ, error: getErr } = await db
    .from('integrations')
    .select('id, config')
    .eq('org_id', auth.orgId)
    .eq('business_id', business_id)
    .eq('provider', provider)
    .maybeSingle()
  if (getErr) return NextResponse.json({ error: getErr.message }, { status: 500 })
  if (!integ)  return NextResponse.json({ error: 'Integration not found for this business' }, { status: 404 })

  const nextConfig = { ...(integ.config ?? {}), [field]: value }
  const { error: updErr } = await db
    .from('integrations')
    .update({ config: nextConfig, updated_at: new Date().toISOString() })
    .eq('id', integ.id)
  if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 })

  return NextResponse.json({ ok: true, provider, business_id, field, value })
}
