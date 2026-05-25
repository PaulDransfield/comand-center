// app/api/admin/onboard/drive/route.ts
//
// The "Drive to completion" orchestrator for the concierge onboarding board.
// Inspects the live snapshot and kicks whatever stage is next/idle/stalled —
// closing the gaps between the self-chaining workers so the slow pipelines
// run flat-out during an onboarding session instead of waiting up to 30 min
// for the passive sweeps.
//
// Safe to call repeatedly (the board polls + calls this every ~5s):
//   - Never re-kicks a stage that is actively running (freshness-gated in
//     the snapshot via 'running' state).
//   - Kicks only 'todo' | 'failed' | 'stalled' stages.
//   - Strictly sequential (financials → invoices → pdf → catalogue) so the
//     line backfill and PDF extractor never fight over the shared
//     inventory_backfill_state row.
//
// POST /api/admin/onboard/drive
//   Body: { business_id, stage?, force? }
//     stage  — force-kick a specific stage instead of auto-picking.
//     force  — kick even if the stage looks active (manual override).
//   Auth: ADMIN_SECRET, org-scoped via requireAdmin.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { buildOnboardSnapshot } from '@/lib/onboard/snapshot'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

// Strictly sequential so the line backfill and PDF extractor never fight
// over the shared inventory_backfill_state row. Matching ('catalogue') runs
// inline during the backfill + after each PDF batch, so it's not driven here.
const DRIVE_ORDER = ['financials', 'invoices', 'pdf'] as const
type DriveStage = typeof DRIVE_ORDER[number]

function baseUrl(): string | null {
  return process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
}

export async function POST(req: NextRequest) {
  noStore()

  const body = await req.json().catch(() => ({} as any))
  const businessId = String(body?.business_id ?? '').trim()
  const forcedStage = body?.stage ? String(body.stage) : null
  const force = body?.force === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  const db = createAdminClient()
  const { data: biz } = await db.from('businesses').select('org_id').eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const guard = await requireAdmin(req, { orgId: biz.org_id, businessId })
  if (!('ok' in guard)) return guard

  const base = baseUrl()
  const cron = process.env.CRON_SECRET
  if (!base || !cron) {
    return NextResponse.json({ error: 'server misconfigured: NEXT_PUBLIC_APP_URL / CRON_SECRET missing' }, { status: 500 })
  }

  const snap = await buildOnboardSnapshot(db, businessId)
  if (!snap) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  // Hard gate: nothing can run until Fortnox is connected.
  const connect = snap.stages.find(s => s.key === 'connect')!
  if (connect.state === 'blocked') {
    return NextResponse.json({ action: 'blocked', stage: 'connect', blocker: connect.blocker, stages: snap.stages })
  }

  const byKey = Object.fromEntries(snap.stages.map(s => [s.key, s]))

  // Pick the target stage: forced, or the first drivable non-done stage.
  let target: DriveStage | null = null
  if (forcedStage && (DRIVE_ORDER as readonly string[]).includes(forcedStage)) {
    target = forcedStage as DriveStage
  } else {
    for (const k of DRIVE_ORDER) {
      const s = byKey[k]
      if (!s || s.state === 'done') continue
      target = k
      break
    }
  }

  if (!target) {
    return NextResponse.json({ action: 'complete', stages: snap.stages })
  }

  const s = byKey[target]
  const kickable = force || ['todo', 'failed', 'stalled'].includes(s.state)
  if (!kickable) {
    // Actively running or waiting on an earlier stage — let it cook.
    return NextResponse.json({ action: s.state === 'running' ? 'running' : 'waiting', stage: target, stages: snap.stages })
  }

  // ── Kick the target stage ─────────────────────────────────────────────
  try {
    if (target === 'financials') {
      // The worker only claims pending/paused rows. Flip a dead/idle/failed
      // row to pending so it gets claimed, then fire the worker.
      const fx = snap.raw.fortnox
      if (!fx || fx.backfill_status !== 'paused') {
        await db.from('integrations')
          .update({
            backfill_status:   'pending',
            backfill_error:    null,
            backfill_progress: { phase: 'enqueued', triggered_by: 'onboard_drive' },
          })
          .eq('business_id', businessId)
          .eq('provider', 'fortnox')
      }
      await fire(`${base}/api/cron/fortnox-backfill-worker`, cron, { trigger: 'onboard_drive', business_id: businessId })
    } else if (target === 'invoices') {
      // resume:true continues from the persisted cursor when a state row
      // already exists; a fresh kick otherwise.
      const resume = snap.raw.invStateExists && snap.raw.invIsLine
      await fire(`${base}/api/inventory/lines/backfill`, cron, { business_id: businessId, resume, trigger: 'onboard_drive' })
    } else if (target === 'pdf') {
      await fire(`${base}/api/cron/inventory-pdf-extract-business`, cron, {
        business_id: businessId, reset_extracting: true, chain_rematch: true,
      })
    }
  } catch (e: any) {
    return NextResponse.json({ action: 'error', stage: target, error: String(e?.message ?? e), stages: snap.stages }, { status: 502 })
  }

  return NextResponse.json({ action: 'kicked', stage: target, from_state: s.state, stages: snap.stages })
}

// Fire a worker endpoint with the cron secret. Awaited (the receiving
// endpoint returns fast after starting its own background work), so the
// POST is guaranteed to leave before this function returns.
async function fire(url: string, cronSecret: string, payload: Record<string, any>): Promise<void> {
  await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cronSecret}` },
    body:    JSON.stringify(payload),
  })
}
