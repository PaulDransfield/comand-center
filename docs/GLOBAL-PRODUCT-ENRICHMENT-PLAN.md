# Global product enrichment — plan

> Status: READ-ONLY investigation + scope. 2026-06-05.
> Trigger: owner ask — "when customer A enriches a product, can customer B benefit when they join?"

## Why this matters

Onboarding cost for restaurant inventory is dominated by metadata work — getting pack_size, base_unit, weight_per_piece_g, density, category right for every product. Today, Vero has done this work for 994 products (94% pack_size set) and Chicce for 1138 products (96% set). Customer #3 starts from zero.

The catalogue we already maintain (`supplier_articles`, 3,161 rows scraped from MS, Spendrups, Carlsberg, Lively, Enjoy, Wine Affair) covers the **spec** side — image, brand, GTIN, brutto weight, packs_per_master. The gap is the **refined / learned** side — the values customers settle on after working with the product (content weight per bottle vs brutto, density for cooking, the correct interpretation of an ambiguous unit label).

## Current state — relevant facts

| | Vero | Chicce |
|---|---|---|
| Active products | 994 | 1138 |
| Pack size set | 939 (94%) | 1097 (96%) |
| Base unit set | 939 (94%) | 1097 (96%) |
| Weight per piece | 12 | 64 |
| Density g/ml | 0 | 5 |
| Linked to a supplier_article | 97 | 72 |

**Zero cross-customer overlap** today (Vero = Italian fine dining suppliers, Chicce = pizzeria + Spendrups beer; almost no shared SKUs). So the global enrichment value compounds with customer count #3, #4, #5 — not visible at 2 customers.

`supplier_articles` already has these columns (read-only catalogue):
- `units_per_pack`, `units_per_pack_label`, `packs_per_master` — pack structure from supplier spec
- `brutto_weight_g`, `net_weight_g` — sometimes published, sometimes not
- `image_url`, `gtin`, `brand`, `category_path`, `country_origin`, `storage_type`

What's MISSING from supplier_articles (lives only on per-business `products` today):
- `weight_per_piece_g` — content weight of one usable piece (250g for 25cl water, not brutto/24)
- `density_g_per_ml` — for liquid mass↔volume conversions in recipes
- "settled" `pack_size` + `base_unit` after owner refinement (when supplier_articles spec was ambiguous)

## Scope — what to share, what to keep local

### SHARE (physical truth, identical across all customers)
- `weight_per_piece_g` — Peroni 33cl bottle holds 330g of beer for everyone
- `density_g_per_ml` — olive oil is 0.91 g/ml everywhere
- Owner-refined `pack_size` + `base_unit` — when spec was wrong/ambiguous and a human got it right
- `category` (food/beverage/alcohol/cleaning) — same SKU has same category for every restaurant
- `count_unit`, `unit_conversion` JSONB — rare but generic when set

### KEEP LOCAL (customer-specific or commercial)
- `price_override` + `price_override_currency` — pricing is commercial
- `default_waste_pct` — kitchen efficiency varies per business
- `default_supplier_name` / `default_supplier_fortnox_number` — supplier relationships vary
- `name` — owners often rename for internal clarity
- `source_recipe_id`, `created_via` — provenance, business-scoped
- All aliases, recipes, prep sessions — confidential operational data

## Architecture — minimal-change Option

Extend `supplier_articles` with a **refinement layer** keyed by the same `(supplier_fortnox_number, article_number)` PK:

```sql
ALTER TABLE supplier_articles
  ADD COLUMN refined_pack_size            numeric,
  ADD COLUMN refined_base_unit            text,
  ADD COLUMN refined_weight_per_piece_g   numeric,
  ADD COLUMN refined_density_g_per_ml     numeric,
  ADD COLUMN refined_category             text,
  ADD COLUMN refined_confidence           smallint DEFAULT 0,    -- 0=none, 1=single-customer, 2=verified
  ADD COLUMN refined_last_updated_at      timestamptz;

CREATE TABLE supplier_article_refinement_log (
  id                       bigserial PRIMARY KEY,
  supplier_fortnox_number  text NOT NULL,
  article_number           text NOT NULL,
  business_id              uuid NOT NULL REFERENCES businesses(id),
  field                    text NOT NULL,                          -- 'weight_per_piece_g' etc
  value                    jsonb NOT NULL,
  set_at                   timestamptz DEFAULT now()
);
```

The log captures every customer save (attribution + dispute audit). The columns on `supplier_articles` hold the **promoted** value visible to the read path.

### Write hook

On `PATCH /api/inventory/items/[id]` — when the patched product is linked to a `supplier_article` (via `external_catalogue_article` OR matched at create time):

