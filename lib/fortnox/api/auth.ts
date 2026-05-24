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
    const isInvalidGrant =
      res.status === 400 || res.status === 401 || /invalid_grant/i.test(text)

    if (isInvalidGrant) {
      // Belt-and-braces race detection: even with the M096 lock, two
      // processes could theoretically race in the millisecond between
      // acquire and Fortnox round-trip if the lock RPC failed silently.
      // Before declaring the integration dead, re-read the row — if
      // credentials_enc has changed since we started, another process
      // already refreshed successfully. Use their result instead of
      // flipping status='needs_reauth'.
      try {
        const { data: fresh } = await db
          .from('integrations')
          .select('credentials_enc, status')
          .eq('id', integ.id)
          .maybeSingle()
        if (
          fresh?.credentials_enc &&
          fresh.credentials_enc !== integ.credentials_enc &&
          fresh.status !== 'needs_reauth'
        ) {
          const newCreds = normaliseCreds(JSON.parse(decrypt(fresh.credentials_enc) ?? '{}'))
          if (newCreds.access_token && newCreds.expires_at > Date.now()) {
            log.info('fortnox_invalid_grant_recovered_via_reread', {
              integration_id: integ.id,
              new_expires_at: newCreds.expires_at,
            })
            return newCreds
          }
        }
      } catch (rereadErr: any) {
        log.warn('fortnox_invalid_grant_reread_failed', {
          integration_id: integ.id,
          error:          rereadErr?.message,
        })
      }

      // Genuinely dead refresh_token — owner must re-OAuth.
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
 * In-process refresh dedupe (Map<integration_id, Promise>) for the case
 * where two callers in the SAME Vercel invocation both want a refresh.
 * Layered on top of the M096 DB lock — without this, two same-process
 * callers would both try to acquire the DB lock, one would lose and
 * poll-wait unnecessarily. With this, they share one Promise that does
 * the lock dance once.
 */
const inflightRefreshes = new Map<string, Promise<DecryptedFortnoxCreds>>()

/**
 * Sleep helper for the lock-wait poll.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Try-acquire-or-wait refresh. Implements the cross-process race fix
 * from M096:
 *
 *   1. Try acquire DB lock on (integration_id). If acquired:
 *      - We're the chosen one. Do the refresh.
 *      - Always release in finally.
 *   2. If NOT acquired, another process is mid-refresh. Wait up to 15s,
 *      polling integrations.updated_at. As soon as the row's
 *      credentials_enc changes (= other process persisted refreshed
 *      creds), re-decrypt + return THEIR result.
 *   3. If we time out waiting, fall through and try the refresh
 *      ourselves (the other process probably crashed).
 *
 * Eliminates the invalid_grant cascade that killed integrations whenever
 * 2+ Lambda invocations posted the same refresh_token to Fortnox.
 */
async function refreshWithLock(
  db:        any,
  integ:     FortnoxIntegrationRow,
  currCreds: DecryptedFortnoxCreds,
): Promise<DecryptedFortnoxCreds> {
  const owner = `pid=${process.pid}/${Math.random().toString(36).slice(2, 8)}`

  // Snapshot current creds string so we can detect when "the row changed"
  // (another process persisted a refresh).
  const baselineEnc = integ.credentials_enc

  // Try to acquire the lock.
  const { data: acquired, error: lockErr } = await db.rpc(
    'acquire_fortnox_refresh_lock',
    { p_integration_id: integ.id, p_owner: owner },
  )

  if (lockErr) {
    // Lock RPC not deployed yet (pre-M096) or transient error — fall
    // back to old behaviour: just refresh and hope for the best.
    log.warn('fortnox_refresh_lock_rpc_unavailable', {
      integration_id: integ.id,
      error:          lockErr.message,
    })
    return refreshFortnoxToken(db, integ, currCreds)
  }

  if (acquired === true) {
    // We have the lock. Do the refresh, always release.
    try {
      return await refreshFortnoxToken(db, integ, currCreds)
    } finally {
      try {
        await db.rpc('release_fortnox_refresh_lock', { p_integration_id: integ.id })
      } catch (releaseErr: any) {
        // Stale-sweep covers us in 30s; this is best-effort.
        log.warn('fortnox_refresh_lock_release_failed', {
          integration_id: integ.id,
          error:          releaseErr?.message,
        })
      }
    }
  }

  // Lost the race. Poll for the holder to finish (= credentials_enc
  // changes in the integrations row). 15s budget, 500ms ticks.
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    const { data: fresh } = await db
      .from('integrations')
      .select('credentials_enc')
      .eq('id', integ.id)
      .maybeSingle()
    if (fresh?.credentials_enc && fresh.credentials_enc !== baselineEnc) {
      // Other process persisted. Use their result.
      try {
        const newCreds = normaliseCreds(JSON.parse(decrypt(fresh.credentials_enc) ?? '{}'))
        if (newCreds.access_token) {
          log.info('fortnox_refresh_race_won_by_other', {
            integration_id: integ.id,
            waited_ms:      (i + 1) * 500,
          })
          return newCreds
        }
      } catch (decErr: any) {
        log.warn('fortnox_refresh_race_decrypt_failed', {
          integration_id: integ.id,
          error:          decErr?.message,
        })
        // fall through to next poll
      }
    }
  }

  // Holder didn't finish in 15s — probably crashed. Try ourselves.
  log.warn('fortnox_refresh_lock_wait_timeout', { integration_id: integ.id })
  return refreshFortnoxToken(db, integ, currCreds)
}

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
  if (!integ) return null

  let creds: DecryptedFortnoxCreds
  try {
    creds = normaliseCreds(JSON.parse(decrypt(integ.credentials_enc) ?? '{}'))
  } catch (e: any) {
    throw new Error('Failed to decrypt Fortnox credentials')
  }

  const stillValid = creds.expires_at - Date.now() > REFRESH_THRESHOLD_MS

  if (!opts?.force && stillValid && creds.access_token) {
    return creds   // happy path — no refresh needed
  }

  // Refresh path — dedupe by integration_id within this process AND
  // serialise across processes via the M096 DB lock.
  const key = `${integ.id}`
  let p = inflightRefreshes.get(key)
  if (!p) {
    p = refreshWithLock(db, integ, creds)
      .finally(() => inflightRefreshes.delete(key))
    inflightRefreshes.set(key, p)
  }
  try {
    return await p
  } catch (e: any) {
    // Mark status='error' for generic refresh errors (HTTP 5xx, network
    // issues, invalid_client) — invalid_grant has its own path in
    // refreshFortnoxToken that flips to needs_reauth instead.
    if (e?.message !== 'FORTNOX_NEEDS_REAUTH') {
      try {
        await db.from('integrations')
          .update({
            status:     'error',
            last_error: `refresh failed: ${e?.message ?? 'unknown'}`,
          })
          .eq('id', integ.id)
      } catch {}
    }
    throw e
  }
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
