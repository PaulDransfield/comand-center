// app/api/admin/v2/health/route.ts
//
// Global system health for the Admin v2 Health tab. Single GET that
// returns six sections in one round-trip:
//
//   crons      — last run per Vercel cron (vercel.json + cron_run_log)
//   migrations — pending count + names parsed from MIGRATIONS.md header
//   rls        — list of public tables with RLS enabled + policy count
//                + anomaly flag (RLS=true AND policies=0 = full lockout)
//   sentry     — last-24h error count + p50 + top message; "not configured"
//                placeholder if SENTRY_AUTH_TOKEN absent
//   anthropic  — last 24h spend + 24h-prior + delta. RPC ai_spend_24h_global_usd
//                preferred (M033); falls back to direct SUM
//   stripe     — last-24h dedup row count + any stuck rows from the future
//                two-phase pattern (currently single-phase, so 0 stuck)
//
// 60s in-process cache because the response can hit ~500ms when Sentry +
// Anthropic + RLS RPC all run cold. Cache is per Vercel-instance; that's
// fine — admin browsers are sticky to one instance for the duration of
// a tab.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { readFile }                  from 'node:fs/promises'
import { join }                      from 'node:path'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// ── 60s in-process cache ─────────────────────────────────────────────
let cached:  { at: number; payload: any } | null = null
const TTL_MS = 60_000

const VERCEL_CRONS = [
  { path: '/api/cron/master-sync',                schedule: '0 5 * * *',     name: 'Daily 05:00 UTC' },
  { path: '/api/cron/catchup-sync',               schedule: '0 6-23 * * *',  name: 'Hourly 06–23 UTC' },
  { path: '/api/cron/anomaly-check',              schedule: '30 5 * * *',    name: 'Daily 05:30 UTC' },
  { path: '/api/cron/health-check',               schedule: '0 6 * * *',     name: 'Daily 06:00 UTC' },
  { path: '/api/cron/weekly-digest',              schedule: '0 6 * * 1',     name: 'Mon 06:00 UTC' },
  { path: '/api/cron/forecast-calibration',       schedule: '0 4 1 * *',     name: '1st-of-month 04:00 UTC' },
  { path: '/api/cron/supplier-price-creep',       schedule: '0 5 1 * *',     name: '1st-of-month 05:00 UTC' },
  { path: '/api/cron/scheduling-optimization',    schedule: '0 7 * * 1',     name: 'Mon 07:00 UTC' },
  { path: '/api/cron/onboarding-success',         schedule: '0 8 * * *',     name: 'Daily 08:00 UTC' },
  { path: '/api/cron/api-discovery',              schedule: '0 2 * * 0',     name: 'Sun 02:00 UTC' },
  { path: '/api/cron/api-discovery-enhanced',     schedule: '0 3 * * 0',     name: 'Sun 03:00 UTC' },
  { path: '/api/cron/customer-health-scoring',    schedule: '0 8 * * 1',     name: 'Mon 08:00 UTC' },
]

