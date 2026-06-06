// app/api/cron/ingestion-coverage-check/route.ts
//
// Phase 3 of INGESTION-PIPELINE-RELIABILITY-PLAN.md (2026-06-06).
//
// Daily coverage check on the ingestion_log table. Computes per-source ×
// per-field population coverage for the last 24h, compares against the
// trailing 13-day baseline (excluding today), and alerts ops on:
//
//   • Field coverage drop ≥ ALERT_DROP_PCT vs baseline
//   • New field appearing with < ALERT_NEW_FIELD_FLOOR coverage
//   • Source with > ALERT_FAIL_RATIO failed-ledger ratio today
//   • Source × business with zero ledger activity in 24h despite
//     being a connected integration with synced state
//
// Why baseline-free design: we don't persist baselines in their own
// table. The ledger itself IS the rolling 14d history. Baseline =
// trailing 13d coverage; today = last 24h. New gap = field present
// in today's expected_fields but absent from baseline's populated_fields.
// Self-recalibrates as the system matures.
//
// Schedule: vercel.json `30 7 * * *` (07:30 UTC, after all major syncs).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret } from '@/lib/admin/check-secret'
import { log } from '@/lib/log/structured'
import { sendOpsEmail } from '@/lib/email/ops-alert'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// Tunables — start conservative so we don't drown ops in alerts during
// the first few weeks. Phase 3 builds the muscle; we tighten later.
const ALERT_DROP_PCT        = 5                   // % drop (percentage points) vs baseline to trigger alert
const ALERT_NEW_FIELD_FLOOR = 0.50                // new fields with <50% coverage on day 1 trigger alert
const ALERT_FAIL_RATIO      = 0.20                // >20% failed ledgers in 24h triggers alert
const MIN_SAMPLE            = 5                   // ignore (source, field) pairs with <5 baseline observations to avoid flapping

interface FieldStat {
  source:        string
  resource:      string
  field:         string
  observed:      number       // how many ledger entries listed this field as expected
  populated:     number       // how many actually populated it
  coverage_pct:  number       // populated / observed (0..1)
}

export async function POST(req: NextRequest) { return run(req) }
export async function GET(req: NextRequest)  { return run(req) }   // Vercel cron uses GET

