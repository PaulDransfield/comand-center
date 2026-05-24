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
  // Volume
  if (['ml', 'milliliter', 'millilitre'].includes(u)) return 'ml'
  if (['cl', 'centiliter', 'centilitre'].includes(u)) return 'cl'
  if (['dl', 'deciliter', 'decilitre'].includes(u)) return 'dl'
  if (['l', 'liter', 'litre', 'lt'].includes(u)) return 'l'
  // Count
  if (['st', 'styck', 'stk', 'pcs', 'piece', 'pieces', 'each', 'ea'].includes(u)) return 'st'
  // Pack-like (we treat these as count for parsing — pack_size deals with the rest)
  if (['frp', 'fp', 'pack', 'paket'].includes(u)) return 'st'
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

// Match a pack-size token like "4,1 kg", "500 ml", "30 st", "1L".
// Swedish uses comma decimals; we accept both.
const PACK_RE = /(\d+(?:[.,]\d+)?)\s*(kg|hg|g|l|dl|cl|ml|st|frp|fp|pack|paket)\b/gi

export interface ParsedPack {
  pack_size: number    // in base_unit
  base_unit: BaseUnit  // g | ml | st
  raw_match: string    // the matched substring for owner display
}

/**
 * Best-effort: parse pack size + base unit from a product name.
 * Returns the LARGEST match, since "Pizza sauce 4,1 kg" can have the
 * same regex match "kg" inside "4,1 kg" and there's only one. Returns
 * null when nothing matches or the unit is unrecognised.
 *
 * Examples:
 *   "Pizza sauce Classica 4,1 kg Mutti"  → { pack_size: 4100, base_unit: 'g' }
 *   "Vitlök Skalad 1kg Kl1"              → { pack_size: 1000, base_unit: 'g' }
 *   "Olive oil 500ml"                    → { pack_size: 500,  base_unit: 'ml' }
 *   "Mjölk 1L"                           → { pack_size: 1000, base_unit: 'ml' }
 *   "Ägg 30 st"                          → { pack_size: 30,   base_unit: 'st' }
 *   "Mozzarella"                         → null
 */
export function parseProductPackSize(name: string | null | undefined): ParsedPack | null {
  if (!name) return null
  const matches = Array.from(String(name).matchAll(PACK_RE))
  if (matches.length === 0) return null
  // Use the LAST match — pack sizes tend to come after the product name.
  // "Pizza sauce 4,1 kg" → "4,1 kg" is the last (and only) match.
  const m = matches[matches.length - 1]
  const num  = Number(m[1].replace(',', '.'))
  if (!Number.isFinite(num) || num <= 0) return null
  const unit = canonicalUnit(m[2])
  if (!unit) return null
  const fam = FAMILY[unit]
  if (!fam) return null
  const base = baseUnitForFamily(fam)
  const pack_size = num * TO_BASE[unit]
  return { pack_size, base_unit: base, raw_match: m[0] }
}
