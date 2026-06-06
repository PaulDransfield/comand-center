# Prep page mobile redesign — investigation (READ-ONLY)

> 2026-06-06. Maps the current prep flow to the approved mobile redesign:
> covers-first hero with smart chips, pre-orders folded in as a committed
> floor, a "my usual" preload, "repeat last [weekday]", a sticky send bar,
> and a bartender "top up to par" mode. Verdict tags: **CHEAP REWIRE** /
> **NEEDS NEW DATA** / **NEEDS NEW FEATURE**. No code changes.

---

## TL;DR — summary table

| Redesign element              | Verdict             | Depends on                                                                                                                 |
|-------------------------------|---------------------|----------------------------------------------------------------------------------------------------------------------------|
| Mobile-first layout           | CHEAP REWIRE        | `useViewport()` + `breakpoints.ts` already exist; SSR default is `'mobile'`. Page-level layout swap, no schema.             |
| Covers smart chips (Quiet / Normal / Busy / Slammed) | NEEDS NEW DATA (light) | Per-business per-weekday baselines derived from `daily_metrics.covers` history (already populated). One new RPC.            |
| Pre-order fold-in (committed floor) | CHEAP REWIRE  | Already implemented in `applyCovers()` — pre-orders are ADDITIVE on top of free-cover share. Just needs UI surfacing.       |
| Sticky send bar (Save & start prep) | CHEAP REWIRE  | Existing `saveSession()` mutation; CSS `position: sticky` + `env(safe-area-inset-bottom)`. No new data.                     |
| "My usual" preload            | CHEAP REWIRE        | Past prep_sessions exist and are queryable. Derive top-N dishes by historical session frequency.                            |
| "Repeat last [weekday]"       | CHEAP REWIRE        | Same `prep_sessions.inputs` JSONB — pull most recent session for matching weekday.                                          |
| Bartender "top up to par"     | **NEEDS NEW FEATURE** | NO par-level column exists. NO stock-on-hand capture exists. Two new schema additions + an owner-facing capture surface.   |

**Direct answers:**

- **Does cover history exist?** YES. `daily_metrics.covers`, `monthly_metrics.covers`, `hourly_metrics.covers` all populated by POS sync. `lib/forecast/hourly.ts` already produces `predicted_covers` per hour. Plenty of signal for weekday baselines.
- **Do prep sessions persist?** YES. `prep_sessions` (M116) stores one row per run with `inputs` JSONB (`[{recipe_id, qty}]`). Soft-completed via `completed_at`. Per-business indexed. Full history queryable.
- **Do pre-orders feed quantities?** YES, **ADDITIVELY**. Settled in `applyCovers()` at `app/inventory/recipes/prep/page.tsx:294-314`. Math: `freeCovers = max(0, covers − Σ party_size)`, share-driven qty on `freeCovers`, **then add pre-order items on top per dish**. **Answer to the earlier fork:** it's `share-on-(covers − party_size) + pre-order items`, NOT `max(estimate, committed)` and NOT `estimate + committed` over the same covers — pre-orders consume their seats so they're never double-counted.
- **Do par levels / stock-on-hand exist?** NO. Searched `sql/` for `par_level` / `par` / `stock_on_hand` / `inventory_count` / `on_hand` — zero hits. Bartender mode is the most expensive item on the list.

---

## 1. Current prep page anatomy

### Component tree

```
PrepListPage  (default export, wraps in PageErrorBoundary)
└─ PrepListPageInner  (the real component, 1500+ LOC in app/inventory/recipes/prep/page.tsx)
   ├─ <AppShell>             — RailNav + sidebar + selected-biz state
   │  └─ <PageContainer>
   │     ├─ Header row (h1 + subtitle + right-side action buttons)
   │     ├─ Food / Drinks view toggle
   │     ├─ Error banner
   │     ├─ PREP MODE branch  (when activeSession exists)
   │     │  ├─ Active-session card with progress bar + dish list
   │     │  ├─ <TabPill> strip (Components / Raw ingredients)
   │     │  └─ <Section> list of <PrepLine>-shaped rows (44px checkbox + 1fr body + 130px qty)
   │     │
   │     └─ CREATE MODE branch  (no active session)
   │        ├─ Left pane (sticky): dish picker + qty inputs
   │        │  ├─ Pre-orders sub-card (M118)
   │        │  │  ├─ Service-date picker
   │        │  │  ├─ Existing pre-order rows
   │        │  │  └─ Inline draft form (party + size + items)
   │        │  ├─ Covers input + Apply button (M117)
   │        │  ├─ Search box
   │        │  └─ Dish list (per-view, with mix-share % editor)
   │        └─ Right pane: aggregated prep preview (components + products tabs)
   │
   └─ Line-edit modal  (rendered when openModal is set; works both modes)
```

