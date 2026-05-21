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
