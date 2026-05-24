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

  // Resolve a live Fortnox access token. We bypass getFreshFortnoxAccessToken
  // here intentionally — that helper was returning null in production despite
  // a valid token sitting in the DB (2026-05-24, root cause TBD, tracked
  // separately). Since this is a user-blocking PDF render path, we read +
  // decrypt directly and refresh inline if the stored token is near expiry.
  // This path matches what loadFortnoxIntegration + getFreshFortnoxCreds do,
  // just inlined so a bug in either can't strand the user.
  let accessToken: string | null = null
  let tokenStage = 'before_call'
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

    if (!integ?.credentials_enc) {
      tokenStage = 'no_integration_row'
    } else {
      const decoded = decrypt(integ.credentials_enc)
      const raw     = decoded ? JSON.parse(decoded) : {}
      const expMs   = typeof raw.expires_at === 'number'
        ? raw.expires_at
        : (typeof raw.expires_at === 'string' ? (Date.parse(raw.expires_at) || 0) : 0)

      const stillValid = expMs - Date.now() > 5 * 60 * 1000

      if (stillValid && raw.access_token) {
        accessToken = String(raw.access_token)
        tokenStage  = `direct_decrypt_len_${accessToken.length}`
      } else {
        // Near expiry or empty — refresh via the shared helper (its refresh
        // path is fine; only the wrapper that returns the cached token was
        // the broken one).
        try {
          const refreshed = await refreshFortnoxToken(db, integ as any, {
            access_token:  String(raw.access_token  ?? ''),
            refresh_token: String(raw.refresh_token ?? ''),
            expires_at:    expMs,
            token_type:    raw.token_type,
            scope:         raw.scope,
          })
          accessToken = refreshed.access_token || null
          tokenStage  = `refreshed_len_${refreshed.access_token?.length ?? 0}`
        } catch (refreshErr: any) {
          return NextResponse.json({
            error:   'fortnox_token_refresh_failed',
            message: refreshErr?.message ?? 'Token refresh failed — please reconnect Fortnox.',
            caught_message: refreshErr?.message ?? null,
          }, { status: 401 })
        }
      }
    }
  } catch (err: any) {
    return NextResponse.json({
      error:   'fortnox_token_load_failed',
      message: err?.message ?? 'Failed to load Fortnox credentials.',
      caught_message: err?.message ?? null,
      stack_excerpt: String(err?.stack ?? '').slice(0, 600),
    }, { status: 500 })
  }
  if (!accessToken) {
    // Diagnostic — surface BOTH the integration's actual state AND the
    // current auth context so we can tell which mismatch is firing.
    // 'No connected Fortnox integration' was previously confusingly
    // shown even when the row existed with status='connected' — that
    // means the auth.orgId doesn't match the integration's org_id.
    const { data: integState } = await db
      .from('integrations')
      .select('status, last_error, org_id')
      .eq('business_id', businessId)
      .eq('provider', 'fortnox')
      .maybeSingle()
    if (integState && integState.status !== 'connected') {
      return NextResponse.json({
        error:   'fortnox_needs_reconnect',
        message: 'Fortnox connection needs to be re-authorised. Go to /integrations and click Connect.',
        status:  integState.status,
        detail:  integState.last_error?.slice(0, 200),
      }, { status: 409 })
    }
    if (integState && integState.org_id !== auth.orgId) {
      return NextResponse.json({
        error:   'auth_org_mismatch',
        message: 'You are signed in to a different organisation than the one that owns this Fortnox integration. Log out and log in as the correct owner, or switch the sidebar business to one in your own organisation.',
        auth_org: auth.orgId,
        biz_org:  integState.org_id,
      }, { status: 403 })
    }
    // ALSO inline the integration's actual access_token state (length
    // only — never the value) so we can diagnose:
    //   - row exists but credentials_enc decrypts to no access_token
    //   - decrypt itself returned null
    //   - refresh fired but persisted something empty
    let access_token_in_db_len = 0
    try {
      const { data: cred } = await db
        .from('integrations')
        .select('credentials_enc, updated_at')
        .eq('business_id', businessId)
        .eq('provider', 'fortnox')
        .maybeSingle()
      if (cred?.credentials_enc) {
        const { decrypt } = await import('@/lib/integrations/encryption')
        const decoded = decrypt(cred.credentials_enc)
        const parsed = decoded ? JSON.parse(decoded) : {}
        access_token_in_db_len = String(parsed.access_token ?? '').length
      }
    } catch (e) { /* swallow — diagnostic only */ }
    return NextResponse.json({
      error: 'No connected Fortnox integration for this business',
      diagnostic: {
        biz_id:        businessId,
        biz_org_id:    biz.org_id,
        auth_org_id:   auth.orgId,
        integration_found: !!integState,
        integration_status: integState?.status ?? null,
        token_stage:   tokenStage,
        access_token_in_db_len,
      },
    }, { status: 404 })
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
