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

  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
  } catch (err: any) {
    return NextResponse.json({
      error:   'fortnox_token_refresh_failed',
      message: err?.message === 'FORTNOX_NEEDS_REAUTH'
        ? 'Your Fortnox connection was disconnected. Reconnect at /integrations.'
        : (err?.message ?? 'Failed to obtain Fortnox token.'),
    }, { status: 401 })
  }
  if (!accessToken) {
    return NextResponse.json({ error: 'No connected Fortnox integration for this business' }, { status: 404 })
  }

  // Fetch the supplier invoice by GivenNumber. Fortnox 3 API path:
  //   /3/supplierinvoices/{GivenNumber}
  // Response carries SupplierInvoiceFileConnections — usually one entry
  // pointing at the inbox FileId for the attached PDF.
  const fnRes = await fortnoxFetch(
    `https://api.fortnox.se/3/supplierinvoices/${encodeURIComponent(invoiceNumber)}`,
    accessToken,
    { accept: 'application/json' },
  )
  if (fnRes.status === 404) {
    return NextResponse.json({ error: `Invoice ${invoiceNumber} not found in Fortnox` }, { status: 404 })
  }
  if (!fnRes.ok) {
    const body = await fnRes.text().catch(() => '')
    return NextResponse.json({ error: 'fortnox_error', status: fnRes.status, body: body.slice(0, 500) }, { status: 502 })
  }
  const j = await fnRes.json().catch(() => ({}))
  const fileId = j?.SupplierInvoice?.SupplierInvoiceFileConnections?.[0]?.FileId
              ?? j?.SupplierInvoiceFileConnections?.[0]?.FileId
              ?? null
  if (!fileId) {
    return NextResponse.json({
      error: 'no_pdf_attached',
      message: `Invoice ${invoiceNumber} has no PDF attached in Fortnox.`,
    }, { status: 404 })
  }

  const target = new URL('/api/integrations/fortnox/file', req.nextUrl.origin)
  target.searchParams.set('business_id', businessId)
  target.searchParams.set('file_id',     String(fileId))
  target.searchParams.set('filename',    `${invoiceNumber}.pdf`)
  return NextResponse.redirect(target, 307)
}
