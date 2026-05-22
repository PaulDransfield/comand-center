// lib/fortnox/company-identity.ts
//
// Fortnox is the source of truth for a business's legal identity:
// organisationsnummer, registered name, address. Every page the
// revisor signs off on (and the printable archive document the
// owner files for 7 years per BFL 7 kap.) MUST carry the same
// org-nr as the customer's Fortnox account.
//
// This module:
//   1. Fetches `/3/companyinformation` from Fortnox
//   2. Compares against the local `businesses` row
//   3. Auto-populates missing fields (e.g. our org_number IS NULL,
//      Fortnox has one → write it down)
//   4. Surfaces divergences (we have one value, Fortnox has another)
//      as anomaly_alerts so the owner can reconcile
//
// Sync triggers:
//   - On Fortnox OAuth connect (in /api/integrations/fortnox callback)
//   - On every successful Fortnox sync (engine.ts entry point)
//   - On admin "Pull company info from Fortnox" button (/admin/v2/tools)
//
// Source-of-truth policy:
//   - org_number: Fortnox always wins (it's a legal identifier, not
//                 owner-editable in any meaningful sense). Divergence
//                 → alert with severity='high' AND auto-update our row.
//   - name:       Fortnox wins only when our value is empty. Divergence
//                 with an owner-set value → alert with severity='medium',
//                 do NOT auto-overwrite (owner may have a polished display
//                 name they prefer).
//   - city:       Same as name.

import { getFreshFortnoxAccessToken } from '@/lib/fortnox/api/auth'
import { fortnoxFetch }                 from '@/lib/fortnox/api/fetch'

const FORTNOX_API = 'https://api.fortnox.se/3'

export interface FortnoxCompanyInfo {
  organisation_number: string | null     // 'XXXXXX-XXXX' or 10-digit, as Fortnox formats
  name:                string | null
  address:             string | null
  city:                string | null
  zip_code:            string | null
  country_code:        string | null     // 'SE' etc.
  vat_number:          string | null
  fiscal_year_start:   string | null
  fiscal_year_end:     string | null
}

/**
 * Fetch `/3/companyinformation` and parse the fields we care about.
 * Returns null on Fortnox call failure (caller decides whether to retry
 * or surface the error).
 */
