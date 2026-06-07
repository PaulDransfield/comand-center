// app/api/admin/v2/backfill-health/route.ts
//
// Per-customer backfill health dashboard. ONE call returns every
// business's:
//   - current inventory_backfill_state (status + progress + staleness)
//   - supplier_invoice_lines counts by match_status + ingestion_status
//   - fortnox_invoices counts by pdf_status
//   - a derived health_score: 'healthy' | 'attention' | 'stuck'
//
// Health rules (in order of severity):
//   stuck     — backfill state='running' but updated > 30 min ago
//                OR any pending PDF older than 48h
//                OR any header_only line older than 48h
//   attention — backfill state='failed'
//                OR pdf_pending > 0 (still draining)
//                OR header_only > 0 (still draining)
//                OR needs_review > 200 (queue building up)
//   healthy   — everything else
//
// 30-second in-process cache. Admin browsers refreshing this don't need
// per-tick freshness; live progress lives on /admin/v2/setup-health or
// the customer's own SyncProgressBanner.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/require-admin'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

const TTL_MS = 30_000
let cached: { at: number; payload: any } | null = null

const STALE_RUNNING_MS  = 30 * 60_000        // backfill running > 30 min since last update = dead
const OLD_PENDING_MS    = 48 * 3_600_000     // pending PDF / header_only older than 48h = stuck
const QUEUE_ATTENTION   = 200                // needs_review > 200 = surface

interface BusinessRow {
  business_id:   string
  business_name: string
  org_id:        string
  org_name:      string
  backfill: {
    status:      string | null               // 'pending' | 'running' | 'completed' | 'failed' | null
    started_at:  string | null
    updated_at:  string | null
    finished_at: string | null
    progress:    any
    is_stale:    boolean
  }
  pdf_queue: {
    pending:   number
    extracted: number
    no_pdf:    number
    failed:    number
    total:     number
  }
  line_queue: {
    matched:       number
    needs_review:  number
    not_inventory: number
    unprocessed:   number
    total:         number
  }
  ingestion: {
    complete:    number
    header_only: number
    partial:     number
    failed:      number
  }
  oldest_pending_pdf_at:    string | null
  oldest_header_only_at:    string | null
  health_score:             'healthy' | 'attention' | 'stuck'
  health_reasons:           string[]
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if (!('ok' in guard)) return guard as NextResponse

