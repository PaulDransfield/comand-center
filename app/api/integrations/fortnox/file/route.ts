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
import { refreshFortnoxToken }          from '@/lib/fortnox/api/auth'
import { decrypt }                      from '@/lib/integrations/encryption'

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

  // Resolve a live Fortnox access token. Bypass the shared helpers entirely
  // — they keep returning null / triggering refresh races in production
  // (2026-05-24, root cause TBD). For this user-blocking PDF render path:
  //
  //   1. Read the credentials_enc directly + decrypt.
  //   2. Use the stored access_token AS-IS, no expiry-window check.
  //   3. If Fortnox returns 401 to our actual file fetch below, refresh
  //      once and retry. This avoids the "guess if it's expired" branch
  //      that was somehow misfiring.
  //
  // The "always try cached, refresh on 401" pattern is the canonical
  // OAuth client pattern — strictly better than expiry-window heuristics
  // because it works even when the server's idea of expiry differs from
  // what we cached.
  let accessToken: string | null = null
  let integForRefresh: any       = null
  let rawCreds: any              = null
  let loadDiag: any              = {}
  try {
    const { data: integ } = await db
      .from('integrations')
      .select('id, org_id, business_id, credentials_enc, status')
      .eq('org_id', auth.orgId)
      .eq('business_id', businessId)
      .eq('provider', 'fortnox')
      .in('status', ['connected', 'error', 'warning'])
      .limit(1)
      .maybeSingle()

    loadDiag.integration_found  = !!integ
    loadDiag.integration_status = integ?.status ?? null
    loadDiag.has_credentials_enc = !!integ?.credentials_enc

    if (integ?.credentials_enc) {
      const decoded  = decrypt(integ.credentials_enc)
      loadDiag.decrypt_ok      = !!decoded
      loadDiag.decoded_len     = (decoded ?? '').length
      const raw     = decoded ? JSON.parse(decoded) : {}
      loadDiag.raw_access_len  = String(raw?.access_token  ?? '').length
      loadDiag.raw_refresh_len = String(raw?.refresh_token ?? '').length
      rawCreds         = raw
      integForRefresh  = integ
      accessToken      = raw?.access_token ? String(raw.access_token) : null
    }
  } catch (err: any) {
    return NextResponse.json({
      error:   'fortnox_token_load_failed',
      message: err?.message ?? 'Failed to load Fortnox credentials.',
      caught_message: err?.message ?? null,
      load_diag: loadDiag,
    }, { status: 500 })
  }

  if (!accessToken) {
    return NextResponse.json({
      error: 'No connected Fortnox integration for this business',
      diagnostic: {
        biz_id: businessId,
        biz_org_id: biz.org_id,
        auth_org_id: auth.orgId,
        ...loadDiag,
      },
    }, { status: 404 })
  }
  // Try inbox first (where uploaded supplier-invoice files live before being
  // archived). Fortnox's `/3/inbox/{id}` returns the raw bytes; some files
  // live in `/3/archive/{id}` instead. fortnoxFetch handles 429 retry-with-
  // backoff so a transient rate limit doesn't 502 the user.
  async function fetchFile(token: string): Promise<Response> {
    let r = await fortnoxFetch(
      `https://api.fortnox.se/3/inbox/${encodeURIComponent(fileId)}`,
      token,
      { accept: '*/*' },
    )
    if (r.status === 404) {
      r = await fortnoxFetch(
        `https://api.fortnox.se/3/archive/${encodeURIComponent(fileId)}`,
        token,
        { accept: '*/*' },
      )
    }
    return r
  }

  let fortnoxRes = await fetchFile(accessToken)

  // If the cached token is actually expired, Fortnox returns 401. Refresh
  // once and retry — this is the canonical OAuth client pattern, strictly
  // better than guessing expiry from the cached expires_at timestamp.
  if (fortnoxRes.status === 401 && integForRefresh && rawCreds?.refresh_token) {
    try {
      const refreshed = await refreshFortnoxToken(db, integForRefresh, {
        access_token:  String(rawCreds.access_token  ?? ''),
        refresh_token: String(rawCreds.refresh_token ?? ''),
        expires_at:    0,   // force "expired" so refresh logic doesn't second-guess
        token_type:    rawCreds.token_type,
        scope:         rawCreds.scope,
      })
      if (refreshed.access_token) {
        accessToken = refreshed.access_token
        fortnoxRes  = await fetchFile(accessToken)
      }
    } catch (refreshErr: any) {
      return NextResponse.json({
        error:   'fortnox_token_refresh_failed',
        message: refreshErr?.message === 'FORTNOX_NEEDS_REAUTH'
          ? 'Your Fortnox connection was disconnected (refresh token rejected). Reconnect at /integrations.'
          : (refreshErr?.message ?? 'Token refresh failed.'),
        caught_message: refreshErr?.message ?? null,
      }, { status: 401 })
    }
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
