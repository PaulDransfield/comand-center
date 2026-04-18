// @ts-nocheck
// app/api/admin/ai-booster/route.ts
//
// Admin-triggered AI Booster activation. Manual path until Stripe self-serve
// Checkout + webhook goes live (blocked on Dransfield Invest AB registration).
//
// POST /api/admin/ai-booster       { org_id, extra, amount, days }
// DELETE /api/admin/ai-booster     { booster_id }   → marks cancelled
//
// Writes to ai_booster_purchases and records every activation in admin_audit_log.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkAdminSecret }          from '@/lib/admin/check-secret'
import { recordAdminAction }         from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  if (!checkAdminSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { org_id, extra, amount, days } = await req.json().catch(() => ({}))
  if (!org_id || !extra || !days) {
    return NextResponse.json({ error: 'org_id, extra, days required' }, { status: 400 })
  }
  const extraN  = parseInt(String(extra),  10)
  const amountN = parseInt(String(amount), 10)
  const daysN   = parseInt(String(days),   10)
  if (extraN  <= 0 || extraN  > 10000) return NextResponse.json({ error: 'extra must be 1..10000'  }, { status: 400 })
  if (amountN < 0)                     return NextResponse.json({ error: 'amount must be ≥ 0'       }, { status: 400 })
  if (daysN   <= 0 || daysN   > 365)   return NextResponse.json({ error: 'days must be 1..365'     }, { status: 400 })

  const db = createAdminClient()
  const periodStart = new Date()
  const periodEnd   = new Date(Date.now() + daysN * 24 * 60 * 60 * 1000)

  const { data, error } = await db.from('ai_booster_purchases').insert({
    org_id,
    period_start:          periodStart.toISOString().slice(0, 10),
    period_end:            periodEnd.toISOString().slice(0, 10),
    extra_queries_per_day: extraN,
    amount_sek:            amountN,
    currency:              'sek',
    status:                'active',
    stripe_invoice_id:     null,       // manual — no Stripe ref
  }).select('*').single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db, {
    action:     'ai_booster_add',
    orgId:      org_id,
    targetType: 'org',
    targetId:   org_id,
    payload:    { extra: extraN, amount_sek: amountN, days: daysN, via: 'manual', booster_id: data.id },
    req,
  })

  return NextResponse.json({
    ok: true,
    booster_id:  data.id,
    period_end:  data.period_end,
    extra_queries_per_day: data.extra_queries_per_day,
  })
}

export async function DELETE(req: NextRequest) {
  if (!checkAdminSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { booster_id } = await req.json().catch(() => ({}))
  if (!booster_id) return NextResponse.json({ error: 'booster_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data, error } = await db.from('ai_booster_purchases').update({
    status:       'cancelled',
    cancelled_at: new Date().toISOString(),
  }).eq('id', booster_id).select('org_id').single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db, {
    action:     'ai_booster_cancel',
    orgId:      data?.org_id ?? null,
    targetType: 'org',
    targetId:   data?.org_id ?? null,
    payload:    { booster_id, via: 'manual' },
    req,
  })

  return NextResponse.json({ ok: true })
}
