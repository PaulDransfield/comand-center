# Item-management surface audit (READ-ONLY)

> 2026-06-02. Audit per `item-management-audit-prompt.md`. No writes, no migrations, no builds. Maps CommandCenter's current item-management surfaces against QVANTI's 4-tab structure (Recipes / Items / Supplier Articles / Purchase Lists). Confirms what exists, what's partial, and what's net-new.

## Files / routes / components inspected

| Surface | File |
|---|---|
| Items list page | `app/inventory/items/page.tsx` |
| Items list API | `app/api/inventory/items/route.ts` |
| Per-item detail page | `app/inventory/items/[id]/page.tsx` |
| Edit Item modal | `components/EditItemModal.tsx` |
| Recipes list page | `app/inventory/recipes/page.tsx` |
| Bulk-review queue (catalogue seed) | `app/inventory/review/page.tsx` |
| Non-inventory suppliers | `app/inventory/skipped/page.tsx` |
| Connect dishes to POS | `app/inventory/sales/page.tsx` |
| Stock counts / waste / variance | `app/inventory/counts/page.tsx` / `waste` / `variance` |
| Order list (purchase list equivalent) | `app/inventory/orders/page.tsx` |
| Order list API | `app/api/inventory/orders/build/route.ts` |
| Nav definition | `lib/nav/areas.ts` |
| Products schema | `sql/M075-INVENTORY-CATALOGUE.sql`, `M087`, `M089`, `M090`, `M110` |

---

## 1. Edit Item modal — what's shipped vs deferred

