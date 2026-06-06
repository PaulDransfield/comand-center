# Mix-share AI seed — investigation (READ-ONLY)

> 2026-06-06. Pre-build map of what's needed to AI-seed
> `recipes.portions_per_cover` for dishes that currently have none, so the
> covers Apply + upcoming smart chips do something useful. Characterises
> the write path, CHECK constraints, provenance gap, and POS sales-mix
> availability. The per-business menu-shape counts (§ 1) require DB
> queries that the credentials classifier blocks in this session — explicit
> SQL is provided so the owner can run them and paste numbers back.

---

## TL;DR — direct answers

- **Write path:** `PATCH /api/inventory/recipes/[id]` only. **No batch endpoint exists for `portions_per_cover`.** Seeding N dishes today means N PATCHes.
- **Stored form:** `NUMERIC`, nullable. **Fraction** (`0.15` = 15%). UI's `saveDishShare()` divides the entered percent by 100 before writing. Server CHECK: `NULL OR (0 ≤ x ≤ 10)`. The 10× ceiling is the "typed-15-thinking-percent" guard.
- **Provenance:** **NO column exists** to tell an owner-set value from a system-seeded one. No `created_by`, `updated_by`, `source`, `origin`, `created_via`, or seeded-flag anywhere on `recipes`. For v1 we **must** restrict writes to where `portions_per_cover IS NULL` so we never overwrite an owner's value. Adding a provenance marker would be a future additive migration — see § 3.
- **POS sales-mix signal:** the schema is there (`pos_menu_items.recipe_id` + `pos_sales`, M097), but the wiring at Vero / Chicce is empirically zero — the variance loop is built (`lib/inventory/variance.ts`) but its inputs are empty. **Confirm with the query in § 4.** If a business unexpectedly HAS sales data, prefer it over name/price guessing for that business.
- **Course-aware seed risk:** the biggest landmine is **drinks bundled into the food-type bucket** (sometimes `wine` is sold as a single dish-shaped recipe but really represents many pours). The seed should never put a non-zero share on a sub-recipe (already excluded via `is_subrecipe`), and should treat the drink types separately because a share for "Margherita" and a share for "Pinot Grigio" mean different things mathematically — see § 1 design note.

---

## 1. Menu shape (per business)

**Status: NOT QUERIED.** Service-role read was blocked by the credentials classifier earlier in this session. Below are the queries to run; paste output back and I'll do the seed-design pass.

The "dish-shaped" filter mirrors `isDish()` in `app/inventory/recipes/prep/page.tsx:155`:

```sql
-- Per-type breakdown of NULL vs SET portions_per_cover, plus price spread,
-- for each business in scope. The COALESCE wraps NULL types as '(no type)'.
WITH dishes AS (
  SELECT
    r.business_id,
    COALESCE(r.type, '(no type)') AS type,
    r.portions_per_cover,
    COALESCE(r.selling_price_ex_vat, r.menu_price) AS price
  FROM recipes r
  WHERE r.archived_at IS NULL
    AND COALESCE(r.is_subrecipe, false) = false
    AND (
      r.selling_price_ex_vat > 0
      OR r.menu_price > 0
      OR r.type IN ('starter','main','pasta','pizza','dessert','side','other',
                    'cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free')
    )
)
SELECT
  business_id,
  type,
  COUNT(*)                                                                    AS total,
  COUNT(*) FILTER (WHERE portions_per_cover IS NULL)                          AS null_count,
  COUNT(*) FILTER (WHERE portions_per_cover IS NOT NULL)                      AS set_count,
  MIN(price)                                                                  AS price_min,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price) FILTER (WHERE price > 0) AS price_median,
  MAX(price)                                                                  AS price_max
FROM dishes
GROUP BY business_id, type
ORDER BY business_id, type;
```

```sql
-- Totals per business (for sizing the seed batch).
SELECT
  business_id,
  COUNT(*) FILTER (WHERE portions_per_cover IS NULL)     AS dishes_to_seed,
  COUNT(*) FILTER (WHERE portions_per_cover IS NOT NULL) AS dishes_already_set,
  COUNT(*)                                                AS dishes_total
FROM recipes
WHERE archived_at IS NULL
  AND COALESCE(is_subrecipe, false) = false
  AND (selling_price_ex_vat > 0 OR menu_price > 0 OR type IS NOT NULL)
GROUP BY business_id;
```

```sql
-- Useful sanity check: per-business count of recipes total (incl. subs +
-- archived) so the "dishes to seed" number sits in context.
SELECT
  business_id,
  COUNT(*)                                                AS recipes_all,
  COUNT(*) FILTER (WHERE archived_at IS NULL)             AS recipes_active,
  COUNT(*) FILTER (WHERE is_subrecipe = true)             AS subrecipes,
  COUNT(*) FILTER (WHERE archived_at IS NULL AND COALESCE(is_subrecipe, false) = false) AS dishes_active
FROM recipes
GROUP BY business_id;
```

