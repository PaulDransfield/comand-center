# POS → Recipe mapping plan

> Status: PLAN ONLY (not implemented). Written 2026-05-24 during the
> stock-count build to scope the variance loop. Revisit when the owner
> wants theoretical food cost % side-by-side with actual, which the
> count + waste log already enable as soon as this lands.

## The closing the loop

We now have, from this session:

- **Catalogue** (`products`) with priced items + recipe-sourced items
- **Recipes** (`recipes` + `recipe_ingredients`) with cost-per-portion
- **Stock counts** (`stock_counts` + `stock_count_lines`) with cost snapshots
- **Waste log** (`waste_log`) with cost snapshots
- **Invoices** (`supplier_invoice_lines`) — purchases, fully attributed

What we DON'T have: a way to know what got SOLD via the POS in recipe terms.

```
Purchases (Fortnox)  ─────────►   ┐
Last count (counts)  ─────────►   ├──► theoretical_remaining
Sales × recipes      ──── ??? ──► │
Waste (waste_log)    ─────────►   ┘

Actual remaining (this count) ────────►  Difference = SHRINKAGE
```

When you sell a Margherita on the POS, you've theoretically consumed:
240 g flour + 110 g mozzarella + 120 g San Marzano + 12 ml olive oil
+ 4 g basil. Multiplied by 50 Margheritas sold last week = real
ingredient draw on the walk-in. Compared to the actual count delta:
shrinkage (or over-portioning, or waste, or theft).

## The data on hand

### POS sale lines
Personalkollen syncs revenue per business/date but typically NOT per
menu item. Inzii/Onslip would, but we backed away from Inzii in
Session 11 (`project_inzii_dropped.md`). Future POS connectors should
absolutely surface per-item lines.

For now, simplest source of menu-item granular sales: **owner manually
maps high-volume menu items** OR Fortnox invoice categories if dishes
are sold per-event with itemised lines (rare).

### What we'd build

#### Schema (sketch)

```sql
-- M0xx — pos_menu_items
CREATE TABLE pos_menu_items (
  id            UUID PRIMARY KEY,
  business_id   UUID NOT NULL REFERENCES businesses(id),
  pos_provider  TEXT NOT NULL,       -- 'manual' | 'inzii' | 'onslip' | 'caspeco'
  pos_item_id   TEXT,                -- provider's stable id
  name          TEXT NOT NULL,
  recipe_id     UUID REFERENCES recipes(id),  -- owner-mapped
  price_inc_vat NUMERIC,             -- menu price (mirror of recipe.menu_price if not overridden)
  archived_at   TIMESTAMPTZ,
  UNIQUE (business_id, pos_provider, pos_item_id)
);

-- M0xx — pos_sales (line-level)
CREATE TABLE pos_sales (
  id            UUID PRIMARY KEY,
  business_id   UUID NOT NULL REFERENCES businesses(id),
  sold_at       TIMESTAMPTZ NOT NULL,
  sold_date     DATE GENERATED ALWAYS AS (sold_at::date) STORED,
  pos_item_id   UUID REFERENCES pos_menu_items(id),
  quantity      NUMERIC NOT NULL,
  net_revenue   NUMERIC,
  ...
);
```

#### Sync paths

1. **Manual entry**: owner types weekly numbers per dish on a simple
   form. Crude but unblocks the variance calc immediately for restaurants
   that don't have a connectable POS.
2. **POS connectors**: incremental — Caspeco, Onslip, Bonebar, etc.
   Each adapter normalises into `pos_sales` and (one-time) into
   `pos_menu_items` with `pos_item_id`.
3. **Auto-map by name**: when a new POS item name lands, fuzzy-match
   against existing recipes; require owner confirmation before linking.

#### Theoretical usage calc

```ts
// For period [start, end], business B:
const sales = await db.from('pos_sales')
  .select('pos_item_id, quantity, pos_menu_items!inner(recipe_id)')
  .eq('business_id', B)
  .gte('sold_date', start).lte('sold_date', end)

// Aggregate by recipe → sum quantity → multiply by recipe's
// ingredient consumption (kg of flour per Margherita = 0.24,
// 50 sold = 12 kg).
const theoretical = computeTheoreticalIngredientUsage(sales, recipeIndex)
// → Map<product_id, base_unit_qty_used>

// Variance per product:
const purchased  = sumOfSupplierInvoiceLines(B, start, end)  // qty in base unit
const wasted     = sumOfWasteLog(B, start, end)              // qty in base unit
const actualDraw = lastCount[product] - thisCount[product] + purchased  // what physically left
const expectedDraw = theoretical[product] + wasted

const variance = actualDraw - expectedDraw    // positive = shrinkage
```

#### UI: `/inventory/variance`

Per-product table:
- Theoretical (from POS × recipes)
- Waste
- Expected total
- Actual (count delta + purchases)
- Variance (kr value + %)
- Drill: which dishes drove the theoretical, which invoices the purchases

## Implementation order

1. **`pos_menu_items` table + CRUD UI** — owner can list dishes + map them to recipes. Standalone value: clean list of "what we sell". (1 day)
2. **Manual weekly sales entry** — form per pos_menu_item per week. Enables variance for owners without POS connector. (0.5 day)
3. **Variance report** at `/inventory/variance` — uses what we have. (1 day)
4. **Caspeco connector** (if Chicce uses it) — first real auto-sync. (1-2 days)
5. **Auto-name-match suggestion** for new POS items. (0.5 day)

## Risks

- **Stock counts must be regular** for variance to work. If the last
  count was 3 months ago, variance is too noisy. The mobile-first
  count UX we just shipped reduces friction; hopefully weekly counts
  become realistic.
- **Menu items vs recipes 1:1** isn't always true. Combo deals (pizza
  + drink), modifications (extra cheese), half-portions — these need
  either weighted recipes or per-line modifier rules. Defer to phase 2.
- **Inventory level tracking between counts** = the holy grail, but
  requires every purchase + sale + waste event to flow into a perpetual
  ledger. Too expensive for restaurant scale today; counts give us 80%
  of the value at 10% of the complexity.

## Why we're parking this

The variance loop is genuinely valuable but it depends on POS data we
don't have for Chicce yet, AND on the owner doing regular counts (which
they've not been doing — the mobile-first count UX we just shipped is
the precondition).

Sensible sequence:
1. Get Chicce doing weekly counts (this week's shipped work)
2. Get the waste log used regularly
3. THEN map a POS or build the manual sales entry
4. Variance dashboard once 2-3 weeks of data exists

Revisit when:
- Chicce has completed 4+ counts and asked "what does this tell me?"
- Second customer onboards with a connectable POS
- Owner explicitly asks for theoretical food cost %

Estimated effort to ship the full loop: ~5-7 days depending on which
POS connector lands first. Manual-only is ~2 days.
