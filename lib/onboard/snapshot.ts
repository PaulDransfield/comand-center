// lib/onboard/snapshot.ts
//
// Shared read-model for the concierge onboarding board. Aggregates the
// state of every onboarding stage for ONE business from the authoritative
// tables (not the shared inventory_backfill_state row, which the line
// backfill and PDF extractor take turns owning). Both /api/admin/onboard/
// status (display) and /api/admin/onboard/drive (orchestration) build on
// this so they can't drift.
//
// Stage order (also the drive priority): connect → financials → invoices
// → pdf → catalogue. recipes + dashboard are shown but not auto-driven in
// Phase 1 (recipe AI-drafting is Phase 3).

export type StageState =
  | 'blocked'   // upstream dependency missing (e.g. Fortnox needs re-auth)
  | 'todo'      // not started, nothing running
  | 'running'   // a worker is actively making progress
  | 'stalled'   // marked in-progress but no recent activity — safe to re-kick
  | 'failed'    // terminal failure; re-kickable
  | 'done'      // complete
  | 'waiting'   // can't start until an earlier stage finishes

export interface OnboardStage {
  key:        string
  label:      string
  state:      StageState
  detail:     string
  percent:    number | null
  blocker:    string | null
  /** Whether the drive orchestrator may kick this stage. */
  drivable:   boolean
}

export interface OnboardSnapshot {
  business: { id: string; name: string; org_id: string }
  stages:   OnboardStage[]
  allDone:  boolean
  raw:      Record<string, any>   // signals the drive endpoint needs
}

const FRESH_MS = 5 * 60 * 1000        // inventory/pdf activity considered "live"
const FIN_STALL_MS = 15 * 60 * 1000   // financials backfill is fast; 15min ⇒ dead

async function cnt(db: any, table: string, build: (q: any) => any): Promise<number> {
  const { count } = await build(db.from(table).select('*', { count: 'exact', head: true }))
  return count ?? 0
}

function ageMs(iso: string | null | undefined): number {
  if (!iso) return Infinity
  const t = new Date(iso).getTime()
  return Number.isFinite(t) ? Date.now() - t : Infinity
}

