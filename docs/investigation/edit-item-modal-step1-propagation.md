# Edit-Item Modal — Step 1 Build + Propagation Report

Run: 2026-06-01
Branch: `edit-item-modal` (pre-merge, preview deploy on push)
Per `edit-item-modal-prompt.md` + `edit-item-modal-propagation-addendum.md`.

## Three-line summary

1. **Mechanism 1 (price + waste propagation by computation) is structurally clean and confirmed by audit.** Every consumer of recipe cost calls `computeRecipeCost` + `getProductLatestPrices` LIVE on each request — `app/api/inventory/recipes/route.ts`, `recipes/[id]/route.ts`, `recipes/preview/route.ts`, `recipes/search/route.ts`, `items/route.ts` (for recipe-sourced items), `counts/[id]/route.ts`, `waste/route.ts`. `loadRecipeIndex` walks the full ingredient tree on every cost call, so transitive sub-recipe consumers re-cost from the same updated product price as direct consumers. There is NO persisted recipe cost / dish margin / food-cost % anywhere outside two intentional accounting snapshots (`inventory_counts.unit_price_at_count`, `waste_log.unit_price_at_entry`) which are correct accounting facts (frozen at count/waste event time) — not display caches.
2. **Mechanism 2 (article repoint + disconnect) propagates by single-row UPDATE with zero synchronous cascade.** `supplier_invoice_lines.product_alias_id` → `product_aliases.product_id` is resolved at every cost read; repoint changes one pointer and all downstream surfaces see the new attribution on next render. Endpoints (`POST /api/inventory/product-aliases/[id]/repoint`, `POST /api/inventory/product-aliases/[id]/deactivate`) complete in milliseconds regardless of how many historical lines the alias has. Cross-business UPDATEs are rejected (business-ownership check on alias AND target product); inactive aliases reject repointing; pointing-to-current-product is a no-op idempotent return.
3. **Risk 3 (cached recipe cost) is clean.** Audit found zero places persisting recipe cost / dish margin outside the two intentional accounting snapshots. No cron writes derived cost. No agent (anomaly detection, Monday briefing, scheduling) stores dish-level cost. Mechanism 1 fully covers cost propagation — no invalidation hooks needed.

## What's built in Step 1

### Migration (owner applies in Supabase SQL Editor before merge)

`sql/M110-PRODUCT-DEFAULT-WASTE-PCT.sql` — adds `products.default_waste_pct` (numeric, NOT NULL DEFAULT 0, CHECK 0..<100). Bounds match `recipe_ingredients.waste_pct` exactly so the auto-fill at link time stays within the recipe-level constraint with no coercion. Additive, no destruction, reversible.

### Engine helpers (`lib/inventory/recipe-cost.ts`)

- **`getProductPriceTrend(db, biz, productId, windowDays=7)`** → `ProductPriceTrend | null`. Splits matched supplier_invoice_lines into latest vs prior windows; returns `null` for too-little-history. Per-line price derived as `total_excl_vat / quantity` (the ground truth, post-merge backfill).
- **`getProductReliabilitySignal(db, biz, productId)`** → `ProductReliabilitySignal`. **First-class requirement.** Two independent checks; if EITHER fires, returns `{ reliable: false, reason }`:
  1. Per-line internal consistency: latest matched line has `quantity × price_per_unit ≉ total_excl_vat` (>5% off). Catches the Marini/Rima per-line bug directly without needing the parent extraction record.
  2. Parent extraction was flagged: invoice has `invoice_pdf_extractions.validation_warnings` containing `over_extraction` or `total_mismatch`.

### Endpoints

- **`GET /api/inventory/items/[id]/edit-context`** — one-shot aggregator. Returns product, latest_cost, trend (or null), reliability, aliases (with per-alias latest price), used_in_recipes (direct + transitive). One round-trip → snappy modal open.
- **`POST /api/inventory/product-aliases/[id]/repoint { product_id }`** — atomic UPDATE on product_aliases.product_id. Business-ownership checked on both alias and target product; cross-business rejected. Idempotent on retry.
- **`POST /api/inventory/product-aliases/[id]/deactivate { reason? }`** — sets `is_active=false` + `deactivated_at` + `deactivated_reason`. Historical lines stay linked for audit. Idempotent.
- **`PATCH /api/inventory/items/[id]`** extended to accept `default_waste_pct`.

### Component

- **`components/EditItemModal.tsx`** — shared modal. Honest-incomplete-state baked in:
  - `reliability.reliable === false` → renders coral "Incomplete cost" box with the reason instead of any number
  - `trend === null` → renders "ingen prishistorik · need 2+ purchases to compute trend" instead of "0,0%"
  - `latest_cost === null` → renders "No price yet" guidance
  - Per-alias latest price uses derived `total_excl_vat / quantity` (ground truth)
- Uses `UXP.*` design tokens, `fmtKr`, no new libraries, lavender system.

### Mount point (v1)

- Recipes drawer `IngredientRow`: new ⚙ button next to the existing ✎. ⚙ opens the modal; ✎ keeps the existing inline pack/base/price expand (back-compat). After modal saves, drawer reloads → recipe cost re-renders against the updated product price.

### Mount point deferred (v2)

- `/inventory/items` page mount — not in this commit; the recipe-authoring flow is where modal value is immediate. Items page mount is a one-line addition in v2.

## Propagation acceptance — tests to run on the preview

The addendum requires evidence, not just architecture. The preview URL is the test bench:

### Mechanism 1 test (price/waste → live recompute)

