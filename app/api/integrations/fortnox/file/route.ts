// app/api/integrations/fortnox/file/route.ts
//
// Streaming proxy for Fortnox file attachments. Used by the overhead-review
// drill-down's "View invoice" action — opens this URL in a new tab; the
// browser renders the PDF natively.
//
// GET /api/integrations/fortnox/file?business_id=X&file_id=Y[&filename=...]
//
// Flow:
//   1. Authenticate the caller's session.
//   2. Verify the caller's org owns the named business.
//   3. Decrypt the customer's Fortnox token.
//   4. GET /3/inbox/{file_id} from Fortnox to retrieve the file bytes.
//   5. Stream the response back to the browser with Content-Disposition: inline
//      so the PDF renders in the new tab.
//
// Why a proxy: Fortnox's file endpoint requires the customer's bearer token,
// which the browser doesn't have. Proxying via our server keeps the token
// server-side and lets the browser render the PDF without any Fortnox login.

import { NextRequest, NextResponse }    from 'next/server'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { decrypt }                      from '@/lib/integrations/encryption'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 30

export async function GET(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const url = new URL(req.url)
  const businessId = String(url.searchParams.get('business_id') ?? '').trim()
  const fileId     = String(url.searchParams.get('file_id') ?? '').trim()
  const filename   = String(url.searchParams.get('filename') ?? 'invoice.pdf').trim()

  if (!businessId || !fileId) {
    return NextResponse.json({ error: 'business_id and file_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  // Verify ownership.
  const { data: biz } = await db
    .from('businesses')
    .select('id, org_id')
    .eq('id', businessId)
    .eq('org_id', auth.orgId)
    .maybeSingle()
  if (!biz) return NextResponse.json({ error: 'Business not found in your org' }, { status: 404 })

  // Find the connected Fortnox integration for this business.
  const { data: integ } = await db
    .from('integrations')
    .select('credentials_enc')
    .eq('org_id', auth.orgId)
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .eq('status', 'connected')
    .limit(1)
    .maybeSingle()

  if (!integ?.credentials_enc) {
    return NextResponse.json({ error: 'No connected Fortnox integration for this business' }, { status: 404 })
  }

  let creds: any
  try {
    creds = JSON.parse(decrypt(integ.credentials_enc) ?? '{}')
  } catch {
    return NextResponse.json({ error: 'Failed to decrypt Fortnox credentials' }, { status: 500 })
  }
  const accessToken = String(creds?.access_token ?? '')
  if (!accessToken) {
    return NextResponse.json({ error: 'No Fortnox access token' }, { status: 500 })
  }

  // Try inbox first (where uploaded supplier-invoice files live before being
  // archived). Fortnox's `/3/inbox/{id}` returns the raw bytes; some files
  // live in `/3/archive/{id}` instead. fortnoxFetch handles 429 retry-with-
  // backoff so a transient rate limit doesn't 502 the user.
  let fortnoxRes = await fortnoxFetch(
    `https://api.fortnox.se/3/inbox/${encodeURIComponent(fileId)}`,
    accessToken,
    { accept: '*/*' },   // PDF binary, not JSON
  )
  if (fortnoxRes.status === 404) {
    fortnoxRes = await fortnoxFetch(
      `https://api.fortnox.se/3/archive/${encodeURIComponent(fileId)}`,
      accessToken,
      { accept: '*/*' },
    )
  }

  if (!fortnoxRes.ok) {
    const text = await fortnoxRes.text().catch(() => '')
    return NextResponse.json({
      error: `Fortnox file fetch failed: HTTP ${fortnoxRes.status}`,
      detail: text.slice(0, 300),
    }, { status: 502 })
  }

  const contentType = fortnoxRes.headers.get('content-type') ?? 'application/pdf'
  const safeFilename = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 200) || 'invoice.pdf'

  // Stream the body back. NextResponse can wrap a ReadableStream directly.
  return new NextResponse(fortnoxRes.body, {
    status: 200,
    headers: {
      'Content-Type':        contentType,
      // 'inline' so the browser renders the PDF in the new tab; switch to
      // 'attachment' to force download.
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control':       'private, max-age=300',  // 5 min — short-lived; user can re-fetch
    },
  })
}