const DAY_MS = 86_400_000

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  // Cache hit?
  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json({ ...cached.payload, cached: true, age_ms: Date.now() - cached.at }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const db  = createAdminClient()
  const now = Date.now()

  // Run all probes in parallel — each is bounded + has a fallback.
  const [crons, migrations, rls, sentry, anthropic, stripe] = await Promise.all([
    probeCrons(db, now),
    probeMigrations(),
    probeRls(db),
    probeSentry(),
    probeAnthropic(db, now),
    probeStripe(db, now),
  ])

  const payload = {
    crons,
    migrations,
    rls,
    sentry,
    anthropic,
    stripe,
    generated_at: new Date().toISOString(),
  }

  cached = { at: Date.now(), payload }

  return NextResponse.json({ ...payload, cached: false }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

// ─── Probes ────────────────────────────────────────────────────────────────

async function probeCrons(db: any, nowMs: number) {
  // Latest run per cron_name from cron_run_log. Falls back to "never logged"
  // for crons that haven't started using withCronLog yet.
  let logged: Record<string, { started_at: string; status: string; finished_at: string | null; error: string | null }> = {}
  let logTablePresent = true
  try {
    const { data, error } = await db
      .from('cron_run_log')
      .select('cron_name, started_at, finished_at, status, error')
      .order('started_at', { ascending: false })
      .limit(500)
    if (error) throw error
    for (const r of data ?? []) {
      const key = r.cron_name
      // Latest only — first one wins because we ordered DESC.
      if (!logged[key]) logged[key] = r
    }
  } catch {
    logTablePresent = false
  }

  const out = VERCEL_CRONS.map(c => {
    const key = c.path.replace('/api/cron/', '').replace(/^\//, '')
    const lr  = logged[key]
    const ageMs = lr?.started_at ? (nowMs - new Date(lr.started_at).getTime()) : null
    return {
      path:        c.path,
      schedule:    c.schedule,
      schedule_human: c.name,
      last_started_at:  lr?.started_at  ?? null,
      last_finished_at: lr?.finished_at ?? null,
      last_status:      lr?.status      ?? null,
      last_error:       lr?.error       ?? null,
      age_ms:           ageMs,
    }
  })

  return {
    crons: out,
    log_table_present: logTablePresent,
    note: logTablePresent
      ? 'Crons not yet wrapped with withCronLog show last_status=null. Wiring per-handler is a follow-up.'
      : 'cron_run_log table missing — apply M036-ADMIN-HEALTH-CONFIG.sql in Supabase.',
  }
}

async function probeMigrations() {
  // Read MIGRATIONS.md from disk, parse the header line for the "applied"/
  // "pending" annotations. Header format:
  //   "> Last updated: 2026-04-28 | M022 applied · M035 applied · M032 pending …"
  try {
    const path = join(process.cwd(), 'MIGRATIONS.md')
    const text = await readFile(path, 'utf-8')
    const headerLine = text.split('\n').find(l => l.includes('Last updated:') && l.includes('|')) ?? ''
    const tail = headerLine.split('|').slice(1).join('|')
    const tokens = tail.split(/[·•]/).map(s => s.trim()).filter(Boolean)
    const pending: string[] = []
    const applied: string[] = []
    for (const t of tokens) {
      const m = t.match(/^(M\d+)\s+(applied|pending)$/i)
      if (!m) continue
      if (m[2].toLowerCase() === 'pending') pending.push(m[1])
      else applied.push(m[1])
    }
    return {
      applied_count: applied.length,
      pending_count: pending.length,
      pending,
      header_line: headerLine.trim(),
      ok: true,
    }
  } catch (e: any) {
    return {
      applied_count: 0,
      pending_count: 0,
      pending: [],
      header_line: '',
      ok: false,
      error: e?.message ?? 'failed to read MIGRATIONS.md',
    }
  }
}

async function probeRls(db: any) {
  // Calls admin_health_rls() RPC (M036). Falls back to "rpc missing" note
  // if M036 not applied.
  try {
    const { data, error } = await db.rpc('admin_health_rls')
    if (error) throw error
    const tables = (data ?? []) as Array<{ table_name: string; rls_enabled: boolean; policy_count: number; is_anomaly: boolean }>
    return {
      rpc_present: true,
      total_tables:    tables.length,
      rls_enabled:     tables.filter(t => t.rls_enabled).length,
      anomalies:       tables.filter(t => t.is_anomaly),
      tables_with_no_policy: tables.filter(t => t.policy_count === 0).length,
      tables,
    }
  } catch (e: any) {
    return {
      rpc_present: false,
      total_tables:    0,
      rls_enabled:     0,
      anomalies:       [],
      tables_with_no_policy: 0,
      tables:          [],
      note: 'admin_health_rls() RPC missing — apply M036-ADMIN-HEALTH-CONFIG.sql in Supabase.',
      error: e?.message,
    }
  }
}

async function probeSentry() {
  const token  = process.env.SENTRY_AUTH_TOKEN
  const orgSlug = process.env.SENTRY_ORG  ?? 'comandcenter'
  const projSlug = process.env.SENTRY_PROJECT ?? 'javascript-nextjs'
  if (!token) {
    return { configured: false, note: 'Set SENTRY_AUTH_TOKEN to enable Sentry health.' }
  }
  // Sentry's stats endpoint. Single 24h bucket.
  try {
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000)
    const url = `https://sentry.io/api/0/projects/${orgSlug}/${projSlug}/stats/?stat=received&resolution=1d&since=${since}`
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      // 5s timeout via AbortController — Sentry can be slow.
      signal: AbortSignal.timeout(5000),
    })
    if (!r.ok) return { configured: true, ok: false, error: `Sentry HTTP ${r.status}` }
    const arr = await r.json()                                         // [[ts, count], …]
    const total = Array.isArray(arr) ? arr.reduce((s: number, p: any) => s + Number(p?.[1] ?? 0), 0) : 0
    return { configured: true, ok: true, errors_24h: total }
  } catch (e: any) {
    return { configured: true, ok: false, error: e?.message ?? 'sentry probe failed' }
  }
}

