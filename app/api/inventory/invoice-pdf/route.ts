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
import { highlightArticleInPdf }   from '@/lib/pdf/highlight-article'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60   // PDF text extraction + annotation can be slower than a plain proxy

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId    = String(url.searchParams.get('business_id') ?? '').trim()
  const invoiceNumber = String(url.searchParams.get('invoice_number') ?? '').trim()
  // Phase 1 highlight: when ?article=N is passed AND the invoice has an
  // attached PDF, fetch the bytes server-side, annotate the matching row
  // with a lavender rectangle, and stream the modified PDF. Empty → plain
  // PDF (existing behavior).
  const articleNumber = String(url.searchParams.get('article') ?? '').trim()
  if (!businessId || !invoiceNumber) {
    return NextResponse.json({ error: 'business_id and invoice_number required' }, { status: 400 })
  }
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Cache-first: look up the local fortnox_supplier_invoices row.
  const { data: cached } = await db.from('fortnox_supplier_invoices')
    .select('file_id, has_pdf, supplier_name')
    .eq('business_id', businessId)
    .eq('given_number', invoiceNumber)
    .maybeSingle()

  let fileId: string | null = cached?.file_id ?? null
  let supplierName: string | null = cached?.supplier_name ?? null

  // Re-check Fortnox whenever we don't have a confirmed file_id. Previously
  // we trusted has_pdf=false from the cache, but customers were stuck on a
  // stale "no PDF" answer when the supplier uploaded the PDF after our last
  // sync. Cost is one extra Fortnox API call per click on a no-PDF row —
  // acceptable for interactive use.
  if (!fileId) {
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
    // Fortnox detail endpoint INCONSISTENTLY embeds FileConnections (often
    // returns empty even when a file exists). Authoritative source is the
    // dedicated /supplierinvoicefileconnections/ endpoint — call it when
    // the detail endpoint says no file. Mirrors lib/inventory/
    // pdf-extraction-worker.ts. Without this, ~99% of supplier-sync rows
    // get logged as "no PDF" because we never actually asked Fortnox right.
    if (!fileId) {
      try {
        const fcRes = await fortnoxFetch(
          `https://api.fortnox.se/3/supplierinvoicefileconnections/?supplierinvoicenumber=${encodeURIComponent(invoiceNumber)}`,
          accessToken,
          { accept: 'application/json' },
        )
        if (fcRes.ok) {
          const fcJson = await fcRes.json().catch(() => ({}))
          const conns = fcJson?.SupplierInvoiceFileConnections ?? []
          if (Array.isArray(conns) && conns.length > 0 && conns[0]?.FileId) {
            fileId = String(conns[0].FileId)
          }
        }
      } catch { /* swallow — non-fatal, just means we'll show no_pdf */ }
    }
    // Write back to the local cache so the next click reflects the latest
    // Fortnox truth without a second API hop. has_pdf = (fileId != null).
    if (cached) {
      void db.from('fortnox_supplier_invoices').update({
        file_id:            fileId,
        has_pdf:            fileId != null,
        file_id_fetched_at: new Date().toISOString(),
      }).eq('business_id', businessId).eq('given_number', invoiceNumber)
    }
  }

  if (!fileId) {
    return noPdfResponse(invoiceNumber, supplierName,
      'This invoice has no PDF attached on Fortnox. Many suppliers (Spendrups, Carlsberg etc.) only book the invoice metadata without uploading the PDF — your supplier portal is the fastest place to verify the price.')
  }

  // No article-highlight requested → fast path. Redirect to the existing
  // PDF proxy which streams the bytes (uses the same Fortnox token + retry
  // logic). Same behavior as before this Phase 1 work.
  if (!articleNumber) {
    const target = new URL('/api/integrations/fortnox/file', req.nextUrl.origin)
    target.searchParams.set('business_id', businessId)
    target.searchParams.set('file_id',     String(fileId))
    target.searchParams.set('filename',    `${invoiceNumber}.pdf`)
    return NextResponse.redirect(target, 307)
  }

  // Highlight path — fetch bytes here, annotate, stream.
  // Reuse the same Fortnox token + inbox/archive fallback as the file proxy.
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
  } catch (err: any) {
    return noPdfResponse(invoiceNumber, supplierName,
      err?.message === 'FORTNOX_NEEDS_REAUTH'
        ? 'Your Fortnox connection was disconnected. Reconnect at /integrations.'
        : (err?.message ?? 'Failed to obtain Fortnox token.'))
  }
  if (!accessToken) {
    return noPdfResponse(invoiceNumber, supplierName, 'No connected Fortnox integration for this business.')
  }
  // Try inbox first, fall back to archive (same as /api/integrations/fortnox/file).
  let bytesRes = await fortnoxFetch(
    `https://api.fortnox.se/3/inbox/${encodeURIComponent(String(fileId))}`,
    accessToken, { accept: '*/*' },
  )
  if (bytesRes.status === 404) {
    bytesRes = await fortnoxFetch(
      `https://api.fortnox.se/3/archive/${encodeURIComponent(String(fileId))}`,
      accessToken, { accept: '*/*' },
    )
  }
  if (!bytesRes.ok) {
    return noPdfResponse(invoiceNumber, supplierName, `Fortnox returned error ${bytesRes.status} when fetching PDF bytes.`)
  }
  const arrayBuf = await bytesRes.arrayBuffer()
  const pdfBytes = new Uint8Array(arrayBuf)

  const hl = await highlightArticleInPdf(pdfBytes, articleNumber)
  const outBytes = hl.ok && hl.bytes ? hl.bytes : pdfBytes

  // BodyInit doesn't accept Uint8Array directly under stricter TS lib defs —
  // wrap in a Blob.
  // Cast through ArrayBuffer to satisfy the stricter TS lib BlobPart type.
  const blobPart: BlobPart = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer
  return new NextResponse(new Blob([blobPart], { type: 'application/pdf' }), {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${invoiceNumber}-highlighted.pdf"`,
      'Cache-Control':       'no-store',
      'X-Highlight-Status':  hl.ok ? 'ok' : (hl.reason ?? 'unknown'),
    },
  })
}