1. Log every shareable-field change into `supplier_article_refinement_log` (always — audit trail).
2. Promote to `supplier_articles.refined_*` IF either:
   - Field is currently NULL → promote with `confidence=1` (single-customer trust)
   - Another customer already saved the same value (within 5% for numerics, exact for text) → promote with `confidence=2` (verified)
3. **NEVER** overwrite an existing `confidence=2` value with a single-customer contradiction. Surface as conflict in admin instead.

### Read hook

On product creation (`matcher.ts::createProductFromLine`) — when a new product is linked to a `supplier_article`:

1. First pass — spec-based defaults from existing `pack-from-supplier-article.ts` (today's behavior).
2. **Second pass — overlay refined values** when present. `refined_weight_per_piece_g` fills weight; `refined_density_g_per_ml` fills density; `refined_pack_size` REPLACES spec-derived pack_size only when `refined_confidence ≥ 2`.

The owner sees a pre-filled EditItemModal on first save instead of empty fields.

## Trust gate

| Refinement state | Behavior |
|---|---|
| `confidence=0` (no global value) | Customer-only; saving promotes to confidence=1 |
| `confidence=1` (one customer agreed) | Used as soft default on new product creation; visible as "from platform community (1 customer)" in tooltip |
| `confidence=2` (≥2 customers agreed) | Used as default; surfaced as "verified (N customers)" |
| Conflict (new save differs by >5%) | Local save wins for that customer; admin alert + log entry; no auto-overwrite of global |

Owner can opt out per business via `businesses.share_refinements_with_platform` boolean (default `true`) — covers GDPR / privacy concerns.

## Implementation phases

**Phase 0 — investigation (done)**
- Schema mapped (see above)
- Overlap measured (zero today, compounds with customer count)
- Field-by-field share/local classification done

**Phase 1 — schema (M132, ~2h)**
- ALTER TABLE supplier_articles
- CREATE TABLE supplier_article_refinement_log
- Index on (supplier_fortnox_number, article_number)
- `businesses.share_refinements_with_platform` flag

**Phase 2 — write hook (~3h)**
- `lib/inventory/supplier-article-refinement.ts`: `logAndPromote(productPatch, supplierArticleKey)`
- Call from PATCH `/api/inventory/items/[id]` after successful save
- Skip when `businesses.share_refinements_with_platform = false`
- Skip when product has no supplier_article link (no key to share against)

**Phase 3 — read hook (~2h)**
- Extend `pack-from-supplier-article.ts` to accept refined values
- `matcher.ts::createProductFromLine` reads refined columns alongside spec
- EditItemModal shows "from platform community" badge on prefilled fields

**Phase 4 — admin surface + opt-out toggle (~3h)**
- `/admin/refinements` — view conflicts, force-confidence, audit log
- Settings → Privacy → "Share product spec refinements with platform" toggle

**Phase 5 — trust UI (optional, owner-facing)**
- When customer saves a value differing from `confidence=2` global, show a confirm dialog: "5 other customers use 327g for this product — keep your value 300g, or accept 327g?"

## Risk register

| Risk | Mitigation |
|---|---|
| One customer's typo pollutes others | `confidence=1` shown as "single source" with caveat; auto-promote to `confidence=2` only on independent agreement |
| Bad supplier_article match prefills wrong product | Already handled — supplier_article link requires owner_confirmed alias (M075) |
| Recipe / pricing data leaks | Scope strict — only fields in the SHARE list, never recipes/prices/names |
| Customer wants out | `businesses.share_refinements_with_platform = false` excludes from both write + read |
| Wrong category gets promoted | Category change at one business triggers refinement_log entry; only promotes after 2-customer agreement. Conflict surfaces in admin. |
| Owner-confirmed alias / supplier_classifications already per-business (M083) | Those stay per-business; only the supplier_article-level spec refinements share |

## Trigger to start

Customer #2 (Chicce) is live but doesn't share product overlap with Vero. The real value unlock is **customer #3** — especially if they buy from a supplier we already have spec data for (Martin Servera, Spendrups, Carlsberg are the highest-overlap suppliers in the Swedish restaurant market).

Recommended: ship Phase 1 + 2 BEFORE customer #3 onboards so their first sync gets the refinement layer warm.

## Open questions

1. Should `category` overrides via `supplier_classifications` (M083) ever promote, or stay strictly per-business? Currently per-business — different businesses legitimately classify the same supplier differently (multi-purpose supplier rule).
2. Naming overrides — should owner renames propagate? Probably NO (kitchen language varies). Spec data is shared; display name stays local.
3. How granular should the `refinement_log` be — every PATCH or only confirmed transitions? Recommend every PATCH (cheap, useful for dispute resolution).
