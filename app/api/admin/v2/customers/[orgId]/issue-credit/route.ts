// app/api/admin/v2/customers/[orgId]/issue-credit/route.ts
//
// Records a manual credit on the org. Writes a billing_events row of
// event_type 'credit_issued' with the amount in öre. Does NOT push to
// Stripe automatically — the admin issues the actual Stripe credit
// from the Stripe dashboard, then this endpoint records the bookkeeping
// entry on our side. (Pushing to Stripe needs a refund_id flow; out of
// scope for this PR.)
//
// Body: { reason: string, amount_sek: number }

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction }         from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'
const REASON_MIN = 10
const MAX_AMOUNT_SEK = 100_000

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}
  const reason     = String(body?.reason ?? '').trim()
  const amountSek  = Math.round(Number(body?.amount_sek ?? 0))

  if (reason.length < REASON_MIN)            return NextResponse.json({ error: `reason required (min ${REASON_MIN} chars)` }, { status: 400 })
  if (!Number.isFinite(amountSek) || amountSek <= 0) return NextResponse.json({ error: 'amount_sek must be positive' }, { status: 400 })
  if (amountSek > MAX_AMOUNT_SEK)            return NextResponse.json({ error: `amount_sek must be ≤ ${MAX_AMOUNT_SEK}` }, { status: 400 })

  const db = createAdminClient()
  const amountOre = amountSek * 100

  await recordAdminAction(db, {
    action:     'issue_credit',
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    {
      reason,
      surface:    'admin_v2',
      amount_sek: amountSek,
    },
    req,
  })

  const { error } = await db.from('billing_events').insert({
    org_id:     orgId,
    event_type: 'credit_issued',
    amount_sek: amountOre,
    metadata:   { reason, surface: 'admin_v2' },
  })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, amount_sek: amountSek, reason }, { headers: { 'Cache-Control': 'no-store' } })
}