export async function fetchFortnoxCompanyInfo(
  accessToken: string,
): Promise<FortnoxCompanyInfo | null> {
  try {
    const res = await fortnoxFetch(`${FORTNOX_API}/companyinformation`, accessToken)
    if (!res.ok) return null
    const json: any = await res.json()
    const c = json?.CompanyInformation
    if (!c) return null
    return {
      organisation_number: c.OrganizationNumber ?? null,
      name:                c.CompanyName ?? null,
      address:             c.Address ?? null,
      city:                c.City ?? null,
      zip_code:            c.ZipCode ?? null,
      country_code:        c.CountryCode ?? null,
      vat_number:          c.VATNumber ?? null,
      fiscal_year_start:   c.FinancialYear ?? null,
      fiscal_year_end:     c.FinancialYearDate ?? null,
    }
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────

export interface IdentitySyncResult {
  ok:                   boolean
  reason?:              string
  changes:              FieldChange[]
  divergences:          FieldDivergence[]
  alerts_created:       number
  business_id:          string
  fortnox_info_present: boolean
}

interface FieldChange {
  field:        'org_number' | 'name' | 'city' | 'country'
  previous:     string | null
  applied:      string | null
  reason:       'auto_populated' | 'fortnox_wins'
}

interface FieldDivergence {
  field:        'org_number' | 'name' | 'city' | 'country'
  our_value:    string | null
  fortnox_value: string | null
}

/**
 * Reconcile a business row against Fortnox. Updates `businesses` and
 * generates anomaly_alerts on any divergence. Idempotent — running
 * this multiple times against unchanged data is a no-op.
 */
export async function syncBusinessIdentityFromFortnox(
  db:         any,
  orgId:      string,
  businessId: string,
): Promise<IdentitySyncResult> {
  let result: IdentitySyncResult = {
    ok:                   true,
    changes:              [],
    divergences:          [],
    alerts_created:       0,
    business_id:          businessId,
    fortnox_info_present: false,
  }

  // 1. Get a fresh token. Failures bubble up as ok=false.
  let token: string | null
  try {
    token = await getFreshFortnoxAccessToken(db, orgId, businessId)
  } catch (e: any) {
    return { ...result, ok: false, reason: `token_refresh: ${e?.message ?? e}` }
  }
  if (!token) {
    return { ...result, ok: false, reason: 'no_fortnox_token' }
  }

  // 2. Pull from Fortnox
  const info = await fetchFortnoxCompanyInfo(token)
  if (!info) {
    return { ...result, ok: false, reason: 'fortnox_companyinformation_fetch_failed' }
  }
  result.fortnox_info_present = true

  // 3. Load current business row
  const { data: biz, error: bizErr } = await db
    .from('businesses')
    .select('id, name, org_number, city, country')
    .eq('id', businessId)
    .maybeSingle()
  if (bizErr || !biz) {
    return { ...result, ok: false, reason: `business_load_failed: ${bizErr?.message ?? 'not found'}` }
  }

  // 4. Reconcile each field
  const updates: Record<string, any> = {}

  // ── org_number: Fortnox ALWAYS wins ───────────────────────────────
  const fortnoxOrg = normaliseOrgNumber(info.organisation_number)
  const ourOrg     = normaliseOrgNumber(biz.org_number)
  if (fortnoxOrg && fortnoxOrg !== ourOrg) {
    updates.org_number = fortnoxOrg
    if (ourOrg) {
      result.divergences.push({
        field:         'org_number',
        our_value:     ourOrg,
        fortnox_value: fortnoxOrg,
      })
      result.changes.push({
        field:    'org_number',
        previous: ourOrg,
        applied:  fortnoxOrg,
        reason:   'fortnox_wins',
      })
    } else {
      result.changes.push({
        field:    'org_number',
        previous: null,
        applied:  fortnoxOrg,
        reason:   'auto_populated',
      })
    }
  }

  // ── name: Fortnox wins only when our value is empty ──────────────
  const fortnoxName = (info.name ?? '').trim() || null
  const ourName     = (biz.name ?? '').trim() || null
  if (fortnoxName && !ourName) {
    updates.name = fortnoxName
    result.changes.push({
      field:    'name',
      previous: null,
      applied:  fortnoxName,
      reason:   'auto_populated',
    })
  } else if (fortnoxName && ourName && fortnoxName !== ourName) {
    // Don't auto-overwrite — but surface as divergence.
    result.divergences.push({
      field:         'name',
      our_value:     ourName,
      fortnox_value: fortnoxName,
    })
  }

  // ── city: Fortnox wins only when our value is empty ──────────────
  const fortnoxCity = (info.city ?? '').trim() || null
  const ourCity     = (biz.city ?? '').trim() || null
  if (fortnoxCity && !ourCity) {
    updates.city = fortnoxCity
    result.changes.push({
      field:    'city',
      previous: null,
      applied:  fortnoxCity,
      reason:   'auto_populated',
    })
  } else if (fortnoxCity && ourCity && normaliseCity(fortnoxCity) !== normaliseCity(ourCity)) {
    result.divergences.push({
      field:         'city',
      our_value:     ourCity,
      fortnox_value: fortnoxCity,
    })
  }

  // ── country: same shape ──────────────────────────────────────────
  const fortnoxCountry = (info.country_code ?? '').trim().toUpperCase() || null
  const ourCountry     = (biz.country ?? '').trim().toUpperCase() || null
  if (fortnoxCountry && !ourCountry) {
    updates.country = fortnoxCountry
    result.changes.push({
      field:    'country',
      previous: null,
      applied:  fortnoxCountry,
      reason:   'auto_populated',
    })
  } else if (fortnoxCountry && ourCountry && fortnoxCountry !== ourCountry) {
    result.divergences.push({
      field:         'country',
      our_value:     ourCountry,
      fortnox_value: fortnoxCountry,
    })
  }

  // 5. Apply updates
  if (Object.keys(updates).length > 0) {
    const { error: updErr } = await db.from('businesses').update(updates).eq('id', businessId)
    if (updErr) {
      return { ...result, ok: false, reason: `business_update_failed: ${updErr.message}` }
    }
  }

  // 6. Generate alerts for divergences (high severity for org_number,
  //    medium for name/city since the owner may have intentionally
  //    overridden them).
  for (const div of result.divergences) {
    const severity = div.field === 'org_number' ? 'high' : 'medium'
    const alertType = `business_identity_drift_${div.field}`
    const today = new Date().toISOString().slice(0, 10)

    // Dedupe — skip if same alert already pending for today
    const { data: existing } = await db.from('anomaly_alerts')
      .select('id')
      .eq('business_id', businessId)
      .eq('alert_type', alertType)
      .eq('date', today)
      .contains('metadata', { fortnox_value: div.fortnox_value })
      .maybeSingle()
    if (existing) continue

    const title = div.field === 'org_number'
      ? `Org-nr i Fortnox skiljer sig från CommandCenter`
      : div.field === 'name'
        ? `Företagsnamn i Fortnox skiljer sig från CommandCenter`
        : div.field === 'city'
          ? `Ort i Fortnox skiljer sig från CommandCenter`
          : `${div.field} i Fortnox skiljer sig från CommandCenter`

    const description = div.field === 'org_number'
      ? `Fortnox: ${div.fortnox_value} · CommandCenter: ${div.our_value}. ` +
        `Org-numret är CommandCenter-uppdaterat till Fortnox-värdet. ` +
        `Kontrollera att rätt företag är anslutet via Fortnox OAuth.`
      : `Fortnox: "${div.fortnox_value}" · CommandCenter: "${div.our_value}". ` +
        `Ingen automatisk uppdatering — ägaren kan ha valt ett annat visningsnamn. ` +
        `Bekräfta eller uppdatera i Inställningar → Företagsinfo.`

    const { error: alertErr } = await db.from('anomaly_alerts').insert({
      org_id:        orgId,
      business_id:   businessId,
      alert_type:    alertType,
      severity,
      title,
      description,
      date:          today,
      metadata:      {
        field:         div.field,
        our_value:     div.our_value,
        fortnox_value: div.fortnox_value,
        action:        div.field === 'org_number' ? 'auto_corrected' : 'manual_review',
      },
      is_read:       false,
      is_dismissed:  false,
    })
    if (!alertErr) result.alerts_created += 1
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────

/**
 * Strip Fortnox's "XXXXXX-XXXX" hyphen and any whitespace so two
 * representations of the same org-nr compare equal.
 */
function normaliseOrgNumber(raw: string | null | undefined): string | null {
  if (!raw) return null
  const clean = String(raw).replace(/\D/g, '')
  if (clean.length !== 10) return null
  return clean
}

/**
 * Cities differ on case + whitespace ("Örebro" vs "örebro" vs " Orebro ").
 * Fold for divergence check.
 */
function normaliseCity(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw.trim().toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/\s+/g, ' ')
}
