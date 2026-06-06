// lib/fortnox/api/file-connections.ts
//
// Phase 2 of INGESTION-PIPELINE-RELIABILITY-PLAN.md (2026-06-06).
//
// Single shared resolver: invoice GivenNumber → attached FileId (or null).
// Used by both:
//   - The daily supplier-sync cron (on each newly-upserted invoice)
//   - The dedicated PDF-backfill cron (on every existing header_only row)
//   - The /api/inventory/invoice-pdf resolver (on demand from EditItemModal)
//
// Why centralised: Fortnox's detail endpoint INCONSISTENTLY embeds
// SupplierInvoiceFileConnections — often empty even when a file exists.
// The authoritative source is /3/supplierinvoicefileconnections/. Before
// this lib, three different routes (invoice-pdf, pdf-extraction-worker,
// supplier-sync) all needed the same two-endpoint dance. Centralising
// prevents the bug class where one caller forgets the fallback.

import { fortnoxFetch } from './fetch'

export type ResolveResult =
  | { kind: 'has_pdf'; file_id: string; source: 'detail' | 'file_connections' }
  | { kind: 'no_pdf' }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string; status?: number }

/**
 * Look up the attached FileId for a Fortnox supplier invoice by
 * GivenNumber. Tries the detail endpoint first (one round trip when
 * we get lucky); falls back to the dedicated file-connections endpoint
 * which is authoritative.
 *
 * Returns a tagged union so the caller can distinguish "Fortnox really
 * has no PDF" from "Fortnox/network failed". Phase 1's ledger uses
 * this distinction — failed lookups are retryable; no_pdf is terminal.
 */
export async function resolveSupplierInvoiceFileId(
  accessToken: string,
  invoiceNumber: string,
): Promise<ResolveResult> {
  // Step 1 — detail endpoint. Sometimes carries SupplierInvoiceFileConnections.
  let detailRes: Response
  try {
    detailRes = await fortnoxFetch(
      `https://api.fortnox.se/3/supplierinvoices/${encodeURIComponent(invoiceNumber)}`,
      accessToken,
      { accept: 'application/json' },
    )
  } catch (e: any) {
    return { kind: 'error', reason: `detail_fetch_threw: ${e?.message ?? e}` }
  }
  if (detailRes.status === 404) {
    return { kind: 'not_found' }
  }
  if (!detailRes.ok) {
    return { kind: 'error', reason: `detail_http_${detailRes.status}`, status: detailRes.status }
  }
  let detailJson: any
  try {
    detailJson = await detailRes.json()
  } catch (e: any) {
    return { kind: 'error', reason: `detail_json_parse: ${e?.message ?? e}` }
  }
  const inlineFileId = detailJson?.SupplierInvoice?.SupplierInvoiceFileConnections?.[0]?.FileId
                    ?? detailJson?.SupplierInvoiceFileConnections?.[0]?.FileId
                    ?? null
  if (inlineFileId) {
    return { kind: 'has_pdf', file_id: String(inlineFileId), source: 'detail' }
  }

  // Step 2 — dedicated file-connections endpoint. Authoritative source.
  let fcRes: Response
  try {
    fcRes = await fortnoxFetch(
      `https://api.fortnox.se/3/supplierinvoicefileconnections/?supplierinvoicenumber=${encodeURIComponent(invoiceNumber)}`,
      accessToken,
      { accept: 'application/json' },
    )
  } catch (e: any) {
    return { kind: 'error', reason: `fc_fetch_threw: ${e?.message ?? e}` }
  }
  if (!fcRes.ok) {
    // 401 / 403 typically means the `connectfile` OAuth scope wasn't
    // granted; bubble as error so the customer can re-OAuth.
    return { kind: 'error', reason: `fc_http_${fcRes.status}`, status: fcRes.status }
  }
  let fcJson: any
  try {
    fcJson = await fcRes.json()
  } catch (e: any) {
    return { kind: 'error', reason: `fc_json_parse: ${e?.message ?? e}` }
  }
  const conns: any[] = fcJson?.SupplierInvoiceFileConnections ?? []
  if (Array.isArray(conns) && conns.length > 0 && conns[0]?.FileId) {
    return { kind: 'has_pdf', file_id: String(conns[0].FileId), source: 'file_connections' }
  }

  // Both endpoints agree there's nothing attached.
  return { kind: 'no_pdf' }
}
