// @ts-nocheck
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { rateLimit }                 from '@/lib/middleware/rate-limit'
import { PLANS }                     from '@/lib/stripe/config'

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // Rate-limit business creation — 20 per user per hour is enough for legit operators
  // and stops any loop that tries to seed thousands of businesses through the API.
  const gate = rateLimit(`biz-add:${auth.userId}`, { windowMs: 60 * 60_000, max: 20 })
  if (!gate.allowed) return NextResponse.json({ error: 'Too many new businesses — slow down' }, { status: 429 })

  // Plan-limit enforcement (ADD-SECOND-BUSINESS-PLAN.md §B). Read the
  // org's plan, look up its businesses cap, count active businesses,
  // 402 with structured payload when at limit so the UI can offer an
  // upgrade CTA.
  const dbForCheck = createAdminClient()
  const [orgRes, countRes] = await Promise.all([
    dbForCheck.from('organisations').select('plan').eq('id', auth.orgId).maybeSingle(),
    dbForCheck.from('businesses')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', auth.orgId)
      .eq('is_active', true),
  ])
  const planKey = (orgRes.data?.plan as string | undefined) ?? 'solo'
  const plan    = PLANS[planKey] ?? PLANS['solo']
  const cap     = plan?.limits?.businesses ?? 1
  const active  = countRes.count ?? 0
  if (Number.isFinite(cap) && active >= cap) {
    // Suggest the smallest upgrade that lifts the cap.
    const upgradeTo = (cap <= 1) ? 'group' : 'chain'
    return NextResponse.json({
      error:        'plan_limit_reached',
      current_plan: planKey,
      cap,
      current:      active,
      upgrade_to:   upgradeTo,
      message:      `Your ${planKey} plan allows ${cap} business${cap === 1 ? '' : 'es'}. Upgrade to ${upgradeTo} to add more.`,
    }, { status: 402 })
  }

  const body = await req.json()
  const {
    name, type, city, org_number, colour,
    target_food_pct, target_staff_pct, target_margin_pct,
    address, opening_days, business_stage, country,
  } = body

  if (!name?.trim()) return NextResponse.json({ error: 'Name is required' }, { status: 400 })

  // Validate the M046 enum at the API edge so a bad client value can't
  // hit the DB CHECK and return a 500. NULL is allowed (legacy + the
  // enrichment-later case).
  const stage = business_stage && ['new','established_1y','established_3y'].includes(business_stage)
    ? business_stage
    : null

  // Phase 1 country picker (2026-05-03 brainstorm). Whitelist to ISO
  // codes we'll plausibly support; anything else falls back to the
  // schema default ('SE'). Matches the businesses.country column shape.
  const countryWhitelist = ['SE', 'NO', 'GB']
  const countryCode = country && countryWhitelist.includes(String(country).toUpperCase())
    ? String(country).toUpperCase()
    : null

  // opening_days: accept the canonical { mon..sun: bool } shape, or null
  // to fall back to the column default ("open every day"). Anything else
  // is ignored — never trust the client to set arbitrary JSONB.
  const DAYS = ['mon','tue','wed','thu','fri','sat','sun'] as const
  let openingDays: Record<string, boolean> | null = null
  if (opening_days && typeof opening_days === 'object') {
    openingDays = {}
    for (const d of DAYS) openingDays[d] = Boolean((opening_days as any)[d])
  }

  const db = createAdminClient()

  const insertRow: Record<string, any> = {
    org_id:            auth.orgId,
    name:              name.trim(),
    type:              type || 'restaurant',
    city:              city || null,
    address:           address?.trim() || null,
    org_number:        org_number || null,
    colour:            colour || '#1A3F6B',
    currency:          'SEK',
    is_active:         true,
    target_food_pct:   target_food_pct   ?? 31,
    target_staff_pct:  target_staff_pct  ?? 35,
    target_margin_pct: target_margin_pct ?? 15,
    business_stage:    stage,
  }
  // Only set opening_days when the client sent something — otherwise let
  // the column default apply ("open every day").
  if (openingDays) insertRow.opening_days = openingDays
  // Same pattern for country — let the schema default ('SE') apply when
  // the caller didn't pick one (legacy callers, programmatic creates).
  if (countryCode) insertRow.country = countryCode

  const { data, error } = await db
    .from('businesses')
    .insert(insertRow)
    .select('id, name')
    .single()

  if (error) return NextResponse.json({ error: 'Failed to save business' }, { status: 500 })

  return NextResponse.json(data)
}
