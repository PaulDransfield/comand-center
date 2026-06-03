// lib/inventory/pack-from-supplier-article.ts
//
// Deterministic translation from a supplier_articles row → (pack_size,
// base_unit). One source of truth for the supplier-catalogue derivation
// rule. Reused by:
//
//   - scripts/diag/promote-supplier-weights-v2.mjs (backfill existing
//     products en masse)
//   - lib/inventory/matcher.ts createProductFromLine (new products
//     created from supplier invoices get correct pack info at birth)
//   - lib/inventory/recipe-cost.ts (last-mile fallback when a product
//     has no pack_size but the matched supplier_article does)
//
// The MS scraper captures:
//   - unit                 — the BUY unit (KRT, DUNK, ST, KG, PKT…)
//   - net_weight_g         — total weight of ONE buy unit
//   - units_per_pack       — the numeric part of the label
//   - units_per_pack_label — human label like "5,00 kg/Dunk", "12 st/Kartong",
//                            "0,70 l/Styck", "Viktvara"
//   - official_name        — name as MS publishes (often has "30p", "5x3kg", etc.)
//
// LABEL is the load-bearing discriminator. Decision order (highest
// specificity first):
//
//   1. COUNT CARTON      — label "N st/..."           → pack=N, base='st'
//   2. VOLUME (LABEL)    — label "X l/..." / "cl/" / "ml/" → pack in ml
//   3. VOLUME (NAME)     — name has clean volume token (no label)
//   4. VIKTVARA          — label "Viktvara" (sold by weight)
//   5. WEIGHT CONTAINER  — unit is single-container OR label "X kg/Styck"
//   6. MULTI-PACK COUNT  — unit=KRT, label "X kg/Kartong", name parses Np
//   7. SKIP              — none of the above
//
// Each branch returns a `confidence` token ('high' | 'medium' | 'low').

export interface SupplierArticleRow {
  unit:                  string | null
  net_weight_g:          number | null
  units_per_pack:        number | null
  units_per_pack_label:  string | null
  official_name:         string | null
}

export type PackBaseUnit = 'g' | 'ml' | 'st'

export type PackDecisionKind =
  | 'count_carton'
  | 'volume_from_label'
  | 'volume_from_name'
  | 'viktvara'
  | 'single_container_weight'
  | 'multi_pack_count'

export type PackDecision =
  | {
      kind:        PackDecisionKind
      pack_size:   number
      base_unit:   PackBaseUnit
      confidence:  'high' | 'medium' | 'low'
      notes:       string
    }
  | { kind: 'skip'; reason: string }

const SINGLE_WEIGHT_UNITS = new Set(['DUNK', 'BURK', 'HINK', 'PKT', 'FRP', 'PÅSE', 'PASE', 'SÄCK', 'SACK', 'IFRP', 'KG', 'ASK', 'BACK'])

function toUpper(u: string | null | undefined): string {
  return (u ?? '').trim().toUpperCase()
}

/** Match "X l/...", "X cl/...", "X ml/..." labels and return ml + units. */
function parseVolumeLabel(label: string): { ml: number } | null {
  // "0,70 l/Styck", "1,00 l/Kartong", "10,00 l/Dunk"
  let m = label.match(/^(\d+(?:[.,]\d+)?)\s*l\s*\//i)
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.')) * 1000) }
  m = label.match(/^(\d+(?:[.,]\d+)?)\s*cl\s*\//i)
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.')) * 10) }
  m = label.match(/^(\d+(?:[.,]\d+)?)\s*ml\s*\//i)
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.'))) }
  return null
}

function parseVolumeName(name: string): { ml: number; matched: string } | null {
  const trimmed = name.trim()
  let m = trimmed.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*l\b/i)
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.')) * 1000), matched: m[0] }
  m = trimmed.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*cl\b/i)
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.')) * 10),   matched: m[0] }
  m = trimmed.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*ml\b/i)
  if (m) return { ml: Math.round(Number(m[1].replace(',', '.'))),        matched: m[0] }
  return null
}

function parseNPackFromName(name: string): { n: number; matched: string } | null {
  const m = name.match(/(?<![\d,.])(\d+)\s*(?:p|p\.|-pack|st)\b/i)
  if (m) return { n: parseInt(m[1], 10), matched: m[0] }
  return null
}

/** Match patterns like "150x27g" → 150 items of 27g each. Returns the
 *  COUNT (left side). Distinct from `Np` (sub-pack count) because there
 *  are NO sub-packs — everything is loose in one KRT.
 */
