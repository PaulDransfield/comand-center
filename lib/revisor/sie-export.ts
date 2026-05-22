// lib/revisor/sie-export.ts
//
// SIE 4 file generator. Implements REVISOR-COMPLIANCE-PLAN.md §4.
//
// SIE 4 is the de-facto Swedish accounting interchange format
// (Föreningen SIE-gruppen). Every revisor / accountant in Sweden has a
// tool that imports it (Visma, Capego, Wolters Kluwer Skatt, Hogia,
// Björn Lundén, Fortnox itself). Giving them a SIE file means they
// can verify our numbers in their own workflow — they don't have to
// trust our UI.
//
// CRITICAL ENCODING RULES (do not change without re-testing imports):
//   1. ISO-8859-1 (Latin-1, codepage 437/850/PC8 family) — NOT UTF-8.
//      Swedish å/ä/ö MUST be single Latin-1 bytes (0xE5, 0xE4, 0xF6).
//      Older revisor tools break on UTF-8.
//   2. CRLF line endings (\r\n), never bare \n.
//   3. Strict tag order per the SIE 4 spec (see writeSie4 below).
//   4. Each #VER block's #TRANS lines MUST sum to zero (debet = kredit
//      in Swedish bookkeeping). We assert this at write-time and warn
//      if a voucher doesn't balance — Fortnox should always emit
//      balanced vouchers but defence-in-depth.
//   5. Amounts: decimal POINT (not comma), 2 decimal places, no
//      thousands separator. Negative numbers prefixed with '-'.
//   6. Dates: YYYYMMDD format (no dashes).

import type { FortnoxVoucher, FortnoxVoucherRow } from '@/lib/fortnox/api/vouchers'
import { basAccountDescription }                  from './bas-chart'

// ── Public types ──────────────────────────────────────────────────

export interface SieBusinessHeader {
  organisation_number: string                 // raw 10-digit OR XXXXXX-XXXX
  legal_name:          string                 // legal entity name (not trading name)
  address?:            string | null
  postal_code?:        string | null
  city?:               string | null
  country?:            string | null
}

export interface SieGenInput {
  business:         SieBusinessHeader
  period_year:      number                    // räkenskapsår (fiscal year), typically the calendar year
  period_month:     number                    // 1-12
  vouchers:         FortnoxVoucher[]          // all vouchers for the period, fetched from Fortnox
  generated_by:     string                    // user name / email — appears in #GEN tag
  // Optional: custom account chart from Fortnox /3/accounts. Map of
  // account_number → description. Falls back to BAS 2024 + Fortnox
  // voucher row descriptions when unset.
  custom_chart?:    Record<string, string>
  // Optional: opening balances per account. SIE 4 #IB lines.
  // Map of account_number → opening_balance (kr).
  opening_balances?: Record<string, number>
  // Same for closing balances (#UB).
  closing_balances?: Record<string, number>
}

export interface SieGenResult {
  bytes:           Buffer                     // ISO-8859-1 encoded file content
  filename:        string                     // suggested filename per archival convention
  voucher_count:   number                     // sanity for the response payload
  trans_count:     number
  unbalanced_vouchers: Array<{ series: string; number: number; delta: number }>
  warnings:        string[]
}

// ── Public entrypoint ─────────────────────────────────────────────

