// lib/fortnox/classify.ts
//
// Shared Fortnox line-item classifiers. Used by both the deterministic
// resultatrapport-parser AND the AI extract-worker so the rules stay
// consistent across extraction paths.
//
// Three classifiers, applied in priority order at the call site:
//   1. classifyByAccount  — BAS account number → category (authoritative)
//   2. classifyLabel      — Swedish label keyword → category + subcategory
//   3. classifyByVat      — Swedish VAT rate in label → revenue subset
//
// Mirror of the maps that used to live inline in extract-worker. The
// parser doesn't have an LLM to fall back on, so the rule-based classifiers
// are load-bearing for it.

// ── Swedish label → category + subcategory ──────────────────────────────────
const SV_SUB = new Map<string, { category: string; subcategory: string }>([
  ['försäljning',             { category: 'revenue', subcategory: 'food' }],
  ['försäljning livsmedel',   { category: 'revenue', subcategory: 'food' }],
  ['försäljning dryck',       { category: 'revenue', subcategory: 'beverage' }],
  ['försäljning alkohol',     { category: 'revenue', subcategory: 'alcohol' }],
  ['övriga intäkter',         { category: 'revenue', subcategory: 'other' }],
  ['råvaror',                    { category: 'food_cost', subcategory: 'raw_materials' }],
  ['råvaror och förnödenheter',  { category: 'food_cost', subcategory: 'raw_materials' }],
  ['handelsvaror',               { category: 'food_cost', subcategory: 'goods_for_resale' }],
  ['varuinköp',                  { category: 'food_cost', subcategory: 'goods' }],
  ['inköp varor',                { category: 'food_cost', subcategory: 'goods' }],
  ['inköp material och varor',   { category: 'food_cost', subcategory: 'goods' }],
  ['inköp av material och varor',{ category: 'food_cost', subcategory: 'goods' }],
  ['inköp livsmedel',            { category: 'food_cost', subcategory: 'food' }],
  ['inköp av livsmedel',         { category: 'food_cost', subcategory: 'food' }],
  ['livsmedel',                  { category: 'food_cost', subcategory: 'food' }],
  ['livsmedelsinköp',            { category: 'food_cost', subcategory: 'food' }],
  ['drycker',                    { category: 'food_cost', subcategory: 'beverages' }],
  ['dryckesinköp',               { category: 'food_cost', subcategory: 'beverages' }],
  ['kostnad sålda varor',        { category: 'food_cost', subcategory: 'cogs' }],
  ['kostnader för sålda varor',  { category: 'food_cost', subcategory: 'cogs' }],
  ['kostnad för sålda varor',    { category: 'food_cost', subcategory: 'cogs' }],
  ['personalkostnader',       { category: 'staff_cost', subcategory: 'salaries' }],
  ['löner',                   { category: 'staff_cost', subcategory: 'salaries' }],
  ['sociala avgifter',        { category: 'staff_cost', subcategory: 'payroll_tax' }],
  ['arbetsgivaravgifter',     { category: 'staff_cost', subcategory: 'payroll_tax' }],
  ['pensionskostnader',       { category: 'staff_cost', subcategory: 'pension' }],
  ['lokalhyra',               { category: 'other_cost', subcategory: 'rent' }],
  ['lokalkostnader',          { category: 'other_cost', subcategory: 'rent' }],
  ['el',                      { category: 'other_cost', subcategory: 'utilities' }],
  ['värme',                   { category: 'other_cost', subcategory: 'utilities' }],
  ['energikostnader',         { category: 'other_cost', subcategory: 'utilities' }],
  ['vatten',                  { category: 'other_cost', subcategory: 'utilities' }],
  ['städning',                { category: 'other_cost', subcategory: 'cleaning' }],
  ['reparationer',            { category: 'other_cost', subcategory: 'repairs' }],
  ['förbrukningsinventarier', { category: 'other_cost', subcategory: 'consumables' }],
  ['kontorsmaterial',         { category: 'other_cost', subcategory: 'office_supplies' }],
  ['telefon',                 { category: 'other_cost', subcategory: 'telecom' }],
  ['internet',                { category: 'other_cost', subcategory: 'telecom' }],
  ['porto',                   { category: 'other_cost', subcategory: 'postage' }],
  ['datorkostnader',          { category: 'other_cost', subcategory: 'software' }],
  ['programvaror',            { category: 'other_cost', subcategory: 'software' }],
  ['it-kostnader',            { category: 'other_cost', subcategory: 'software' }],
  ['reklam',                  { category: 'other_cost', subcategory: 'marketing' }],
  ['marknadsföring',          { category: 'other_cost', subcategory: 'marketing' }],
  ['representation',          { category: 'other_cost', subcategory: 'entertainment' }],
  ['bankavgifter',            { category: 'other_cost', subcategory: 'bank_fees' }],
  ['konsultarvoden',          { category: 'other_cost', subcategory: 'consulting' }],
  ['redovisning',             { category: 'other_cost', subcategory: 'accounting' }],
  ['revisorsarvoden',         { category: 'other_cost', subcategory: 'audit' }],
  ['försäkringar',            { category: 'other_cost', subcategory: 'insurance' }],
  ['frakter',                 { category: 'other_cost', subcategory: 'shipping' }],
  ['bilkostnader',            { category: 'other_cost', subcategory: 'vehicles' }],
  ['övriga externa kostnader',{ category: 'other_cost', subcategory: 'other' }],
  ['avskrivningar',           { category: 'depreciation', subcategory: 'depreciation' }],
  ['räntekostnader',          { category: 'financial', subcategory: 'interest' }],
  ['ränteintäkter',           { category: 'financial', subcategory: 'interest_income' }],
  ['finansiella poster',      { category: 'financial', subcategory: 'other' }],
])