function parseDirectCountFromName(name: string): { n: number; perItemG: number; matched: string } | null {
  const m = name.match(/(?<![\d,.])(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(g|kg)\b/i)
  if (!m) return null
  const n = parseInt(m[1], 10)
  const num = Number(m[2].replace(',', '.'))
  const perItemG = m[3].toLowerCase() === 'kg' ? Math.round(num * 1000) : Math.round(num)
  if (n <= 0 || n > 10000 || perItemG <= 0) return null
  return { n, perItemG, matched: m[0] }
}

function parsePerPackWeightG(name: string): number | null {
  let m = name.match(/(\d+(?:[.,]\d+)?)\s*kg\b/i)
  if (m) return Math.round(Number(m[1].replace(',', '.')) * 1000)
  m = name.match(/(\d+(?:[.,]\d+)?)\s*g\b/i)
  if (m) return Math.round(Number(m[1].replace(',', '.')))
  return null
}

/**
 * Translate a supplier_articles row into a pack-size decision.
 *
 * The decision order matters: more-specific patterns win because they
 * disambiguate. E.g. "Monin 70cl" with label "0,70 l/Styck" is volume
 * (Branch 2), not weight (Branch 5) — even though net_weight_g is set,
 * the LABEL explicitly says litres.
 */
export function packFromSupplierArticle(row: SupplierArticleRow): PackDecision {
  const unit       = toUpper(row.unit)
  const label      = (row.units_per_pack_label ?? '').trim()
  const labelLower = label.toLowerCase()
  const netG       = row.net_weight_g != null ? Number(row.net_weight_g) : null
  const name       = (row.official_name ?? '').trim()

  // BRANCH 1 — count carton (label leads "N st/...")
  if (/^\d[\d.,]*\s*st\s*\//i.test(labelLower) && Number.isFinite(Number(row.units_per_pack)) && Number(row.units_per_pack) > 0) {
    const n = Math.round(Number(row.units_per_pack))
    return {
      kind: 'count_carton', pack_size: n, base_unit: 'st', confidence: 'high',
      notes: `Label "${label}" → ${n} pieces per buy unit`,
    }
  }

  // BRANCH 2 — volume from label (highest priority for liquids)
  // Label "0,70 l/Styck" or "10,00 l/Dunk" → the buy unit IS a single
  // bottle/dunk of N litres. Trumps weight branch.
  const volLabel = parseVolumeLabel(label)
  if (volLabel && unit !== 'KRT' && unit !== 'BACK') {
    return {
      kind: 'volume_from_label', pack_size: volLabel.ml, base_unit: 'ml', confidence: 'high',
      notes: `Label "${label}" → ${volLabel.ml} ml per buy unit`,
    }
  }

  // BRANCH 3 — volume from name (only when label didn't disambiguate)
  if (unit !== 'KRT' && unit !== 'BACK') {
    const volName = parseVolumeName(name)
    if (volName) {
      return {
        kind: 'volume_from_name', pack_size: volName.ml, base_unit: 'ml', confidence: 'high',
        notes: `Volume "${volName.matched}" from name → ${volName.ml} ml`,
      }
    }
  }

  // BRANCH 4 — Viktvara (sold by weight, no per-unit weight)
  // "Viktvara" labels mean the customer pays per kg; pack=1000g.
  if (/^\s*viktvara\s*$/i.test(label) && unit === 'KG') {
    return {
      kind: 'viktvara', pack_size: 1000, base_unit: 'g', confidence: 'high',
      notes: `Label "Viktvara" with unit=KG → 1000 g (1 kg)`,
    }
  }

  // BRANCH 5 — single-container weight (only when not volume)
  if (netG != null && netG > 0 && (SINGLE_WEIGHT_UNITS.has(unit) || (unit === 'ST' && /\/styck/i.test(labelLower)))) {
    return {
      kind: 'single_container_weight', pack_size: netG, base_unit: 'g', confidence: 'high',
      notes: `Unit=${unit} treated as single container, net_weight=${netG}g`,
    }
  }

  // BRANCH 6 — multi-pack count carton (eggs / mini-brioche etc.)
  // When `net_weight_g` is missing (the scraper didn't capture it for
  // some articles), fall back to deriving it from a "X kg/Kartong" label.
  // units_per_pack carries the numeric portion, so 4.05 + label "kg/X" = 4050g.
  let effectiveNetG = netG
  if ((effectiveNetG == null || effectiveNetG <= 0) && unit === 'KRT' && /^(\d+(?:[.,]\d+)?)\s*kg\s*\//i.test(label)) {
    const m = label.match(/^(\d+(?:[.,]\d+)?)\s*kg\s*\//i)
    if (m) effectiveNetG = Math.round(Number(m[1].replace(',', '.')) * 1000)
  }
  if (unit === 'KRT' && effectiveNetG != null && effectiveNetG > 0 && /\/kartong/i.test(labelLower)) {
    // 6a — Direct-count pattern "NxYg" (Mini brioche roll 150x27g):
    // 150 pieces of 27g each, no sub-packs. Pack=N st directly.
    const direct = parseDirectCountFromName(name)
    if (direct) {
      // Sanity: direct.n × direct.perItemG ≈ netG (within 10%) confirms
      // the name's claim matches the carton weight.
      const claimed = direct.n * direct.perItemG
      const consistent = Math.abs(claimed - effectiveNetG) / effectiveNetG <= 0.15
      if (consistent) {
        return {
          kind: 'multi_pack_count', pack_size: direct.n, base_unit: 'st',
          confidence: 'high',
          notes: `Name "${direct.matched}" → ${direct.n} pieces × ${direct.perItemG}g = ${claimed}g (matches net ${netG}g)`,
        }
      }
    }
    // 6b — Sub-pack pattern "Np Xkg" (eggs 30p 1,95kg): N items per
    // sub-pack, multiple sub-packs in KRT. Pack = N × subPacks st.
    const np = parseNPackFromName(name)
    const perPackG = parsePerPackWeightG(name)
    if (np && perPackG && perPackG > 0) {
      const subPacks = Math.round(netG / perPackG)
      if (subPacks >= 1 && subPacks <= 50) {
        const totalSt = np.n * subPacks
        return {
          kind: 'multi_pack_count', pack_size: totalSt, base_unit: 'st',
          confidence: subPacks === 1 ? 'high' : 'medium',
          notes: `Name "${np.matched}" + per-pack ${perPackG}g → ${subPacks} sub-pack(s) × ${np.n} = ${totalSt} st per KRT`,
        }
      }
    }
  }

  return {
    kind: 'skip',
    reason: `unit=${unit || '∅'} label="${label || '∅'}" net_g=${netG ?? '∅'} — no rule matches`,
  }
}
