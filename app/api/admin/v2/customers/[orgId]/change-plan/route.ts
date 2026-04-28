// app/api/admin/v2/customers/[orgId]/change-plan/route.ts
//
// Changes the org's plan field. Audit-logged with before/after.
// Does NOT push to Stripe — that's the source of truth for paid plans
// via the webhook flow. This endpoint is for manual overrides:
// retiring a customer to 'past_due', putting a special-case org on
// 'enterprise' until Stripe catches up, etc.
//
// Body: { reason: string, new_plan: string }

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'
import { PLANS }                     from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'
const REASON_MIN = 10

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason  = String(body?.reason ?? '').trim()
  const newPlan = String(body?.new_plan ?? '').trim()

  if (reason.length < REASON_MIN)  return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  if (!newPlan)                    return NextResponse.json({ error: 'new_plan required' }, { status: 400 })
  if (!(newPlan in PLANS))         return NextResponse.json({ error: `unknown plan: ${newPlan}` }, { status: 400 })

  const db = createAdminClient()
  const { data: org } = await db
    .from('organisations')
    .select('plan')
    .eq('id', orgId)
    .maybeSingle()
  if (!org) return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  await recordAdminAction(db, {
    action:     'change_plan',
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    {
      reason,
      surface:       'admin_v2',
      previous_plan: org.plan,
      new_plan:      newPlan,
    },
    req,
  })

  const { error } = await db.from('organisations').update({ plan: newPlan }).eq('id', orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, plan: newPlan, previous_plan: org.plan, reason }, { headers: { 'Cache-Control': 'no-store' } })
}