export function classifyLabel(label: string): { category: string; subcategory: string | null } {
  const key = String(label ?? '').trim().toLowerCase()
  if (SV_SUB.has(key)) return SV_SUB.get(key)!
  for (const [k, v] of SV_SUB.entries()) if (key.includes(k)) return v
  return { category: 'other_cost', subcategory: null }
}

// ── Swedish BAS chart-of-accounts → category ────────────────────────────────
// Account number is the ONLY authoritative classifier on a Fortnox P&L.
// Label-based lookup is fallback.
export function classifyByAccount(acct: number | null): { category: string; subcategory: string | null } | null {
  if (acct == null || !Number.isFinite(acct)) return null
  if (acct >= 3000 && acct <= 3999) return { category: 'revenue',      subcategory: null }
  if (acct >= 4000 && acct <= 4999) return { category: 'food_cost',    subcategory: 'goods' }
  if (acct >= 5000 && acct <= 6999) return { category: 'other_cost',   subcategory: null }
  if (acct >= 7000 && acct <= 7999) return { category: 'staff_cost',   subcategory: null }
  if (acct >= 8900 && acct <= 8999) return { category: 'depreciation', subcategory: 'depreciation' }
  if (acct >= 8000 && acct <= 8899) return { category: 'financial',    subcategory: 'other' }
  return null
}

// ── VAT-rate-based subcategory (revenue + food_cost lines only) ─────────────
// Swedish restaurant VAT rates encode product/service classification:
//   25 % moms → alcohol & non-food drinks
//   12 % moms → dine-in food
//    6 % moms → takeaway food (Wolt, Foodora, Uber Eats)
// Platform names also map to takeaway when the VAT suffix is missing.
export function classifyByVat(label: string): { subcategory: string | null } | null {
  const key = String(label ?? '').trim().toLowerCase()
  if (/\b25\s*%?\s*moms\b/.test(key))  return { subcategory: 'alcohol' }
  if (/\b12\s*%?\s*moms\b/.test(key))  return { subcategory: 'food' }
  if (/\b6\s*%?\s*moms\b/.test(key))   return { subcategory: 'takeaway' }
  if (/\b(wolt|foodora|uber\s*eats)\b/.test(key)) return { subcategory: 'takeaway' }
  // Label-keyword fallback: cost-side line "Inköp av varor och material
  // alkohol" (account 4011) doesn't carry a VAT % in the label, but the
  // word "alkohol" (or vin/öl/sprit/cider/whisky/dryck) is unambiguous.
  // Without this the alcohol_cost rollup ends up at 0 for any business
  // whose Fortnox uses dedicated alcohol-purchase accounts.
  if (/\b(alkohol|vin|öl|sprit|cider|whisky|dryck)/i.test(key)) return { subcategory: 'alcohol' }
  return null
}
