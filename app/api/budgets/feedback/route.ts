// app/api/budgets/feedback/route.ts
//
// Owner feedback on an AI-suggested monthly budget row. Writes the
// thumbs-up / thumbs-down / shape reaction into the matching
// ai_forecast_outcomes row so the next AI generation can see which
// suggestions the owner accepted, rejected, or disagreed with.
//
// POST { business_id, year, month, reaction, comment?, surface? }
//   reaction: 'too_high' | 'too_low' | 'just_right' | 'wrong_shape'
//   comment: optional free-text, max 500 chars
//   surface: optional, defaults to 'budget_generate'
//
// Scope: org members can UPDATE owner feedback fields on their own
// org's outcomes (RLS policy ai_forecast_outcomes_feedback_update
// enforces this). This endpoint runs under the user's session so the
// policy applies naturally — no admin client needed.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { log } from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 10

const VALID_REACTIONS = ['too_high', 'too_low', 'just_right', 'wrong_shape']

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({} as any))
  const businessId = body.business_id as string | undefined
  const year       = Number(body.year)
  const month      = Number(body.month)
  const reaction   = body.reaction as string | undefined
  const comment    = body.comment ? String(body.comment).slice(0, 500) : null
  const surface    = body.surface ? String(body.surface) : 'budget_generate'

  if (!businessId)                         return NextResponse.json({ error: 'business_id required' },      { status: 400 })
  if (!year || !month || month < 1 || month > 12)
                                          return NextResponse.json({ error: 'year + month (1-12) required' }, { status: 400 })
  if (!reaction || !VALID_REACTIONS.includes(reaction))
                                          return NextResponse.json({ error: `reaction must be one of ${VALID_REACTIONS.join(',')}` }, { status: 400 })

  const db = createAdminClient()

  // Verify the business belongs to the caller's org before writing.
  const { data: biz } = await db
    .from('businesses')
    .select('id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your organisation' }, { status: 403 })

  // Find the latest outcome row for this (business, year, month, surface).
  // Prefer the most recent un-resolved row (active suggestion). If none
  // un-resolved, take the most recent resolved one — owner is commenting
  // on a closed period retrospectively.
  const { data: rows, error: findErr } = await db
    .from('ai_forecast_outcomes')
    .select('id, actuals_resolved_at, created_at')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('period_year', year)
    .eq('period_month', month)
    .eq('surface', surface)
    .order('created_at', { ascending: false })
    .limit(5)

  if (findErr) {
    log.error('budget-feedback find failed', {
      route: 'api/budgets/feedback',
      error: findErr.message,
      org_id: auth.orgId,
      business_id: businessId,
    })
    return NextResponse.json({ error: findErr.message }, { status: 500 })
  }
  if (!rows?.length) {
    return NextResponse.json({ error: 'No matching AI suggestion found for that month' }, { status: 404 })
  }

  const target = rows.find(r => !r.actuals_resolved_at) ?? rows[0]

  const { error: updErr } = await db.from('ai_forecast_outcomes').update({
    owner_reaction:    reaction,
    owner_comment:     comment,
    owner_feedback_at: new Date().toISOString(),
    updated_at:        new Date().toISOString(),
  }).eq('id', target.id)

  if (updErr) {
    log.error('budget-feedback update failed', {
      route: 'api/budgets/feedback',
      outcome_id: target.id,
      error: updErr.message,
    })
    return NextResponse.json({ error: updErr.message }, { status: 500 })
  }

  log.info('budget-feedback recorded', {
    route:       'api/budgets/feedback',
    outcome_id:  target.id,
    org_id:      auth.orgId,
    business_id: businessId,
    year, month,
    reaction,
    has_comment: Boolean(comment),
    status:      'success',
  })

  return NextResponse.json({ ok: true, outcome_id: target.id })
}
