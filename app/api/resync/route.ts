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
import { filterEligible } from '@/lib/sync/eligibility'

export const dynamic    = 'force-dynamic'
export const maxDuration = 120

// In-memory per-business lock. Adequate for single-region Vercel; if we go
// multi-region we can back this with Supabase. Two-tier cooldown: full
// 3-minute lock on success (protects upstream APIs from repeat work), 30s
// lock when every integration errored (lets the owner retry quickly while
// debugging without the cooldown being a wall).
const LAST_SYNC: Record<string, { at: number; cooldownMs: number }> = {}
const COOLDOWN_SUCCESS_MS = 3 * 60 * 1000
const COOLDOWN_FAILURE_MS = 30 * 1000

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
  if (lastRun && Date.now() - lastRun.at < lastRun.cooldownMs) {
    const waitSec = Math.ceil((lastRun.cooldownMs - (Date.now() - lastRun.at)) / 1000)
    return NextResponse.json({
      error:    `Sync already ran recently. Try again in ${waitSec}s.`,
      retry_in: waitSec,
    }, { status: 429 })
  }
  // Optimistically set the success-cooldown — re-set below if everything
  // errored so the next attempt is allowed sooner.
  LAST_SYNC[bizId] = { at: Date.now(), cooldownMs: COOLDOWN_SUCCESS_MS }

  // User-clicked "Sync now" deserves a stronger probe than cron: if the
  // integration is in needs_reauth we still try (subject to the 6 h backoff
  // in eligibility.ts) so a transient earlier failure doesn't make the
  // button look broken. If the probe still fails, the integration stays
  // needs_reauth and the UI prompts reconnect; if it succeeds, runSync
  // resets status='connected' and the button effectively self-heals.
  const { data: rawIntegrations } = await db
    .from('integrations')
    .select('id, org_id, business_id, provider, status, reauth_notified_at')
    .eq('business_id', bizId)
    .in('status', ['connected', 'needs_reauth', 'error'])

  const integrations = filterEligible(rawIntegrations ?? [])

  if (!integrations?.length) {
    // Distinguish "nothing connected" from "all wedged in needs_reauth and
    // backoff hasn't elapsed" so the UI can tell the user what to do.
    const wedged = (rawIntegrations ?? []).filter(i => i.status === 'needs_reauth').length
    return NextResponse.json({
      ok:      true,
      synced:  0,
      message: wedged > 0
        ? `${wedged} integration(s) need reconnecting. Open Settings → Integrations.`
        : 'No connected integrations',
      needs_reauth: wedged,
    })
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

  // If every integration errored, downgrade the cooldown so the user can
  // retry quickly without waiting 3 minutes for a sync that wrote nothing.
  if (errors.length === results.length && results.length > 0) {
    LAST_SYNC[bizId] = { at: Date.now(), cooldownMs: COOLDOWN_FAILURE_MS }
  }

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
