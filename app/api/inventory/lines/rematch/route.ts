// app/api/inventory/lines/rematch/route.ts
//
// "Re-match" endpoint. Walks already-persisted supplier_invoice_lines
// rows for a business and re-runs the matcher on them — without
// re-fetching from Fortnox. Useful after:
//
//   - lib/inventory/categories.ts allowlist changes (e.g. broadening
//     the inventory BAS range; lines that were 'not_inventory' under
//     the old rules can be re-evaluated)
//   - matcher logic tweaks
//   - manually flipping lines back to 'needs_review' via SQL
//   - the P2.0 voucher back-fill activating Gate-0 BAS routing on
//     thousands of previously-NULL account_number rows
//
// Default: process ALL non-matched lines (status IN ('not_inventory',
// 'needs_review')). Pass `only_not_inventory=1` to limit to the
// not_inventory rows specifically (e.g. after broadening the
// allowlist).
//
// ── Self-chaining worker ─────────────────────────────────────────────
//
// Each Vercel function run is capped at 800s. A cold rematch over a
// business with thousands of unmatched lines (Vero P2.0: ~5,500
// candidates @ trigram-fuzzy lookups per line) cannot complete in one
// run. Without the self-chain the worker dies mid-page, the row stays
// at 'running' indefinitely, and progress is lost.
//
// Mirrors lib/inventory/backfill-worker.ts:
//   - Deadline = function maxDuration - 90s safety margin
//   - Before each page/row, check (Date.now() > deadline)
//   - On deadline: persist cursor + counts, flip to 'pending', kick
//     a fresh function via CRON_SECRET-authenticated POST with
//     resume:true
//   - Resume reloads cursor + counts so the loop continues monotonically
//   - MAX_RESUMES guard prevents runaway re-launches
//
// Cursor uses (id > last_seen_id) ordering for stability across hops
// — offset-based pagination would skip rows when lines drop out of the
// result set as they get matched.

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 800

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { waitUntil } from '@vercel/functions'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { matchInvoiceLine, type InvoiceLineForMatching, type MatchOutcome } from '@/lib/inventory/matcher'

const MAX_RESUMES = 30
const ZERO_UUID   = '00000000-0000-0000-0000-000000000000'
const PAGE_SIZE   = 500

