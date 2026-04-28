// app/api/admin/v2/customers/[orgId]/extend-trial/route.ts
//
// Extends the org's trial_end by N days. Audit logs the reason +
// before/after dates. Body: { reason: string, days: number }

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'
const REASON_MIN = 10
const MAX_DAYS = 90

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason = String(body?.reason ?? '').trim()
  const days   = Math.round(Number(body?.days ?? 0))

  if (reason.length < REASON_MIN)         return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  if (!Number.isFinite(days) || days <= 0) return NextResponse.json({ error: 'days must be a positive integer' }, { status: 400 })
  if (days > MAX_DAYS)                     return NextResponse.json({ error: `days must be ≤ ${MAX_DAYS}` }, { status: 400 })

  const db = createAdminClient()
  const { data: org } = await db
    .from('organisations')
    .select('trial_end, plan')
    .eq('id', orgId)
    .maybeSingle()
  if (!org) return NextResponse.json({ error: 'Organisation not found' }, { status: 404 })

  // Anchor the new trial_end on whichever is later: existing trial_end
  // or today. Avoids "extending" a long-expired trial back into the past.
  const todayMs = Date.now()
  const currentMs = org.trial_end ? new Date(org.trial_end).getTime() : 0
  const anchorMs = Math.max(todayMs, currentMs)
  const newEndMs = anchorMs + days * 86400_000
  const newEnd   = new Date(newEndMs).toISOString().slice(0, 10)

  await recordAdminAction(db, {
    action:     ADMIN_ACTIONS.EXTEND_TRIAL,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    {
      reason,
      surface:        'admin_v2',
      days_added:     days,
      previous_end:   org.trial_end,
      new_end:        newEnd,
      previous_plan:  org.plan,
    },
    req,
  })

  const { error } = await db
    .from('organisations')
    .update({ trial_end: newEnd })
    .eq('id', orgId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, trial_end: newEnd, days_added: days, reason }, { headers: { 'Cache-Control': 'no-store' } })
}
