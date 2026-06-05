// lib/inventory/unaccent.ts
//
// Diacritic-insensitive search helper. Mirrors the SQL
// `lower(f_unaccent(...))` used by the M131 generated columns
// (`products.name_unaccent`, `supplier_invoice_lines.raw_description_unaccent`).
//
// Pattern: query side normalises in JS, data side normalises in Postgres,
// both produce the same form so `.ilike('name_unaccent', '%${unaccent(q)}%')`
// matches accented stored values with un-accented queries (and vice versa).
//
// Decomposes via NFD then strips Unicode combining marks (U+0300–U+036F).
// "café" → "cafe", "crème" → "creme", "naïve" → "naive", "smörgås" → "smorgas".
// Idempotent — already-stripped input is unchanged.

const COMBINING_MARKS_RE = /[̀-ͯ]/g

export function unaccent(s: string | null | undefined): string {
  if (!s) return ''
  return String(s).normalize('NFD').replace(COMBINING_MARKS_RE, '').toLowerCase()
}