**Businesses to target:** the brief mentions "Chicce Slottsgatan? Vero? all in the org?" Both Chicce (`63ada0ac-18af-406a-8ad3-4acfd0379f2c`) and Vero (`0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99`) have recipe data and would benefit. Chicce is the cleaner test bed (recipes recently bulk-imported via the AI importer — see Session 23 invariants in CLAUDE.md), so propose **Chicce first as the pilot**, then Vero once the seed-design pass has been reviewed. The query above will tell us the dish counts to seed.

**Design note for the seed (once we have the numbers):** the course-uptake distribution needs to be type-aware:

- **Food types** within a Stockholm Italian sit at typical shares like: starter ~0.5–0.7 of covers, pasta or pizza ~0.4–0.6 (these often substitute for each other), main ~0.3–0.5, side ~0.2, dessert ~0.2–0.4, `other` neutral ~0.1.
- Food shares across a menu CAN sum to >1.0 (a cover can order a starter + a main + a dessert — they're not mutually exclusive per cover), and the math in `applyCovers()` doesn't assume they sum to 1.
- **Drink types** are a different model — a single cocktail share like 0.3 means "30% of covers order this cocktail." Cocktails / wines / beers should each be small (~0.05–0.2 per dish), summing in the bartender bucket.
- **Within a type, prices matter**: the cheapest pasta on the menu probably outsells the most expensive one. The seed should look at price rank within type and apply a mild decay (cheaper dishes = higher share). The price-min/median/max numbers above feed that.
- **`other` and `drink` (the catch-alls)** should default to a small placeholder share or be left NULL — they're heterogeneous by design.

I'll formalise these defaults in the seed-design pass once the actual counts come back.

---

## 2. Write path + constraints

### Endpoint

**`PATCH /api/inventory/recipes/[id]`** — one recipe per call.

Source: `app/api/inventory/recipes/[id]/route.ts:122-136`:

```ts
// M117 — portions_per_cover (mix share for prep-list auto-fill).
// Accept null to clear; otherwise a non-negative number capped at 10
// (the DB CHECK constraint also enforces this — bound prevents the
// "owner typed 15 thinking percent" typo).
if (body.portions_per_cover !== undefined) {
  if (body.portions_per_cover === null || body.portions_per_cover === '') {
    patch.portions_per_cover = null
  } else {
    const ppc = Number(body.portions_per_cover)
    if (!Number.isFinite(ppc) || ppc < 0 || ppc > 10) {
      return NextResponse.json({
        error: 'portions_per_cover must be between 0 and 10 (decimal share, e.g. 0.15 for 15%)',
      }, { status: 400 })
    }
    patch.portions_per_cover = ppc
  }
}
```

### No batch endpoint

Searched `app/api/**/*.ts` for `batch.*update` / `bulk.*update.*recipe` / `/recipes/batch` — **zero hits**. There is no existing batch update path for any recipe field.

**Implication for the seed:** N PATCHes for N recipes. Per-business sizing is small (a typical menu is <100 dishes; the M097 wiring brief mentions ~99 dishes at Chicce), so 100 sequential PATCHes is fine — sub-second per call. A batch endpoint isn't strictly required; if we want one, it'd be a small additive POST `/api/inventory/recipes/batch-update-shares` accepting `[{ recipe_id, portions_per_cover }]`. Out of scope for this investigation.

### Stored form (confirmed)

| Aspect            | Value                                                            |
|-------------------|------------------------------------------------------------------|
| Column            | `recipes.portions_per_cover`                                     |
| Type              | `NUMERIC`                                                        |
| Nullability       | NULL allowed (= "no share set")                                  |
| Stored unit       | **Fraction** — `0.15` means "15% of covers order this dish"      |
| UI translation    | Owner types `15`, client divides by 100 before PATCH             |
| Server cap        | `Number.isFinite && 0 ≤ x ≤ 10` (PATCH route line 131)           |
| DB CHECK          | `recipes_portions_per_cover_range`: `NULL OR (≥ 0 AND ≤ 10)` (M117) |

Client `saveDishShare()` at `app/inventory/recipes/prep/page.tsx:396-400`:

```ts
const saveDishShare = useCallback(async (recipeId: string, sharePct: number | null) => {
  const ppc = sharePct == null ? null : sharePct / 100
  // …PATCH /api/inventory/recipes/[id] with { portions_per_cover: ppc }…
}, [dishes])
```

### RLS

`sql/M084-RECIPES.sql:108-113`:

```sql
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;

CREATE POLICY recipes_org_isolation
  ON public.recipes
  FOR ALL
  USING      (org_id = ANY (current_user_org_ids()))
  WITH CHECK (org_id = ANY (current_user_org_ids()));
```

**Implication for the seed:** the seed worker MUST run via service-role (`createAdminClient()`) to bypass RLS, OR be triggered as a user-driven action by a logged-in member of the target org. The existing PATCH endpoint already validates org access via `requireBusinessAccess(auth, businessId)` for user-driven calls. For a one-shot batch seed, service-role + explicit `business_id` filter is the safer pattern (mirrors how the AI bulk importer and other admin-driven flows write).

---

## 3. Provenance

### Does a flag exist? **NO.**

Searched `sql/` and the recipes-table definitions for any source / origin / updated_by / created_via / seeded marker on `recipes`:

- `sql/M084-RECIPES.sql` (the original) columns: `id, business_id, org_id, name, type, menu_price, portions, notes, archived_at, created_at, updated_at` + `UNIQUE(business_id, name)`. **No provenance.**
- Subsequent additive migrations (M086 sub-recipes link, M109 selling_price_ex_vat / vat_rate / channel, M111 yield_amount/unit, M114 method, M117 portions_per_cover, M124 is_subrecipe, M125 image_url, M127 glass_price). **None added provenance.**

`grep` for `created_by|updated_by|seeded|origin|source|created_via` inside recipes-related SQL → only one hit and it's an unrelated comment in M084.

### What this means for the seed

**(a) Only ever fill NULLs.** Without a provenance marker, the only safe rule is "only write to rows where `portions_per_cover IS NULL`." If we overwrite a non-NULL value we destroy the owner's judgement. The PATCH route doesn't enforce this — the seed worker must check NULL itself before issuing each PATCH, or include `.is('portions_per_cover', null)` on a future batch endpoint.

**(b) Owner can't tell what's seeded.** When the owner opens `/inventory/recipes/prep` they'll see `15%`, `25%`, `30%` etc. populated on dishes they never touched. Some of those might be wrong by 10–20 percentage points (the seed is a starting point, not truth). Without a flag, the owner has no way to know "this 30% is my number" vs "this 30% was AI-guessed." The covers Apply will then produce inflated/deflated prep numbers and the owner won't know whether the guidance came from their own work or the seed.

**Mitigation paths (ranked):**

1. **Ship flag-less for v1, mitigate via UX cue.** Add a one-time UX banner on `/inventory/recipes/prep` after the seed runs: "We've estimated mix-share for N dishes. Review the % column and override anything that looks wrong." Light, no migration. Owner trust depends on telling them clearly that the numbers are estimates.
2. **Add a provenance column (additive future migration).** `recipes.portions_per_cover_source TEXT NULL` with values `'owner' | 'seeded_v1' | 'pos_mix'`. Seed worker writes `'seeded_v1'`. UI shows a small dimmed "estimated" badge next to seeded values; owner editing the % flips it to `'owner'`. Future "re-seed" only touches rows with non-`'owner'` source. Cleanest long-term but adds scope.
3. **Use `updated_at` as a weak proxy.** Compare `updated_at` against the timestamp of the seed run. If `updated_at` is later, treat as owner-touched. Fragile (any unrelated edit bumps updated_at) and not recommended.

**Recommendation:** option 1 for v1 ship (no migration, no schema risk). Option 2 as a follow-up if owners flag the trust gap. Document in the seed PR description so reviewers know we deliberately accepted the gap.

---

## 4. POS sales-mix signal

### Schema exists (M097)

`sql/M097-POS-SALES.sql` defines:
- `pos_menu_items(id, business_id, pos_provider, pos_item_id, name, recipe_id, …)` — the venue's menu, with `recipe_id` linking each menu item to the costed recipe. Indexed `(recipe_id) WHERE recipe_id IS NOT NULL`.
- `pos_sales(id, business_id, pos_item_id, sold_at, sold_date, quantity, net_revenue, source, source_ref, …)` — one row per sale event (manual entry = weekly aggregate; connector writes = per-ticket).

`lib/inventory/variance.ts:117-122` already joins them for the theoretical-draw calculation:

```ts
const { data: sales } = await db
  .from('pos_sales')
  .select(`
    quantity,
    pos_item:pos_menu_items ( id, recipe_id )
  `)
  .eq('business_id', businessId)
```

### Empirical wiring at Vero / Chicce

**Status: NOT QUERIED** (same credentials block). Confirm with:

```sql
-- Wired-recipe count per business — how many pos_menu_items have a
-- recipe_id set (i.e. are actually usable as a sales-mix signal).
SELECT
  business_id,
  COUNT(*)                                       AS pos_items_total,
  COUNT(*) FILTER (WHERE recipe_id IS NOT NULL)  AS pos_items_wired_to_recipe,
  COUNT(*) FILTER (WHERE archived_at IS NULL)    AS pos_items_active
FROM pos_menu_items
GROUP BY business_id;
```

```sql
-- Sales rows per business in the last 90 days — minimum signal needed
-- to compute a defensible mix.
SELECT
  s.business_id,
  COUNT(*)                                            AS sales_rows_90d,
  COUNT(DISTINCT mi.recipe_id) FILTER (WHERE mi.recipe_id IS NOT NULL)
                                                      AS distinct_wired_recipes
FROM pos_sales s
JOIN pos_menu_items mi ON mi.id = s.pos_item_id
WHERE s.sold_date >= NOW() - INTERVAL '90 days'
GROUP BY s.business_id;
```

**Expectation** (per CLAUDE.md Session 22 + the read-only investigation a few hours ago): both Vero and Chicce have **zero `pos_menu_items` rows with `recipe_id` set** — the M097 wiring is built but parked. So the seed has to fall back on name + price + type signals.

**Rule:** if the query above returns `pos_items_wired_to_recipe > 0 AND sales_rows_90d > 50` for any business, switch that business's seed source to the POS mix:

```sql
-- Per-recipe mix share derived directly from POS sales over the window.
WITH window_sales AS (
  SELECT s.business_id, mi.recipe_id, SUM(s.quantity) AS qty
  FROM pos_sales s
  JOIN pos_menu_items mi ON mi.id = s.pos_item_id
  WHERE s.sold_date >= NOW() - INTERVAL '90 days'
    AND mi.recipe_id IS NOT NULL
  GROUP BY s.business_id, mi.recipe_id
),
covers_window AS (
  SELECT business_id, SUM(covers) AS covers_total
  FROM daily_metrics
  WHERE date >= NOW() - INTERVAL '90 days'
  GROUP BY business_id
)
SELECT
  w.business_id,
  w.recipe_id,
  w.qty / NULLIF(c.covers_total, 0) AS portions_per_cover_pos
FROM window_sales w
JOIN covers_window c ON c.business_id = w.business_id;
```

That's a clean signal — sells `qty / covers` directly is the empirical mix share. Don't AI-guess when this is available.

---

## Anything that would make a course-aware seed misbehave

1. **NULL `type` is common.** Bulk-imported recipes routinely have `type = NULL` (per CLAUDE.md Session 24 invariants — owner has to retrofit). A type-aware distribution can't classify a NULL row, so it'd skip it. Could be a lot of NULL rows. Confirm with the query above; if NULL-type count is large, consider either (a) skipping NULL rows with a "set the type first" note in the post-seed banner, or (b) running an LLM type-classifier first.
2. **Drinks mixed into food math.** If a `type='wine'` row sits next to a `type='pasta'` row in the seed's input, the heuristic must treat them in different buckets — a wine's "15% of covers" means 15% per pour, while a pasta's "55%" means 55% per course. The brief's reference to mixing these has bitten before; mitigate by computing shares per `(business_id, type_bucket)` cluster.
3. **`other` and `drink` catch-alls.** Both are heterogeneous (anything-not-otherwise-classified). Seeding them with the same defaults as a defined type would be misleading. **Skip these or use a low default share (0.05–0.10).**
4. **`sauce`-typed recipes are sub-recipes.** Excluded already via the `is_subrecipe = false` filter. Defensive: also filter `type != 'sauce'` since some bulk-imported rows have `type='sauce'` without the `is_subrecipe=true` flag.
5. **Price-vs-share inversion.** If we apply the "cheaper = higher share" decay too aggressively, a 95kr starter could look like 70% of covers — implausible. Cap each per-type share at a sensible ceiling (e.g. starters ≤ 0.7).
6. **Sum-greater-than-1 IS legitimate.** A cover can order a starter + a pasta + a dessert. The `applyCovers()` math doesn't normalise. The seed mustn't accidentally normalise per-cover to 1.0 — that'd halve every share at a venue where most covers eat 2 courses.
7. **Mode collapse from the LLM.** If we let an LLM pick exact percentages for 100 dishes in one call, it will tend to land on round numbers (10%, 15%, 20%) and ignore the price-spread signal. Pass the per-type price-rank + price-relative-to-median in the prompt so the model has a numeric anchor.

---

*Source files inspected: app/api/inventory/recipes/[id]/route.ts, app/inventory/recipes/prep/page.tsx, sql/M084-RECIPES.sql, sql/M097-POS-SALES.sql, sql/M117-RECIPE-PORTIONS-PER-COVER.sql, lib/inventory/variance.ts. No DB queries executed — owner runs the SQL in §§ 1, 4 and pastes results for the seed-design pass.*