export function generateSie4(input: SieGenInput): SieGenResult {
  const lines: string[] = []
  const warnings: string[] = []
  const unbalanced: SieGenResult['unbalanced_vouchers'] = []

  // 1. File header
  lines.push('#FLAGGA 0')
  lines.push(`#PROGRAM ${sieQuote('CommandCenter')} ${sieQuote('1.0')}`)
  lines.push('#FORMAT PC8')
  lines.push(`#GEN ${formatDateYYYYMMDD(new Date())} ${sieQuote(input.generated_by)}`)
  lines.push('#SIETYP 4')

  // 2. Company identity
  lines.push(`#FNAMN ${sieQuote(input.business.legal_name)}`)
  lines.push(`#ORGNR ${normaliseOrgNumber(input.business.organisation_number)}`)
  if (input.business.address || input.business.postal_code || input.business.city) {
    // #ADRESS contact_name address postal_code city
    // SIE 4 requires 4 quoted args; empty quotes for missing fields.
    lines.push([
      '#ADRESS',
      sieQuote(''),                                        // contact name — we don't have one
      sieQuote(input.business.address ?? ''),
      sieQuote([input.business.postal_code, input.business.city].filter(Boolean).join(' ')),
      sieQuote(input.business.city ?? ''),
    ].join(' '))
  }

  // 3. Fiscal year (RAR) — we emit ONE row for the calendar year that
  // contains the requested period. Most Swedish SMEs use calendar
  // fiscal years; the SIE file is still valid if the FY happens to
  // span a different range — the revisor's tool merges it.
  const fyStart = `${input.period_year}-01-01`
  const fyEnd   = `${input.period_year}-12-31`
  lines.push(`#RAR 0 ${formatDateYYYYMMDD(new Date(fyStart))} ${formatDateYYYYMMDD(new Date(fyEnd))}`)
  lines.push(`#TAXAR ${input.period_year}`)
  lines.push('#KPTYP "EUBAS97"')

  // 4. Account chart (#KONTO). Build from:
  //    - All accounts referenced in voucher rows
  //    - + The opening/closing balance keys (if any)
  //    - + Account descriptions: prefer custom_chart (Fortnox /3/accounts),
  //      then BAS 2024 fallback, then "Konto N" placeholder
  const accountsUsed = new Set<string>()
  for (const v of input.vouchers) {
    for (const r of v.VoucherRows ?? []) {
      if (r.Removed) continue
      accountsUsed.add(String(r.Account))
    }
  }
  for (const k of Object.keys(input.opening_balances ?? {})) accountsUsed.add(k)
  for (const k of Object.keys(input.closing_balances ?? {})) accountsUsed.add(k)

  const sortedAccounts = Array.from(accountsUsed).sort((a, b) => Number(a) - Number(b))
  for (const acc of sortedAccounts) {
    const desc = input.custom_chart?.[acc] ?? basAccountDescription(acc)
    lines.push(`#KONTO ${acc} ${sieQuote(desc)}`)
  }

  // 5. Opening + closing balances (#IB / #UB). Period 0 = current FY.
  for (const [acc, amt] of Object.entries(input.opening_balances ?? {})) {
    lines.push(`#IB 0 ${acc} ${formatAmount(amt)}`)
  }
  for (const [acc, amt] of Object.entries(input.closing_balances ?? {})) {
    lines.push(`#UB 0 ${acc} ${formatAmount(amt)}`)
  }

  // 6. Verifications (#VER) with nested #TRANS.
  let transCount = 0
  // Filter vouchers to the requested month. The caller may pass a
  // wider range (e.g. fetched a whole year for efficiency); we trim.
  const monthStart = `${input.period_year}-${String(input.period_month).padStart(2, '0')}-01`
  const monthEndDate = new Date(Date.UTC(input.period_year, input.period_month, 0))
  const monthEnd = monthEndDate.toISOString().slice(0, 10)
  const inPeriod = input.vouchers.filter(v => {
    const d = String(v.TransactionDate ?? '').slice(0, 10)
    return d >= monthStart && d <= monthEnd
  })

  // Sort by series then number for stable output (matches Fortnox UI's ordering).
  inPeriod.sort((a, b) => {
    if (a.VoucherSeries !== b.VoucherSeries) return a.VoucherSeries.localeCompare(b.VoucherSeries)
    return Number(a.VoucherNumber) - Number(b.VoucherNumber)
  })

  for (const v of inPeriod) {
    const rows = (v.VoucherRows ?? []).filter(r => !r.Removed)
    if (rows.length === 0) continue

    // Sanity: balanced check (debits - credits should sum to ~0)
    const sum = rows.reduce((s, r) => s + (Number(r.Debit) || 0) - (Number(r.Credit) || 0), 0)
    if (Math.abs(sum) > 0.005) {
      unbalanced.push({ series: v.VoucherSeries, number: Number(v.VoucherNumber), delta: sum })
    }

    const verDate = formatDateYYYYMMDD(new Date(v.TransactionDate))
    const verDesc = sieQuote(v.Description ?? '')
    lines.push(`#VER ${v.VoucherSeries} ${v.VoucherNumber} ${verDate} ${verDesc}`)
    lines.push('{')
    for (const r of rows) {
      // SIE 4 #TRANS: account, {dimensions}, amount, [date], [description]
      // Amount = Debit - Credit (signed). Empty {} when no dimensions.
      const amt = (Number(r.Debit) || 0) - (Number(r.Credit) || 0)
      const txInfo = (r.TransactionInformation ?? r.Description ?? '').trim()
      const txDate = formatDateYYYYMMDD(new Date(v.TransactionDate))
      const parts  = [
        '   #TRANS',
        String(r.Account),
        '{}',
        formatAmount(amt),
        txDate,
      ]
      if (txInfo) parts.push(sieQuote(txInfo))
      lines.push(parts.join(' '))
      transCount += 1
    }
    lines.push('}')
  }

  // 7. Assemble. CRLF line endings; ISO-8859-1 encoding.
  const text = lines.join('\r\n') + '\r\n'
  const bytes = encodeLatin1(text)

  // 8. Filename per archival convention: ORGNR_PERIOD.se
  const orgNrClean = normaliseOrgNumber(input.business.organisation_number).replace(/-/g, '')
  const safeName = input.business.legal_name.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 40)
  const filename = `${safeName}_${orgNrClean}_${input.period_year}-${String(input.period_month).padStart(2, '0')}.se`

  if (unbalanced.length > 0) {
    warnings.push(`${unbalanced.length} voucher(s) in this period don't balance to zero. Fortnox should never emit these; check the source.`)
  }
  if (inPeriod.length === 0) {
    warnings.push('No vouchers found in the requested period.')
  }

  return {
    bytes,
    filename,
    voucher_count:       inPeriod.length,
    trans_count:         transCount,
    unbalanced_vouchers: unbalanced,
    warnings,
  }
}

