// @ts-nocheck
// app/api/integrations/personalkollen/route.ts
// Connect and sync Personalkollen staff data

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { encrypt, decrypt }          from '@/lib/integrations/encryption'
import {
  getStaff, getWorkplaces, getWorkPeriods, getLoggedTimes, getStaffSummary
} from '@/lib/pos/personalkollen'

const getAuth = getRequestAuth

export async function POST(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { action, api_key, business_id } = await req.json()
  const db = createAdminClient()

  // ── Test connection ───────────────────────────────────────────────────────
  if (action === 'test') {
    if (!api_key) return NextResponse.json({ error: 'API key required' }, { status: 400 })
    try {
      const workplaces = await getWorkplaces(api_key)
      return NextResponse.json({
        ok:         true,
        workplaces: workplaces.length,
        message:    `Connected — found ${workplaces.length} workplace(s)`,
      })
    } catch (e: any) {
      return NextResponse.json({ error: e.message ?? String(e) }, { status: 400 })
    }
  }

  // ── Save credentials ──────────────────────────────────────────────────────
  if (action === 'connect') {
    if (!api_key) return NextResponse.json({ error: 'api_key required' }, { status: 400 })

    const encrypted = encrypt(api_key)
    // business_id may be empty string — convert to null
    const bizId = business_id || null

    // If no business_id, use org-level upsert
    const upsertData: any = {
      org_id:          auth.orgId,
      provider:        'personalkollen',
      status:          'connected',
      credentials_enc: encrypted,
      updated_at:      new Date().toISOString(),
    }
    if (bizId) upsertData.business_id = bizId

    // Try upsert — if conflict key fails, do insert
    let error: any = null
    // Always upsert on org_id+provider to prevent duplicates
    const res = await db.from('integrations').upsert(upsertData, { onConflict: 'org_id,business_id,provider' })
    error = res.error

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true, message: 'Personalkollen connected successfully' })
  }

  // ── Sync data ─────────────────────────────────────────────────────────────
  if (action === 'sync') {
    const { data: integration } = await db.from('integrations')
      .select('credentials_enc, business_id')
      .eq('org_id', auth.orgId)
      .eq('provider', 'personalkollen')
      .single()

    if (!integration) return NextResponse.json({ error: 'Not connected' }, { status: 404 })

    const token = decrypt(integration.credentials_enc)
    if (!token)  return NextResponse.json({ error: 'Invalid credentials' }, { status: 400 })

    const now       = new Date()
    const fromDate  = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
    const toDate    = now.toISOString().slice(0, 10)

    try {
      const summary = await getStaffSummary(token, fromDate, toDate)

      // Update tracker_data with staff cost from Personalkollen
      if (summary.staff_cost > 0) {
        const { data: existing } = await db.from('tracker_data')
          .select('id, staff_cost')
          .eq('business_id', integration.business_id)
          .eq('period_year',  now.getFullYear())
          .eq('period_month', now.getMonth() + 1)
          .single()

        if (existing) {
          await db.from('tracker_data')
            .update({ staff_cost: summary.staff_cost })
            .eq('id', existing.id)
        }
      }

      // Update last sync
      await db.from('integrations')
        .update({ last_sync_at: new Date().toISOString(), status: 'connected', last_error: null })
        .eq('org_id', auth.orgId)
        .eq('provider', 'personalkollen')

      return NextResponse.json({ ok: true, summary })
    } catch (e: any) {
      await db.from('integrations')
        .update({ last_error: e.message })
        .eq('org_id', auth.orgId)
        .eq('provider', 'personalkollen')
      return NextResponse.json({ error: e.message }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function GET(req: NextRequest) {
  const auth = await getAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const action      = searchParams.get('action') ?? 'summary'
  const db          = createAdminClient()

  const { data: integration, error: integError } = await db.from('integrations')
    .select('credentials_enc, business_id, last_sync_at, status')
    .eq('org_id', auth.orgId)
    .eq('provider', 'personalkollen')
    .maybeSingle()

  if (!integration || integError) return NextResponse.json({ connected: false })

  if (action === 'status') {
    return NextResponse.json({
      connected:    true,
      status:       integration.status,
      last_sync_at: integration.last_sync_at,
    })
  }

  if (action === 'summary') {
    const token = decrypt(integration.credentials_enc)
    if (!token) return NextResponse.json({ error: 'Invalid credentials' }, { status: 400 })

    const now      = new Date()
    const fromDate = searchParams.get('from') ?? new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
    const toDate   = searchParams.get('to')   ?? now.toISOString().slice(0, 10)

    try {
      const [summary, staff, workplaces] = await Promise.all([
        getStaffSummary(token, fromDate, toDate),
        getStaff(token),
        getWorkplaces(token),
      ])
      return NextResponse.json({ ok: true, summary, staff, workplaces })
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 500 })
    }
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