// Friendly HTML response when there's no PDF — the link is opened in a
// new tab so we don't want to dump JSON in the user's face.
function noPdfResponse(invoiceNumber: string, supplierName: string | null, message: string): NextResponse {
  const supplier = supplierName ? supplierName : 'supplier'
  // Page renders inside the in-app <PdfModal>'s iframe. Strong visual
  // treatment so it's unmistakably a TERMINAL state ("there is no PDF
  // for this invoice") rather than something the user is meant to wait
  // through. Big icon, clear heading, no spinner-like patterns.
  const html = `<!DOCTYPE html><html lang="en"><head>
  <meta charset="utf-8"><title>No PDF · Invoice ${invoiceNumber}</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { --lav-fill: #ece8f8; --lav-mid: #c4b8ec; --lav-deep: #7d6cc9; --ink1: #1a1a1a; --ink3: #6e6e6e; --ink4: #999; --border: #e5e5e5; }
    body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #fafafa; color: var(--ink1); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
    .card { max-width: 520px; background: #fff; border: 0.5px solid var(--border); border-radius: 12px; padding: 32px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); text-align: center; }
    .icon { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 50%; background: var(--lav-fill); display: flex; align-items: center; justify-content: center; color: var(--lav-deep); font-size: 28px; line-height: 1; font-weight: 600; }
    h1 { font-size: 18px; font-weight: 600; margin: 0 0 6px; color: var(--ink1); }
    .sub { font-size: 11px; color: var(--ink4); text-transform: uppercase; letter-spacing: 0.06em; font-weight: 600; margin-bottom: 18px; }
    .meta { background: var(--lav-fill); border-radius: 6px; padding: 10px 14px; margin: 0 0 18px; text-align: left; }
    .meta-row { font-size: 11px; color: var(--ink3); margin-bottom: 2px; }
    .meta-row strong { color: var(--ink1); font-weight: 600; }
    p { font-size: 13px; line-height: 1.55; color: var(--ink3); margin: 0; text-align: left; }
  </style></head><body>
  <div class="card">
    <div class="icon" aria-hidden="true">!</div>
    <h1>This invoice has no PDF</h1>
    <div class="sub">Final state — nothing more will load</div>
    <div class="meta">
      <div class="meta-row"><strong>Supplier:</strong> ${escapeHtml(supplier)}</div>
      <div class="meta-row"><strong>Invoice number:</strong> ${escapeHtml(invoiceNumber)}</div>
    </div>
    <p>${escapeHtml(message)}</p>
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
