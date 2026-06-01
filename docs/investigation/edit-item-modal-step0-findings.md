# Edit-Item Modal — Step 0 Findings (READ-ONLY)

Run: 2026-06-01
Per `edit-item-modal-prompt.md` — schema verification + path identification before building.

## Three-line headline

1. **Most edit fields the modal needs already exist + already have a working PATCH endpoint.** `name`, `category`, `invoice_unit`, `pack_size`, `base_unit`, `price_override` (+ currency), `default_supplier_name`, `default_supplier_fortnox_number`, `archived` are all live on `app/api/inventory/items/[id]/route.ts` PATCH. The IngredientRow in `app/inventory/recipes/page.tsx` already uses this for inline pack/base/price edits — modal just becomes a wider rendering of the same writes.
2. **`cost_group` / `inventory_list` / `default_waste_pct` / `description` / `notes` / `tags` are all MISSING from `products`.** Per the prompt's "render only what exists, do not block on net-new", **defer all six** for the modal v1. None of them are load-bearing for cost computation; they're metadata/sorting fields that can be added incrementally if owner asks. Skipping them keeps v1 lean and avoids a same-commit DB+TS dance for fields nobody's missed yet.
3. **Article-connect needs ONE new endpoint.** The connection layer (`product_aliases`) is fully read-modelled and the correction-write path exists (`/api/inventory/lines/[id]/correct-attribution`), but there's no endpoint that **changes which product an alias points to** (the "this article belongs to a different product" case). The clean shape is `POST /api/inventory/product-aliases/[id]/repoint { product_id }` — atomic update with the same SELECT-then-validate pattern the matcher uses for partial-unique-index hygiene. Plus the existing alias-create path from `/api/inventory/needs-review/approve` is reusable for the "create a new connection" case.

## What renders today vs net-new

### A. Item details (left pane)

| Field | Source | Read | Write | Render in v1 |
|---|---|---|---|---|
| Name | `products.name` | GET items/[id] | PATCH items/[id] | ✓ |
| Category | `products.category` | same | same | ✓ |
| Invoice unit | `products.invoice_unit` | same | same | ✓ |
| Pack size + base unit | `products.pack_size` + `base_unit` | same | same | ✓ |
| Default supplier | `products.default_supplier_name` + `_fortnox_number` | same | same | ✓ |
| Price override | `products.price_override` (+ currency) | same | same | ✓ |
| Default waste % | **MISSING column** | — | — | ✗ defer (use recipe_ingredients.waste_pct per-line for now) |
| Description / notes / tags | **MISSING columns** | — | — | ✗ defer |
| Cost group / inventory list | **MISSING columns** | — | — | ✗ defer |

### B. Current cost + price trend (top of modal)

- **Latest unit cost**: `getProductLatestPrices(db, businessId, [productId], fxIndex)` — already in `lib/inventory/recipe-cost.ts`, returns `latest_price`, `invoice_unit`, `latest_date`, `pack_size`, `base_unit`, `cost_per_base_unit` (derivable). **Reusable.**
- **Price trend ("X% senaste veckan")**: not pre-computed; needs a small reader that pulls `supplier_invoice_lines` history for a product (via its aliases), buckets by week, computes delta. The data is there (supplier_invoice_lines has invoice_date + the post-merge `total/quantity` derivation gives clean per-unit), the query is one shot. **Net-new, ~30 lines.**
- **Honest incomplete state**: the costing engine already returns `missing_prices` and `unit_mismatch` per ingredient. For a standalone product (not in a recipe), the rule is:
  - No matched supplier line → "ofullständig kostnad — no recent invoice"
  - Has price but no `pack_size`/`base_unit` AND the recipe unit families differ → "ofullständig kostnad — pack info missing"
  - Post-rebill-rule-merge: if the product's recent invoice rows came from an extraction flagged with `over_extraction` or `total_mismatch`, surface that ("price may be unreliable — extraction needs review")

### C. Supplier article connection (right pane, top)

