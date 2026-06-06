// lib/inventory/unit-conversion.ts
//
// Restaurant unit conversion. Three base unit families — mass (g/kg/hg),
// volume (ml/cl/dl/l), count (st). Mass <-> volume is NOT supported
// (would need per-product density).
//
// Two jobs:
//   1. parseProductPackSize(name) — best-effort regex parse so we can
//      auto-suggest pack_size + base_unit for products that haven't
//      been curated yet. "Pizza sauce 4,1 kg" → 4100 g.
//   2. convertQuantity(qty, from, to) — convert recipe qty into the
//      product's base_unit. Returns null when the two units are in
//      different families (cross-family is a real user mistake we want
//      to surface, not silently zero out).

export type BaseUnit = 'g' | 'ml' | 'st'

// Normalise a free-text unit string into one of our canonical inputs.
// Anything we don't recognise stays as-is (the caller treats unknown
// units as a hard mismatch).
export function canonicalUnit(raw: string | null | undefined): string | null {
  if (!raw) return null
  const u = String(raw).trim().toLowerCase()
  if (!u) return null
  // Mass
  if (['g', 'gram', 'gr', 'grams'].includes(u)) return 'g'
  if (['kg', 'kilo', 'kilogram', 'kilograms'].includes(u)) return 'kg'
  if (['hg', 'hekto', 'hektogram'].includes(u)) return 'hg'
  // Volume — 'eg' is Swedish supplier shorthand for cl bottles
  // ("75eg" = 75 cl wine bottle, "70eg" = 70 cl spirits, "27,5eg" =
  // 27,5 cl FAB). Always disambiguated by leading digits in the regex.
  if (['ml', 'milliliter', 'millilitre'].includes(u)) return 'ml'
  if (['cl', 'centiliter', 'centilitre', 'eg'].includes(u)) return 'cl'
  if (['dl', 'deciliter', 'decilitre'].includes(u)) return 'dl'
  // 'lf' is Swedish for "liter fat" (liter keg — beer/cider draught).
  if (['l', 'liter', 'litre', 'lt', 'lf'].includes(u)) return 'l'
  // Count
  if (['st', 'styck', 'stk', 'pcs', 'piece', 'pieces', 'each', 'ea'].includes(u)) return 'st'
  // Pack-like (we treat these as count for parsing — pack_size deals with the rest)
  if (['frp', 'fp', 'pack', 'paket'].includes(u)) return 'st'
  // Container words — same idea: 1 of these = 1 of the pack. Lets wine
  // recipes say "1 flaska" against a 750ml bottle product and the engine
  // costs it at unit_price directly. Swedish bot (flaska) + burk (can/jar)
  // + dunk + hink (pail) are common supplier-side units.
  if (['flaska', 'flasa', 'bottle', 'bot', 'btl', 'btlf'].includes(u)) return 'st'
  if (['burk', 'jar', 'can', 'tin'].includes(u))                       return 'st'
  if (['dunk', 'hink', 'sack', 'säck', 'ask', 'kart', 'krt'].includes(u)) return 'st'
  return u
}

// All the unit families we know about.
type Family = 'mass' | 'volume' | 'count'
const FAMILY: Record<string, Family> = {
  g: 'mass', kg: 'mass', hg: 'mass',
  ml: 'volume', cl: 'volume', dl: 'volume', l: 'volume',
  st: 'count',
}

// Conversion factors to the base unit for each family.
//   mass base = g
//   volume base = ml
//   count base = st
const TO_BASE: Record<string, number> = {
  g: 1, kg: 1000, hg: 100,
  ml: 1, cl: 10, dl: 100, l: 1000,
  st: 1,
}

export function unitFamily(unit: string | null | undefined): Family | null {
  const c = canonicalUnit(unit)
  return c ? (FAMILY[c] ?? null) : null
}

export function baseUnitForFamily(f: Family): BaseUnit {
  return f === 'mass' ? 'g' : f === 'volume' ? 'ml' : 'st'
}

/**
 * Convert `qty` from `fromUnit` to `toUnit`. Returns null when the two
 * units are in different families (mass vs volume, etc) — caller should
 * surface a unit-mismatch warning. Returns qty unchanged when canonical
 * units match (no-op).
 */
export function convertQuantity(
  qty:      number,
  fromUnit: string | null | undefined,
  toUnit:   string | null | undefined,
): number | null {
  const f = canonicalUnit(fromUnit)
  const t = canonicalUnit(toUnit)
  if (!f || !t) return null
  if (f === t) return qty
  const fFam = FAMILY[f]
  const tFam = FAMILY[t]
  if (!fFam || !tFam || fFam !== tFam) return null
  // qty * (from→base) / (to→base)
  return qty * TO_BASE[f] / TO_BASE[t]
}

// Match a pack-size token like "4,1 kg", "500 ml", "30 st", "1L",
// "10 liter SE", "1 burk", "75cl flaska". Swedish uses comma decimals;
// we accept both. Long-form alternations (liter, litre, gram, gr,
// styck, stk, burk, flaska) added 2026-06-02 (Phase A) to catch
// supplier-written names like "Olja Rapsolja 10 liter SE" that the
// short-form-only regex missed because `l\b` doesn't match inside
// `liter`.
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kilogram|kilograms|kilo|kg|hg|gram|grams|gr|g|liter|litre|lt|lf|l|deciliter|decilitre|dl|centiliter|centilitre|cl|eg|milliliter|millilitre|ml|styck|stk|st|pcs|burk|flaska|paket|pkt|frp|fp|pack)\b/gi

