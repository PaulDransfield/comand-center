// app/api/status/route.ts
//
// A3.7 — public status endpoint. NO auth required (this is the
// "is the system healthy" surface prospects + customers can hit). It
// aggregates cron_run_log into per-pillar status without exposing any
// per-customer detail.
//
// Pillars and the crons that feed them:
//   - Data sync       — master-sync
//   - Fortnox sync    — fortnox-supplier-sync + fortnox-pdf-backfill
//   - PDF extraction  — extraction-sweeper + inventory-pdf-extract-sweep
//   - FX rates        — fx-rates-update
//   - AI agents       — ai-daily-report + anomaly-check
//   - Reviews         — reviews-sync
//
// Per pillar: greenest of its constituent crons wins.
// Thresholds for each cron's status:
//   green  — last successful run < 24h ago, no current failure
//   yellow — last success 24-48h ago OR last run errored but recovered
//   red    — > 48h since success OR currently in failure state
//
// Refreshed via 60s in-process cache; data updates every minute.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const TTL_MS = 60_000
let cached: { at: number; payload: any } | null = null

type PillarStatus = 'green' | 'yellow' | 'red' | 'unknown'

interface Pillar {
  key:       string
  label:     string
  status:    PillarStatus
  last_run:  string | null
  message:   string
}

const PILLARS: Array<{ key: string; label: string; crons: string[] }> = [
  { key: 'data_sync',      label: 'Data sync',       crons: ['master-sync', 'catchup-sync'] },
  { key: 'fortnox',        label: 'Fortnox',         crons: ['fortnox-supplier-sync', 'fortnox-pdf-backfill', 'fortnox-backfill-worker'] },
  { key: 'pdf_extraction', label: 'PDF extraction',  crons: ['extraction-sweeper', 'inventory-pdf-extract-sweep'] },
  { key: 'fx_rates',       label: 'FX rates',        crons: ['fx-rates-update'] },
  { key: 'ai_agents',      label: 'AI agents',       crons: ['ai-daily-report', 'anomaly-check', 'weekly-digest'] },
  { key: 'reviews',        label: 'Reviews',         crons: ['reviews-sync'] },
]

const GREEN_THRESHOLD_MS  = 24 * 3_600_000
const YELLOW_THRESHOLD_MS = 48 * 3_600_000

export async function GET(_req: NextRequest) {
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.payload, {
      headers: { 'Cache-Control': 'public, max-age=60' },
    })
  }

  const db = createAdminClient()

  // Pull the latest run per cron_name. One query, then group.
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString()
  const { data: rows, error } = await db
    .from('cron_run_log')
    .select('cron_name, started_at, finished_at, status, error')
    .gte('started_at', since)
    .order('started_at', { ascending: false })
    .limit(2000)

  if (error) {
    return NextResponse.json({ error: 'status_unavailable' }, { status: 503 })
  }

  const latestByCron = new Map<string, any>()
  for (const r of rows ?? []) {
    if (!latestByCron.has(r.cron_name)) latestByCron.set(r.cron_name, r)
  }

  const now = Date.now()
  const cronStatus = (cronName: string): { status: PillarStatus; last_run: string | null; message: string } => {
    const r = latestByCron.get(cronName)
    if (!r) return { status: 'unknown', last_run: null, message: 'No recent runs' }
    const age = now - new Date(r.started_at).getTime()
    if (r.status === 'error') {
      return { status: 'red', last_run: r.started_at, message: 'Last run failed' }
    }
    if (r.status === 'running') {
      // Stale running > 30 min = bad signal but not a confirmed failure.
      if (age > 30 * 60_000) return { status: 'yellow', last_run: r.started_at, message: 'Run in progress > 30 min' }
      return { status: 'green', last_run: r.started_at, message: 'Run in progress' }
    }
    if (age <= GREEN_THRESHOLD_MS)  return { status: 'green',  last_run: r.started_at, message: 'Healthy' }
    if (age <= YELLOW_THRESHOLD_MS) return { status: 'yellow', last_run: r.started_at, message: 'Behind schedule' }
    return { status: 'red', last_run: r.started_at, message: `Stale (${Math.round(age / 3_600_000)}h)` }
  }

  const tierRank: Record<PillarStatus, number> = { green: 0, yellow: 1, red: 2, unknown: 3 }
  const pillars: Pillar[] = PILLARS.map(p => {
    let worst: ReturnType<typeof cronStatus> = { status: 'unknown', last_run: null, message: '' }
    for (const cronName of p.crons) {
      const s = cronStatus(cronName)
      if (tierRank[s.status] > tierRank[worst.status]) worst = s
    }
    return { key: p.key, label: p.label, ...worst }
  })

  const overallRank = pillars.reduce((m, p) => Math.max(m, tierRank[p.status]), 0)
  const overall: PillarStatus = (['green','yellow','red','unknown'] as PillarStatus[])[overallRank] ?? 'unknown'

  const payload = {
    overall,
    pillars,
    computed_at: new Date().toISOString(),
  }
  cached = { at: Date.now(), payload }
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'public, max-age=60' },
  })
}
