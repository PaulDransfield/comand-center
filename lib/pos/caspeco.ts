// lib/pos/caspeco.ts
//
// Caspeco staff scheduling + booking integration.
//
// 2026-06-09 rewrite — the original code targeted `api.caspeco.se`
// (host doesn't resolve) with `Authorization: Bearer <api_key>` (auth
// model wrong for Caspeco). Multi-business mapping was missing
// entirely. Probe verified the real layout:
//
//   Base URL:     https://cloud.caspeco.se
//   Auth:         Authorization: Bearer <full PAT>
//                 (PAT format: "<shortname>-<from>-<to>--<hex>")
//   Per-company:  companyid: <UUID>  header on every request
//   CSRF:         x-csrf: 1  header
//
// Each Caspeco user account can span many companies (restaurants).
// CommandCenter integrations are per-business, so the connect flow
// stores the company UUID in integrations.metadata.caspeco_company_id
// and every API call pins that ID.
//
// Endpoints used today (matched against confirmed-working calls):
//   GET /api/v1/Employees   — staff roster
//   GET /api/v1/Stations    — restaurant location(s) in this company
//   GET /api/v1/Articles    — POS menu items (empty for Chicce today)
//
// Endpoints we want but lack permission for:
//   GET /api/v1/Booking/Bookings  ← needs `booking.getall` permission
//   GET /api/v1/Booking/Units     ← needs `unit.getall`
//
// When permission is granted, the bookings sync just plugs in via
// getBookings(); no other changes needed.

const BASE = 'https://cloud.caspeco.se'

export interface CaspecoCreds {
  pat:       string   // full Personal Access Token (with the `--` separator)
  companyid: string   // UUID identifying the per-company database
}

function baseHeaders(creds: CaspecoCreds): Record<string, string> {
  return {
    Authorization: `Bearer ${creds.pat}`,
    Accept:        'application/json',
    companyid:     creds.companyid,
    'x-csrf':      '1',
  }
}

interface FetchResult<T> {
  ok:           boolean
  status:       number
  data:         T | null
  error:        string | null
  missing_perm: string | null   // for 403 — the permission name Caspeco surfaced
}

async function call<T>(creds: CaspecoCreds, path: string): Promise<FetchResult<T>> {
  try {
    const r = await fetch(BASE + path, { headers: baseHeaders(creds) })
    if (r.ok) {
      const json = await r.json().catch(() => null)
      return { ok: true, status: r.status, data: json as T, error: null, missing_perm: null }
    }
    const text = await r.text()
    // Caspeco's 403 plain-text shape: "You do not have the authorization needed to perform action: booking.getall"
    let missingPerm: string | null = null
    if (r.status === 403) {
      const m = text.match(/action: ([a-zA-Z0-9_.]+)/)
      if (m) missingPerm = m[1]
    }
    return {
      ok:           false,
      status:       r.status,
      data:         null,
      error:        text.replace(/\s+/g, ' ').slice(0, 300),
      missing_perm: missingPerm,
    }
  } catch (e: any) {
    return { ok: false, status: 0, data: null, error: String(e?.message ?? e), missing_perm: null }
  }
}

/**
 * Probes /api/v1/Employees with `?$top=1` to verify auth + companyid in
 * one cheap call. Returns true when the credentials work end-to-end.
 */
export async function testCaspecoConnection(creds: CaspecoCreds): Promise<{ ok: boolean; message: string; missing_perm: string | null }> {
  const r = await call<any>(creds, '/api/v1/Employees')
  if (r.ok) return { ok: true, message: 'Caspeco connected — employees readable', missing_perm: null }
  if (r.status === 401) return { ok: false, message: 'Authentication failed — PAT may be invalid or expired', missing_perm: null }
  if (r.status === 403) return { ok: false, message: `Authorized but missing permission: ${r.missing_perm ?? 'unknown'}`, missing_perm: r.missing_perm }
  if (r.status === 500) return { ok: false, message: 'Caspeco server error — companyid may be wrong for this PAT', missing_perm: null }
  return { ok: false, message: `Caspeco returned ${r.status}: ${r.error}`, missing_perm: null }
}

// ── Domain types (subset of what Caspeco returns) ────────────────────

export interface CaspecoEmployee {
  id:               number
  employeeNumber:   number | null
  personalIdentity: string | null   // Swedish personal number — TREAT AS PII
  firstName:        string
  lastName:         string
  email?:           string | null
  active?:          boolean
  employments?:     Array<{
    id:                 number
    employeeId:         number
    employmentNumber:   number | null
    startDate:          string | null
    endDate:            string | null
    contractId:         string | null
    changePoints?:      Array<{
      validFrom:        string | null
      localProfessionId: number | null
      defaultStationId: number | null
    }>
  }>
}

export interface CaspecoStation {
  id:                  number
  name:                string
  parentNodeId:        number | null
  legacyBookingUnitId: number | null
}

export interface CaspecoArticle {
  id:    number
  name?: string
  // (response shape TBD — Chicce returns 0 rows today)
}

// ── Reads ────────────────────────────────────────────────────────────

export async function getCaspecoEmployees(creds: CaspecoCreds): Promise<FetchResult<CaspecoEmployee[]>> {
  return call<CaspecoEmployee[]>(creds, '/api/v1/Employees')
}

export async function getCaspecoStations(creds: CaspecoCreds): Promise<FetchResult<CaspecoStation[]>> {
  return call<CaspecoStation[]>(creds, '/api/v1/Stations')
}

export async function getCaspecoArticles(creds: CaspecoCreds): Promise<FetchResult<CaspecoArticle[]>> {
  return call<CaspecoArticle[]>(creds, '/api/v1/Articles')
}

/**
 * Booking list — gated by `booking.getall` permission on the Caspeco
 * user. Until that's granted, this returns a 403 with missing_perm set
 * so the caller can surface a clear "grant this permission" message.
 *
 * Once granted, the data structure is the forward-looking covers signal
 * we want for forecasting: each booking has guestCount + arrivalTime.
 */
export async function getCaspecoBookings(
  creds:    CaspecoCreds,
  fromDate: string,
  toDate:   string,
): Promise<FetchResult<any[]>> {
  // Query param shape TBD until permission lands; fromDate/toDate
  // matches the docs' published example.
  const qs = new URLSearchParams({ fromDate, toDate }).toString()
  return call<any[]>(creds, `/api/v1/Booking/Bookings?${qs}`)
}

/**
 * Unit list — gated by `unit.getall`. Used to surface a per-unit
 * picker when companies have multiple restaurants.
 */
export async function getCaspecoUnits(creds: CaspecoCreds): Promise<FetchResult<any[]>> {
  return call<any[]>(creds, '/api/v1/Booking/Units')
}