`components/EditItemModal.tsx` is mounted from two places:
- `/inventory/recipes` (in the recipe drawer's ingredient row expand)
- Conceptually also opens from `/inventory/items` via the per-item detail page (but that detail page renders read-only history — the modal proper isn't currently launched from there in code, see §2)

### Shipped fields (editable in the modal)
- `name` — display name (UNIQUE on business_id + name)
- `category` — food / beverage / alcohol / cleaning / takeaway_material / disposables / other
- `invoice_unit` — kg / l / st / etc
- `pack_size` + `base_unit` — pack conversion (g/ml/st)
- `default_waste_pct` — applied to NEW recipe ingredient lines created after this save
- `price_override` (+ currency) — when set, wins over invoice-derived price
- Supplier articles section: list of linked `product_aliases` + "+ Link article" picker + repoint per alias (manual attribution; covers products with no auto-built alias)
- Used-in-recipes section: read-only list of recipes consuming this product (direct + transitive)

### Shipped read-only signals
- `latest_cost` — latest unit price + invoice unit + cost_per_base_unit
- `trend` — week-on-week price delta (NULL when too few data points; renders "ingen prishistorik" not "0,0%")
- `reliability` — `{ reliable, reason, evidence }`. When `reliable === false`, the cost header surfaces the reason instead of showing a confident-but-wrong number

### Confirmed deferred (NOT in schema, NOT in modal)
Per the prompt's expected gap:
- `cost_group` — bookkeeping bucket (could roll up Food cost / Beverage cost in P&L)
- `inventory_list` — which physical count sheet this item belongs to (Walk-in / Bar / Dry store)
- `can_be_inventoried` — boolean. Excludes consumables that don't get counted (e.g. cleaning supplies)
- `description` — long-form notes per product
- `tags` — owner-defined classification beyond `category`

None of those columns exist on `products` (verified by reading `sql/M075-INVENTORY-CATALOGUE.sql` + every subsequent `ADD COLUMN` migration M087/M089/M090/M110). Adding them is a net-new migration.

---

## 2. Items LIST surface — does it exist?

**Yes.** `app/inventory/items/page.tsx` is a real list surface. It is NOT the suspected gap. Contrast with QVANTI to see why it might *feel* like a gap:

### What `/inventory/items` already does
- **Live data** from `GET /api/inventory/items?business_id=X&category=Y`
- **Search** by name (client-side filter on the loaded set)
- **Filter** by category pills: all / food / beverage / alcohol / cleaning / takeaway_material / disposables / other — each with a count badge
- **Sortable columns** (toggled via `sortKey` + `sortDesc` state): name / latest_price / change_pct / observation_count / latest_date
- **KPI strip**: total items / observations / latest-price sum / hike count (items with change_pct ≥ 5 %)
- **"+ Add article"** button — opens a hand-rolled modal that POSTs to `/api/inventory/items` (find-or-create by name). Lets owners create products outside the invoice-matching flow (Vero edge case where invoices have no line text).
- **"Sort 'other' (N)"** — AI re-categorise button calling `/api/inventory/recategorise-other` (Sonnet web-search escalation)
- **"Backfill pack size"** — one-click parse pack size from product names
- **Per-row click** → `/inventory/items/[id]` (separate detail page with sparkline + full invoice-line history table, NOT the EditItemModal)

### What `/inventory/items` does NOT do
- **No "Warning" filter** as a first-class column/pill. The inputs exist:
  - missing default supplier: `products.default_supplier_name IS NULL`
  - no observations / no price: `observation_count = 0` OR `latest_price IS NULL`
  - reliability flag: `reliability.reliable === false` (already computed by `getProductReliabilitySignal` per-product, but only consumed by the modal — not the list)
  - no connected article: `aliases.length === 0` per product
- **No EditItemModal launch** from the list directly (clicking a row navigates to the detail page; the modal is mounted only from the recipe drawer). The wiring exists, the trigger doesn't.
- **No tabs** — the nav entry "Articles / Price creep" sits as a flat page under Inventory.
- **No pagination** — loads the whole catalogue per request. At Chicce ~1,200 products it's fine; at 10× this will start to need pagination.

### Verdict on the suspected gap
The QVANTI shape isn't "build an Items list" — that exists. The gap is:
- (a) wire the **EditItemModal launch from the list** (currently you go to a detail page; modal is only reachable via the recipe drawer)
- (b) add a **"Needs attention" filter** that surfaces incomplete-cost / missing-supplier / unreliable-extraction items
- (c) add the **deferred columns** (cost_group, inventory_list, can_be_inventoried, description, tags) if they're confirmed worth the schema work

---

## 3. Four-tab map: QVANTI → CommandCenter

| QVANTI tab | CC equivalent today | Status | Notes |
|---|---|---|---|
| **Recipes** | `/inventory/recipes` | ✅ Full | Dishes / Sub-recipes / All filter pills + cost calc + bulk-import + add recipe. Drawer-style detail. |
| **Items** | `/inventory/items` + `/inventory/items/[id]` | ⚠️ Partial | Full list + search + filter + sort + add + per-item detail. **Missing**: EditItemModal launch from the list, "Warning" filter, deferred columns (cost_group/inventory_list/can_be_inventoried/description/tags). |
| **Supplier Articles** | EditItemModal "Supplier articles" section + `/inventory/review` (seeding queue) | ❌ No standalone tab | Aliases (`product_aliases`) are only visible per-product inside the modal. Bulk-review queue at `/inventory/review` is a *seeding* surface (grouped by `supplier × normalised_description × unit` for approval), not a browsable alias library. **Net-new**: a queryable "all supplier articles" surface with their product attribution + latest price + supplier. |
| **Purchase Lists** | `/inventory/orders` | ⚠️ Partial | Single live-regenerated supplier-grouped guide from prep sessions + pre-orders. **Missing**: persistence (no `prep_orders` table — each generate produces a fresh ephemeral list), draft / sent / received states, multi-list-per-supplier, history. |

So:
- 1 full (Recipes)
- 2 partial (Items, Purchase Lists)
- 1 absent (Supplier Articles browsable surface)

---

## 4. Schema readiness for an upgraded Items list

### Already queryable
- `products.name`, `category`, `category_overridden`
- `products.invoice_unit`, `count_unit`, `unit_conversion`
- `products.pack_size`, `base_unit` (M087)
- `products.default_supplier_name`, `default_supplier_fortnox_number`
- `products.default_waste_pct` (M110)
- `products.price_override`, `price_override_currency`, `price_override_set_at` (M090)
- `products.source_recipe_id` — recipe-promoted product marker (M089)
- `products.archived_at` — soft delete
- Derived per-request in `/api/inventory/items`: `latest_price`, `latest_unit`, `latest_supplier`, `latest_date`, `prior_median_price`, `change_pct`, `observation_count`, `is_recipe_sourced`

### Net-new (would require migration)
- `cost_group TEXT` — if needed for P&L roll-up bucketing beyond the `category` axis
- `inventory_list TEXT` — physical count location ("Walk-in", "Bar", "Dry store"). Would also need a per-business list of valid values, OR a free-text + autocomplete pattern
- `can_be_inventoried BOOLEAN NOT NULL DEFAULT TRUE` — count sheets exclude items with this `= FALSE` (cleaning, single-use packaging, etc.)
- `description TEXT` — long-form prose. Like `recipes.method` (already capped 20k chars)
- `tags TEXT[]` — owner-defined classification. Would also need a per-business tag library or just trust free-text

All five would be ADD COLUMN IF NOT EXISTS on `products`. Each is independent (no cross-column constraints). None blocks the others.

### "Warning" / "Needs attention" filter — derivable now

All four inputs are computable from existing data without new columns:

| Signal | Source | Cost |
|---|---|---|
| No connected supplier article | `product_aliases.count = 0` per product | One join per row |
| No latest price | `aliases-derived` latest_price IS NULL (already in `/api/inventory/items`) | Free (already computed) |
| Missing default supplier | `products.default_supplier_name IS NULL` | Free |
| Reliability flagged | `getProductReliabilitySignal()` — per-product line-consistency check + extraction warnings | Per-row call (already done inside EditItemModal; would need batching for list view) |

The reliability one is the only mildly expensive one. Could be batched or moved server-side into the items list response with a `needs_attention` flag.

### Item count + creation paths

- **Chicce**: ~1,200 products (estimate from prior session work). Single page-load fine; pagination becomes useful at ~5,000+
- **Creation paths today** (3):
  1. Auto from matcher: `created_via='auto_exact'` or `'auto_fuzzy'`
  2. Owner approves a group in `/inventory/review`: `created_via='owner_review'`
  3. Manual hand-create via `POST /api/inventory/items` (the "+ Add article" button): `created_via='manual'`
  4. Promoted from recipe: `created_via='fortnox_backfill'` (M089 path)
- All four paths flow through the same `products` row shape — no schema-level differences

---

## 5. Navigation / IA fit

### Current nav (`lib/nav/areas.ts`)

**Inventory area** (`box` icon):
- Articles / Price creep → `/inventory/items`
- Article review → `/inventory/review`
- Non-inventory suppliers → `/inventory/skipped`
- PDF review → `/inventory/extractions`
- Connect dishes to POS → `/inventory/sales`
- Stock counts → `/inventory/counts`
- Waste → `/inventory/waste`
- Variance → `/inventory/variance`

**Recipes area** (`chef-hat` icon, lifted out of Inventory 2026-06-01):
- Recipes → `/inventory/recipes`
- Prep list → `/inventory/recipes/prep`
- Order list → `/inventory/orders`

### Fit options for a QVANTI-style 4-tab Item Management area

**Option A — Tabs inside an existing area**:
Rename the "Recipes" area to "Recipes & Items" and add tabs:
- Recipes (current)
- Prep list (current)
- Order list (current)
- + Items
- + Supplier Articles

Pros: Mirrors QVANTI's mental model. Items / Articles / Recipes all live in one area.
Cons: 5 entries inflates the dropdown. Stock counts / waste / variance stay in Inventory which feels arbitrary.

**Option B — Two-level tab pattern inside a "Catalogue" landing page**:
New top-level area "Catalogue" with horizontal sub-tabs:
- Items
- Supplier Articles
- Recipes
- Purchase Lists

Pros: Closer to QVANTI's literal IA.
Cons: Net-new layout pattern. Doesn't exist anywhere else in CC today; sub-tab framework would need building.

**Option C — Keep current split, fill the gaps in place**:
- Items already at `/inventory/items` — wire EditItemModal launch + Warning filter
- Supplier Articles → new page `/inventory/supplier-articles` under Inventory area
- Purchase Lists → already at `/inventory/orders` under Recipes area
- Recipes → already under Recipes area

Pros: Lowest IA churn. No new layout pattern. Each surface is reachable today; gaps fill in their natural homes.
Cons: Doesn't fully match QVANTI's "everything in one area" — owners switching from QVANTI would scan two sidebar areas instead of one.

CC's current IA supports Option C without any new layout work (every page already gets `AppShell` + 2-level nav). Options A and B both require sub-tabs at the page level — pattern not currently used in CC.

---

## Summary deltas (what's actually missing)

If pursuing a QVANTI-like upgrade:
1. **EditItemModal launch from `/inventory/items`** (~15 min — already wired in the recipe drawer; mount + trigger on list-row click)
2. **"Needs attention" filter** on `/inventory/items` (~1–2 h — derivable from existing data; UI pill + server-side computation in the items API)
3. **Standalone Supplier Articles surface** (~1 day — new page + new API endpoint listing `product_aliases` grouped by supplier with product attribution + price)
4. **Order list persistence** (~1 day — new `prep_orders` table + endpoints + draft/sent/received state UI)
5. **Deferred product columns** (variable — schema migration + UI fields per column; biggest single piece is `inventory_list` because it implies a per-business list registry)

Items 1 + 2 are the cheapest wins and address the visible UX gap of "I have to navigate to a separate detail page to edit an item". Item 3 is the only fully net-new surface. Items 4 + 5 are larger and orthogonal — driven by different workflows.
