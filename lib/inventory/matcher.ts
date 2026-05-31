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
import { categoryForBasAccount, type InventoryCategory } from './categories'
import { categoryForSupplier, type SupplierClassification } from './suppliers'
import { descriptionRule } from './description-rules'
import { parseProductPackSize } from './unit-conversion'

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
  // Gate 0 — does this line look like inventory at all?
  //
  // Three passes, first hit wins:
  //   (a) Per-business supplier_classifications override (M083). Owner
  //       has explicitly said "all invoices from this supplier are
  //       overhead" — trust that over the universal classifier.
  //   (b) BAS account routing (lib/inventory/categories.ts). Most
  //       reliable when present — Fortnox posts AccountNumber once an
  //       invoice is bokförd.
  //   (c) Supplier-name routing (lib/inventory/suppliers.ts). Fallback
  //       for businesses whose Fortnox setup doesn't post the GL
  //       account at supplier-invoice receipt time (Chicce's case:
  //       100% of 3218 rows had account_number = NULL on 2026-05-21).
  //
  // The (a) override is per-business so a marketing agency that's
  // overhead for restaurant A might still be inventory for restaurant B.
  const ownerOverride = await getSupplierOverride(db, line.business_id, line.supplier_fortnox_number)
  if (ownerOverride === 'not_inventory') {
    return {
      status: 'not_inventory', product_id: null, alias_id: null,
      method: null, confidence: null, candidates: [],
    }
  }

  // Gate 0b — description-level veto. Pallets, deposits, rebates, freight
  // and packaging units are never inventory regardless of which BAS account
  // the accountant booked them to. See lib/inventory/description-rules.ts
  // for the pattern + the anchoring discipline (mid-string tokens on real
  // products MUST NOT be caught — both-directions check in dry-run before
  // adding any new arm).
  if (descriptionRule(line.raw_description) === 'not_inventory') {
    return {
      status: 'not_inventory', product_id: null, alias_id: null,
      method: null, confidence: null, candidates: [],
    }
  }

  // Gate 0c + 0d — global supplier dictionary veto AND fallthrough_unknown,
  // BOTH gated by owner_confirmed safeguard.
  //
  // The principle (refined 2026-05-31 by the Vero-59 drill-in):
  //
  //   Human-confirmed decisions are protected; machine guesses are not.
  //
  // What that means in practice:
  //   - Gate 0a (per-business supplier_classifications override) and Gate 0b
  //     (description rule) always veto. 0a is explicit-at-this-business
  //     owner action; 0b is structural fact (pallets/deposits never being
  //     products). No safeguard.
  //   - Gate 0c (global supplier dictionary) and Gate 0d (fallthrough_unknown:
  //     no positive signal at all) BOTH defer to an owner_confirmed alias if
  //     one exists for this line's (supplier, normalised_description) signature.
  //     These are the auto-categorization paths — they may be wrong, and an
  //     explicit owner-verified match outranks them. Fuzzy aliases
  //     (fuzzy_same_supplier, fuzzy_cross_supplier) are NOT protected — those
  //     are machine guesses the audit queue is meant to catch.
  //
  // Two history points the principle was earned by:
  //   - Frimurarholmen (2026-05-31): a landlord supplier globally classified
  //     as not_inventory also did food passthrough at Vero. 8 owner_confirmed
  //     food matches were being vetoed by the global guess.
  //   - 59 Vero "regressions" surfaced by the Fix 1 hunt: real Snabbgross
  //     vegetables, Spendrups wines, etc., on 5xxx admin BAS accounts the
  //     accountant mis-coded. basCategory=null, supplierClass=null →
  //     fallthrough veto. All 100% had owner_confirmed aliases.
  //
  // The safeguard is one indexed lookup per would-be-vetoed line — sub-ms
  // against the product_aliases (business_id, supplier_fortnox_number,
  // normalised_description) index. Only fires when wouldVeto is true.
  const supplierClass = categoryForSupplier(line.supplier_name_snapshot)
  const basCategory   = categoryForBasAccount(line.account_number)
  const positiveCategory: SupplierClassification | null = basCategory ?? supplierClass

  const wouldVetoBySupplier    = supplierClass === 'not_inventory'
  const wouldVetoByFallthrough = !positiveCategory || positiveCategory === 'other'
  const wouldVeto = wouldVetoBySupplier || wouldVetoByFallthrough

  if (wouldVeto) {
    const normalisedForSafeguard = normaliseDescription(line.raw_description)
    const safeguarded = normalisedForSafeguard
      ? await hasOwnerConfirmedAlias(db, line, normalisedForSafeguard)
      : false

    if (!safeguarded) {
      return {
        status: 'not_inventory', product_id: null, alias_id: null,
        method: null, confidence: null, candidates: [],
      }
    }
    // else: owner_confirmed alias exists for this signature → fall through
    // to Steps 1-4. The matcher will hit the alias via Step 2 (description_exact)
    // and confirm the existing match. The auto-veto is overridden by explicit
    // owner verification at the line level.
  }

  // If we reach here we have either a positive category or a safeguarded
  // fall-through. Resolve the category for downstream use; safeguarded
  // fall-through with no positive signal gets 'other' as a placeholder
  // (only used by create-new code paths, which Step 2 won't reach when
  // an owner_confirmed alias already exists).
  const resolved: InventoryCategory =
    (positiveCategory && positiveCategory !== 'not_inventory' && positiveCategory !== 'other')
      ? positiveCategory as InventoryCategory
      : 'other'
  const _resolvedInventory: InventoryCategory = resolved

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
  // M105: filter on is_active=TRUE so demoted aliases are skipped. The
  // partial unique index doesn't condition on is_active, so a demoted
  // row WITH the same article_number still exists in the table — the
  // .eq('is_active', true) here is what hides it from the matcher.
  if (line.article_number) {
    const { data: hit } = await db
      .from('product_aliases')
      .select('id, product_id')
      .eq('business_id', line.business_id)
      .eq('supplier_fortnox_number', line.supplier_fortnox_number)
      .eq('article_number', line.article_number)
      .eq('is_active', true)
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
  // M105: same is_active filter.
  const { data: descHit } = await db
    .from('product_aliases')
    .select('id, product_id')
    .eq('business_id', line.business_id)
    .eq('supplier_fortnox_number', line.supplier_fortnox_number)
    .eq('normalised_description', normalised)
    .eq('unit', line.unit ?? '')
    .is('article_number', null)
    .eq('is_active', true)
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

// Per-business override lookup (M083). Returns 'not_inventory' if the
// owner has explicitly skipped this supplier, otherwise null. Cached
// per-call via the supabase client's internal connection pool — this
// is a single indexed lookup on (business_id, supplier_fortnox_number)
// against a small table, so we don't bother caching across calls. If
// matcher throughput ever becomes a bottleneck, the caller can pre-
// load the map and short-circuit.
async function getSupplierOverride(db: any, business_id: string, supplier_fortnox_number: string): Promise<string | null> {
  if (!supplier_fortnox_number) return null
  const { data } = await db
    .from('supplier_classifications')
    .select('classification')
    .eq('business_id', business_id)
    .eq('supplier_fortnox_number', supplier_fortnox_number)
    .maybeSingle()
  return data?.classification ?? null
}

// Owner-confirmed safeguard. Returns true when this line's signature
// (business, supplier, normalised_description) has an active alias
// created via 'owner_confirmed' — i.e. a human explicitly verified that
// THIS specific raw_description from THIS supplier maps to a real
// product. That signal outranks any of the auto-categorization Gate-0
// vetoes (supplier dict guess, fallthrough-unknown).
//
// CRITICAL: only 'owner_confirmed' counts. Fuzzy aliases
// (fuzzy_same_supplier, fuzzy_cross_supplier) are machine guesses —
// they are NOT safeguarded; they remain vulnerable to re-veto, which
// is what the audit queue + demotion mechanism is built to catch.
// Conflating "matched" with "human-confirmed" would entrench machine
// guesses and undo the learning loop.
//
// Uses the product_aliases_desc_uniq partial index (M075) for the
// (business_id, supplier_fortnox_number, normalised_description) lookup
// — sub-ms.
async function hasOwnerConfirmedAlias(
  db: any,
  line: InvoiceLineForMatching,
  normalised: string,
): Promise<boolean> {
  if (!normalised) return false
  const { data } = await db
    .from('product_aliases')
    .select('id')
    .eq('business_id', line.business_id)
    .eq('supplier_fortnox_number', line.supplier_fortnox_number)
    .eq('normalised_description', normalised)
    .eq('match_method', 'owner_confirmed')
    .eq('is_active', true)
    .limit(1)
    .maybeSingle()
  return !!data
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
  // SELECT-first-then-INSERT, with 23505-aware re-SELECT on race.
  //
  // We CAN'T use supabase-js `.upsert({ onConflict })` here because the
  // two unique indexes on product_aliases are both partial (one
  // WHERE article_number IS NULL, one WHERE article_number IS NOT NULL,
  // and the NULL branch wraps `unit` in COALESCE). PostgREST validates
  // the onConflict target against full constraints/indexes only — it
  // rejects partial + expression indexes with "no unique or exclusion
  // constraint matching the ON CONFLICT specification".
  //
  // The partial indexes still enforce uniqueness at the DB layer; this
  // helper just stops trying to drive them via upsert. Race window:
  // SELECT→INSERT can be beaten by a concurrent insert, which raises
  // 23505 — we then re-SELECT and return the winning row's id.
  //
  // M105 — demotion-aware re-activation: findExistingAlias INTENTIONALLY
  // returns demoted rows too (the partial unique index doesn't condition
  // on is_active, so the demoted row would block an INSERT with the same
  // key). When we find a demoted-or-different-product existing alias,
  // re-activate it with the new product_id + reset counters. This counts
  // as a fresh owner decision and stays in the same DB row (preserves
  // first_seen_at + seen_count history; resets corrections_against +
  // deactivated_*).

  const existing = await findExistingAlias(db, args)
  if (existing) {
    const { data: ex } = await db
      .from('product_aliases')
      .select('id, product_id, is_active')
      .eq('id', existing)
      .maybeSingle()
    if (ex?.is_active === true && ex.product_id === args.product_id) {
      // Active + same product → nothing to do, return the existing id.
      return ex.id
    }
    // Demoted, or active but pointing at a different product → re-target.
    // Treat as a fresh owner decision: reset corrections_against to 0,
    // clear deactivation, set new product_id + match_method.
    // Don't reset seen_count — historical usage pattern stays for audit.
    const { error: reactErr } = await db
      .from('product_aliases')
      .update({
        product_id:          args.product_id,
        is_active:           true,
        corrections_against: 0,
        deactivated_reason:  null,
        deactivated_at:      null,
        match_method:        args.match_method,
        match_confidence:    args.match_confidence,
        last_seen_at:        new Date().toISOString(),
        last_applied_at:     new Date().toISOString(),
        last_corrected_at:   null,
      })
      .eq('id', existing)
    if (reactErr) throw new Error(`inventory matcher insertAlias re-activate: ${reactErr.message}`)
    return existing
  }

  const { data, error } = await db
    .from('product_aliases')
    .insert(args)
    .select('id')
    .single()

  if (!error) return data.id

  // 23505 = unique_violation. Could be either partial index. Re-SELECT.
  if ((error as any).code === '23505') {
    const winner = await findExistingAlias(db, args)
    if (winner) return winner
  }

  throw new Error(`inventory matcher insertAlias failed: ${error.message}`)
}

async function findExistingAlias(db: any, args: NewAliasArgs): Promise<string | null> {
  // Mirror the two partial indexes: article_number path or normalised-
  // description path, depending on whether article_number is set.
  if (args.article_number) {
    const { data } = await db
      .from('product_aliases')
      .select('id')
      .eq('business_id', args.business_id)
      .eq('supplier_fortnox_number', args.supplier_fortnox_number)
      .eq('article_number', args.article_number)
      .maybeSingle()
    return data?.id ?? null
  }
  // article_number IS NULL branch — matches COALESCE(unit, '') in the index.
  const unitKey = args.unit ?? ''
  let q = db
    .from('product_aliases')
    .select('id, unit')
    .eq('business_id', args.business_id)
    .eq('supplier_fortnox_number', args.supplier_fortnox_number)
    .eq('normalised_description', args.normalised_description)
    .is('article_number', null)
  // .eq('unit', null) doesn't fly — supabase translates that to ?unit=eq.null
  // which IS NOT how SQL NULL equality works. Use .is() for the null case,
  // .eq() for the non-null case.
  q = args.unit == null ? q.is('unit', null) : q.eq('unit', args.unit)
  const { data } = await q.maybeSingle()
  if (data) return data.id
  // Edge case: index treats NULL and '' as the same key via COALESCE, but
  // SELECT above is strict. Look for the sibling form too.
  if (unitKey === '') {
    const { data: alt } = await db
      .from('product_aliases')
      .select('id')
      .eq('business_id', args.business_id)
      .eq('supplier_fortnox_number', args.supplier_fortnox_number)
      .eq('normalised_description', args.normalised_description)
      .is('article_number', null)
      .or('unit.is.null,unit.eq.')
      .maybeSingle()
    return alt?.id ?? null
  }
  return null
}

/**
 * Helper exposed to the route handlers so they can create-or-link a
 * product + alias when the owner approves a group in the bulk-review
 * queue.
 *
 * IDEMPOTENT against the products UNIQUE(business_id, name) constraint:
 *   - If a product with this name already exists in this business, we
 *     link a new alias for the current supplier under that existing
 *     product. This is the right thing when two different suppliers
 *     sell the same SKU (cross-supplier merge that the matcher's
 *     step 4 missed because trigram similarity fell under 0.85), or
 *     when the owner approves the same canonical name twice from
 *     different groups.
 *   - Otherwise, INSERT a new product then a new alias.
 *
 * Returns `reused: true` when the product was found rather than created
 * so the caller can communicate "Linked to existing X" instead of
 * "Created new X" in the UI.
 */
export async function createProductFromLine(
  db: any,
  line: InvoiceLineForMatching,
  productName: string,
  category: ReturnType<typeof categoryForBasAccount>,
): Promise<{ product_id: string; alias_id: string; reused: boolean }> {
  const normalised = normaliseDescription(line.raw_description)
  const effectiveCategory = category ?? categoryForBasAccount(line.account_number) ?? 'other'

  // Find-or-create the product. Race-aware: SELECT-then-INSERT, retry
  // SELECT on 23505 in case another approve landed first.
  let productId:   string
  let wasExisting = false

  const { data: existing } = await db
    .from('products')
    .select('id')
    .eq('business_id', line.business_id)
    .eq('name',        productName)
    .maybeSingle()

  if (existing?.id) {
    productId   = existing.id
    wasExisting = true
  } else {
    // Auto-detect pack size from the canonical name. Free fill-in for
    // every product created via owner-review — they land already
    // priced-per-gram in recipes without owner curation.
    const parsedPack = parseProductPackSize(productName)

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
        pack_size:               parsedPack?.pack_size ?? null,
        base_unit:               parsedPack?.base_unit ?? null,
      })
      .select('id')
      .single()
    if (prodErr) {
      // 23505 = SELECT lost the race vs concurrent approve. Re-SELECT.
      if ((prodErr as any).code === '23505') {
        const { data: raceWinner } = await db
          .from('products')
          .select('id')
          .eq('business_id', line.business_id)
          .eq('name',        productName)
          .maybeSingle()
        if (raceWinner?.id) {
          productId   = raceWinner.id
          wasExisting = true
        } else {
          throw new Error(`createProductFromLine product insert: ${prodErr.message}`)
        }
      } else {
        throw new Error(`createProductFromLine product insert: ${prodErr.message}`)
      }
    } else {
      productId = prod.id
    }
  }

  const alias_id = await insertAlias(db, {
    product_id:               productId,
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

  return { product_id: productId, alias_id, reused: wasExisting }
}
