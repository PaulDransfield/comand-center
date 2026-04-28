// lib/overheads/normalise.ts
//
// Normalises a Fortnox line label into the lookup key used by
// overhead_classifications.supplier_name_normalised. Lowercases, strips
// company-form suffixes (AB, Ltd, Oy, …), drops punctuation, collapses
// whitespace.
//
// "Supplier" in this codebase = Fortnox P&L line label, not literal
// vendor company. The names line up because Fortnox lines are
// account-coded ("Konsultarvoden", "Hyra", "Marknadsföring") which is
// the right granularity for owner decisions ("essential as a category"),
// and the column name `supplier_name_normalised` is just our internal
// term for that lookup key.
//
// Idempotent: normaliseSupplier(normaliseSupplier(x)) === normaliseSupplier(x).

const COMPANY_SUFFIX_RX = /\s+(ab|aktiebolag|ltd|limited|inc|incorporated|oy|gmbh|srl|kommanditbolag|kb|hb|handelsbolag)\b/gi

export function normaliseSupplier(raw: string | null | undefined): string {
  if (!raw) return ''
  return String(raw)
    .toLowerCase()
    .trim()
    .replace(COMPANY_SUFFIX_RX, '')      // strip company suffixes
    .replace(/[^\w\sÅÄÖåäö]/g, ' ')      // drop punctuation, KEEP Swedish chars
    .replace(/\s+/g, ' ')                 // collapse whitespace
    .trim()
}

// Pick the best display label for a tracker_line_items row. Prefers
// label_sv (Swedish, what the owner sees in Fortnox), falls back to
// label_en, then to a synthetic "account-XXXX" so flags never have empty
// names even on misclassified rows.
export function pickDisplayLabel(line: {
  label_sv?:        string | null
  label_en?:        string | null
  fortnox_account?: string | number | null
}): string {
  const sv = String(line.label_sv ?? '').trim()
  if (sv) return sv
  const en = String(line.label_en ?? '').trim()
  if (en) return en
  const acc = line.fortnox_account != null ? String(line.fortnox_account) : '?'
  return `account-${acc}`
}
