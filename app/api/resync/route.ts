// @ts-nocheck
// app/api/resync/route.ts
//
// User-facing "Sync now" action. Re-pulls the last 7 days for every active
// integration on a given business. Safe to run multiple times (all sync
// paths upsert). Rate-limited to once per 3 minutes per business so a
// frustrated click-spam doesn't hammer the upstream APIs.
//
// POST /api/resync
//   body: { business_id: "uuid" }
//   auth: session cookie (same as the rest of the app)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { runSync } from '@/lib/sync/engine'

export const dynamic    = 'force-dynamic'
export const maxDuration = 120

// In-memory per-business lock. Adequate for single-region Vercel; if we go
// multi-region we can back this with Supabase. At 3-minute throttle a
// determined user can still trigger ~20 syncs/hour which is fine.
const LAST_SYNC: Record<string, number> = {}
const COOLDOWN_MS = 3 * 60 * 1000

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const bizId = body.business_id
  if (!bizId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()

  // Validate the user owns this business
  const { data: biz } = await db.from('businesses').select('id, org_id, name').eq('id', bizId).maybeSingle()
  if (!biz || biz.org_id !== auth.orgId) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Rate limit
  const lastRun = LAST_SYNC[bizId]
  if (lastRun && Date.now() - lastRun < COOLDOWN_MS) {
    const waitSec = Math.ceil((COOLDOWN_MS - (Date.now() - lastRun)) / 1000)
    return NextResponse.json({
      error:    `Sync already ran recently. Try again in ${waitSec}s.`,
      retry_in: waitSec,
    }, { status: 429 })
  }
  LAST_SYNC[bizId] = Date.now()

  const { data: integrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, provider, status')
    .eq('business_id', bizId)
    .eq('status', 'connected')

  if (!integrations?.length) {
    return NextResponse.json({ ok: true, message: 'No connected integrations', synced: 0 })
  }

  const now   = new Date()
  const from7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const to    = now.toISOString().slice(0, 10)

  const PER_INTEGRATION_TIMEOUT_MS = 45_000

  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout: ${label} exceeded ${ms}ms`)), ms)
      p.then(v => { clearTimeout(t); resolve(v) },
             e => { clearTimeout(t); reject(e) })
    })
  }

  const results = await Promise.all(integrations.map(async (integ) => {
    try {
      const result = await withTimeout(
        runSync(integ.org_id, integ.provider, from7, to, integ.id),
        PER_INTEGRATION_TIMEOUT_MS,
        `${integ.provider}/${integ.id}`,
      )
      return { provider: integ.provider, integration_id: integ.id, ...result }
    } catch (e: any) {
      return { provider: integ.provider, integration_id: integ.id, error: e.message }
    }
  }))

  const errors = results.filter(r => r.error)

  return NextResponse.json({
    ok:         errors.length === 0,
    synced:     results.length,
    errors:     errors.length,
    date_range: `${from7} to ${to}`,
    business_name: biz.name,
    detail:     results,
  }, {
    headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
  })
}