| Need | Path | New? |
|---|---|---|
| Show currently-linked aliases for the product | SELECT product_aliases WHERE product_id=X AND is_active=true | exists |
| Per-alias: latest price, last seen, supplier | join with most-recent supplier_invoice_lines | exists |
| Search catalogue to connect a different article | typeahead over `product_aliases` raw_description / supplier — same shape as the IngredientPicker | exists (in recipe drawer) |
| **Repoint an existing alias to a different product** | `UPDATE product_aliases SET product_id = ... WHERE id = ...` | **NEW endpoint needed** |
| Add a new alias to this product | match-loop call OR a small `/api/inventory/products/[id]/aliases POST` | NEW small endpoint |
| Demote/disconnect an alias | `/api/inventory/lines/[id]/correct-attribution` (via line-level) OR `UPDATE is_active=false` directly | exists for line-level; need product-level variant |

**At Chicce currently:** 890 products carry active aliases (801 have 1 alias, 76 have 2, 13 have 3-5). 92.5% of aliases are `owner_confirmed`. The alias-edit affordance won't be a daily-driver feature — but it's the right surface for the rare "this invoice line drifted to a different product over time" case the modal exists to handle in-context.

### D. Used in recipes (right pane, below)

| Need | Path | New? |
|---|---|---|
| Direct: which recipes have this product as an ingredient | SELECT recipe_ingredients WHERE product_id=X — already verified, simple | exists (1 query) |
| Transitive: which recipes have a sub-recipe that contains this product | `loadRecipeIndex(db, biz)` already builds the full graph for costing; walk it to find all recipes whose ingredient tree includes this product | exists (reuse, 1 helper function) |
| Per usage row: recipe name + quantity + unit + waste% | join with recipes — straightforward | exists |
| Blast-radius cost preview (estimated cost delta if this product's price changes) | optional — compute via `computeRecipeCost` on the changed price; skip for v1 unless owner asks | nice-to-have |

## Net-new code for v1

1. **`<EditItemModal>`** — shared component in `app/inventory/_components/` (new dir) or co-located.
2. **Read endpoint** `/api/inventory/items/[id]/edit-context` — single fetch returning: product, latest_cost, price_trend, aliases (with supplier+price), used_in_recipes. Saves the modal making 4 sequential calls; one round-trip → snappy open.
3. **Alias-repoint endpoint** `POST /api/inventory/product-aliases/[id]/repoint { product_id }` — atomic UPDATE with business-ownership check + reapply the matcher to dependent supplier_invoice_lines.
4. **Alias-disconnect endpoint** (or extend existing correct-attribution to accept a product-level body): `POST /api/inventory/product-aliases/[id]/deactivate` — same pattern, sets `is_active=false`.
5. **Price-trend reader** in `lib/inventory/recipe-cost.ts` (sibling to `getProductLatestPrices`): `getProductPriceTrend(db, biz, productId, windowDays=7)` returning `{ latest_price, prev_price, delta_pct }` or null if too little history.
6. **Mount points**: extend `app/inventory/recipes/page.tsx` IngredientRow to open the modal in place of the existing inline-expand panel; extend `app/inventory/items/[id]/page.tsx` (or its parent list) to open the modal on edit.

Total scope: ~1 component, 3 small endpoints, 1 reader helper, 2 mount-point integrations. No schema migration needed if we defer the 6 missing-column fields (and the prompt explicitly says don't block on them).

## Hard rules check

- ✓ One shared component, two mount points — by design.
- ✓ Render only schema-supported fields; `cost_group`/`inventory_list`/`default_waste_pct`/`description`/`notes`/`tags` deferred to v2.
- ✓ Article-link writes via SELECT-then-validate, not `.upsert` (partial unique index on `product_aliases`).
- ✓ Honest incomplete-cost state — reuse existing `missing_prices` / `unit_mismatch` + new `over_extraction` flags.
- ✓ Delete = archive via `archived_at` (already supported by PATCH `archived: true`).
- ✓ CC design tokens (`UXP.*` / `Z.*`), Swedish formatting (`fmtKr`), no new libraries.

## What was NOT done

- No component built, no endpoints written.
- No schema changes proposed (the 6 missing columns are deferred per prompt).
- No PDF / Fortnox calls.

## Recommended go / no-go

**Proceed to Step 1.** Scope is clean: one modal, three small endpoints, one reader. No schema work needed for v1. Defer the 6 missing-column fields and the blast-radius cost preview to v2 when owner asks. Build on feature branch + preview, stop for review before merging to main.

If owner wants `default_waste_pct` on `products` (so it auto-fills the recipe_ingredients.waste_pct at link time), that's the one column worth adding now — same-commit DB+TS, additive. Flagged as the single judgement-call item to confirm before Step 1.
