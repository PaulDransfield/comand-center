// lib/sweden/orgnr.ts
//
// Swedish organisationsnummer (org-nr) — validation, normalisation, formatting.
//
// Format: 10 digits, optionally with a dash before the last 4 (XXXXXX-XXXX).
// First 6 digits encode the entity type / birth date for sole proprietors.
// Last digit is a checksum (Luhn variant — multiply digits 1-9 alternately
// by 2 and 1, sum the digit-of-each-product, then `(10 - sum mod 10) mod 10`
// gives the check digit).
//
// References:
//   https://www.skatteverket.se/  (Skatteverket — Swedish Tax Agency)
//   https://en.wikipedia.org/wiki/Personal_identity_number_(Sweden)
//
// Storage convention (matches M042 CHECK):
//   - DB stores the 10 digits with no dashes (`5566778899`)
//   - UI renders with a dash (`556677-8899`)
//   - Caller normalises on input via `normaliseOrgNr()`

/**
 * Strip non-digits. Keeps only 0-9.
 * "556677-8899" → "5566778899"
 * "  556677 8899" → "5566778899"
 */
export function normaliseOrgNr(raw: string | null | undefined): string {
  if (!raw) return ''
  return String(raw).replace(/\D/g, '')
}

/**
 * Render the 10-digit form as `XXXXXX-XXXX`. Returns the input unchanged
 * if it's not exactly 10 digits — display safety on bad data.
 */
export function formatOrgNr(raw: string | null | undefined): string {
  const norm = normaliseOrgNr(raw)
  if (norm.length !== 10) return raw ? String(raw) : ''
  return `${norm.slice(0, 6)}-${norm.slice(6)}`
}

/**
 * Validate the checksum. Returns true if the org-nr is structurally
 * valid AND the check digit matches.
 *
 * Algorithm (Luhn variant for Swedish 10-digit identifiers):
 *   - Multiply position 0,2,4,6,8 by 2; position 1,3,5,7 by 1.
 *   - For each product, sum its digits (e.g. 2×8 = 16 → 1+6 = 7).
 *   - Sum all those digit-sums for positions 0-8.
 *   - Check digit = (10 - (sum % 10)) % 10.
 *   - Compare to the actual digit at position 9.
 */
export function isValidOrgNrChecksum(raw: string | null | undefined): boolean {
  const norm = normaliseOrgNr(raw)
  if (norm.length !== 10) return false
  if (!/^\d{10}$/.test(norm)) return false

  let sum = 0
  for (let i = 0; i < 9; i++) {
    const digit = Number(norm[i])
    const product = digit * (i % 2 === 0 ? 2 : 1)
    // Sum the digits of the product (handles two-digit products like 16 → 7).
    sum += product >= 10 ? Math.floor(product / 10) + (product % 10) : product
  }
  const expected = (10 - (sum % 10)) % 10
  return expected === Number(norm[9])
}

/**
 * Full validation chain. Returns { ok: true } when input passes; otherwise
 * { ok: false, error: '<human-readable reason>' } so callers can surface
 * the right message inline.
 */
export type OrgNrValidationResult =
  | { ok: true;  value: string }      // value is the normalised 10-digit form
  | { ok: false; error: string }

export function validateOrgNr(raw: string | null | undefined): OrgNrValidationResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'Organisationsnummer is required.' }
  }
  const norm = normaliseOrgNr(raw)
  if (norm.length === 0) {
    return { ok: false, error: 'Enter a 10-digit organisationsnummer.' }
  }
  if (norm.length !== 10) {
    return { ok: false, error: `Organisationsnummer must be 10 digits (got ${norm.length}).` }
  }
  if (!/^\d{10}$/.test(norm)) {
    return { ok: false, error: 'Organisationsnummer must contain only digits.' }
  }
  if (!isValidOrgNrChecksum(norm)) {
    return { ok: false, error: 'Checksum failed — please double-check the number.' }
  }
  return { ok: true, value: norm }
}

// ─── Self-tests (kept inline as comments — copy into a unit test file later) ──
// Known valid (real public-record AB):
//   normaliseOrgNr('556036-0793') === '5560360793'
//   formatOrgNr('5560360793') === '556036-0793'
//   isValidOrgNrChecksum('5560360793') === true
//   validateOrgNr('556036-0793') → { ok: true, value: '5560360793' }
//
// Known invalid:
//   isValidOrgNrChecksum('5566778899') === false  (random digits)
//   validateOrgNr('123') → { ok: false, error: 'must be 10 digits' }
//   validateOrgNr('') → { ok: false, error: 'is required' }