export async function POST(req: NextRequest) {
  noStore()

  // Two auth paths — mirrors backfill/route.ts:
  //   - User session (owner clicking 'Re-match' from /admin/v2/tools)
  //   - CRON_SECRET / ADMIN_SECRET (server-to-server from the self-
  //     chain re-launch). The cron path needs an explicit business_id
  //     since there's no session to derive org from.
  const headerAuth = req.headers.get('authorization') ?? ''
  const cronSecret  = process.env.CRON_SECRET
  const adminSecret = process.env.ADMIN_SECRET
  const isCronCall =
    (cronSecret  && headerAuth === `Bearer ${cronSecret}`) ||
    (adminSecret && headerAuth === `Bearer ${adminSecret}`)

  let userOrgId: string | null = null
  let userIdentity = 'cron'
  if (!isCronCall) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    userOrgId   = auth.orgId
    userIdentity = auth.userId
  }

  const body = await req.json().catch(() => ({} as any))
  const businessId = String(body.business_id ?? '').trim()
  const onlyNotInv = !!body.only_not_inventory
  const isResume   = body?.resume === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })

  // User-session calls go through the existing business-access gate.
  // Cron self-chain trusts the secret + the explicit business_id.
  if (!isCronCall) {
    const auth = await getRequestAuth(req)
    if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
    const forbidden = requireBusinessAccess(auth, businessId)
    if (forbidden) return forbidden
  }

  const db = createAdminClient()

  // Cron path needs org_id from the businesses table directly.
  let orgId = userOrgId
  if (!orgId) {
    const { data: biz } = await db
      .from('businesses')
      .select('org_id')
      .eq('id', businessId)
      .maybeSingle()
    if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })
    orgId = biz.org_id
  }
  if (!orgId) return NextResponse.json({ error: 'business has no org_id' }, { status: 500 })

  // Skip state reset on resume — worker reloads cursor + counts from the
  // existing row, and started_at must NOT be touched (ETA spans all hops).
  if (!isResume) {
    const { error: upsertErr } = await db
      .from('inventory_backfill_state')
      .upsert({
        org_id:        orgId,
        business_id:   businessId,
        status:        'pending',
        progress:      {
          phase:         'enqueued',
          operation:     onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all',
          triggered_at:  new Date().toISOString(),
          triggered_by:  userIdentity,
        },
        started_at:    new Date().toISOString(),
        finished_at:   null,
        error_message: null,
      }, { onConflict: 'business_id' })
    if (upsertErr) {
      return NextResponse.json({ error: 'state_init_failed', message: upsertErr.message }, { status: 500 })
    }
  }

  // Deadline = function cap minus 90s safety margin for checkpoint + re-kick HTTP.
  const deadlineMs = Date.now() + (maxDuration - 90) * 1000

  // Fire worker. waitUntil keeps the function alive after the HTTP
  // response so the worker finishes regardless of poll cadence. The
  // catch is belt-and-braces for crashes before the worker's own
  // try/catch fires.
  waitUntil(
    runRematch(db, { businessId, orgId, onlyNotInv, deadlineMs, resume: isResume }).catch(err =>
      db.from('inventory_backfill_state').update({
        status:        'failed',
        error_message: `rematch crashed: ${err?.message ?? err}`,
        finished_at:   new Date().toISOString(),
      }).eq('business_id', businessId).then(() => {})
    )
  )

  return NextResponse.json({
    ok:                 true,
    status:             'started',
    business_id:        businessId,
    only_not_inventory: onlyNotInv,
    resume:             isResume,
    message:            'Rematch running in the background. Poll /api/inventory/lines/backfill/status for progress.',
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}

// ─────────────────────────────────────────────────────────────────────

interface RematchInput {
  businessId: string
  orgId:      string
  onlyNotInv: boolean
  deadlineMs: number
  resume:     boolean
}

interface RematchProgress {
  phase:                'matching' | 'done'
  operation:            'rematch_not_inventory_only' | 'rematch_all'
  cursor:               string  // last id processed; lines with id > cursor still pending
  lines_matched:        number
  lines_needs_review:   number
  lines_not_inventory:  number
  rematched_total:      number
  errors:               Array<{ invoice: string; error: string }>
  error_count:          number
  resume_count:         number
}

async function runRematch(db: any, input: RematchInput): Promise<void> {
  // Resume: reload prior progress (cursor + counts) so the loop continues
  // monotonically rather than restarting. Fresh start: a clean zeroed shape.
  let p: RematchProgress
  if (input.resume) {
    const { data: existing } = await db
      .from('inventory_backfill_state')
      .select('progress')
      .eq('business_id', input.businessId)
      .maybeSingle()
    const prev = (existing?.progress ?? {}) as any
    p = {
      phase:                  'matching',
      operation:              (prev.operation as RematchProgress['operation']) ?? (input.onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all'),
      cursor:                 String(prev.cursor ?? ZERO_UUID),
      lines_matched:          Number(prev.lines_matched ?? 0),
      lines_needs_review:     Number(prev.lines_needs_review ?? 0),
      lines_not_inventory:    Number(prev.lines_not_inventory ?? 0),
      rematched_total:        Number(prev.rematched_total ?? 0),
      errors:                 Array.isArray(prev.errors) ? prev.errors : [],
      error_count:            Number(prev.error_count ?? 0),
      resume_count:           Number(prev.resume_count ?? 0) + 1,
    }
  } else {
    p = {
      phase:                  'matching',
      operation:              input.onlyNotInv ? 'rematch_not_inventory_only' : 'rematch_all',
      cursor:                 ZERO_UUID,
      lines_matched:          0,
      lines_needs_review:     0,
      lines_not_inventory:    0,
      rematched_total:        0,
      errors:                 [],
      error_count:            0,
      resume_count:           0,
    }
  }
  await flush(db, input.businessId, 'running', p)

  const targetStatuses = input.onlyNotInv ? ['not_inventory'] : ['not_inventory', 'needs_review']

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // Deadline check BEFORE next page fetch — clean boundary, persists the
    // cursor at the last completed row. Re-launch worker picks up from here.
    if (Date.now() > input.deadlineMs) {
      await checkpointAndRelaunch(db, input, p)
      return
    }

    // Cursor pagination: id > p.cursor ordered by id. Stable across hops
    // because matched rows drop out of the predicate (alias_id != null)
    // and we never re-scan an id we've already advanced past.
    const { data: rows, error } = await db
      .from('supplier_invoice_lines')
      .select('id, org_id, business_id, supplier_fortnox_number, supplier_name_snapshot, article_number, raw_description, unit, account_number, source')
      .eq('business_id', input.businessId)
      .in('match_status', targetStatuses)
      .is('product_alias_id', null)
      .gt('id', p.cursor)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE)
    if (error) {
      p.errors.push({ invoice: '(load)', error: error.message })
      p.error_count += 1
      break
    }
    if (!rows || rows.length === 0) break

    for (const row of rows) {
      // Deadline check INSIDE the page too — a 500-row page of trigram
      // queries can drift past the wall if the catalogue is large.
      if (Date.now() > input.deadlineMs) {
        await checkpointAndRelaunch(db, input, p)
        return
      }

      const lineInput: InvoiceLineForMatching = {
        id:                       row.id,
        business_id:              row.business_id,
        org_id:                   row.org_id,
        supplier_fortnox_number:  row.supplier_fortnox_number,
        supplier_name_snapshot:   row.supplier_name_snapshot,
        article_number:           row.article_number,
        raw_description:          row.raw_description,
        unit:                     row.unit,
        account_number:           row.account_number,
        source:                   row.source ?? 'fortnox_row',
      }
      let outcome: MatchOutcome
      try {
        outcome = await matchInvoiceLine(db, lineInput)
      } catch (e: any) {
        p.errors.push({ invoice: row.id, error: `matcher: ${e?.message ?? e}` })
        p.error_count += 1
        // Advance cursor anyway — never retry the same broken row forever.
        p.cursor = row.id
        continue
      }

      const update: any = {
        match_status:     outcome.status,
        product_alias_id: outcome.alias_id,
        match_candidates: outcome.candidates.length ? outcome.candidates : null,
      }
      if (outcome.status === 'matched' || outcome.status === 'not_inventory') {
        update.matched_at = new Date().toISOString()
      }
      await db.from('supplier_invoice_lines').update(update).eq('id', row.id)

      if (outcome.status === 'matched')           p.lines_matched      += 1
      else if (outcome.status === 'needs_review') p.lines_needs_review += 1
      else if (outcome.status === 'not_inventory') p.lines_not_inventory += 1

      p.cursor = row.id
      p.rematched_total += 1
    }

    if (p.errors.length > 20) p.errors = p.errors.slice(-20)
    await flush(db, input.businessId, 'running', p)

    // Short page = end of result set.
    if (rows.length < PAGE_SIZE) break
  }

  p.phase = 'done'
  await db.from('inventory_backfill_state').update({
    status:        'completed',
    progress:      p,
    finished_at:   new Date().toISOString(),
    error_message: null,
  }).eq('business_id', input.businessId)
}

