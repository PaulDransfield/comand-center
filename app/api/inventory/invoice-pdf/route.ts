// app/api/inventory/invoice-pdf/route.ts
//
// GET ?business_id=X&invoice_number=Y
//
// Resolves a supplier_invoice_lines.fortnox_invoice_number to its attached
// Fortnox PDF FileId by calling /3/supplierinvoices/{number}, then redirects
// (307) to the existing PDF proxy at /api/integrations/fortnox/file which
// streams the bytes back to the browser.
//
// Why a separate hop: the supplier-articles section of EditItemModal carries
// `latest_invoice` (the Fortnox GivenNumber). We could fetch the FileId at
// edit-context build time, but that adds one Fortnox call per alias on every
// modal open — wasted work since most owners never click. Lazy-resolve here
// only when they click "View PDF".

import { NextRequest, NextResponse } from 'next/server'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'
import { fortnoxFetch }            from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId    = String(url.searchParams.get('business_id') ?? '').trim()
  const invoiceNumber = String(url.searchParams.get('invoice_number') ?? '').trim()
  if (!businessId || !invoiceNumber) {
    return NextResponse.json({ error: 'business_id and invoice_number required' }, { status: 400 })
  }
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Cache-first: look up the local fortnox_supplier_invoices row. The cron
  // syncs this table including file_id + has_pdf, so we usually know the
  // FileId (or its absence) without calling Fortnox.
  const { data: cached } = await db.from('fortnox_supplier_invoices')
    .select('file_id, has_pdf, supplier_name')
    .eq('business_id', businessId)
    .eq('given_number', invoiceNumber)
    .maybeSingle()

  let fileId: string | null = cached?.file_id ?? null
  let supplierName: string | null = cached?.supplier_name ?? null

  // Cache miss OR file_id never fetched — call Fortnox to resolve.
  if (cached == null || (cached.has_pdf !== false && !fileId)) {
    let accessToken: string | null
    try {
      accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
    } catch (err: any) {
      return noPdfResponse(invoiceNumber, supplierName,
        err?.message === 'FORTNOX_NEEDS_REAUTH'
          ? 'Your Fortnox connection was disconnected. Reconnect at /integrations and try again.'
          : (err?.message ?? 'Failed to obtain Fortnox token.'),
      )
    }
    if (!accessToken) {
      return noPdfResponse(invoiceNumber, supplierName, 'No connected Fortnox integration for this business.')
    }
    const fnRes = await fortnoxFetch(
      `https://api.fortnox.se/3/supplierinvoices/${encodeURIComponent(invoiceNumber)}`,
      accessToken,
      { accept: 'application/json' },
    )
    if (fnRes.status === 404) {
      return noPdfResponse(invoiceNumber, supplierName, `Invoice ${invoiceNumber} not found in Fortnox.`)
    }
    if (!fnRes.ok) {
      const body = await fnRes.text().catch(() => '')
      return noPdfResponse(invoiceNumber, supplierName,
        `Fortnox returned error ${fnRes.status}. ${body.slice(0, 200)}`)
    }
    const j = await fnRes.json().catch(() => ({}))
    fileId = j?.SupplierInvoice?.SupplierInvoiceFileConnections?.[0]?.FileId
          ?? j?.SupplierInvoiceFileConnections?.[0]?.FileId
          ?? null
  }

  if (!fileId) {
    return noPdfResponse(invoiceNumber, supplierName,
      'This invoice has no PDF attached on Fortnox. Many suppliers (Spendrups, Carlsberg etc.) only book the invoice metadata without uploading the PDF — your supplier portal is the fastest place to verify the price.')
  }

  const target = new URL('/api/integrations/fortnox/file', req.nextUrl.origin)
  target.searchParams.set('business_id', businessId)
  target.searchParams.set('file_id',     String(fileId))
  target.searchParams.set('filename',    `${invoiceNumber}.pdf`)
  return NextResponse.redirect(target, 307)
}

// Friendly HTML response when there's no PDF — the link is opened in a
// new tab so we don't want to dump JSON in the user's face.
function noPdfResponse(invoiceNumber: string, supplierName: string | null, message: string): NextResponse {
  const supplier = supplierName ? supplierName : 'supplier'
  const html = `<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"><title>No PDF · Invoice ${invoiceNumber}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #f8f9fa; color: #1a1a1a; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 480px; background: #fff; border: 0.5px solid #e5e5e5; border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
    h1 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
    .label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 4px; }
    .number { font-size: 14px; font-weight: 500; margin-bottom: 16px; font-variant-numeric: tabular-nums; }
    p { font-size: 13px; line-height: 1.5; color: #444; margin: 0 0 16px; }
    .close { background: #6e5cf7; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 500; cursor: pointer; font-family: inherit; }
  </style></head><body>
  <div class="card">
    <h1>PDF not available</h1>
    <div class="label">Invoice from ${escapeHtml(supplier)}</div>
    <div class="number">${escapeHtml(invoiceNumber)}</div>
    <p>${escapeHtml(message)}</p>
    <button class="close" onclick="window.close()">Close this tab</button>
  </div>
  </body></html>`
  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
