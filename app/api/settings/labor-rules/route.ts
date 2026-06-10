// app/api/settings/labor-rules/route.ts
//
// Per-business Swedish labour config + per-staff under-18 flagging.
//
// GET  ?business_id=  → resolved LaborConfig + staff list with is_minor/birth_date
// POST { business_id, config?, staff_minor? }
//        config       = { agreement, enforce_minor_rules }  → businesses.scheduling_labor_config
//        staff_minor  = { staff_uid, is_minor }             → staff_profiles.is_minor
//
// The config drives both the scheduling AI prompt and the pre-publish
// compliance engine (lib/scheduling/labor-rules-sweden.ts).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { DEFAULT_LABOR_CONFIG, type AgreementType, type LaborConfig } from '@/lib/scheduling/labor-rules-sweden'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const AGREEMENTS = new Set<AgreementType>(['visita_hrf', 'hangavtal_hrf', 'none'])

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const businessId = String(new URL(req.url).searchParams.get('business_id') ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()
  const { data: biz } = await db
    .from('businesses')
    .select('id, scheduling_labor_config')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const config: LaborConfig = { ...DEFAULT_LABOR_CONFIG, ...((biz as any).scheduling_labor_config ?? {}) }

  const { data: staff } = await db
    .from('staff_profiles')
    .select('staff_uid, display_name, is_minor, birth_date')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .order('display_name')

  return NextResponse.json({
    config,
    staff: (staff ?? []).map((s: any) => ({
      staff_uid:   s.staff_uid,
      name:        s.display_name,
      is_minor:    s.is_minor === true,
      birth_date:  s.birth_date ?? null,
      // When a birth date is known, is_minor is derived on sync — the owner
      // can still override but should know the source.
      age_known:   s.birth_date != null,
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Update the business labour config (merge onto existing).
  if (body.config) {
    const agreement = body.config.agreement
    if (agreement != null && !AGREEMENTS.has(agreement)) {
      return NextResponse.json({ error: `agreement must be one of: ${Array.from(AGREEMENTS).join(', ')}` }, { status: 400 })
    }
    const { data: biz } = await db.from('businesses').select('scheduling_labor_config').eq('id', businessId).maybeSingle()
    const merged: LaborConfig = {
      ...DEFAULT_LABOR_CONFIG,
      ...((biz as any)?.scheduling_labor_config ?? {}),
      ...(agreement != null ? { agreement } : {}),
      ...(body.config.enforce_minor_rules != null ? { enforce_minor_rules: !!body.config.enforce_minor_rules } : {}),
    }
    const { error } = await db.from('businesses').update({ scheduling_labor_config: merged }).eq('id', businessId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Update a single staff member's under-18 flag.
  if (body.staff_minor) {
    const staffUid = String(body.staff_minor.staff_uid ?? '').trim()
    if (!staffUid) return NextResponse.json({ error: 'staff_minor.staff_uid required' }, { status: 400 })
    const { error } = await db
      .from('staff_profiles')
      .update({ is_minor: !!body.staff_minor.is_minor })
      .eq('business_id', businessId)
      .eq('staff_uid', staffUid)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
