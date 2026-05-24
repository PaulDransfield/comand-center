// lib/fortnox/api/auth.ts
//
// Shared Fortnox token-refresh helper. Use from ANY endpoint that calls
// api.fortnox.se/3/* with a customer's bearer token — passing the raw
// stored access_token directly will 401 once the 60-minute token expires
// (which happens within an hour of OAuth on every fresh connection).
//
// The recent-invoices / drilldown / invoice-pdf routes were originally
// reading `creds.access_token` straight from the integrations row with
// no expiry check, so Vero's dashboard started 401-ing the day after she
// onboarded (2026-05-11). The fix is to route every Fortnox call through
// `getFreshFortnoxAccessToken()` which:
//
//   1. Loads the integration row (status IN ('connected','error','warning'))
//   2. Decrypts the credentials JSON
//   3. Checks if access_token is within REFRESH_THRESHOLD_MS of expiry
//   4. If yes, exchanges refresh_token for a new access_token via Fortnox
//      OAuth token endpoint and persists the refreshed payload back to
//      the integrations row
//   5. Returns the (possibly-refreshed) access_token
//
// Identical refresh semantics to `ensureFreshToken()` in vouchers.ts;
// extracted so non-voucher endpoints can share it. vouchers.ts can be
// migrated to import this in a separate session — keeping its internal
// copy avoids any risk of breaking the backfill worker.

import { decrypt, encrypt } from '@/lib/integrations/encryption'
import { log } from '@/lib/log/structured'

const FORTNOX_TOKEN_URL    = 'https://apps.fortnox.se/oauth-v1/token'
const REFRESH_THRESHOLD_MS = 5 * 60 * 1000   // refresh if <5min to expiry

export interface DecryptedFortnoxCreds {
  access_token:  string
  refresh_token: string
  expires_at:    number   // ms epoch
  token_type?:   string
  scope?:        string
}

export interface FortnoxIntegrationRow {
  id:               string
  org_id:           string
  business_id:      string | null
  credentials_enc:  string
}

/**
 * Load the Fortnox integration row for (org, business). Accepts status
 * IN ('connected', 'error', 'warning') — the credentials are valid in
 * any of those states, only 'disconnected'/'not_connected' means there's
 * genuinely nothing to use.
 *
 * Returns null when no usable row exists — callers decide whether to
 * 404 or return an empty payload. Throws only on schema errors.
 */
export async function loadFortnoxIntegration(
  db:         any,
  orgId:      string,
  businessId: string,
): Promise<FortnoxIntegrationRow | null> {
  const { data, error } = await db
    .from('integrations')
    .select('id, org_id, business_id, credentials_enc, status')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'error', 'warning'])
    .limit(1)
    .maybeSingle()
  console.log('[fortnox/auth] loadIntegration', {
    orgId, businessId,
    error: error?.message ?? null,
    found: !!data, status: data?.status ?? null,
    creds_len: data?.credentials_enc?.length ?? 0,
  })
  if (error) throw new Error(`Fortnox integration load failed: ${error.message}`)
  if (!data?.credentials_enc) {
    // No-org-filter probe to spot RLS / org mismatch
    const { data: anyRow } = await db
      .from('integrations')
      .select('id, org_id, status, credentials_enc')
      .eq('business_id', businessId)
      .eq('provider', 'fortnox')
      .maybeSingle()
    console.log('[fortnox/auth] no-filter probe', {
      found: !!anyRow,
      its_org_id: anyRow?.org_id ?? null,
      its_status: anyRow?.status ?? null,
      its_creds_len: anyRow?.credentials_enc?.length ?? 0,
      requested_orgId: orgId,
    })
    return null
  }
  return data as FortnoxIntegrationRow
}

/**
 * Refresh the access_token using the stored refresh_token and persist
 * the new credentials back to the integrations row. Throws on refresh
 * failure (revoked / invalid refresh_token / Fortnox API error) — caller
 * should catch and surface a "reconnect Fortnox" message.
 */
export async function refreshFortnoxToken(
  db:    any,
  integ: FortnoxIntegrationRow,
  creds: DecryptedFortnoxCreds,
): Promise<DecryptedFortnoxCreds> {
  if (!creds.refresh_token) {
    throw new Error('Fortnox token expired and no refresh_token available — customer must reconnect')
  }
  const clientId     = process.env.FORTNOX_CLIENT_ID
  const clientSecret = process.env.FORTNOX_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('FORTNOX_CLIENT_ID / FORTNOX_CLIENT_SECRET not set in env')
  }

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch(FORTNOX_TOKEN_URL, {
    method:  'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refresh_token }).toString(),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // Fortnox returns invalid_grant when the refresh token has been
    // rotated (a previous refresh response wasn't persisted), revoked
    // by the customer, or expired (45 days idle). Any of these mean
    // the only path forward is owner re-OAuth — so flip the integration
    // to status='needs_reauth' and stop pretending the connection is
    // healthy. Without this flip, every subsequent request hits the
    // same dead token and re-throws the same HTTP 400 in a loop.
    const isInvalidGrant =
      res.status === 400 || res.status === 401 || /invalid_grant/i.test(text)
    if (isInvalidGrant) {
      try {
        await db.from('integrations')
          .update({
            status:     'needs_reauth',
            last_error: `Fortnox refresh token rejected: ${text.slice(0, 200)}`,
          })
          .eq('id', integ.id)
      } catch { /* best-effort — the throw below is still the loud signal */ }
      log.error('fortnox_needs_reauth', {
        route:          'lib/fortnox/api/auth.ts',
        org_id:         integ.org_id,
        business_id:    integ.business_id,
        integration_id: integ.id,
        http_status:    res.status,
        body_excerpt:   text.slice(0, 200),
      })
      throw new Error('FORTNOX_NEEDS_REAUTH')
    }
    throw new Error(`Fortnox token refresh failed: HTTP ${res.status} — ${text.slice(0, 200)}`)
  }
  const tok: any = await res.json()
  const refreshed: DecryptedFortnoxCreds = {
    access_token:  tok.access_token  ?? creds.access_token,
    refresh_token: tok.refresh_token ?? creds.refresh_token,
    expires_at:    Date.now() + (Number(tok.expires_in ?? 3600) * 1000),
    token_type:    tok.token_type    ?? creds.token_type,
    scope:         tok.scope         ?? creds.scope,
  }

  await db.from('integrations')
    .update({
      credentials_enc:  encrypt(JSON.stringify(refreshed)),
      token_expires_at: new Date(refreshed.expires_at).toISOString(),
      status:           'connected',
      last_error:       null,
    })
    .eq('id', integ.id)

  return refreshed
}