// ── Encoding + formatting helpers ─────────────────────────────────

/**
 * SIE 4 string values are wrapped in double quotes. Internal " gets
 * escaped to \" per the spec. Newlines aren't allowed inside quoted
 * strings — we strip them.
 */
function sieQuote(s: string | null | undefined): string {
  const cleaned = String(s ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
  return `"${cleaned}"`
}

/**
 * Format an org-nr as Fortnox's canonical SSSSSS-NNNN form. SIE 4
 * accepts both, but consumer tools tend to prefer the hyphenated form.
 */
function normaliseOrgNumber(raw: string): string {
  const clean = String(raw).replace(/\D/g, '')
  if (clean.length === 10) {
    return `${clean.slice(0, 6)}-${clean.slice(6)}`
  }
  return raw
}

function formatDateYYYYMMDD(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function formatAmount(n: number): string {
  // SIE 4 uses decimal point, max 2 decimals, no thousands separator.
  // toFixed(2) handles both rounding and the decimal point.
  if (!Number.isFinite(n)) return '0.00'
  return Number(n).toFixed(2)
}

/**
 * Encode a JS string into ISO-8859-1 (Latin-1) bytes. Node's
 * Buffer.from(str, 'latin1') does this by truncating each codepoint
 * to a single byte — works for Swedish å (0xE5), ä (0xE4), ö (0xF6),
 * Å (0xC5), Ä (0xC4), Ö (0xD6). Codepoints > 255 (rare in Swedish
 * bookkeeping data — would be e.g. emoji in a voucher description)
 * get truncated to garbage; we replace them with '?' first to keep
 * the file valid.
 */
function encodeLatin1(text: string): Buffer {
  const safe = text.replace(/[^ -ÿ]/g, '?')
  return Buffer.from(safe, 'latin1')
}
