// lib/inventory/normalise.ts
//
// The bedrock function for the matching ladder in
// INVENTORY-CATALOGUE-PLAN.md §3. Same input → same output, always.
// Called by both the ingestion path (lib/inventory/matcher.ts) and
// later by the UI's catalogue search box, so changing this without a
// re-normalisation migration silently corrupts the unique index on
// (business_id, supplier_fortnox_number, normalised_description, unit).
//
// Deliberate quirks (documented for the next person who's tempted to
// "simplify" them):
//
//   1. We do NOT strip numbers. "Lavazza 1kg" and "Lavazza 500g" are
//      different products and must score below the 0.80 threshold.
//
//   2. We DO collapse the space between a number and its unit suffix
//      ("5 kg" → "5kg") so spacing variants don't cost similarity
//      points on otherwise-identical descriptions.
//
//   3. We do NOT stem. Swedish stemmers add false positives more often
//      than they help on short product descriptions.
//
//   4. We fold åäö → aao for trigram robustness. Half of Swedish food
//      products have at least one of these characters and ASCII-folded
//      trigrams cluster much better than the multi-byte originals.

const UNIT_SUFFIX_RE = /(\d+)\s+(st|kg|hg|g|l|cl|ml|dl|pack|frp|fp|paket|liter|kilo|gram)\b/gi

export function normaliseDescription(raw: string | null | undefined): string {
  if (!raw) return ''

  return raw
    .toLowerCase()
    .replace(/å/g, 'a')
    .replace(/ä/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[éè]/g, 'e')
    .replace(/[^\w\s]/g, ' ')              // strip punctuation
    .replace(UNIT_SUFFIX_RE, (_, n, u) => `${n}${u.toLowerCase()}`)
    .replace(/\s+/g, ' ')                  // collapse whitespace
    .trim()
}

// ── Product-name normalisation ────────────────────────────────────────
//
// Stricter than `normaliseDescription` — strips trailing attribute
// annotations that get appended to product names from MS invoice
// descriptions but aren't load-bearing for identity. Used by the
// `POST /api/inventory/items` dedupe ladder to detect cases like:
//
//   "HARICOTS VERTS 2,5KG, Nyckelhål;"        (noise: ", Nyckelhål;")
//   "Hjortytterfile 1,1-1,8kg Ursprungsland:Nya Zeeland"  (noise: country tail)
//   "Tortilla Wrap 28cm 110g/1,1kg, Från Sverige"          (noise: origin tail)
//
// where two product names refer to the same SKU but byte-equal lookup
// can't see it. We keep pack hints like "(2/fp)" and unit suffixes —
// "1kg" vs "500g" stay distinct.

// Trailing attribute clauses we treat as noise. Order matters — apply
// before whitespace collapse.
const NOISE_TAILS = [
  /,?\s*nyckelhål\s*;?\s*$/i,
  /,?\s*från\s+sverige\s*;?\s*$/i,
  /,?\s*ursprungsland\s*:\s*[^,;()]+;?\s*$/i,
  /,?\s*eu-?ekologisk\s*;?\s*$/i,
  /,?\s*krav\s*;?\s*$/i,
  /,?\s*svensk\s+fågel\s*;?\s*$/i,
  /,?\s*msc\s*;?\s*$/i,            // careful: leaves "MSC" mid-name alone
  /,?\s*kött\s+fr\s+sverige\s*;?\s*$/i,
  /\(\s*sverige\s*\)\s*$/i,
]

export function normaliseProductName(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = raw

  // Strip known noise tails iteratively until none apply. Multiple
  // annotations can chain: "X, Nyckelhål; EU-ekologisk".
  let changed = true
  while (changed) {
    changed = false
    for (const re of NOISE_TAILS) {
      const next = s.replace(re, '')
      if (next !== s) { s = next; changed = true }
    }
  }

  // Now apply the description-style normalisation (lowercase, fold,
  // strip punctuation, collapse, etc.).
  return normaliseDescription(s)
}

// ── Token overlap (Jaccard) — used for similarity matching ────────────
//
// Tokens are >1-letter words from `normaliseProductName(s)`. Returns
// 0..1. Used by the find-or-create endpoint to surface "did you mean X?"
// candidates.

export function tokenise(name: string): Set<string> {
  return new Set(
    normaliseProductName(name)
      .split(/\s+/)
      .filter(t => t.length > 1)
  )
}

export function jaccardSimilarity(a: string, b: string): number {
  const A = tokenise(a)
  const B = tokenise(b)
  if (A.size === 0 || B.size === 0) return 0
  let intersection = 0
  for (const t of A) if (B.has(t)) intersection++
  return intersection / (A.size + B.size - intersection)
}