export async function buildOnboardSnapshot(db: any, businessId: string): Promise<OnboardSnapshot | null> {
  const { data: biz } = await db
    .from('businesses')
    .select('id, name, org_id')
    .eq('id', businessId)
    .maybeSingle()
  if (!biz) return null

  const bid = businessId

  const [
    integrations,
    invState,
    pdfLatest,
    trackerMonths,
    silTotal, silMatched, silNeedsReview, silNotInventory,
    pdfTotal, pdfPending, pdfExtracting, pdfExtracted, pdfFailed,
    productCount, recipeCount, menuCount, dailyMetricCount,
  ] = await Promise.all([
    db.from('integrations')
      .select('provider, status, backfill_status, backfill_progress, backfill_started_at, backfill_finished_at, backfill_error')
      .eq('business_id', bid),
    db.from('inventory_backfill_state')
      .select('status, progress, started_at, finished_at, updated_at, error_message')
      .eq('business_id', bid).maybeSingle(),
    db.from('invoice_pdf_extractions')
      .select('started_at, updated_at')
      .eq('business_id', bid)
      .order('started_at', { ascending: false })
      .limit(1).maybeSingle(),
    cnt(db, 'tracker_data', q => q.eq('business_id', bid)),
    cnt(db, 'supplier_invoice_lines', q => q.eq('business_id', bid)),
    cnt(db, 'supplier_invoice_lines', q => q.eq('business_id', bid).eq('match_status', 'matched')),
    cnt(db, 'supplier_invoice_lines', q => q.eq('business_id', bid).eq('match_status', 'needs_review')),
    cnt(db, 'supplier_invoice_lines', q => q.eq('business_id', bid).eq('match_status', 'not_inventory')),
    cnt(db, 'invoice_pdf_extractions', q => q.eq('business_id', bid)),
    cnt(db, 'invoice_pdf_extractions', q => q.eq('business_id', bid).eq('status', 'pending')),
    cnt(db, 'invoice_pdf_extractions', q => q.eq('business_id', bid).eq('status', 'extracting')),
    cnt(db, 'invoice_pdf_extractions', q => q.eq('business_id', bid).eq('status', 'extracted')),
    cnt(db, 'invoice_pdf_extractions', q => q.eq('business_id', bid).eq('status', 'failed')),
    cnt(db, 'products', q => q.eq('business_id', bid)),
    cnt(db, 'recipes', q => q.eq('business_id', bid)),
    cnt(db, 'pos_menu_items', q => q.eq('business_id', bid)),
    cnt(db, 'daily_metrics', q => q.eq('business_id', bid)),
  ])

  const integs = (integrations.data ?? []) as any[]
  const fortnox = integs.find(i => i.provider === 'fortnox') ?? null
  const pk      = integs.find(i => i.provider === 'personalkollen') ?? null

  const stages: OnboardStage[] = []

  // ── 1. Connect ──────────────────────────────────────────────────────
  // Fortnox is the gate for everything inventory/financial. needs_reauth /
  // disconnected / missing ⇒ blocked. 'error'/'warning' may still have
  // valid tokens (see run-backfill notes) so we let those proceed.
  const fxStatus = fortnox?.status ?? null
  const fxBlocked = !fortnox || ['needs_reauth', 'disconnected', 'not_connected'].includes(fxStatus)
  stages.push({
    key: 'connect', label: 'Connections',
    state: fxBlocked ? 'blocked' : 'done',
    detail: !fortnox ? 'Fortnox not connected'
      : fxBlocked ? `Fortnox ${fxStatus} — reconnect needed`
      : `Fortnox ${fxStatus}${pk ? ` · Personalkollen ${pk.status}` : ' · no Personalkollen'}`,
    percent: null,
    blocker: fxBlocked ? `fortnox_${fxStatus ?? 'missing'}` : null,
    drivable: false,
  })

  // ── 2. Financials ───────────────────────────────────────────────────
  const finStatus = fortnox?.backfill_status ?? null
  const finProg   = fortnox?.backfill_progress ?? {}
  const finInFlight = ['running', 'paused', 'pending'].includes(finStatus) && !fortnox?.backfill_finished_at
  const finStale  = finInFlight && ageMs(fortnox?.backfill_started_at) > FIN_STALL_MS
  const finDone   = finStatus === 'completed' || (trackerMonths > 0 && !finInFlight && finStatus !== 'failed')
  const finPct    = finStatus === 'completed' ? 100
    : (finProg.total_vouchers ? Math.min(99, Math.round((Number(finProg.cursor ?? 0) / Number(finProg.total_vouchers)) * 100)) : null)
  stages.push({
    key: 'financials', label: 'Financial history',
    state: fxBlocked ? 'waiting'
      : finDone ? 'done'
      : finStatus === 'failed' ? 'failed'
      : finStale ? 'stalled'
      : finInFlight ? 'running'
      : 'todo',
    detail: finDone ? `${trackerMonths} months of P&L`
      : finInFlight ? `${finProg.months_written_total ?? 0} months${finProg.total_vouchers ? ` · ${finProg.cursor ?? 0}/${finProg.total_vouchers} vouchers` : ''}`
      : finStatus === 'failed' ? (fortnox?.backfill_error ?? 'failed').slice(0, 120)
      : 'not started',
    percent: finPct,
    blocker: null,
    drivable: !fxBlocked,
  })

  // ── 3. Invoices (line backfill) ─────────────────────────────────────
  const invProg = invState.data?.progress ?? {}
  const invStatus = invState.data?.status ?? null
  const invIsPdf = invProg.operation === 'pdf_extraction' || String(invProg.phase ?? '').startsWith('pdf_extraction')
  const invIsLine = !invIsPdf
  const invFresh = ageMs(invState.data?.updated_at) < FRESH_MS
  const invFound = Number(invProg.invoices_found ?? 0)
  const invProcessed = Number(invProg.invoices_processed ?? 0)
  // Done when: the row has moved on to PDF (past line backfill), OR a
  // line-shape row reports completed, OR (legacy) lines exist with no
  // active line backfill.
  const invDone =
    invIsPdf ||
    (invIsLine && invStatus === 'completed') ||
    (silTotal > 0 && !(invIsLine && ['running', 'pending'].includes(invStatus)))
  const invInFlight = invIsLine && ['running', 'pending'].includes(invStatus)
  stages.push({
    key: 'invoices', label: 'Invoice import',
    state: fxBlocked ? 'waiting'
      : !finDone && !invInFlight && silTotal === 0 ? 'waiting'
      : invDone ? 'done'
      : invStatus === 'failed' && invIsLine ? 'failed'
      : invInFlight && !invFresh ? 'stalled'
      : invInFlight ? 'running'
      : 'todo',
    detail: invDone ? `${silTotal.toLocaleString()} invoice lines imported`
      : invInFlight ? `${invProcessed}${invFound ? `/${invFound}` : ''} invoices · ${silTotal.toLocaleString()} lines`
      : silTotal > 0 ? `${silTotal.toLocaleString()} lines` : 'not started',
    percent: invInFlight && invFound > 0 ? Math.min(99, Math.round((invProcessed / invFound) * 100)) : (invDone ? 100 : null),
    blocker: null,
    drivable: !fxBlocked,
  })

  // ── 4. PDF extraction (the scanner) ─────────────────────────────────
  // Authoritative source: invoice_pdf_extractions. Independent of the
  // shared inventory_backfill_state row.
  const pdfRemaining = pdfPending + pdfExtracting
  const pdfActivityAge = ageMs(pdfLatest.data?.updated_at ?? pdfLatest.data?.started_at)
  const pdfDone = pdfRemaining === 0   // also true when there are no PDF-only invoices
  stages.push({
    key: 'pdf', label: 'Invoice scanner',
    state: fxBlocked ? 'waiting'
      : !invDone ? 'waiting'
      : pdfDone ? 'done'
      : pdfActivityAge < 4 * 60 * 1000 ? 'running'
      : 'stalled',
    detail: pdfDone
      ? (pdfTotal === 0 ? 'no PDF-only invoices' : `${pdfExtracted} scanned${pdfFailed ? ` · ${pdfFailed} failed` : ''}`)
      : `${pdfExtracted}/${pdfTotal} scanned · ${pdfRemaining} left`,
    percent: pdfTotal > 0 ? Math.round((pdfExtracted / pdfTotal) * 100) : (pdfDone ? 100 : null),
    blocker: null,
    drivable: !fxBlocked,
  })

  // ── 5. Catalogue (matcher) ──────────────────────────────────────────
  const silUnprocessed = Math.max(0, silTotal - silMatched - silNeedsReview - silNotInventory)
  const catDone = silTotal > 0 && silUnprocessed === 0
  stages.push({
    key: 'catalogue', label: 'Product matching',
    state: fxBlocked ? 'waiting'
      : silTotal === 0 ? 'waiting'
      : catDone ? 'done'
      : silUnprocessed > 0 ? 'todo'
      : 'done',
    detail: silTotal === 0 ? 'waiting for invoices'
      : `${productCount} products · ${silMatched} matched · ${silNeedsReview} to review${silUnprocessed ? ` · ${silUnprocessed} unprocessed` : ''}`,
    percent: silTotal > 0 ? Math.round(((silTotal - silUnprocessed) / silTotal) * 100) : null,
    blocker: null,
    // Matching runs inline during the backfill + after each PDF batch
    // (chain_rematch). An explicit matcher kick is redundant and would
    // clobber the shared state row, so it's display-only in Phase 1.
    // Phase 2's catalogue auto-build (bulk ai-suggest) becomes the driven
    // action here.
    drivable: false,
  })

  // ── 6. Recipes (informational in Phase 1) ───────────────────────────
  stages.push({
    key: 'recipes', label: 'Recipes',
    state: menuCount > 0 && recipeCount >= menuCount ? 'done' : recipeCount > 0 ? 'running' : 'todo',
    detail: menuCount > 0 ? `${recipeCount}/${menuCount} menu items have a recipe` : `${recipeCount} recipes`,
    percent: menuCount > 0 ? Math.min(100, Math.round((recipeCount / menuCount) * 100)) : null,
    blocker: null,
    drivable: false,   // Phase 3 (AI drafting) — not auto-driven yet
  })

  // ── 7. Dashboard ────────────────────────────────────────────────────
  stages.push({
    key: 'dashboard', label: 'Dashboard live',
    state: dailyMetricCount > 0 ? 'done' : finDone ? 'todo' : 'waiting',
    detail: dailyMetricCount > 0 ? `${dailyMetricCount} days of metrics` : 'no metrics yet',
    percent: null,
    blocker: null,
    drivable: false,
  })

  const allDone = stages.filter(s => s.drivable).every(s => s.state === 'done')

  return {
    business: { id: biz.id, name: biz.name, org_id: biz.org_id },
    stages,
    allDone,
    raw: {
      fortnox, finStatus, finInFlight, finStale, finDone,
      invIsLine, invStatus, invDone, invInFlight, invFresh, invStateExists: !!invState.data,
      pdfDone, pdfRemaining,
      catDone, silUnprocessed, silTotal,
    },
  }
}