  if (cached && Date.now() - cached.at < TTL_MS) {
    return NextResponse.json(
      { ...cached.payload, cached: true, age_ms: Date.now() - cached.at },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  }

  const db = createAdminClient()
  const now = Date.now()

  // Load every business + its org name in one go.
  const { data: businesses, error: bErr } = await db
    .from('businesses')
    .select('id, name, org_id, organisations(name)')
    .order('name', { ascending: true })
  if (bErr) return NextResponse.json({ error: bErr.message }, { status: 500 })

  if (!businesses || businesses.length === 0) {
    return NextResponse.json({
      businesses:    [],
      summary:       { total: 0, healthy: 0, attention: 0, stuck: 0 },
      generated_at:  new Date().toISOString(),
      cached:        false,
    }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const bizIds = businesses.map(b => b.id)

  // ── Parallel fetches across all businesses ──────────────────────────
  // We pull per-business aggregates in parallel rather than per-business
  // serial; cuts the cold-load from ~5s (with 4 customers) to ~600ms.

  const [
    backfillStates,
    pdfStatusCounts,
    matchStatusCounts,
    ingestionCounts,
    oldestPending,
    oldestHeaderOnly,
  ] = await Promise.all([
    // 1. Per-business inventory_backfill_state (latest row)
    db.from('inventory_backfill_state')
      .select('business_id, status, started_at, updated_at, finished_at, progress, error_message')
      .in('business_id', bizIds),

    // 2. fortnox_invoices counts by pdf_status — one query, group client-side
    db.from('fortnox_invoices')
      .select('business_id, pdf_status', { count: 'exact', head: false })
      .in('business_id', bizIds)
      .limit(50_000),

    // 3. supplier_invoice_lines counts by match_status — one query, group client-side
    db.from('supplier_invoice_lines')
      .select('business_id, match_status', { count: 'exact', head: false })
      .in('business_id', bizIds)
      .limit(200_000),

    // 4. supplier_invoice_lines counts by ingestion_status
    db.from('supplier_invoice_lines')
      .select('business_id, ingestion_status', { count: 'exact', head: false })
      .in('business_id', bizIds)
      .limit(200_000),

    // 5. Oldest pending PDF per business
    db.from('fortnox_invoices')
      .select('business_id, created_at')
      .in('business_id', bizIds)
      .eq('pdf_status', 'pending')
      .order('created_at', { ascending: true })
      .limit(500),

    // 6. Oldest header_only line per business
    db.from('supplier_invoice_lines')
      .select('business_id, created_at')
      .in('business_id', bizIds)
      .eq('ingestion_status', 'header_only')
      .order('created_at', { ascending: true })
      .limit(500),
  ])

  // ── Roll up the parallel results per-business ───────────────────────
  const stateByBiz = new Map<string, any>()
  for (const s of backfillStates.data ?? []) stateByBiz.set(s.business_id, s)

  function rollupCounts(rows: any[] | null | undefined, field: string) {
    const map = new Map<string, Record<string, number>>()
    for (const r of rows ?? []) {
      const bid = r.business_id
      const key = r[field] ?? 'unknown'
      const slot = map.get(bid) ?? {}
      slot[key] = (slot[key] ?? 0) + 1
      map.set(bid, slot)
    }
    return map
  }
  const pdfByBiz       = rollupCounts(pdfStatusCounts.data, 'pdf_status')
  const matchByBiz     = rollupCounts(matchStatusCounts.data, 'match_status')
  const ingestionByBiz = rollupCounts(ingestionCounts.data, 'ingestion_status')

  // Oldest pending: keep the FIRST timestamp per business (already sorted asc).
  const oldestPendingByBiz   = new Map<string, string>()
  for (const r of oldestPending.data ?? []) {
    if (!oldestPendingByBiz.has(r.business_id)) oldestPendingByBiz.set(r.business_id, r.created_at)
  }
  const oldestHeaderByBiz = new Map<string, string>()
  for (const r of oldestHeaderOnly.data ?? []) {
    if (!oldestHeaderByBiz.has(r.business_id)) oldestHeaderByBiz.set(r.business_id, r.created_at)
  }

  // ── Compose per-business rows + score health ────────────────────────
  const rows: BusinessRow[] = businesses.map(b => {
    const state    = stateByBiz.get(b.id)
    const pdfRaw   = pdfByBiz.get(b.id)       ?? {}
    const matchRaw = matchByBiz.get(b.id)     ?? {}
    const ingRaw   = ingestionByBiz.get(b.id) ?? {}
    const oldPdf   = oldestPendingByBiz.get(b.id) ?? null
    const oldHdr   = oldestHeaderByBiz.get(b.id) ?? null

    const stateUpdated = state?.updated_at ? new Date(state.updated_at).getTime() : 0
    const isStale = state?.status === 'running' && (now - stateUpdated) > STALE_RUNNING_MS

    const pdfQueue = {
      pending:   pdfRaw['pending']   ?? 0,
      extracted: pdfRaw['extracted'] ?? 0,
      no_pdf:    pdfRaw['no_pdf']    ?? 0,
      failed:    pdfRaw['failed']    ?? 0,
      total:     Object.values(pdfRaw).reduce((a, b) => a + (b as number), 0) as number,
    }
    const lineQueue = {
      matched:       matchRaw['matched']       ?? 0,
      needs_review:  matchRaw['needs_review']  ?? 0,
      not_inventory: matchRaw['not_inventory'] ?? 0,
      unprocessed:   matchRaw['unknown']       ?? 0,
      total:         Object.values(matchRaw).reduce((a, b) => a + (b as number), 0) as number,
    }
    const ingestion = {
      complete:    ingRaw['complete']    ?? 0,
      header_only: ingRaw['header_only'] ?? 0,
      partial:     ingRaw['partial']     ?? 0,
      failed:      ingRaw['failed']      ?? 0,
    }

    // ── Health scoring (severity order) ───────────────────────────────
    const reasons: string[] = []
    let score: BusinessRow['health_score'] = 'healthy'

    if (isStale) {
      reasons.push(`Backfill worker stale (running since ${state?.updated_at}, no update for >30 min)`)
      score = 'stuck'
    }
    if (oldPdf && (now - new Date(oldPdf).getTime()) > OLD_PENDING_MS) {
      reasons.push(`Oldest pending PDF is from ${oldPdf} (>48h ago)`)
      score = 'stuck'
    }
    if (oldHdr && (now - new Date(oldHdr).getTime()) > OLD_PENDING_MS) {
      reasons.push(`Oldest header_only line is from ${oldHdr} (>48h ago)`)
      score = 'stuck'
    }
    if (score !== 'stuck') {
      if (state?.status === 'failed') {
        reasons.push(`Backfill failed: ${state.error_message ?? '(no message)'}`)
        score = 'attention'
      }
      if (pdfQueue.pending > 0) {
        reasons.push(`${pdfQueue.pending} PDF extraction(s) pending`)
        score = 'attention'
      }
      if (ingestion.header_only > 0) {
        reasons.push(`${ingestion.header_only} header_only line(s) waiting for full extract`)
        score = 'attention'
      }
      if (lineQueue.needs_review > QUEUE_ATTENTION) {
        reasons.push(`${lineQueue.needs_review} line(s) in needs_review queue`)
        score = 'attention'
      }
    }

    return {
      business_id:   b.id,
      business_name: b.name,
      org_id:        b.org_id,
      org_name:      (b as any).organisations?.name ?? '(unknown)',
      backfill: {
        status:      state?.status      ?? null,
        started_at:  state?.started_at  ?? null,
        updated_at:  state?.updated_at  ?? null,
        finished_at: state?.finished_at ?? null,
        progress:    state?.progress    ?? null,
        is_stale:    isStale,
      },
      pdf_queue:                pdfQueue,
      line_queue:               lineQueue,
      ingestion,
      oldest_pending_pdf_at:    oldPdf,
      oldest_header_only_at:    oldHdr,
      health_score:             score,
      health_reasons:           reasons,
    }
  })

  // Sort worst-first so admin's eye lands on what's broken
  rows.sort((a, b) => {
    const order = { stuck: 0, attention: 1, healthy: 2 }
    return order[a.health_score] - order[b.health_score]
  })

  const summary = {
    total:     rows.length,
    healthy:   rows.filter(r => r.health_score === 'healthy').length,
    attention: rows.filter(r => r.health_score === 'attention').length,
    stuck:     rows.filter(r => r.health_score === 'stuck').length,
  }

  const payload = {
    businesses:   rows,
    summary,
    generated_at: new Date().toISOString(),
  }
  cached = { at: Date.now(), payload }

  return NextResponse.json(
    { ...payload, cached: false },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
