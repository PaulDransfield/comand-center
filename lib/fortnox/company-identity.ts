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

type IdentityField = 'org_number' | 'name' | 'legal_name' | 'city' | 'legal_city' | 'country' | 'address'

interface FieldChange {
  field:        IdentityField
  previous:     string | null
  applied:      string | null
  reason:       'auto_populated' | 'fortnox_wins'
}

interface FieldDivergence {
  field:        IdentityField
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
    .select('id, name, org_number, city, country, legal_name, legal_city, address')
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

  // ── legal_name: Fortnox ALWAYS wins (this is the LEGAL entity name,
  //     used by the revisor surface + SIE export + every archival doc).
  //     The "Aglianico i Örebro AB" vs "Chicce Slotsgatan" case is the
  //     standard Swedish AB pattern — both are correct, they answer
  //     different questions. So we silently keep legal_name in sync
  //     with Fortnox and only ALERT if legal_name was non-empty AND
  //     diverged (which would mean Fortnox now points at a different
  //     legal entity — re-OAuth-to-wrong-company case).
  const fortnoxName  = (info.name ?? '').trim() || null
  const ourLegalName = (biz.legal_name ?? '').trim() || null
  if (fortnoxName && fortnoxName !== ourLegalName) {
    updates.legal_name = fortnoxName
    if (ourLegalName) {
      // We had a legal_name; Fortnox now disagrees. This is suspicious
      // (likely a re-OAuth to the wrong company). Surface as alert.
      result.divergences.push({
        field:         'legal_name',
        our_value:     ourLegalName,
        fortnox_value: fortnoxName,
      })
    }
    result.changes.push({
      field:    'legal_name',
      previous: ourLegalName,
      applied:  fortnoxName,
      reason:   ourLegalName ? 'fortnox_wins' : 'auto_populated',
    })
  }

  // ── name: stays owner-controlled. Backfill ONLY when both name AND
  //     legal_name are empty (first-time onboarding before owner had
  //     a chance to set a display name). After that, Fortnox != name
  //     is the expected dual-identity case — no alert, no action.
  const ourName = (biz.name ?? '').trim() || null
  if (fortnoxName && !ourName && !ourLegalName) {
    updates.name = fortnoxName
    result.changes.push({
      field:    'name',
      previous: null,
      applied:  fortnoxName,
      reason:   'auto_populated',
    })
  }

  // ── legal_city: same shape as legal_name ────────────────────────
  const fortnoxCity   = (info.city ?? '').trim() || null
  const ourLegalCity  = (biz.legal_city ?? '').trim() || null
  if (fortnoxCity && fortnoxCity !== ourLegalCity) {
    updates.legal_city = fortnoxCity
    if (ourLegalCity && normaliseCity(fortnoxCity) !== normaliseCity(ourLegalCity)) {
      result.divergences.push({
        field:         'legal_city',
        our_value:     ourLegalCity,
        fortnox_value: fortnoxCity,
      })
    }
    result.changes.push({
      field:    'legal_city',
      previous: ourLegalCity,
      applied:  fortnoxCity,
      reason:   ourLegalCity ? 'fortnox_wins' : 'auto_populated',
    })
  }

  // ── city: owner-controlled display value. Backfill only when both
  //     city and legal_city are empty.
  const ourCity = (biz.city ?? '').trim() || null
  if (fortnoxCity && !ourCity && !ourLegalCity) {
    updates.city = fortnoxCity
    result.changes.push({
      field:    'city',
      previous: null,
      applied:  fortnoxCity,
      reason:   'auto_populated',
    })
  }

  // ── address: owner-controlled display value. Backfill only when ours is
  //     empty (first-time onboarding prefill); never overwrite an address the
  //     owner already entered. Folds in the zip code since we have no zip column.
  const fortnoxAddress = (info.address ?? '').trim() || null
  const ourAddress     = (biz.address ?? '').trim() || null
  if (fortnoxAddress && !ourAddress) {
    const zip = (info.zip_code ?? '').trim()
    const composed = zip ? `${fortnoxAddress}, ${zip}` : fortnoxAddress
    updates.address = composed
    result.changes.push({ field: 'address', previous: null, applied: composed, reason: 'auto_populated' })
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

  // 6. Generate alerts for divergences. After M079:
  //    - 'org_number'  → high severity. Auto-corrected to Fortnox value.
  //    - 'legal_name'  → high severity. Means Fortnox now points at a
  //                      different legal entity than before — re-OAuth-
  //                      to-wrong-company scenario. Suspicious.
  //    - 'legal_city'  → medium severity. Probably an address update.
  //    - 'name'/'city' → NEVER reach this loop after M079 (dual-identity
  //                      case is silent). Defensive default kept.
  for (const div of result.divergences) {
    const severity = (div.field === 'org_number' || div.field === 'legal_name')
      ? 'high'
      : 'medium'
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
      ? 'Org-nr i Fortnox skiljer sig från CommandCenter'
      : div.field === 'legal_name'
        ? 'Företagsnamn (juridiskt) i Fortnox skiljer sig från tidigare'
        : div.field === 'legal_city'
          ? 'Registrerad ort i Fortnox skiljer sig från tidigare'
          : `${div.field} i Fortnox skiljer sig från CommandCenter`

    const description = div.field === 'org_number'
      ? `Fortnox: ${div.fortnox_value} · CommandCenter (gammalt värde): ${div.our_value}. ` +
        `Org-numret är auto-uppdaterat till Fortnox-värdet. ` +
        `Kontrollera att rätt företag är anslutet via Fortnox OAuth — ett annat org-nr betyder antingen byte av juridiskt företag eller felkopplad OAuth.`
      : div.field === 'legal_name'
        ? `Fortnox: "${div.fortnox_value}" · CommandCenter (gammalt värde): "${div.our_value}". ` +
          `Det juridiska företagsnamnet har ändrats sedan tidigare sync — kan vara namnbyte hos Bolagsverket eller felkopplad OAuth. ` +
          `Värdet är auto-uppdaterat; bekräfta att rätt företag är anslutet.`
        : `Fortnox: "${div.fortnox_value}" · CommandCenter: "${div.our_value}". ` +
          `Värdet är auto-uppdaterat till Fortnox-värdet.`

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
        action:        'auto_corrected',
      },
      is_read:       false,
      is_dismissed:  false,
    })
    if (alertErr) {
      console.warn('[fortnox/company-identity] alert insert failed:', alertErr.message)
    } else {
      result.alerts_created += 1
    }
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