### State shape (`PrepListPageInner`)

| State                           | Type                              | Purpose                                              |
|---------------------------------|-----------------------------------|------------------------------------------------------|
| `bizId`                         | `string \| null`                  | Selected business (from `localStorage.cc_selected_biz`) |
| `dishes`                        | `DishRow[]`                       | All dish-shaped recipes for the biz (after `isDish()` filter) |
| `selected`                      | `Record<recipe_id, qty>`          | The Production input — recipe → portion count        |
| `coversInput`                   | `string`                          | M117 covers number (string for typing tolerance)     |
| `serviceDate`                   | `string` (`YYYY-MM-DD`)           | Tomorrow by default — pre-orders + future session date |
| `preOrders`                     | `PreOrder[]`                      | M118 advance commitments for `serviceDate`           |
| `draftPreOrder`                 | `DraftPreOrder \| null`           | The inline add-pre-order form                        |
| `activeSession` + `sessionLines`| `PrepSession \| null` + `PrepSessionLine[]` | Frozen prep run when in PREP MODE          |
| `result`                        | `PrepResult \| null`              | Live aggregation output in CREATE MODE               |
| `view`                          | `'food' \| 'drinks'`              | Top-level bucket filter (chef vs bartender)          |
| `tab`                           | `'components' \| 'ingredients'`   | Inner tab on both the preview + frozen lines         |
| `search`                        | `string`                          | Dish-picker filter                                   |
| `openModal`                     | `{ line, session_line_id }` `\| null` | Unified line-edit modal state (PREP + CREATE)    |

### End-to-end flow

1. **Load.** `bizId` arrives from localStorage. `loadDishes()` GETs `/api/inventory/recipes?business_id=X`, filters client-side via `isDish()`. `loadActiveSession()` GETs `?active=1`; if a session exists the page enters **prep-mode**, else **create-mode**.
2. **Create-mode entry points (any combination):**
   - **Manual picker.** Tap a dish row → `selected[id] += 1`. Stepper UI in the dish list.
   - **Covers auto-fill (M117).** Type covers count → tap "Apply" → `applyCovers()` distributes per `recipes.portions_per_cover`, then layers pre-orders. Overwrites `selected`.
   - **Pre-orders (M118).** Inline form creates rows in `prep_pre_orders`. They appear in the list and are folded by Apply.
3. **Live preview.** Every change to `selected` triggers `compute()` (350ms debounce) → POST `/api/inventory/prep-list` with `{business_id, items}` → server runs `aggregatePrepRequirements()` → returns `{components, products, flags}` → renders preview.
4. **Save.** Tap "Save & start prep" → POST `/api/inventory/prep-sessions` with `{business_id, items}`. Server **re-runs the engine** and writes the frozen result into `prep_session_lines`. Returns `{session, lines}`. Local state flips to prep-mode.
5. **Prep-mode (kitchen tablet).** Each line has a 44px checkbox column + a body that opens the modal. `toggleLine()` PATCHes `/api/inventory/prep-sessions/{id}/lines/{lineId}/toggle`. Progress bar fills as lines tick off.
6. **Complete or Discard.** PATCH `{ complete: 'now' }` or DELETE the session.

### What "submit / send" does

**Endpoint:** `POST /api/inventory/prep-sessions` with `{ business_id, items: [{recipe_id, qty}] }`.