async function run(req: NextRequest): Promise<NextResponse> {
  noStore()
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const startedAt = Date.now()
  const db        = createAdminClient()

  const now            = new Date()
  const dayAgo         = new Date(now.getTime() - 24 * 3600_000)
  const fourteenDayAgo = new Date(now.getTime() - 14 * 24 * 3600_000)

  // Pull last 14d of ledger entries. We expect a few thousand rows at
  // current scale; if this ever gets heavy, swap to a SQL-side rollup.
  const { data: rows, error } = await db
    .from('ingestion_log')
    .select('source, resource, business_id, started_at, expected_fields, populated_fields, status, error')
    .gte('started_at', fourteenDayAgo.toISOString())
    .order('started_at', { ascending: false })
    .range(0, 49_999)
  if (error) {
    log.error('coverage_check fetch failed', { error: error.message })
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
  }
  if (!rows || rows.length === 0) {
    return NextResponse.json({ ok: true, message: 'no ledger entries in window', alerts: [] })
  }

  // Split into today (last 24h) vs baseline (the preceding 13 days).
  const todayRows    = rows.filter(r => new Date(r.started_at) >= dayAgo)
  const baselineRows = rows.filter(r => new Date(r.started_at) < dayAgo)

  const todayStats    = computeFieldStats(todayRows)
  const baselineStats = computeFieldStats(baselineRows)

  const alerts: string[] = []

  // ── 1. Field coverage drops vs baseline ────────────────────────────
  for (const [key, today] of todayStats) {
    const base = baselineStats.get(key)
    if (!base) {
      // New (source, resource, field) tuple appeared today. Alert if
      // coverage is below the floor — could be a new ingestion gap.
      if (today.coverage_pct < ALERT_NEW_FIELD_FLOOR && today.observed >= MIN_SAMPLE) {
        alerts.push(
          `NEW field appeared with low coverage:\n` +
          `  ${today.source}.${today.resource}.${today.field}\n` +
          `  Today: ${today.populated}/${today.observed} (${pct(today.coverage_pct)})`,
        )
      }
      continue
    }
    if (base.observed < MIN_SAMPLE) continue
    const dropPct = (base.coverage_pct - today.coverage_pct) * 100
    if (dropPct >= ALERT_DROP_PCT) {
      alerts.push(
        `Coverage REGRESSION:\n` +
        `  ${today.source}.${today.resource}.${today.field}\n` +
        `  Today:    ${today.populated}/${today.observed} (${pct(today.coverage_pct)})\n` +
        `  Baseline: ${base.populated}/${base.observed} (${pct(base.coverage_pct)})\n` +
        `  Drop:     ${dropPct.toFixed(1)} percentage points`,
      )
    }
  }

  // ── 2. Failed-ledger ratio per source × resource ────────────────────
  const sourceTotals = new Map<string, { total: number; failed: number }>()
  for (const r of todayRows) {
    const k = `${r.source}.${r.resource}`
    const e = sourceTotals.get(k) ?? { total: 0, failed: 0 }
    e.total++
    if (r.status === 'failed') e.failed++
    sourceTotals.set(k, e)
  }
  for (const [k, s] of sourceTotals) {
    if (s.total < MIN_SAMPLE) continue
    const ratio = s.failed / s.total
    if (ratio >= ALERT_FAIL_RATIO) {
      alerts.push(
        `FAILED-LEDGER ratio above threshold:\n` +
        `  ${k}\n` +
        `  Today: ${s.failed} failed / ${s.total} total (${pct(ratio)})`,
      )
    }
  }

  // ── 3. Silent integrations: connected Fortnox biz with zero activity ──
  const silentAlerts = await checkSilentIntegrations(db, todayRows)
  alerts.push(...silentAlerts)

  // ── 4. Email if anything fired ──────────────────────────────────────
  if (alerts.length > 0) {
    const headline = `[CommandCenter] Ingestion coverage check — ${alerts.length} alert${alerts.length === 1 ? '' : 's'}`
    const body =
      `Window: last 24h vs trailing 13-day baseline.\n` +
      `Generated: ${now.toISOString()}\n` +
      `Total ledger rows in window: today=${todayRows.length}, baseline=${baselineRows.length}\n\n` +
      `══ Alerts ══\n\n` +
      alerts.map((a, i) => `${i + 1}. ${a}`).join('\n\n') +
      `\n\n──\nSource: Phase 3 of INGESTION-PIPELINE-RELIABILITY-PLAN.md\n` +
      `Tunables: ALERT_DROP_PCT=${ALERT_DROP_PCT}, ALERT_NEW_FIELD_FLOOR=${ALERT_NEW_FIELD_FLOOR}, ALERT_FAIL_RATIO=${ALERT_FAIL_RATIO}, MIN_SAMPLE=${MIN_SAMPLE}`
    try {
      await sendOpsEmail({ subject: headline, body })
    } catch (e: any) {
      log.warn('coverage_check email failed', { error: e?.message ?? e })
    }
  }

  log.info('coverage_check done', {
    route:        'cron/ingestion-coverage-check',
    duration_ms:  Date.now() - startedAt,
    today_rows:   todayRows.length,
    baseline_rows:baselineRows.length,
    alerts:       alerts.length,
  })

  return NextResponse.json({
    ok: true,
    today_rows:    todayRows.length,
    baseline_rows: baselineRows.length,
    alerts_count:  alerts.length,
    alerts:        alerts.slice(0, 50),                 // truncate the response body
  })
}

/**
 * Compute per (source, resource, field) coverage stats over a set of
 * ledger rows. observed = how many entries listed the field in
 * expected_fields; populated = how many actually populated it.
 */
function computeFieldStats(rows: any[]): Map<string, FieldStat> {
  const out = new Map<string, FieldStat>()
  for (const r of rows) {
    const expected:  string[] = Array.isArray(r.expected_fields)  ? r.expected_fields  : []
    const populated: string[] = Array.isArray(r.populated_fields) ? r.populated_fields : []
    const popSet = new Set(populated)
    for (const f of expected) {
      const key = `${r.source}.${r.resource}.${f}`
      let stat = out.get(key)
      if (!stat) {
        stat = { source: r.source, resource: r.resource, field: f, observed: 0, populated: 0, coverage_pct: 0 }
        out.set(key, stat)
      }
      stat.observed++
      if (popSet.has(f)) stat.populated++
    }
  }
  for (const stat of out.values()) {
    stat.coverage_pct = stat.observed > 0 ? stat.populated / stat.observed : 0
  }
  return out
}

/**
 * Flag silent integrations: a connected Fortnox business that produced
 * zero ledger entries in the last 24h. Strong signal that something
 * broke in the cron itself (the bug class this whole pipeline was
 * built to catch).
 */
async function checkSilentIntegrations(db: any, todayRows: any[]): Promise<string[]> {
  const alerts: string[] = []
  const activeBizSet = new Set(todayRows.filter(r => r.business_id).map(r => r.business_id as string))

  const { data: integs } = await db
    .from('integrations')
    .select('id, business_id, status, businesses(name)')
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'warning'])

  for (const integ of integs ?? []) {
    if (!integ.business_id) continue
    if (activeBizSet.has(integ.business_id)) continue
    const name = ((integ.businesses as any)?.name) ?? integ.business_id.slice(0, 8)
    alerts.push(
      `SILENT integration — Fortnox connected but zero ledger entries in 24h:\n` +
      `  business: ${name} (${integ.business_id.slice(0, 8)}…)\n` +
      `  status:   ${integ.status}\n` +
      `  hint: check master-sync logs / supplier-sync errors`,
    )
  }
  return alerts
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}