async function probeAnthropic(db: any, nowMs: number) {
  // Use ai_spend_24h_global_usd RPC (M033) when available, else SUM.
  // We need TWO numbers: last 24h vs the prior 24h.
  const day1 = new Date(nowMs - 1 * DAY_MS).toISOString()
  const day2 = new Date(nowMs - 2 * DAY_MS).toISOString()

  // Last 24h via RPC if possible.
  let last24: number | null = null
  let rpcUsed = false
  try {
    const { data, error } = await db.rpc('ai_spend_24h_global_usd')
    if (!error && data != null) {
      last24 = Number(data) || 0
      rpcUsed = true
    }
  } catch { /* fall through to SUM */ }

  if (last24 == null) {
    try {
      const { data } = await db.from('ai_request_log')
        .select('cost_usd')                                            // FIXES §0w.3 — cost_usd not total_cost_usd
        .gte('created_at', day1)
        .limit(50000)
      last24 = (data ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0)
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'anthropic probe failed' }
    }
  }

  // Prior 24h always via SUM (no RPC for that window).
  let prior24 = 0
  try {
    const { data } = await db.from('ai_request_log')
      .select('cost_usd')
      .gte('created_at', day2)
      .lt('created_at',  day1)
      .limit(50000)
    prior24 = (data ?? []).reduce((s: number, r: any) => s + Number(r.cost_usd ?? 0), 0)
  } catch { /* keep 0 */ }

  const deltaPct = prior24 > 0 ? Math.round(((last24! - prior24) / prior24) * 100) : null
  const cap = parseFloat(process.env.MAX_DAILY_GLOBAL_USD ?? '50') || 50
  return {
    ok:               true,
    rpc_used:         rpcUsed,
    last_24h_usd:     Math.round(last24! * 10000) / 10000,
    prior_24h_usd:    Math.round(prior24  * 10000) / 10000,
    delta_pct:        deltaPct,
    global_cap_usd:   cap,
    pct_of_cap:       cap > 0 ? Math.round((last24! / cap) * 100) : null,
  }
}

async function probeStripe(db: any, nowMs: number) {
  const since24h = new Date(nowMs - 1 * DAY_MS).toISOString()
  const stuckCutoff = new Date(nowMs - 5 * 60_000).toISOString()
  try {
    const [recentRes, stuckRes] = await Promise.all([
      db.from('stripe_processed_events')
        .select('event_id', { count: 'exact', head: true })
        .gte('processed_at', since24h),
      // Two-phase dedup not yet shipped; query is harmless — returns 0.
      // When the pattern lands, this surfaces real stuck rows.
      db.from('stripe_processed_events')
        .select('event_id', { count: 'exact', head: true })
        .is('processed_at', null)
        .lt('created_at', stuckCutoff),
    ])
    return {
      ok:                true,
      events_24h:        recentRes.count ?? 0,
      stuck_count:       stuckRes.count  ?? 0,
      note: stuckRes.count && stuckRes.count > 0
        ? 'Rows with NULL processed_at older than 5 min — investigate webhook retry path.'
        : 'Single-phase dedup currently in use; stuck count will populate when two-phase pattern ships.',
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'stripe probe failed' }
  }
}
