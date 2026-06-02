# Claude Code — Item-Management Surface Audit (READ-ONLY)

## Purpose

We're considering an upgrade to item management, modelled on QVANTI's "Recipes & Items" area — which has a **four-tab top-level surface**: Recipes / Items / Supplier Articles / Purchase Lists, with the Items tab being a searchable, filterable, paginated table of ALL items (unit, inventory list, cost group, price, a "Warning" filter), and the Edit Item modal opening *from* that list.

Before planning, **map what CommandCenter already has** so we upgrade the real gap, not rebuild what exists. We already built an Edit Item modal recently (item details + supplier-article connect + used-in-recipes + price/trend) — confirm its current state. The likely gap is a **first-class Items *list* surface** (browse/search/filter/bulk-manage the whole item library outside the recipe context), plus the tab organisation. Audit, don't build.

## HARD RULES
- **READ-ONLY.** Read code/routes/components + schema. No writes, no build, no migrations.
- Print every file/route/component inspected.
- Deliverable: `docs/investigation/item-management-audit.md` + a three-line chat summary mapping existing → gap.

## Step 1 — What item-management UI exists today

Inventory the current surfaces and components:
1. **The Edit Item modal** (built recently — `<EditItemModal>` / `/api/inventory/items/[id]/edit-context`): what does it currently render and write? (name, category, unit, pack_size, base_unit, price_override, default_supplier, article-connect/repoint/disconnect, used-in-recipes, price-trend, default_waste_pct). Confirm against the recent edit-item build — what shipped vs what was deferred (cost_group, inventory_list, tags, description, can_be_inventoried).
2. **Is there any Items *list* surface?** A page that lists ALL products/items (not just within a recipe) — searchable, filterable, paginated, columns? Or are items only reachable via the recipe drawer / scattered? This is the suspected gap — confirm presence/absence.
3. **The recipes surface** (`/inventory/recipes` — screen shows Recipes list with GP%/food%/cost columns, dishes/sub-recipes/all tabs). Map what it currently shows.
4. **Supplier articles** — is there any surface listing supplier articles / `product_aliases` directly (the QVANTI "Supplier Articles" tab)? Or only via the item modal's connect widget?
5. **Purchase Lists** — the QVANTI 4th tab. We just built `/inventory/orders` (order list) — is that the equivalent, or different? Map it.

## Step 2 — Map QVANTI's four tabs onto CC reality

For each QVANTI tab, state what CC already has and what's missing:
| QVANTI tab | CC equivalent today | Gap |
|---|---|---|
| Recipes | `/inventory/recipes` | ? |
| Items | ? (suspected: no dedicated list) | ? |
| Supplier Articles | ? (only in modal?) | ? |
| Purchase Lists | `/inventory/orders`? | ? |

Be concrete: which are full surfaces, which are partial, which don't exist.

## Step 3 — Schema readiness for an Items list

If we build an Items-list surface, what's queryable now vs net-new:
1. The columns QVANTI's Items list shows — name, unit, inventory_list, cost_group, price, a warning/incomplete flag. Which of these exist on `products` today? (We know cost_group / inventory_list were deferred — confirm still absent.)
2. The "Warning" filter — what would drive it in CC? (Items with no connected article / no price / incomplete cost — the honest-incomplete signals we already compute.) Is that derivable now?
3. Item count + how items currently get created (the QVANTI "Create" button — does CC have item-creation outside the recipe flow, or do items only come into being via invoice extraction / recipe authoring?).

## Step 4 — Navigation / IA

- Where would an Items surface live in CC's nav? (The recipes/prep/orders moved under a "Recipes" section — would Items join that, or is "Recipes & Items" a renamed section like QVANTI's?)
- Does CC's current IA support a four-tab sub-structure, or would that be net-new layout?

## Deliverable

`docs/investigation/item-management-audit.md`:
- What the Edit Item modal does today (shipped vs deferred fields).
- Whether an Items-list surface exists (the suspected core gap).
- The four-tab map (Recipes / Items / Supplier Articles / Purchase Lists → CC reality).
- Schema readiness for an Items list (queryable-now vs net-new columns; what drives the warning filter).
- Nav/IA fit.

Three-line chat summary: (1) does CC already have an Items-list surface or only the in-recipe modal (the suspected gap); (2) of QVANTI's four tabs, which CC has / partially has / lacks; (3) for an Items-list build, what's queryable now vs net-new (cost_group/inventory_list still deferred?), and where it'd live in nav.
