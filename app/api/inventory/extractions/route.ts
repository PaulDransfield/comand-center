// app/api/inventory/extractions/route.ts
//
// GET — list extractions for a business, filterable by status.
// Returns headline counts + array of {id, status, supplier, invoice_number,
// invoice_date, rows_extracted, total_extracted, total_header, total_delta_pct,
// has_pdf, warning_codes[]}.
//
// Used by the /inventory/extractions list page (Phase B.4 review UI).

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { supplierInvoiceUrl, getFortnoxWorkspaceId } from '@/lib/fortnox/web-url'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const statusFilter = String(url.searchParams.get('status') ?? 'needs_review').trim()
  const limit = Math.min(200, Math.max(10, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50))

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Counts across all statuses for the page header
  const { data: allStatuses } = await db
    .from('invoice_pdf_extractions')
    .select('status')
    .eq('business_id', businessId)
    .range(0, 9999)
  const counts: Record<string, number> = {}
  for (const r of (allStatuses ?? [])) counts[(r as any).status] = (counts[(r as any).status] ?? 0) + 1

  // The actual list — filtered by status
  let q = db
    .from('invoice_pdf_extractions')
    .select('id, status, supplier_name_snapshot, supplier_fortnox_number, fortnox_invoice_number, invoice_date, rows_extracted, total_extracted, total_header, total_delta_pct, validation_warnings, pdf_file_id, completed_at, ai_model, cost_usd')
    .eq('business_id', businessId)
    .order('completed_at', { ascending: false, nullsFirst: false })
    .limit(limit)
  if (statusFilter !== 'all') q = q.eq('status', statusFilter)

  const { data, error } = await q
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const workspaceId = await getFortnoxWorkspaceId(db, businessId)

  const items = (data ?? []).map((r: any) => ({
    id:                r.id,
    status:            r.status,
    supplier:          r.supplier_name_snapshot ?? '—',
    supplier_number:   r.supplier_fortnox_number,
    invoice_number:    r.fortnox_invoice_number,
    invoice_date:      r.invoice_date,
    rows_extracted:    r.rows_extracted,
    total_extracted:   r.total_extracted,
    total_header:      r.total_header,
    total_delta_pct:   r.total_delta_pct,
    has_pdf:           !!r.pdf_file_id,
    pdf_file_id:       r.pdf_file_id,
    warning_codes:     (r.validation_warnings ?? []).map((w: any) => w.code),
    completed_at:      r.completed_at,
    cost_usd:          r.cost_usd,
    fortnox_url:       supplierInvoiceUrl(workspaceId, r.fortnox_invoice_number),
  }))

  return NextResponse.json({
    counts,
    total:           Object.values(counts).reduce((s, n) => s + n, 0),
    status_filter:   statusFilter,
    items,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
