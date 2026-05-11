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
    .select('id, org_id, business_id, credentials_enc')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('provider', 'fortnox')
    .in('status', ['connected', 'error', 'warning'])
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Fortnox integration load failed: ${error.message}`)
  if (!data?.credentials_enc) return null
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

/**
 * One-call helper: load integration → decrypt creds → refresh if expiring →
 * return the live access_token. Returns null when there's no usable
 * Fortnox connection for this (org, business). Throws only on refresh
 * failure (customer must reconnect).
 */
export async function getFreshFortnoxAccessToken(
  db:         any,
  orgId:      string,
  businessId: string,
): Promise<string | null> {
  const integ = await loadFortnoxIntegration(db, orgId, businessId)
  if (!integ) return null

  let creds: DecryptedFortnoxCreds
  try {
    creds = normaliseCreds(JSON.parse(decrypt(integ.credentials_enc) ?? '{}'))
  } catch {
    throw new Error('Failed to decrypt Fortnox credentials')
  }

  const stillValid = creds.expires_at - Date.now() > REFRESH_THRESHOLD_MS
  if (!stillValid) {
    creds = await refreshFortnoxToken(db, integ, creds)
  }
  return creds.access_token || null
}