export interface ParsedPack {
  pack_size: number    // in base_unit
  base_unit: BaseUnit  // g | ml | st
  raw_match: string    // the matched substring for owner display
  // Phase A — provenance of the parse. 'name' = pulled from the product
  // name itself; 'invoice_unit' = inferred from the supplier's invoice
  // unit when the name disclosed nothing. Callers can route this to
  // the products.pack_source column so the owner can audit later.
  source: 'name' | 'invoice_unit'
}

/**
 * Best-effort: parse pack size + base unit from a product name, with an
 * optional fall-back to the supplier `invoice_unit` when the name itself
 * discloses nothing.
 *
 * Resolution order (deterministic):
 *
 *   1. Match a "<number> <unit>" token in the name (the original
 *      behaviour). This is the strongest signal — owners commonly
 *      write "Pizza sauce 4,1 kg" or "Olive oil 500ml".
 *
 *   2. If that fails AND `invoice_unit` is provided AND it normalizes
 *      to a known mass / volume / count unit, return that unit's
 *      conversion factor to its base unit. E.g. invoice_unit='KG' →
 *      pack_size=1000, base_unit='g'. The supplier sells by weight and
 *      we know the dictionary answer; no judgement required.
 *
 *   3. Otherwise null. Caller handles honest-incomplete.
 *
 * IMPORTANT — the invoice_unit fallback ONLY fires for canonical units
 * already in the {mass, volume, count} families. Multi-unit packaging
 * names like 'KRT' / 'KOLLI' / 'PKT' / 'FRP' that imply "a box of N
 * items" are deliberately NOT inferred from — those require the owner
 * to disclose the box contents.
 *
 * Examples:
 *   "Pizza sauce Classica 4,1 kg Mutti"           → { pack: 4100, base: 'g',  source: 'name' }
 *   "Olive oil 500ml"                             → { pack:  500, base: 'ml', source: 'name' }
 *   "Citron",                  invoice_unit='KG'  → { pack: 1000, base: 'g',  source: 'invoice_unit' }
 *   "Gurka Kg",                invoice_unit='KG'  → { pack: 1000, base: 'g',  source: 'invoice_unit' }   (name parse fails — 'Kg' has no number)
 *   "Råa Vannamei",            invoice_unit='st'  → { pack:    1, base: 'st', source: 'invoice_unit' }
 *   "Olivolja XV",             invoice_unit='CL'  → { pack:   10, base: 'ml', source: 'invoice_unit' }
 *   "Mozzarella",              invoice_unit='KRT' → null    (KRT is a box, contents unknown)
 *   "Mozzarella",              invoice_unit=null  → null
 */
export function parseProductPackSize(
  name:         string | null | undefined,
  invoice_unit?: string | null | undefined,
): ParsedPack | null {
  // 1. Name-based parse (strongest signal — original behaviour).
  if (name) {
    const matches = Array.from(String(name).matchAll(PACK_RE))
    if (matches.length > 0) {
      const m = matches[matches.length - 1]
      const num  = Number(m[1].replace(',', '.'))
      if (Number.isFinite(num) && num > 0) {
        const unit = canonicalUnit(m[2])
        if (unit) {
          const fam = FAMILY[unit]
          if (fam) {
            return {
              pack_size: num * TO_BASE[unit],
              base_unit: baseUnitForFamily(fam),
              raw_match: m[0],
              source:    'name',
            }
          }
        }
      }
    }
  }

  // 2. invoice_unit fallback — supplier sells by a known weight/volume/
  //    count unit. The dictionary answer: pack_size = unit→base factor.
  if (invoice_unit) {
    const inv = canonicalUnit(invoice_unit)
    if (inv) {
      const fam = FAMILY[inv]
      if (fam) {
        return {
          pack_size: TO_BASE[inv],
          base_unit: baseUnitForFamily(fam),
          raw_match: `invoice unit ${invoice_unit}`,
          source:    'invoice_unit',
        }
      }
    }
  }

  // 3. Honest-incomplete.
  return null
}

/**
 * Best-effort: extract the per-piece VOLUME (in ml) disclosed by a
 * product name. Used by the cost engine's volume↔count bridge for
 * piece-priced liquids — e.g. "Thomas H Mystic Mango 20cl" → 200,
 * meaning each piece holds 200 ml. Mirrors the mass-side bridge
 * (M122 weight_per_piece_g) but for volume.
 *
 * Returns null when:
 *   - the name discloses no volume token, OR
 *   - the parsed token is a mass / count unit (the caller is asking
 *     specifically for "ml-per-piece"; mass or count don't qualify).
 *
 * Examples:
 *   "Thomas H Mystic Mango 20cl"   → 200
 *   "Coca-Cola 33cl"               → 330
 *   "San Pellegrino 75cl"          → 750
 *   "Olive oil 500ml"              → 500
 *   "Olja Rapsolja 10 liter SE"    → 10000
 *   "Pizza sauce 4,1 kg"           → null   (mass, not volume)
 *   "Tomato",                      → null   (no token)
 */
export function volumePerPieceMlFromName(name: string | null | undefined): number | null {
  const parsed = parseProductPackSize(name)
  if (!parsed) return null
  if (parsed.base_unit !== 'ml') return null
  return parsed.pack_size > 0 ? parsed.pack_size : null
}
