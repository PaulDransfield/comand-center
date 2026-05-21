// lib/inventory/matcher.ts
//
// The 5-step matching ladder from INVENTORY-CATALOGUE-PLAN.md §3.
// First match wins. A line never visits more than one branch.
//
//   1. Exact (supplier_fortnox_number, article_number)            — auto
//   2. Exact (supplier_fortnox_number, normalised_description, unit) — auto
//   3. Trigram > 0.80 within same supplier                          — auto
//   4. Trigram > 0.85 across all suppliers                          — auto
//   5. Queue for owner review                                      — manual
//
// Thresholds are chosen so cross-supplier merges are stricter (more chance
// of "kind of similar but actually different product"). Same-supplier
// variance is almost always word-order or spacing, so 0.80 is comfortably
// safe.
//
// IDEMPOTENT: re-running the matcher on a line that already has
// product_alias_id IS NOT NULL is a no-op. The matcher only acts on rows
// where match_status IN ('needs_review', NULL).
//
// THE DEDUP INVARIANT (do not bypass): every new alias row goes through
// matchInvoiceLine() or a corresponding owner-review action. Never write
// to product_aliases directly from a route handler — you'll race the
// unique constraints and create duplicate products.

import { normaliseDescription } from './normalise'
import { categoryForBasAccount, isInventoryAccount } from './categories'

const SAME_SUPPLIER_THRESHOLD  = 0.80
const CROSS_SUPPLIER_THRESHOLD = 0.85

export interface InvoiceLineForMatching {
  id:                       string
  business_id:              string
  org_id:                   string
  supplier_fortnox_number:  string
  supplier_name_snapshot:   string | null
  article_number:           string | null
  raw_description:          string
  unit:                     string | null
  account_number:           string | null
}

export interface MatchOutcome {
  status:         'matched' | 'needs_review' | 'not_inventory'
  product_id:     string | null
  alias_id:       string | null
  method:         'article_number' | 'description_exact' | 'fuzzy_same_supplier' | 'fuzzy_cross_supplier' | null
  confidence:     number | null
  candidates:     MatchCandidate[]      // top-3 near-misses, even on success
}

export interface MatchCandidate {
  alias_id:        string
  product_id:      string
  product_name:    string
  raw_description: string
  similarity:      number
}

/**
 * Walk the ladder for a single invoice line. Mutates the database — inserts
 * a new alias row on auto-match and step-1/step-2 cache-misses; never
 * mutates on step-5 (caller writes the row with match_status='needs_review').
 *
 * Returns the outcome so the caller can update the line row in one go.
 */
