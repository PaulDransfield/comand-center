// app/api/admin/cron-health/route.ts
//
// A1.6 — admin cron observability surface. Reads cron_run_log (the
// shared run log already populated by withCronLog in lib/cron/log.ts).
// Returns:
//   - latest_per_cron: latest run for every distinct cron_name we've seen
//   - stuck_running: rows still in status='running' past the stale threshold
//   - failures_24h: count of failed runs in the last 24 hours
//   - top_long_runners: top 10 by computed duration in the last 24h
//
// Duration is derived from finished_at - started_at (cron_run_log
// doesn't store duration_ms directly).
//
// Read-only. 30-second in-process cache.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { createAdminClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_RUNNING_MS = 20 * 60_000   // running > 20 min after start = presumed crashed

const TTL_MS = 30_000
let cached: { at: number; payload: any } | null = null

interface LogRow {
  id:          string
  cron_name:   string
  started_at:  string
  finished_at: string | null
  status:      string | null
  error:       string | null
  meta:        any
}

interface OutRow extends LogRow {
  duration_ms:     number | null
  items_processed: number | null
}

function enrich(r: LogRow): OutRow {
  const dur = r.started_at && r.finished_at
    ? Math.max(0, new Date(r.finished_at).getTime() - new Date(r.started_at).getTime())
    : null
  // items_processed lives in meta in a few conventional shapes; we try
  // the common ones so different cron flavours surface a number.
  const m = r.meta ?? {}
  let items: number | null = null
  for (const k of ['processed', 'items_processed', 'count', 'rows', 'lines']) {
    if (typeof m[k] === 'number') { items = m[k]; break }
  }
  return { ...r, duration_ms: dur, items_processed: items }
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if (!('ok' in guard)) return guard

  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(cached.payload, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const db = createAdminClient()

  // Last 24h window
  const dayAgo = new Date(Date.now() - 24 * 3_600_000).toISOString()
  const { data: rowsRaw, error } = await db
    .from('cron_run_log')
    .select('id, cron_name, started_at, finished_at, status, error, meta')
    .gte('started_at', dayAgo)
    .order('started_at', { ascending: false })
    .limit(2000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows: OutRow[] = (rowsRaw ?? []).map(enrich as any)

  // Latest per cron — broader query, not date-bounded, so daily-only crons surface.
  const { data: latestRaw } = await db
    .from('cron_run_log')
    .select('id, cron_name, started_at, finished_at, status, error, meta')
    .order('started_at', { ascending: false })
    .limit(500)

  const seen = new Set<string>()
  const latestPerCron: OutRow[] = []
  for (const r of latestRaw ?? []) {
    if (seen.has((r as any).cron_name)) continue
    seen.add((r as any).cron_name)
    latestPerCron.push(enrich(r as any))
  }

  const staleThresh = Date.now() - STALE_RUNNING_MS
  const stuckRunning = rows.filter(r =>
    r.status === 'running' &&
    new Date(r.started_at).getTime() < staleThresh,
  )

  const failures24h = rows.filter(r => r.status === 'error')

  const topLongRunners = rows
    .filter(r => r.duration_ms != null)
    .sort((a, b) => Number(b.duration_ms ?? 0) - Number(a.duration_ms ?? 0))
    .slice(0, 10)

  const payload = {
    computed_at: new Date().toISOString(),
    summary: {
      crons_seen:     latestPerCron.length,
      stuck_running:  stuckRunning.length,
      failures_24h:   failures24h.length,
      total_runs_24h: rows.length,
    },
    latest_per_cron:  latestPerCron,
    stuck_running:    stuckRunning,
    failures_24h:     failures24h.slice(0, 30),
    top_long_runners: topLongRunners,
  }

  cached = { at: Date.now(), payload }
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
