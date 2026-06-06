// lib/ingestion/ledger.ts
//
// Phase 1 of INGESTION-PIPELINE-RELIABILITY-PLAN.md — ledger helper.
//
// Wrap every external API call we make with `openLedger` / `closeLedger`
// to produce an audit row in `ingestion_log`. Sources annotate the
// expected field set; populated fields are computed at close time
// from the actual returned data. Status (`complete` / `partial` /
// `failed`) is derived from coverage.
//
// Defensive contract: ledger writes that fail must NOT break the
// caller. We log + continue. The ingestion is more important than
// its audit trail; the audit trail is the safety net, not the
// critical path.

export type LedgerStatus = 'started' | 'complete' | 'partial' | 'failed'
export type RowStatus    = 'complete' | 'partial' | 'header_only' | 'failed'

export interface OpenLedgerArgs {
  db:              any
  source:          string                                // 'fortnox'
  resource:        string                                // 'supplier_invoices'
  operation:       string                                // 'list' | 'detail' | 'file_connections' | 'upsert'
  business_id?:    string | null
  org_id?:         string | null
  expected_fields: string[]                              // e.g. ['file_id', 'invoice_date', 'total']
  context?:        Record<string, any>                   // cursor / page / HTTP status / retry count
}

export interface LedgerHandle {
  id:              number | null                         // null if the open() write failed
  source:          string
  resource:        string
  expected_fields: string[]
}

/**
 * Open a ledger row at the start of an API operation.
 * Returns a handle to use with closeLedger(). Never throws — if the
 * ledger write fails, returns a handle with id=null and the caller
 * proceeds with the actual ingestion uninterrupted.
 */
export async function openLedger(args: OpenLedgerArgs): Promise<LedgerHandle> {
  const row = {
    source:          args.source,
    resource:        args.resource,
    business_id:     args.business_id ?? null,
    org_id:          args.org_id ?? null,
    operation:       args.operation,
    expected_fields: args.expected_fields,
    populated_fields: [] as string[],
    status:          'started' as LedgerStatus,
    context:         args.context ?? {},
  }
  try {
    const { data, error } = await args.db.from('ingestion_log').insert(row).select('id').single()
    if (error) {
      console.warn('[ingestion-ledger] open failed:', error.message)
      return { id: null, source: args.source, resource: args.resource, expected_fields: args.expected_fields }
    }
    return { id: data.id, source: args.source, resource: args.resource, expected_fields: args.expected_fields }
  } catch (e: any) {
    console.warn('[ingestion-ledger] open threw:', e?.message ?? e)
    return { id: null, source: args.source, resource: args.resource, expected_fields: args.expected_fields }
  }
}

export interface CloseLedgerArgs {
  db:               any
  handle:           LedgerHandle
  populated_fields: string[]                              // subset of expected_fields that came back populated
  rows_processed?:  number
  error?:           string | null
  context_patch?:   Record<string, any>                   // merged into existing context
}

/**
 * Close a ledger row with results. Status is derived:
 *   - error present                          → 'failed'
 *   - populated covers every expected field  → 'complete'
 *   - some populated, some missing           → 'partial'
 *   - nothing populated                      → 'failed' (treat as failure to ingest)
 */
export async function closeLedger(args: CloseLedgerArgs): Promise<void> {
  if (args.handle.id == null) return            // open() failed; nothing to close
  const expected  = new Set(args.handle.expected_fields)
  const populated = new Set(args.populated_fields.filter(f => expected.has(f)))
  let status: LedgerStatus
  if (args.error)                                    status = 'failed'
  else if (populated.size === 0 && expected.size > 0) status = 'failed'
  else if (populated.size < expected.size)            status = 'partial'
  else                                                status = 'complete'
  try {
    await args.db.from('ingestion_log').update({
      finished_at:      new Date().toISOString(),
      populated_fields: Array.from(populated),
      rows_processed:   args.rows_processed ?? 0,
      status,
      error:            args.error ?? null,
      ...(args.context_patch ? { context: args.context_patch } : {}),
    }).eq('id', args.handle.id)
  } catch (e: any) {
    console.warn('[ingestion-ledger] close failed:', e?.message ?? e)
  }
}

/**
 * Compute a row-level ingestion_status from the expected vs populated
 * field sets for ONE row. Use at upsert time to annotate the row
 * itself (separate from the ledger which audits the whole operation).
 *
 *   - all expected fields populated                                    → 'complete'
 *   - some populated, but missing critical fields                      → 'partial'
 *   - only header-level fields populated (no detail / file data)       → 'header_only'
 *   - nothing usable                                                   → 'failed'
 *
 * `headerFields` lets the caller mark which fields count as "header
 * only" — when ALL populated fields fall into the header set and the
 * expected set has more, the row is 'header_only' rather than 'partial'.
 * That's the file_id case: list endpoint returns invoice_date + total +
 * supplier but never file_id, so the row is honestly header_only — not
 * a partial fetch that needs retry the same way.
 */
export function computeRowStatus(
  expectedFields:  string[],
  populatedFields: string[],
  headerFields?:   string[],
): RowStatus {
  const expected  = new Set(expectedFields)
  const populated = new Set(populatedFields.filter(f => expected.has(f)))
  if (populated.size === 0) return 'failed'
  if (populated.size === expected.size) return 'complete'
  const headerSet = new Set(headerFields ?? [])
  if (headerSet.size > 0) {
    const allPopulatedAreHeader = Array.from(populated).every(f => headerSet.has(f))
    const someExpectedAreNonHeader = Array.from(expected).some(f => !headerSet.has(f))
    if (allPopulatedAreHeader && someExpectedAreNonHeader) return 'header_only'
  }
  return 'partial'
}

/**
 * Build the `ingestion_meta` jsonb for a row at upsert time. Keeps the
 * payload shape consistent across sources.
 */
export function buildIngestionMeta(args: {
  ledgerId:          number | null
  source_path:       string
  expected_fields:   string[]
  populated_fields:  string[]
  missing_fields?:   string[]
  extra?:            Record<string, any>
}): Record<string, any> {
  return {
    ledger_id:        args.ledgerId,
    source_path:      args.source_path,
    expected_fields:  args.expected_fields,
    populated_fields: args.populated_fields,
    missing_fields:   args.missing_fields ?? args.expected_fields.filter(f => !args.populated_fields.includes(f)),
    annotated_at:     new Date().toISOString(),
    ...(args.extra ?? {}),
  }
}