/** Normalise both legacy (ISO string expires_at) and current (ms-epoch number) shapes. */
function normaliseCreds(raw: any): DecryptedFortnoxCreds {
  let expiresAt: number = 0
  if (typeof raw?.expires_at === 'number')      expiresAt = raw.expires_at
  else if (typeof raw?.expires_at === 'string') expiresAt = Date.parse(raw.expires_at) || 0
  return {
    access_token:  String(raw?.access_token  ?? ''),
    refresh_token: String(raw?.refresh_token ?? ''),
    expires_at:    expiresAt,
    token_type:    raw?.token_type,
    scope:         raw?.scope,
  }
}

export interface GetFreshTokenOpts {
  /** Force refresh even if the cached token isn't expiring yet. Use
   *  when a 401 came back from Fortnox despite expires_at being far in
   *  the future (stale cache, manual revocation, etc). */
  force?: boolean
}

/**
 * Race-prevention: when two callers refresh simultaneously, only one
 * actually hits Fortnox — the other awaits the in-flight promise.
 * Single-process scope only; concurrent Vercel function invocations
 * can still race. Cross-process safety needs DB advisory lock + that's
 * a follow-up scoped in SCALING-FORTNOX-AUTH.md.
 */
const inflightRefreshes = new Map<string, Promise<DecryptedFortnoxCreds>>()

/** Load + decrypt + (maybe) refresh. Returns the full creds object so
 *  callers that need scope / expires_at can consume them. Most callers
 *  want just the access_token via `getFreshFortnoxAccessToken`. */
export async function getFreshFortnoxCreds(
  db:         any,
  orgId:      string,
  businessId: string,
  opts?:      GetFreshTokenOpts,
): Promise<DecryptedFortnoxCreds | null> {
  const integ = await loadFortnoxIntegration(db, orgId, businessId)
  if (!integ) {
    console.log('[fortnox/auth] loadFortnoxIntegration returned null', { orgId, businessId })
    return null
  }
  console.log('[fortnox/auth] integ found', {
    id: integ.id, creds_len: integ.credentials_enc?.length ?? 0,
  })

  let creds: DecryptedFortnoxCreds
  try {
    const decrypted = decrypt(integ.credentials_enc)
    console.log('[fortnox/auth] decrypted', {
      is_null: decrypted == null, len: decrypted?.length ?? 0,
    })
    const parsed = JSON.parse(decrypted ?? '{}')
    console.log('[fortnox/auth] parsed keys', Object.keys(parsed))
    creds = normaliseCreds(parsed)
    console.log('[fortnox/auth] normalised', {
      access_token_len: creds.access_token?.length ?? 0,
      refresh_token_len: creds.refresh_token?.length ?? 0,
      expires_at: creds.expires_at,
      expires_in_ms: creds.expires_at - Date.now(),
    })
  } catch (e: any) {
    console.log('[fortnox/auth] decrypt/parse threw:', e?.message)
    throw new Error('Failed to decrypt Fortnox credentials')
  }

  const stillValid = creds.expires_at - Date.now() > REFRESH_THRESHOLD_MS
  console.log('[fortnox/auth] stillValid:', stillValid, 'force:', !!opts?.force)
  if (opts?.force || !stillValid) {
    const key = `${integ.id}`
    let p = inflightRefreshes.get(key)
    if (!p) {
      p = refreshFortnoxToken(db, integ, creds)
        .finally(() => inflightRefreshes.delete(key))
      inflightRefreshes.set(key, p)
    }
    creds = await p
    console.log('[fortnox/auth] post-refresh', {
      access_token_len: creds.access_token?.length ?? 0,
    })
  }
  return creds
}

/** One-call helper: load → decrypt → refresh if expiring → return the
 *  live access_token. Returns null when there's no usable Fortnox
 *  connection for this (org, business). Throws only on refresh failure
 *  (customer must reconnect). */
export async function getFreshFortnoxAccessToken(
  db:         any,
  orgId:      string,
  businessId: string,
  opts?:      GetFreshTokenOpts,
): Promise<string | null> {
  const creds = await getFreshFortnoxCreds(db, orgId, businessId, opts)
  return creds?.access_token ?? null
}
