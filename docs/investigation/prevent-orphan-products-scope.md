# Prevent orphan-product creation — scope

**Goal:** stop the bleed. Today's auto-merge cleared 63 orphans, but the same pattern recreates them every time a chef types a name in the recipe editor that doesn't byte-match an existing product. The structural fix: make `POST /api/inventory/items` reject create-new when a similar-named or same-SKU product already exists at the business, and let the client surface "did you mean X?" inline.

## Current state (verified 2026-06-03)

### `POST /api/inventory/items` — `app/api/inventory/items/route.ts:85-90`

```ts
const { data: existing, error: exErr } = await db
  .from('products').select('id').eq('business_id', businessId).eq('name', name).maybeSingle()
if (existing?.id) {
  return NextResponse.json({ ok: true, product_id: existing.id, reused: true, ... })
}
```

**Exact-name match only.** "Antica Osteria Rosso 75eg" and "Casa Vinicola Antica Osteria Rosso Montepulciano 12,5% 75cl" don't match even though they're the same SKU. The chef can type any variant and get a new orphan product.

### Recipe editor `createProduct()` — `components/RecipeEditor.tsx:1381-1396`

The chef types a new ingredient name in the modal, clicks Create, and POSTs straight to `/api/inventory/items`. **No client-side incremental search to surface existing matches**. So even with a perfect catalogue, the chef never sees "we already have this".

### Bulk recipe importer — `app/api/inventory/recipes/import-parse/route.ts:172-195`

Already does the right thing: Sonnet is constrained to pick products from the prefix-matched catalogue. **Not the source of orphans.** The system prompt literally says "Use ONLY product prefixes that appear in the catalogue. Never invent a product." Verified.

### Direct product-create button — `/inventory/items` page

Same `/api/inventory/items` POST. Inherits the exact-name limitation.

## Sources of duplicates today

Of the 162 orphans diagnosed today (Chicce 57 + Vero 105), the dominant patterns are:
1. **Case / whitespace variants** — `"HARICOTS VERTS 2,5KG, Nyckelhål;"` vs `"Haricots Verts 2,5kg"` (case + punctuation)
2. **Typo variants** — `"Tvål & Shampoo ULTRA 2,5L"` vs `"Tvål & Schampo ULTRA 2,5L"` (Shampoo vs Schampo)
3. **Chef-short vs invoice-long** — `"Antica Osteria Rosso 75eg"` vs `"Casa Vinicola Antica Osteria Rosso Montepulciano 12,5% 75cl"` (the case the owner reported)
4. **Pack-size drift in name** — `"Hummerkött vac 320g * MSC"` vs `"Hummerkött vac 300g * MSC"` (might be a real variant — worth eyeballing)

All four classes are catchable with normalized + similarity matching.

## Proposed fix — two layers

### Layer 1 — Server-side `findOrCreate` extension (the load-bearing part)

Replace the exact-name lookup in `POST /api/inventory/items` with a three-step ladder:

```ts
// Step A: exact-name (existing behavior)
const exact = await db.from('products')... .eq('name', name)
if (exact) return { ok: true, product_id: exact.id, reused: true }

// Step B: normalized-name (lowercase + trim + collapse spaces + strip
// trailing punctuation like ", Nyckelhål;" / leading articles like "the "
// — reuses lib/inventory/normalise.ts normaliseDescription pattern)
const normalised = normaliseProductName(name)
const norm = await db.rpc('find_product_by_normalised_name', { biz: businessId, n: normalised })
if (norm) return { ok: true, product_id: norm.id, reused: true, reason: 'normalised_match' }

// Step C: similarity match (Jaccard ≥ 0.7 within same business)
// Returns top 3 candidates if similarity ≥ 0.7. Does NOT auto-create.
const candidates = await searchSimilarProducts(db, businessId, name, 0.7, 3)
if (candidates.length > 0 && !body.force_create) {
  return {
    ok: false,
    error: 'similar_product_exists',
    candidates,
    message: `${candidates.length} similar product(s) already exist at this business. Pick one to reuse, or pass force_create:true to create anyway.`,
  }
}

// Step D: create fresh
const created = ... (existing insert)
```

**Body shape changes:**
- Existing: `{ business_id, name, category, unit, base_unit, pack_size }`
- New optional fields: `{ ..., force_create?: boolean, link_to_product_id?: string }`

**Why server-side:** the dedupe is load-bearing. We can't trust every client to remember to check (e.g. AI bulk importer might bypass). Server enforcement is the only way to guarantee no more orphans.

### Layer 2 — Client-side incremental search (UX win)

