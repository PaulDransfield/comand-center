// @ts-nocheck
// app/api/cron/ai-log-retention/route.ts
//
// Weekly cron that archives + deletes ai_request_log rows older than 365 days.
//
// Two-step flow (2026-05-25 hardening — was hard-delete-only before):
//   1. Aggregate the to-delete window into ai_request_log_archive
//      (per-day per-(org × request_type × model) totals). M102 added
//      the table.
//   2. Delete the source rows only after the upsert succeeds. If
//      archive fails, abort — we never delete unarchived audit data.
//
// The archive is ~99% smaller (one row per day × org × type × model
// instead of one per request) so we can keep 7+ years cheaply for
// compliance + historical cost analysis.
//
// Schedule (vercel.json): '0 3 * * 0' — Sunday 03:00 UTC.
// Returns: { archived: N, deleted: N, cutoff: 'YYYY-MM-DD' }

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { log }                       from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const RETENTION_DAYS = 365
// SELECT batch size — fetch this many to-delete rows at a time. Keeps
// memory bounded for orgs with very chatty AI usage.
const BATCH_SIZE     = 5000

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}
export async function GET(req: NextRequest) {
  if (!checkCronSecret(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return run()
}

async function run() {
  const started = Date.now()
  const db = createAdminClient()
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // ── Step 1: archive aggregates ──────────────────────────────────
  let archivedRollupCount = 0
  let archivedRowCount    = 0

  while (true) {
    // Load a batch of to-delete rows. Order by created_at so we
    // process oldest first (stable archive write order).
    const { data: batch, error: selErr } = await db
      .from('ai_request_log')
      .select('created_at, org_id, request_type, model, input_tokens, output_tokens, cost_usd, cost_sek, duration_ms')
      .lt('created_at', cutoff)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE)

    if (selErr) {
      log.error('ai-log-retention archive select failed', {
        route: 'cron/ai-log-retention', error: selErr.message, status: 'error',
      })
      return NextResponse.json({ error: `archive select: ${selErr.message}` }, { status: 500 })
    }
    if (!batch || batch.length === 0) break

    // Aggregate in JS — group by (date, org_id, request_type, model)
    const buckets: Record<string, any> = {}
    for (const row of batch) {
      const date = String(row.created_at).slice(0, 10)
      const orgId = row.org_id
      const type  = row.request_type ?? 'unknown'
      const model = row.model ?? 'unknown'
      const key   = `${date}|${orgId}|${type}|${model}`
      if (!buckets[key]) {
        buckets[key] = {
          date, org_id: orgId, request_type: type, model,
          request_count: 0,
          input_tokens_total: 0, output_tokens_total: 0,
          cost_usd_total: 0, cost_sek_total: 0,
          duration_ms_total: 0,
        }
      }
      buckets[key].request_count       += 1
      buckets[key].input_tokens_total  += Number(row.input_tokens  ?? 0)
      buckets[key].output_tokens_total += Number(row.output_tokens ?? 0)
      buckets[key].cost_usd_total      += Number(row.cost_usd      ?? 0)
      buckets[key].cost_sek_total      += Number(row.cost_sek      ?? 0)
      buckets[key].duration_ms_total   += Number(row.duration_ms   ?? 0)
    }
    const rollups = Object.values(buckets)

    // Upsert into archive. PK is (date, org_id, request_type, model);
    // re-runs add to the existing counters via the RPC below. (We use
    // a small helper RPC instead of straight upsert because PostgREST
    // upsert doesn't expose SET col = col + EXCLUDED.col semantics.)
    for (const r of rollups) {
      const { error: upErr } = await db.rpc('upsert_ai_log_archive', {
        p_date:                r.date,
        p_org_id:              r.org_id,
        p_request_type:        r.request_type,
        p_model:               r.model,
        p_request_count:       r.request_count,
        p_input_tokens_total:  r.input_tokens_total,
        p_output_tokens_total: r.output_tokens_total,
        p_cost_usd_total:      r.cost_usd_total,
        p_cost_sek_total:      r.cost_sek_total,
        p_duration_ms_total:   r.duration_ms_total,
      })
      if (upErr) {
        log.error('ai-log-retention archive upsert failed', {
          route: 'cron/ai-log-retention', error: upErr.message,
          date: r.date, org_id: r.org_id, request_type: r.request_type,
        })
        // Abort the whole run — never delete unarchived audit data
        return NextResponse.json({
          error:         `archive upsert: ${upErr.message}`,
          archived_rows: archivedRowCount,
          archived_rollups: archivedRollupCount,
        }, { status: 500 })
      }
    }
    archivedRollupCount += rollups.length
    archivedRowCount    += batch.length

    // If we got fewer than BATCH_SIZE rows, we've drained the window
    if (batch.length < BATCH_SIZE) break
  }

  // ── Step 2: delete the archived window ──────────────────────────
  const { count: deleted, error: delErr } = await db
    .from('ai_request_log')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff)

  if (delErr) {
    log.error('ai-log-retention delete failed', {
      route: 'cron/ai-log-retention', error: delErr.message,
      archived_rows: archivedRowCount, status: 'error',
    })
    return NextResponse.json({
      error:         delErr.message,
      archived_rows: archivedRowCount,
      archived_rollups: archivedRollupCount,
    }, { status: 500 })
  }

  log.info('ai-log-retention complete', {
    route:            'cron/ai-log-retention',
    duration_ms:      Date.now() - started,
    archived_rows:    archivedRowCount,
    archived_rollups: archivedRollupCount,
    deleted:          deleted ?? 0,
    retention_days:   RETENTION_DAYS,
    status:           'success',
  })
  return NextResponse.json({
    ok:               true,
    archived_rows:    archivedRowCount,
    archived_rollups: archivedRollupCount,
    deleted:          deleted ?? 0,
    cutoff:           cutoff.slice(0, 10),
  })
}
