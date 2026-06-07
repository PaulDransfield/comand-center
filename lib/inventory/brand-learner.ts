// lib/inventory/brand-learner.ts
//
// M138 — reactive brand auto-learner. Called from the items PATCH
// endpoint whenever an owner sets / clears sub_category. Recomputes
// the brand_classifications_learned row for that product's brand,
// upserting or deleting based on agreement among ALL owner-classified
// products with that brand (across all customers).
//
// Rules (mirror sql/M138-BRAND-CLASSIFICATIONS-LEARNED.sql):
//   - Require >= 3 owner classifications for the brand
//   - Dominant sub_category needs >= 80 % agreement to count as learned
//   - Otherwise: delete the row (let LLM handle it again)

import type { SupabaseClient } from '@supabase/supabase-js'

const MIN_SAMPLES   = 3
const MIN_AGREEMENT = 0.80

/**
 * Recompute the brand_classifications_learned row for one brand.
 * Best-effort — logs and swallows errors so the caller (items PATCH)
 * never fails on this side-effect.
 */
export async function relearnBrand(db: SupabaseClient, brand: string | null | undefined): Promise<void> {
  if (!brand) return
  const brandKey = String(brand).toLowerCase().trim()
  if (!brandKey) return

  try {
    // Pull every owner-classified product with this brand (case-insensitive).
    // 'brand' is stored as the supplier's free-form text; we lower+trim
    // server-side to match how the learner stores keys.
    const { data: rows, error } = await db
      .from('products')
      .select('sub_category, brand')
      .eq('classification_source', 'owner')
      .not('sub_category', 'is', null)
      .ilike('brand', brand)                              // case-insensitive exact
      .limit(500)
    if (error) {
      console.warn(`[brand-learner] lookup failed for "${brand}": ${error.message}`)
      return
    }
    const candidates = (rows ?? []).filter(r =>
      String(r.brand ?? '').toLowerCase().trim() === brandKey,
    )

    const total = candidates.length
    if (total < MIN_SAMPLES) {
      // Not enough signal yet. Delete any stale row so we don't keep
      // a learned classification that's no longer supported.
      await db.from('brand_classifications_learned').delete().eq('brand', brandKey)
      return
    }

    // Tally per sub_category
    const tally = new Map<string, number>()
    for (const r of candidates) {
      const k = String(r.sub_category)
      tally.set(k, (tally.get(k) ?? 0) + 1)
    }
    // Pick the dominant
    let bestKey = ''
    let bestCount = 0
    for (const [k, n] of tally) {
      if (n > bestCount) { bestKey = k; bestCount = n }
    }
    const agreement = bestCount / total

    if (agreement < MIN_AGREEMENT) {
      // Mixed signal — owners use this brand across multiple categories.
      // Don't pretend it's learned.
      await db.from('brand_classifications_learned').delete().eq('brand', brandKey)
      return
    }

    // Upsert the learned row.
    const { error: upErr } = await db
      .from('brand_classifications_learned')
      .upsert({
        brand:              brandKey,
        sub_category:       bestKey,
        confidence:         Math.round(agreement * 1000) / 1000,
        sample_count:       bestCount,
        total_observations: total,
        last_observed_at:   new Date().toISOString(),
      }, { onConflict: 'brand' })
    if (upErr) {
      console.warn(`[brand-learner] upsert failed for "${brandKey}": ${upErr.message}`)
    }
  } catch (e: any) {
    console.warn(`[brand-learner] threw for "${brand}": ${e?.message ?? e}`)
  }
}

/**
 * Read the learned classification for one brand, if any.
 * Used by the classify cascade as a source between cross_customer
 * and openfoodfacts.
 */
export async function lookupLearnedBrand(
  db: SupabaseClient,
  brand: string | null | undefined,
): Promise<{ sub_category: string; confidence: number; sample_count: number } | null> {
  if (!brand) return null
  const brandKey = String(brand).toLowerCase().trim()
  if (!brandKey) return null
  try {
    const { data, error } = await db
      .from('brand_classifications_learned')
      .select('sub_category, confidence, sample_count')
      .eq('brand', brandKey)
      .maybeSingle()
    if (error || !data) return null
    return data as any
  } catch {
    return null
  }
}

/**
 * Batch variant for the cascade — single round-trip when classifying
 * many products at once.
 */
export async function lookupLearnedBrands(
  db: SupabaseClient,
  brands: string[],
): Promise<Map<string, { sub_category: string; confidence: number; sample_count: number }>> {
  const out = new Map<string, { sub_category: string; confidence: number; sample_count: number }>()
  const keys = Array.from(new Set(brands.map(b => String(b ?? '').toLowerCase().trim()).filter(Boolean)))
  if (keys.length === 0) return out
  try {
    const { data, error } = await db
      .from('brand_classifications_learned')
      .select('brand, sub_category, confidence, sample_count')
      .in('brand', keys)
    if (error || !data) return out
    for (const row of data) out.set(row.brand, {
      sub_category: row.sub_category,
      confidence:   Number(row.confidence),
      sample_count: row.sample_count,
    })
  } catch { /* swallow */ }
  return out
}