In `RecipeEditor.tsx`'s "Add ingredient" modal:
1. While the chef types `newName`, debounce 300ms and call `GET /api/inventory/products/search?business_id=…&q=...` (endpoint already exists)
2. Below the input, render top 3 results as clickable cards: name, current pack, supplier
3. If user clicks one → use that product_id, skip create entirely
4. If they keep typing past the suggestions → "Create new" button stays enabled

This is pure UI sugar — turns the rare "did you mean X?" server response into a constant gentle nudge that keeps the chef in the existing catalogue.

## Decisions needed before build

1. **`force_create` flag:** if the chef explicitly says "no, mine's different" (e.g. genuinely new ingredient with similar name like 18%/30% creme fraiche), do we
   - (a) Allow with `force_create: true` (client passes after they dismiss the suggestion), OR
   - (b) Force them to set a marker like `disambiguated_from: "other_product_id"` so we can audit later?
   **Recommendation: (a).** Simpler. Auditing happens via the orphan diag script if patterns emerge.

2. **Normalization rules:** the trailing-text variants (`"…, Nyckelhål;"` `"…, EU-ekologisk"`) are a Chicce/Vero pattern from MS invoice descriptions getting saved verbatim. Should the normalizer strip:
   - Trailing `, X;` clauses? (Yes — they're attribute annotations, not part of name)
   - Trailing `(Sverige)` country-of-origin? (Yes)
   - Trailing pack-info like `(2/fp)`? (No — that's load-bearing for cost)
   **Recommendation: build `normaliseProductName()` as a separate helper, mirror `normaliseDescription()` but with an additional strip pass for those known noise patterns. Iterate as we see new patterns.**

3. **Jaccard threshold:** 0.7 is conservative (today's auto-merge used 0.5 with extra constraints). For ambient suggestions to chefs, 0.5 might be too noisy. **Recommendation: 0.7 as a hard wall; show top-3 above that. Tune later if chefs ignore suggestions.**

4. **What about supplier_articles?** Should the dedupe ALSO consult the cross-customer supplier_articles catalogue? E.g. chef types "Mascarpone 2kg" — if MS art 379952 "Mascarpone 2kg" exists in supplier_articles AND another product at this business is linked to it, suggest THAT product. **Recommendation: defer to a follow-up. supplier_articles is sparser than the in-business catalogue; the in-business check catches 90%+ of cases.**

## Build effort estimate

| Task | Effort |
|---|---|
| `lib/inventory/normalise.ts` — add `normaliseProductName()` helper + tests | 1 h |
| New `searchSimilarProducts()` helper in same file | 1 h |
| Extend `POST /api/inventory/items` with three-step ladder + `force_create` flag | 2 h |
| Client: `RecipeEditor` "Add ingredient" inline search (Layer 2) | 2 h |
| Client: handle `similar_product_exists` 200-with-candidates response (the "did you mean?" modal step) | 2 h |
| Verification: re-run `diag-orphan-by-article.mjs` after one week of usage; expect new orphans to drop to ~0 | (deferred) |
| **Total** | **~8 h focused** |

## What this does NOT cover (parked for later)

- **Bulk importer pre-flight check:** the importer currently constrains AI to existing catalogue prefixes. If we wanted to be even safer, we could add a post-AI dedupe pass that fuzzy-matches Sonnet's chosen prefixes against the catalogue using the new helper. Probably unnecessary given the prompt is strict already.
- **Cross-customer supplier_articles consultation:** the supplier_articles catalogue could ALSO inform the suggestion ("Mascarpone 2kg matches MS article 379952 already in your catalogue under Mascarpone 47% 2kg"). Higher ROI later when more suppliers are scraped.
- **Retroactive merge of dups created BEFORE this fix:** today's auto-merge handled the existing class. Future ones get caught at creation; the script can be re-run if invasions happen.

## Recommendation

Build Layer 1 + Layer 2 together as one feature branch (the server-side rejection without the client-side suggestion would be jarring; both together makes the dedupe feel helpful, not obstructive). ~8 hours focused work.

Ship behind a feature flag if we want to verify chef-acceptance before forcing everyone through the suggestion flow. (Probably overkill — the server still ALLOWS creation with `force_create:true` if the chef rejects suggestions, so worst case it's one extra click.)

After ship: re-run `diag-orphan-by-article.mjs` weekly for 4 weeks. Expect new-orphan count to drop to ~0. If chefs are spamming `force_create`, that's a signal the suggestion threshold needs tuning OR the normalization is missing a pattern — both fixable in the helper.