async function flush(db: any, businessId: string, status: 'running' | 'pending', p: RematchProgress) {
  await db.from('inventory_backfill_state')
    .update({ status, progress: p })
    .eq('business_id', businessId)
}

// Persist cursor + counts, flip row back to 'pending', launch a fresh
// worker hop. Status stays non-terminal so the UI banner keeps showing
// the job as in-progress across the hop.
async function checkpointAndRelaunch(db: any, input: RematchInput, p: RematchProgress) {
  if (p.resume_count >= MAX_RESUMES) {
    await db.from('inventory_backfill_state').update({
      status:        'failed',
      progress:      p,
      finished_at:   new Date().toISOString(),
      error_message: `Stopped after ${MAX_RESUMES} resume hops at cursor=${p.cursor}. Re-kick to continue.`,
    }).eq('business_id', input.businessId)
    return
  }
  await db.from('inventory_backfill_state')
    .update({ status: 'pending', progress: p })
    .eq('business_id', input.businessId)
  await triggerNextRematch(input)
}

// Re-launch on a fresh Vercel function (new ~13min budget) by hitting
// the kick endpoint with resume:true — which skips the state reset so
// the worker reloads the persisted cursor. Awaited so the POST actually
// leaves before this function ends.
async function triggerNextRematch(input: RematchInput): Promise<void> {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  if (!base || !process.env.CRON_SECRET) return
  await fetch(`${base}/api/inventory/lines/rematch`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({
      business_id:        input.businessId,
      only_not_inventory: input.onlyNotInv,
      resume:             true,
      trigger:            'self_chain',
    }),
  }).catch(() => {})
}