1. **Direct consumer:** open a recipe at Chicce that uses Pizza sauce Classica (we have one). Note current food cost + GP%. Open Pizza sauce via ⚙. Change `price_override` to 200 (or some test value). Save. Drawer reloads. Confirm food cost + GP% changed in line with 200 × the recipe's grams.
2. **Transitive consumer:** if a sub-recipe in Chicce uses an ingredient, edit that ingredient via ⚙ from inside the parent dish. After save, the parent dish's food cost should reflect the change. (loadRecipeIndex walks the full tree on every cost call — this is structurally guaranteed but worth eyeballing once.)
3. **Waste:** change a product's `default_waste_pct` from 0 → 10. Add it to a new recipe (don't touch existing rows — those have their own waste_pct already set). Confirm the new line auto-fills `waste_pct=10` and the line cost inflates by `1/0.9 ≈ 1.111×`.

### Mechanism 2 test (article repoint → live reattribution, no Save hang)

1. Pick a product with 2+ aliases at Chicce (76 such products per Step 0 audit). Open it via ⚙.
2. Disconnect one alias via the × button. Confirm the modal stays responsive (no spinner past ~100ms). Confirm the alias disappears from the list. Reload — confirm price reads from remaining alias(es). Recipes that used this product re-cost from the new price.
3. (Repoint not yet wired in the modal UI — endpoint exists; "Connect a different article" picker is a v2 enhancement. Server-side test: `curl POST` against the endpoint with a same-business product target → returns ok with dependent_lines_count.)

### Reliability acceptance — the test that proves the modal is safe

1. **Known-clean item:** open Trädgårdshallen 3599's "Citron Belsan" via ⚙ (or any M&S product extracted with full reconciliation). Modal MUST show a real cost (e.g. 34,35 kr/KG = 0,0344 kr/g) and a trend or "ingen prishistorik" — never a confident-wrong number, never "0,0%" on no history.
2. **Known-broken item:** open a Laweka Marini/Rima passthrough item (any product whose latest line came from invoice 3174, 2902, 2948, 2975, 3278). Modal MUST show **"Incomplete cost — Latest invoice line is internally inconsistent..."** with the reason. If it shows a confident price, the reliability gate has a hole.

Both must pass. If both do, the modal is safe to use across the catalogue regardless of which suppliers' extractions are still being fixed — that's the property that makes it the durable editor.

## Mechanism 1 audit details (Risk 3)

Files calling `computeRecipeCost` or `getProductLatestPrices`:

| File | Pattern |
|---|---|
| `lib/inventory/recipe-cost.ts` | engine |
| `app/api/inventory/recipes/route.ts` | live read |
| `app/api/inventory/recipes/[id]/route.ts` | live read |
| `app/api/inventory/recipes/search/route.ts` | live read |
| `app/api/inventory/recipes/preview/route.ts` | live read |
| `app/api/inventory/items/route.ts` | live read (recipe-sourced items) |
| `app/api/inventory/items/[id]/edit-context/route.ts` | live read (new — this commit) |
| `app/api/inventory/counts/[id]/route.ts` | **intentional snapshot** (`unit_price_at_count`, `line_value_at_count`) — accounting fact, NOT a display cache |
| `app/api/inventory/waste/route.ts` | **intentional snapshot** (`unit_price_at_entry`, `value_at_entry`) — accounting fact |
| `app/api/inventory/products/search/route.ts` | live read |
| `app/api/inventory/product-aliases/[id]/repoint/route.ts` | n/a (UPDATE only) |
| `app/api/inventory/product-aliases/[id]/deactivate/route.ts` | n/a (UPDATE only) |

Search of `--include='*.ts'` for `recipe.*food_cost`, `recipe.*gp_pct`, `recipe_cost`, `dish_cost`, `menu_cost` in INSERT/UPDATE/upsert contexts: zero hits.

No agent (anomaly detection, Monday briefing, scheduling optimisation, supplier price creep, forecast calibration) writes dish-level cost or recipe margin. No materialised view persists derived cost.

**Verdict: live-on-read end to end. Mechanism 1 is the propagation, no invalidation hooks needed.**

## What was NOT done (intentional)

- Items page mount — v2.
- "Connect a different article" picker UI — server endpoint is live; UI picker is v2.
- Cost group / inventory_list / description / notes / tags columns — explicitly deferred per Step 0 owner decision.
- Blast-radius cost preview (numeric delta to each used-in recipe) — v2; the qualitative "Used in recipes" list ships now.

## Hard rules check

- ✓ One shared component, mounted in recipes drawer; items page mount queued for v2 with the same component.
- ✓ Renders only schema-supported fields; `default_waste_pct` added via M110 same-commit DB+TS.
- ✓ Alias writes are atomic UPDATEs; no `.upsert` against partial unique indexes.
- ✓ Honest incomplete-cost first class — reliability + trend null state.
- ✓ Delete = archive via `archived_at` (PATCH `archived: true`).
- ✓ Business-ownership checks on every mutation (`requireBusinessAccess`).
- ✓ CC design tokens (`UXP.*`), Swedish formatting (`fmtKr`), no new libraries.
- ✓ Feature branch + preview, no prod deploy without review.

## To apply

1. Owner runs `sql/M110-PRODUCT-DEFAULT-WASTE-PCT.sql` in Supabase SQL Editor (additive, safe on prod).
2. Owner opens the preview URL, runs the four acceptance tests above.
3. If both reliability tests pass + both mechanism tests pass, merge to main.