**Server work** (search confirms it's the canonical write path):
- Validates dishes belong to the business.
- Loads the recipe index (same one the cost engine uses).
- Calls `aggregatePrepRequirements(items, recipeIndex, recipeNames)` from `lib/inventory/prep-list.ts`.
- Inserts one `prep_sessions` row.
- Inserts N `prep_session_lines` rows (one per component + one per product), with `total_qty`, `unit`, `uncertain` flags, and `source_recipe_ids` arrays.
- Returns `{ session, lines }`.

**The engine's contract:**

```ts
aggregatePrepRequirements(
  input:       [{ recipe_id, qty }],
  recipeIndex: RecipeIndex,                // shared with computeRecipeCost
  recipeNames: Map<recipeId, string|null>,
): {
  components: PrepComponentLine[],         // sub-recipes to prep, summed
  products:   PrepProductLine[],           // raw ingredients to pull, summed
  flags:      [{ recipe_id, reason }],     // cycles / no-yield / unit mismatch
}
```

Single source of truth for prep math. **Live preview and frozen save both use this same function.** A redesign must not bypass it.

### Frozen-quantity / live-text session boundary (CRITICAL invariant)

From CLAUDE.md Session 24:

> Quantities = frozen at session save (`prep_session_lines.total_qty`). Text (method, notes, uses, archived_at) = read live on every GET. Owner mid-service edits to `recipes.method` / `recipe_ingredients.notes` surface immediately on next refresh; qtys stay stable because the engine's intent at save time is what the kitchen committed to.

**What this protects:** the chef checks off "300g basil" mid-service. The owner edits the recipe at 14:00 and changes basil to 600g. Without the freeze, the kitchen tablet would re-render "600g" and the check mark would silently re-apply to a different number.

**What a redesign must NOT break:**
- `total_qty`, `unit`, `name_snapshot`, `source_recipe_ids` written at session save → never re-computed from current state.
- Text fields (`method`, `notes`, sub-recipe `ingredients` notes, product `uses`) read live on every GET via the server's enrichment join.
- `meta.archived_at` for sub-recipes is read live and surfaces as a coral banner in the modal (H3 audit fix).

**Verdict:** the redesign is presentational — it can re-arrange how this state is collected and displayed, but every write path must still go through `POST /api/inventory/prep-sessions` so the engine + freeze happen on the server. **CHEAP REWIRE.**

---

## 2. Covers + mix share

### Mix-share storage

| Field                        | Where                          | Type                          | Constraint                              |
|------------------------------|--------------------------------|-------------------------------|-----------------------------------------|
| `recipes.portions_per_cover` | M117                           | `NUMERIC` nullable             | `CHECK (NULL OR (0 ≤ x ≤ 10))`          |

Value semantics: `0.15` = 15% of guests order this dish. `NULL` = no share set, dish skips the auto-fill. The 10× ceiling exists to catch the "typed 15 thinking percent" typo (commented in the SQL).

UI translation: owner types `15`, page stores `15 / 100 = 0.15` via `saveDishShare()`.

### Apply math (the existing implementation)

From `app/inventory/recipes/prep/page.tsx:294-314`:

```ts
const applyCovers = useCallback(() => {
  const covers = Number(coversInput)
  if (!Number.isFinite(covers) || covers <= 0) return

  const preOrderCovers = preOrders.reduce((s, p) => s + p.party_size, 0)
  const freeCovers     = Math.max(0, covers - preOrderCovers)

  const next: Record<string, number> = {}

  // 1. Share-driven walk-in distribution.
  for (const d of dishes) {
    const share = d.portions_per_cover != null ? Number(d.portions_per_cover) : 0
    if (share > 0) {
      const qty = Math.round(freeCovers * share)
      if (qty > 0) next[d.id] = qty
    }
  }

  // 2. Layer the committed pre-order items on top.
  for (const po of preOrders) {
    for (const it of po.items) {
      next[it.recipe_id] = (next[it.recipe_id] ?? 0) + it.qty
    }
  }

  setSelected(next)
}, [coversInput, dishes, preOrders])
```

Verdict: **CHEAP REWIRE.** Same function fits a "smart chip" model directly — chips just write to `coversInput` instead of typing. A "smart chip" UX surface could pre-compute four cover counts (Quiet / Normal / Busy / Slammed) and tapping one sets `coversInput` + immediately fires `applyCovers()`.

### Historical covers data — what's actually queryable

**Daily, persistent:**
- `daily_metrics(business_id, date, covers, …)` — POS-synced. Indexed `(business_id, date)`. **Per-weekday baseline is one `GROUP BY EXTRACT(DOW FROM date)` away.**

**Monthly, persistent:**
- `monthly_metrics(business_id, year, month, covers, …)`.

**Hourly, persistent (M071):**
- `hourly_metrics(business_id, business_date, hour, covers, transactions, …)`. Per-hour covers since 2026-04 for any business with POS.

**Predictive:**
- `lib/forecast/hourly.ts` produces `HourlyForecast { predicted_revenue, predicted_covers, … }` per hour with `'high' | 'medium' | 'low'` confidence. Already used by the AI scheduling agent. Not yet persisted to a forecasts table accessible from the prep page.

### Smart-chip seeding

A "Quiet / Normal / Busy / Slammed" 4-chip set is one read away. Proposed query (no new schema):

```sql
SELECT
  PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY covers) AS quiet,
  PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY covers) AS normal,
  PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY covers) AS busy,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY covers) AS slammed
FROM daily_metrics
WHERE business_id = $1
  AND EXTRACT(DOW FROM date) = EXTRACT(DOW FROM $2::date)
  AND date >= NOW() - INTERVAL '180 days'
  AND covers > 0
```

180-day window with same-weekday filter. New customers without 180d of POS history → fall back to "type covers manually" or use a global default. Honest-incomplete principle — never show fabricated chip numbers when the underlying data isn't there.

**Verdict for smart chips: NEEDS NEW DATA (light).** No schema change, but one new API route (e.g. `GET /api/inventory/prep/covers-baseline?business_id=X&date=Y`) + a feature gate that hides chips when the percentile query returns nulls / too few rows.

---

## 3. Pre-orders

### Schema (M118)

| Column        | Type                  | Notes                                                    |
|---------------|-----------------------|----------------------------------------------------------|
| `id`          | `UUID`                |                                                          |
| `org_id`      | `UUID FK org`         | RLS isolation                                            |
| `business_id` | `UUID FK biz`         |                                                          |
| `service_date`| `DATE NOT NULL`       | Day-bounded (lunch vs dinner is a future refinement)     |
| `party_name`  | `TEXT`                | "Sara's birthday" / NULL                                 |
| `party_size`  | `INTEGER NOT NULL`    | `CHECK (1 ≤ x ≤ 500)` (L8 audit)                         |
| `notes`       | `TEXT`                |                                                          |
| `items`       | `JSONB DEFAULT '[]'`  | `[{recipe_id, qty}]`. `CHECK jsonb_typeof = 'array'`     |
| `archived_at` | `TIMESTAMPTZ`         | Soft delete                                              |

Indexed for the prep-list path: `(business_id, service_date) WHERE archived_at IS NULL`.

### How pre-orders feed quantities

**ADDITIVELY** (settled — see Apply math above):

- Pre-order party sizes **consume seats**: `freeCovers = covers − Σ party_size`.
- Pre-order items are **then layered on top** per dish: `selected[recipe_id] += pre_order.qty`.

This is **not** `max(estimate, committed)` and **not** `estimate + committed` over the same covers. It's `(estimate over free covers) + (committed items per pre-order)` — pre-ordered seats stop generating walk-in share, and the committed items are added explicitly to whichever dishes were named.

**Worked example.** 100 covers, pre-orders: Sara's party of 8 ordering 4 Margherita + 4 Pinsa.
- `preOrderCovers = 8`; `freeCovers = 92`.
- Margherita share 30% → 28 Margherita from walk-in distribution.
- Pre-order layer: +4 Margherita, +4 Pinsa.
- Result: 32 Margherita, 4 + (Pinsa share × 92) Pinsa.

**Verdict for pre-order fold-in: CHEAP REWIRE.** The math already supports the "committed floor" model the redesign wants. The UI just needs to make this fold-in visible — e.g. a Production Plan tile showing `{ walk-in share: 28 } + { pre-order: 4 } = 32` per dish so the owner can verify the math at a glance.

---

## 4. "My usual" + repeat-last-day

### Are prep sessions persisted per venue/date?

**YES.** `prep_sessions` (M116) is the audit trail of every prep run. Each row carries:
- `business_id`, `org_id`
- `inputs JSONB` — `[{recipe_id, qty}]` as entered
- `created_at TIMESTAMPTZ`
- `completed_at TIMESTAMPTZ` — NULL = active, set when "Complete prep" tapped
- `name TEXT` — optional owner label

Indexed `(business_id, created_at DESC)` so "last N sessions for this biz" is one cheap query.

**Note:** `prep_sessions` does NOT carry a `service_date` column. It only knows `created_at`. The day a session was "for" is implicitly the day it was created (or the day after — owner discretion). Pre-orders have `service_date`; sessions don't. **If "repeat last Friday" needs day-of-week precision, we use `EXTRACT(DOW FROM created_at)` as the proxy.** That's good enough for v1 — kitchens prep within a few hours of service so the DOW match holds. A future enhancement could add `prep_sessions.service_date` if it doesn't.

### Deriving "my usual"

Three signals available today:

1. **Session-frequency.** Count how many of the last N sessions included each dish:
   ```sql
   SELECT dish_id, COUNT(*) AS sessions_with_dish
   FROM prep_sessions, jsonb_array_elements(inputs) AS item,
        (item->>'recipe_id')::uuid AS dish_id
   WHERE business_id = $1
     AND completed_at IS NOT NULL
     AND created_at > NOW() - INTERVAL '30 days'
   GROUP BY dish_id
   ORDER BY sessions_with_dish DESC
   ```
   Most reliable signal — directly reflects what this venue actually preps.

2. **Menu membership** (`menu_items` linked to a menu the dish is on). Surface-only — doesn't tell you which dishes are commonly prepped vs just on the menu.

3. **POS sales mix.** Most accurate signal of "what customers order" but only available for businesses that have wired `pos_menu_items.recipe_id` to recipes (M097, parked per CLAUDE.md). Currently 0 at Vero + Chicce.

**Recommendation:** session-frequency is most reliable AND highest signal/noise for an owner-facing preload. POS mix is the future seam when M097 wiring lands.

### "Repeat last [weekday]" feasibility

Pure SQL, no new schema:

```sql
SELECT inputs FROM prep_sessions
WHERE business_id = $1
  AND completed_at IS NOT NULL
  AND EXTRACT(DOW FROM created_at) = EXTRACT(DOW FROM NOW())
ORDER BY created_at DESC LIMIT 1
```

Returns the most recent prep_sessions row for a matching weekday. Pre-loads `selected` directly from `inputs` JSONB.

**Verdict for "my usual" preload: CHEAP REWIRE.**
**Verdict for "repeat last [weekday]": CHEAP REWIRE.**

Both are one new `GET /api/inventory/prep/suggest?business_id=X&kind=usual|last_dow|last_session` endpoint away. No schema change, no migration.

---

## 5. Bartender "top up to par" — the key fork

### Par-level data

Searched `sql/`, `lib/`, `app/` for `par_level`, `par`, `stock_on_hand`, `inventory_count`, `on_hand`. **Zero matching tables or columns.** The phrase "par" appears only in the `EditItemModal` TS file (and a few JSDoc comments) — not as a stored value, not as a queryable column.

Closest data we have:
- `products.pack_size` + `products.base_unit` (M111-ish era) — the size of the unit we buy. Not a target stock level.
- `supplier_invoice_lines` history — what we ordered, not what we have.
- M097 `pos_menu_items.recipe_id` — what's sold, not what's in stock.

There is no concept of "we want to keep 8 bottles of vermouth on hand" in the schema today.

### Stock-on-hand data

Same search: **zero hits.** No `stock_count`, no `inventory_levels`, no end-of-day count table. The owner has no surface to record "we have 5 left." Closest existing concept is the implicit assumption in the BAS bucket logic that 4xxx food/beverage purchases roll up to total food cost — but that's monetary, not unit-count, and it doesn't track current state.

### "Top up to par" feasibility

To ship the bartender mode we need three new things:

1. **Schema:** `recipes.par_qty NUMERIC NULL` + `recipes.par_unit TEXT NULL` (target stock level — bottles of vermouth, batches of simple syrup, etc.). Drink-recipe-shaped because bartenders think in finished pours/batches. Could also be `products.par_qty` for raw ingredients but the bartender hero is about ready-to-serve drinks, so recipe-keyed is the right level.
2. **Capture surface:** an owner-facing "count current stock" UI. End-of-service, bartender taps each tracked recipe and enters "have N left." Stored in a new `stock_counts` table (timestamp + count + counted_by). Most recent count per recipe → "have X" number.
3. **Top-up math:** `gap = par − have`; gap drives the prep quantity automatically. UI shows "Vermouth 3 / 8 → make 5" with one-tap-apply.

Plus:
- Honest-incomplete: if a recipe has no `par_qty` set, the bartender mode hides it (don't fabricate a target).
- Staleness handling: if the most recent stock count is > N hours old, surface a "count again?" prompt rather than silently using the stale number.

**Verdict: NEEDS NEW FEATURE.** This is the most expensive item by a wide margin — two schema columns + one new table + one new capture surface + new business logic. Plan it as a separate ticket sequenced AFTER mobile-first layout + smart chips + my-usual preload, where everything else lands quickly on top of what's already there.

---

## 6. Responsive / layout

### Current state

The prep page is **desktop-first but with mobile-aware components**. Evidence:

- Outer layout uses inline `flex` with `flexWrap: 'wrap'` and `flex: '1 1 380px'` on the two-pane create-mode body — the panes will stack at narrow widths.
- Prep-mode rows use `gridTemplateColumns: '44px 1fr 130px'` with explicit 44px (tablet/finger-friendly) and 56px row height on the checkbox column — this is the existing tablet/mobile concession in the prep-mode read.
- The Pre-orders sub-card, dish picker, and covers Apply row are all inline-styled and not wrapped in any `useViewport()` branching — they stack via `flex-wrap` but the layout density isn't optimised for one-handed phone use.
- The view-toggle and tab-pills sit at the top of the page (above the picker), which on a phone means they consume the entire upper viewport before the first actionable element.

### Responsive primitives already in the codebase

These were built during Session 3-4 mobile work (tasks #163-#167):

- `lib/constants/breakpoints.ts` — 3-tier system: `mobile < 768`, `tablet 768-1023`, `desktop ≥ 1024`. `BP` constants, `tierFor(width)` helper, `PAGE_PADDING` per tier.
- `lib/hooks/useViewport.ts` — `useViewport()` returns `'mobile' | 'tablet' | 'desktop'`. Uses `useLayoutEffect` so first paint is correct on mobile (SSR default is `'mobile'` — important for phone perf). Helpers: `useIsMobile()`, `useIsTablet()`, `useIsDesktop()`. `useContainerWidth(ref)` for ResizeObserver-driven chart sizing.
- `components/ui/Layout.tsx::PageContainer` — already accepts the tier-aware padding.
- `components/ui/DataTable.tsx::DataTableColumn` — has a `hideOnMobile` field used elsewhere (e.g. recipes list hides "Menu price" / "Food cost" / "Food %" on mobile).
- `components/ui/CardGrid` — primitive for the "cards instead of table at narrow widths" pattern.

### What a mobile-first rebuild must respect

1. **AppShell + RailNav.** The 46px left rail (`UXP.railW`) collapses to a bottom-bar pattern on mobile (verified elsewhere in the codebase). The prep page shouldn't fight this — let `AppShell` handle the chrome and own the page body.
2. **`UXP.*` design tokens.** Same lavender palette, same `shadowCard` elevation, same `fsBody / fsLabel / fsMicro` typography scale. Do NOT introduce new colours or fonts in the redesign — extend the existing palette.
3. **Safe-area insets.** Sticky bottom send bar needs `padding-bottom: env(safe-area-inset-bottom)` so it sits above the iOS home indicator. Check for an existing helper before inventing one.
4. **Z-index tokens.** Use `Z.sticky` (10) for sticky page headers, `Z.banner` (50) for the send bar background overlay, `Z.modal` (200) for the line-edit modal. Don't reintroduce raw numbers.
5. **Touch targets.** The existing checkbox column at 44×56px is the right size. The dish picker rows are 6×10px-padded — fine on tablet, snug on phone. Mobile build should bump rows to 12px-padded and ensure no tap target is < 44px on the smallest dimension.
6. **Frozen-quantity invariant.** As above — no shortcut writes around the engine.

**Verdict for mobile-first layout: CHEAP REWIRE.** The primitives exist, the page just doesn't lean on them yet. The redesign is a layout swap + a few `useIsMobile()` branches inside `PrepListPageInner`, not a rebuild.

---

## 7. Constraints to preserve

1. **`POST /api/inventory/prep-sessions` is the only Save path.** Re-runs the engine, writes the frozen lines. Bypass = silent corruption.
2. **`prep_session_lines.total_qty` / `unit` are frozen.** Read live = wrong. (Text fields ARE read live — that's intentional, see Session 24 invariant.)
3. **`aggregatePrepRequirements()` is the only quantity-math function.** Mirrors `computeRecipeCost`'s recursion + cycle-guard + M111 yield resolution. Honest-incomplete on `'sub_no_yield'` / `'unit_mismatch'` / `'cycle'` — never replace these flags with silent zeros.
4. **One active session per business (DB-enforced).** Partial unique index `prep_sessions_one_active_idx`. The UI must handle the 409 race response (H1 audit fix — caught at the POST handler, returns friendly "Concurrent create" 409).
5. **`recipes.portions_per_cover` ≤ 10.** Server CHECK rejects > 10. UI typing tolerance lives in the client; server validates on PATCH.
6. **`prep_pre_orders.party_size` 1..500.** L8 audit cap. Don't widen.
7. **`prep_pre_orders.items` MUST be a JSONB array.** `CHECK jsonb_typeof = 'array'`. Don't write objects.
8. **RLS via `current_user_org_ids()`** on every prep table (sessions + lines + pre-orders). RLS uuid[] array function — policies use `= ANY(current_user_org_ids())` not `IN (SELECT …)` (see `feedback_rls_uuid_array_function` memory).
9. **Order pipeline downstream.** `/inventory/orders` builds shopping lists by aggregating frozen `prep_session_lines` (kind=product) across selected sessions + pre-orders. Any change to session-line shape ripples there.
10. **Mobile primitives + tokens.** Use `useViewport()`, `BP`, `UXP.*`, `Z.*`. Don't reintroduce raw values.

---

## Anything surprising / risk

1. **Pre-orders ride the existing math — owner just doesn't see the fold-in.** The `applyCovers()` already does `(walk-in share × freeCovers) + pre-order items`. The UX risk is that the owner can't tell, from the dish list, whether a given dish's number came from share-distribution or from pre-orders — they see one number. A "Production Plan" tile in the mobile redesign that surfaces `walk-in: N + pre-order: M = K` per dish would make this visible without changing the math.
2. **Sessions don't carry `service_date`** — only `created_at`. Repeat-last-DOW math uses `EXTRACT(DOW FROM created_at)`. If owners prep > 24 hours ahead this could misclassify (rare in practice, but worth a `service_date` column add in a future migration if owners ask).
3. **The smart-chip percentile baseline is per-weekday but doesn't account for holidays / events.** Stockholm holidays are pure-compute (`lib/holidays/sweden.ts`); the chip query could optionally drop holidays from the baseline window so a Christmas Day in the history doesn't flatten the "Normal" chip for a Wednesday baseline. Cheap enhancement to bake in from day 1.
4. **`portions_per_cover` is sparse at Chicce / Vero today.** The covers Apply only fills dishes that have it set. Smart chips inherit this — if 0 dishes have shares set, chips do nothing. Onboarding UX needs a "set your dish shares" entry point if we're going to surface chips prominently.
5. **No mass-update path for `portions_per_cover`.** Owner has to set shares per dish in the picker. For new customers with 100+ dishes that's tedious. An AI seed (one-shot "guess shares from menu type + price + name") could short-circuit this — separate ticket, not the redesign's problem to solve, but worth flagging because empty shares = empty chips.
6. **`prep_pre_orders.service_date` is `DATE` not `TIMESTAMPTZ`.** Lunch vs dinner is a future column (`service_slot`). The redesign's "today's service" mental model maps cleanly to date for v1; multi-slot is post-MVP.
7. **Bartender mode is the cliff.** Everything else in the redesign is 1-2 day work. Bartender top-up-to-par is a multi-week feature in itself (schema + capture UI + count freshness + reporting). Don't bundle it with the mobile redesign — sequence it after.

---

*Source files inspected: app/inventory/recipes/prep/page.tsx, lib/inventory/prep-list.ts, sql/M116-PREP-SESSIONS.sql, sql/M117-RECIPE-PORTIONS-PER-COVER.sql, sql/M118-PREP-PRE-ORDERS.sql, sql/M008-summary-tables.sql, sql/M071-HOURLY-METRICS.sql, lib/hooks/useViewport.ts, lib/constants/breakpoints.ts, lib/forecast/hourly.ts. No DB queries executed (the percentile baseline + my-usual queries are proposed, not run).*
