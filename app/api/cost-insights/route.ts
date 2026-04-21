// app/api/cost-insights/route.ts
// Returns active (non-dismissed, non-expired) cost insights for a business.
// Populated by the cost-intel agent (/api/cron/cost-intelligence).
// Empty array when the agent hasn't run yet.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = new URL(req.url).searchParams.get('business_id')
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data, error } = await db
    .from('cost_insights')
    .select('id, kind, tone, entity, message, estimated_saving_kr_annual, evidence, generated_at, expires_at')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .is('dismissed_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('estimated_saving_kr_annual', { ascending: false, nullsFirst: false })
    .limit(8)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Shape for AttentionPanel consumers
  const items = (data ?? []).map(r => ({
    tone:    r.tone,
    entity:  r.entity,
    message: r.message,
  }))

  return NextResponse.json({ items, raw: data ?? [] })
}

export async function DELETE(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const id = new URL(req.url).searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const db = createAdminClient()
  const { error } = await db
    .from('cost_insights')
    .update({ dismissed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('org_id', auth.orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
