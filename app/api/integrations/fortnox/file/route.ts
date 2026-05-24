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
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'
import { getFreshFortnoxAccessToken }   from '@/lib/fortnox/api/auth'

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

  // Resolve a live Fortnox access token via the canonical helper. The
  // helper now serialises cross-process refreshes via the M096 lock, so
  // concurrent invocations won't all hammer Fortnox's token endpoint
  // with the same refresh_token. If the token is fresh, this is just a
  // DB read + decrypt.
  let accessToken: string | null
  try {
    accessToken = await getFreshFortnoxAccessToken(db, auth.orgId, businessId)
  } catch (err: any) {
    return NextResponse.json({
      error:   'fortnox_token_refresh_failed',
      message: err?.message === 'FORTNOX_NEEDS_REAUTH'
        ? 'Your Fortnox connection was disconnected. Reconnect at /integrations.'
        : (err?.message ?? 'Failed to obtain Fortnox token.'),
      caught_message: err?.message ?? null,
    }, { status: 401 })
  }

  if (!accessToken) {
    return NextResponse.json({
      error: 'No connected Fortnox integration for this business',
      hint:  'Go to /integrations and click Connect, then try again.',
    }, { status: 404 })
  }

  // Try inbox first (where uploaded supplier-invoice files live before
  // being archived). Some files live in /3/archive/{id} instead.
  // fortnoxFetch handles 429 retry-with-backoff.
  let fortnoxRes = await fortnoxFetch(
    `https://api.fortnox.se/3/inbox/${encodeURIComponent(fileId)}`,
    accessToken,
    { accept: '*/*' },
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

  const safeFilename = filename.replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 200) || 'invoice.pdf'

  // Force application/pdf — Fortnox sometimes sends application/octet-stream
  // which Chrome's built-in PDF viewer ignores (you'd get a download
  // prompt or blank iframe). We know these are PDFs by definition.
  // X-Frame-Options=SAMEORIGIN so OUR iframe can render the PDF
  // (without it, some browsers/Vercel defaults add DENY which blocks
  // even same-origin embeds).
  return new NextResponse(fortnoxRes.body, {
    status: 200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="${safeFilename}"`,
      'Cache-Control':       'private, max-age=300',  // 5 min — short-lived; user can re-fetch
      'X-Frame-Options':     'SAMEORIGIN',
      'Content-Security-Policy': "frame-ancestors 'self'",  // explicit frame allow for same-origin
    },
  })
}