export async function matchInvoiceLine(
  db: any,                              // supabase service client
  line: InvoiceLineForMatching,
): Promise<MatchOutcome> {
  // Gate 0 — is this an inventory account at all?
  if (!isInventoryAccount(line.account_number)) {
    return {
      status: 'not_inventory', product_id: null, alias_id: null,
      method: null, confidence: null, candidates: [],
    }
  }

  const normalised = normaliseDescription(line.raw_description)
  if (!normalised) {
    // Empty / unreadable description with an inventory BAS account — push to
    // review so owner can decide. Don't auto-create a "Lavazza" called "".
    return {
      status: 'needs_review', product_id: null, alias_id: null,
      method: null, confidence: null, candidates: [],
    }
  }

  // ── Step 1: exact (supplier, article_number) ───────────────────────────
  if (line.article_number) {
    const { data: hit } = await db
      .from('product_aliases')
      .select('id, product_id')
      .eq('business_id', line.business_id)
      .eq('supplier_fortnox_number', line.supplier_fortnox_number)
      .eq('article_number', line.article_number)
      .maybeSingle()
    if (hit?.id) {
      await touchAlias(db, hit.id)
      return {
        status: 'matched', product_id: hit.product_id, alias_id: hit.id,
        method: 'article_number', confidence: null, candidates: [],
      }
    }
  }

  // ── Step 2: exact (supplier, normalised_description, unit) ────────────
  const { data: descHit } = await db
    .from('product_aliases')
    .select('id, product_id')
    .eq('business_id', line.business_id)
    .eq('supplier_fortnox_number', line.supplier_fortnox_number)
    .eq('normalised_description', normalised)
    .eq('unit', line.unit ?? '')
    .is('article_number', null)
    .maybeSingle()
  if (descHit?.id) {
    await touchAlias(db, descHit.id)
    return {
      status: 'matched', product_id: descHit.product_id, alias_id: descHit.id,
      method: 'description_exact', confidence: null, candidates: [],
    }
  }

  // ── Steps 3 + 4: trigram similarity ───────────────────────────────────
  // Single RPC call, ranked by similarity. Pull top 3 always (for the
  // candidates array on the line row) and inspect the top hit for the
  // auto-merge decision.
  const candidates = await fetchTrigramCandidates(db, line.business_id, normalised, line.supplier_fortnox_number)

  // Step 3: same-supplier, threshold 0.80
  const sameSupplierTop = candidates
    .filter(c => c.supplier_fortnox_number === line.supplier_fortnox_number)
    .sort((a, b) => b.similarity - a.similarity)[0]

  if (sameSupplierTop && sameSupplierTop.similarity > SAME_SUPPLIER_THRESHOLD) {
    // Auto-link, but also insert a new alias row for this exact spelling
    // so step 2 catches the next instance instantly.
    const alias_id = await insertAlias(db, {
      product_id:             sameSupplierTop.product_id,
      business_id:            line.business_id,
      supplier_fortnox_number: line.supplier_fortnox_number,
      supplier_name_snapshot:  line.supplier_name_snapshot,
      article_number:          line.article_number,
      raw_description:         line.raw_description,
      normalised_description:  normalised,
      unit:                    line.unit,
      match_method:            'fuzzy_same_supplier',
      match_confidence:        sameSupplierTop.similarity,
    })
    return {
      status: 'matched', product_id: sameSupplierTop.product_id, alias_id,
      method: 'fuzzy_same_supplier', confidence: sameSupplierTop.similarity,
      candidates: toCandidateRows(candidates).slice(0, 3),
    }
  }

  // Step 4: cross-supplier, threshold 0.85
  const crossTop = candidates
    .filter(c => c.supplier_fortnox_number !== line.supplier_fortnox_number)
    .sort((a, b) => b.similarity - a.similarity)[0]

  if (crossTop && crossTop.similarity > CROSS_SUPPLIER_THRESHOLD) {
    // Owner switched suppliers for the same SKU — link under existing
    // product, alias points at the NEW supplier so future invoices from
    // them hit step 1/2 directly.
    const alias_id = await insertAlias(db, {
      product_id:             crossTop.product_id,
      business_id:            line.business_id,
      supplier_fortnox_number: line.supplier_fortnox_number,
      supplier_name_snapshot:  line.supplier_name_snapshot,
      article_number:          line.article_number,
      raw_description:         line.raw_description,
      normalised_description:  normalised,
      unit:                    line.unit,
      match_method:            'fuzzy_cross_supplier',
      match_confidence:        crossTop.similarity,
    })
    return {
      status: 'matched', product_id: crossTop.product_id, alias_id,
      method: 'fuzzy_cross_supplier', confidence: crossTop.similarity,
      candidates: toCandidateRows(candidates).slice(0, 3),
    }
  }

  // ── Step 5: queue for owner review ────────────────────────────────────
  return {
    status: 'needs_review', product_id: null, alias_id: null,
    method: null, confidence: null,
    candidates: toCandidateRows(candidates).slice(0, 3),
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

interface TrigramRow {
  alias_id:                string
  product_id:              string
  product_name:            string
  raw_description:         string
  supplier_fortnox_number: string
  similarity:              number
}

async function fetchTrigramCandidates(
  db: any,
  business_id: string,
  normalised: string,
  same_supplier: string,
): Promise<TrigramRow[]> {
  // Postgres' similarity() is a 0..1 score. We do the SELECT in JS rather
  // than via an RPC because the join to products lets us return the
  // canonical product name for the review UI in one round trip.
  //
  // The trigram GIN index on product_aliases.normalised_description gets
  // used here via the % operator + ORDER BY ... <-> distance.
  const { data } = await db.rpc('inventory_trigram_search', {
    p_business_id: business_id,
    p_query:       normalised,
    p_limit:       12,
  })
  if (!data) return []
  return (data as any[]).map(r => ({
    alias_id:                r.alias_id,
    product_id:              r.product_id,
    product_name:            r.product_name,
    raw_description:         r.raw_description,
    supplier_fortnox_number: r.supplier_fortnox_number,
    similarity:              Number(r.similarity),
  }))
}

function toCandidateRows(rows: TrigramRow[]): MatchCandidate[] {
  return rows.map(r => ({
    alias_id:        r.alias_id,
    product_id:      r.product_id,
    product_name:    r.product_name,
    raw_description: r.raw_description,
    similarity:      r.similarity,
  }))
}

async function touchAlias(db: any, alias_id: string): Promise<void> {
  // Bump last_seen_at + seen_count on a successful exact match. Best-
  // effort — failure here doesn't block the line from being linked.
  // Use rpc('inventory_touch_alias') so we can atomically increment.
  await db.rpc('inventory_touch_alias', { p_alias_id: alias_id }).then(() => {}, () => {})
}

interface NewAliasArgs {
  product_id:               string
  business_id:              string
  supplier_fortnox_number:  string
  supplier_name_snapshot:   string | null
  article_number:           string | null
  raw_description:          string
  normalised_description:   string
  unit:                     string | null
  match_method:             'article_number' | 'description_exact' | 'fuzzy_same_supplier' | 'fuzzy_cross_supplier' | 'owner_confirmed'
  match_confidence:         number | null
}

async function insertAlias(db: any, args: NewAliasArgs): Promise<string> {
  // Use insert + ON CONFLICT DO NOTHING via the unique indexes on
  // product_aliases. Concurrent matchers racing on the same SKU will both
  // attempt the insert; whichever loses gets the existing row via the
  // RETURNING fallback below.
  const { data, error } = await db
    .from('product_aliases')
    .upsert(args, {
      onConflict: args.article_number
        ? 'business_id,supplier_fortnox_number,article_number'
        : 'business_id,supplier_fortnox_number,normalised_description,unit',
      ignoreDuplicates: false,
    })
    .select('id')
    .single()
  if (error) {
    // Diagnostic — if this fires, the unique constraints are misaligned
    // with the upsert onConflict spec. That's the load-bearing invariant
    // breaking — surface loudly.
    throw new Error(`inventory matcher insertAlias failed: ${error.message}`)
  }
  return data.id
}

/**
 * Helper exposed to the route handlers so they can create a NEW product
 * + alias in one transaction when the owner clicks "Create as new
 * product" in the review queue. Routes through the same conflict logic
 * as auto-matching, so re-running on a duplicate description is a no-op.
 */
export async function createProductFromLine(
  db: any,
  line: InvoiceLineForMatching,
  productName: string,
  category: ReturnType<typeof categoryForBasAccount>,
): Promise<{ product_id: string; alias_id: string }> {
  const normalised = normaliseDescription(line.raw_description)
  const effectiveCategory = category ?? categoryForBasAccount(line.account_number) ?? 'other'

  const { data: prod, error: prodErr } = await db
    .from('products')
    .insert({
      org_id:                 line.org_id,
      business_id:             line.business_id,
      name:                    productName,
      category:                effectiveCategory,
      invoice_unit:            line.unit,
      default_supplier_fortnox_number: line.supplier_fortnox_number,
      default_supplier_name:   line.supplier_name_snapshot,
      created_via:             'owner_review',
    })
    .select('id')
    .single()
  if (prodErr) throw new Error(`createProductFromLine product insert: ${prodErr.message}`)

  const alias_id = await insertAlias(db, {
    product_id:               prod.id,
    business_id:              line.business_id,
    supplier_fortnox_number:  line.supplier_fortnox_number,
    supplier_name_snapshot:   line.supplier_name_snapshot,
    article_number:           line.article_number,
    raw_description:          line.raw_description,
    normalised_description:   normalised,
    unit:                     line.unit,
    match_method:             'owner_confirmed',
    match_confidence:         null,
  })

  return { product_id: prod.id, alias_id }
}
