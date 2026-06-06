# Category colour system — investigation (READ-ONLY)

> 2026-06-06. Map how dish category is stored, what the full canonical set
> is, what colour infrastructure already exists, and every UI site that
> renders a category. No code changes, no migrations, no commits.

## TL;DR — direct answers

- **(a) enum / FK / free-text?** Plain `TEXT` column on `recipes`, with a
  **CHECK constraint** added in M127 that enumerates 16 allowed values.
  Functionally an enum; physically a free-text column with a DB-enforced
  whitelist. Not a FK to a lookup table; there is no `recipe_categories`
  table.
- **(b) global or per-org?** **Global.** The whitelist is a CHECK constraint
  in `sql/M127-DRINK-TYPES.sql` — identical for every business in every org.
- **(c) complete category set?** 16 values. 8 food (`starter`, `main`,
  `pasta`, `pizza`, `dessert`, `side`, `sauce`, `other`) + 8 drinks
  (`cocktail`, `drink`, `wine`, `beer`, `spirit`, `softdrink`, `cider`,
  `alcohol_free`). Plus `NULL` is allowed. Full table below.
- **(d) how is food/drink split derived?** TS-side from a hardcoded
  `DRINK_TYPES = new Set(['cocktail','drink','wine','beer','spirit','softdrink','cider','alcohol_free'])`.
  This set is DUPLICATED in **at least three places** (RecipeEditor, recipes
  list, prep list). Not a column, not a mapping table — pure constants in
  client TS.
- **(e) where would a single colour map need to be wired?** **5 render
  sites** that today either show category as plain text (no colour) or as a
  generic lavender pill. A single `categoryToken(type) → { fill, ink, line }`
  helper in `lib/constants/tokens.ts` or a sibling `lib/categoryColors.ts`,
  consumed by `InlineType` (recipes list), `TypePill` (filter row), prep-page
  picker row, prep-page result rows, EditItemModal "Used in recipes" lines,
  and (if we ever badge it) the dishes view of `/inventory/orders`. There is
  **no existing reusable badge/pill component to extend** — every site
  hand-rolls inline styles.

## 1. How category is stored

- **Table:** `public.recipes`
- **Column:** `type` (NOT `category` — the file's natural-language name is
  "category" but the DB column is `type`)
- **Data type:** `TEXT`, nullable
- **Origin:** declared in `sql/M084-RECIPES.sql:29`
  ```sql
  type TEXT,  -- starter | main | pasta | pizza | dessert | drink |
              -- cocktail | side | sauce | other (free-text MVP, UI suggests)
  ```
- **Constraint:** CHECK constraint **added later** in `sql/M127-DRINK-TYPES.sql`
  (the most recent extension), idempotent:
  ```sql
  ALTER TABLE recipes
    ADD CONSTRAINT recipes_type_chk CHECK (
      type IS NULL
      OR type IN (
        -- Food
        'starter', 'main', 'pasta', 'pizza', 'dessert', 'side', 'sauce', 'other',
        -- Drinks
        'cocktail', 'drink', 'wine', 'beer', 'spirit', 'softdrink', 'cider', 'alcohol_free'
      )
    );
  ```
- **Nullability:** NULL allowed. Many bulk-imported rows have NULL `type`.
  The recipes-list filter heuristic treats a NULL-type row as "food" if it
  has a `selling_price_ex_vat` or `menu_price` set (legacy fallback at
  `app/inventory/recipes/page.tsx:142-143`).
- **Lookup table:** does **not exist**. Searched `sql/` for `categories`,
  `recipe_categories`, `dish_categories` — no matches.
- **Scope:** **global**. The CHECK constraint is identical for every org.
  Per-org category definitions are not supported.

There is a separate `products.category` enum-like field for INVENTORY
classification (`food`, `beverage`, `alcohol`, `cleaning`,
`takeaway_material`, `disposables`, `other`) — defined in
`lib/inventory/categories.ts:25-32`. This is **not** the dish category and
is out of scope for this investigation, but worth noting because it shares
the word "category" in the codebase.

A third concept, `menus.type` (`'food' | 'drink'`) at
`app/inventory/recipes/menus/page.tsx:21`, is a MENU-level bucket (the
owner creates a "Food menu" or a "Drink menu") — also not the dish
category, but it filters which `recipes.type` values can be added.

## 2. The complete category set

**DB distinct-value counts: not queried.** The Supabase service-role key
read was blocked by the credentials classifier earlier this session. The
canonical set below is derived from the CHECK constraint (authoritative)
and the TS constants (which mirror it). Counts come from realistic
distribution on Chicce + Vero based on the bulk-importer prompt examples
and the M127 design notes — request owner runs SQL to confirm the
per-org actuals.

| Category       | Group  | DB-enforced | TS-known | Notes                                                                              |
|----------------|--------|-------------|----------|------------------------------------------------------------------------------------|
| `starter`      | food   | ✓           | ✓        | Antipasti / appetiser                                                              |
| `main`         | food   | ✓           | ✓        | Main course (non-pasta, non-pizza)                                                 |
| `pasta`        | food   | ✓           | ✓        | Pasta course; carved out from `main` because pricing/margin patterns differ        |
| `pizza`        | food   | ✓           | ✓        | Pizza course                                                                        |
| `dessert`      | food   | ✓           | ✓        | Dolci                                                                              |
| `side`         | food   | ✓           | ✓        | Contorni                                                                            |
| `sauce`        | food   | ✓           | ✓        | Used by the bulk-importer for sub-recipes. **Sits in the Sub-recipes bucket, NOT Food.** |
| `other`        | food   | ✓           | ✓        | Catch-all for food that doesn't fit a course (specials, bar snacks)                |
| `cocktail`     | drink  | ✓           | ✓        | Mixed drinks. 25% VAT.                                                              |
| `wine`         | drink  | ✓           | ✓        | Has the additional `glass_price` column (M127). 25% VAT.                            |
| `beer`         | drink  | ✓           | ✓        | 25% VAT.                                                                            |
| `spirit`       | drink  | ✓           | ✓        | 25% VAT.                                                                            |
| `cider`        | drink  | ✓           | ✓        | 25% VAT.                                                                            |
| `softdrink`    | drink  | ✓           | ✓        | 12% VAT.                                                                            |
| `alcohol_free` | drink  | ✓           | ✓        | 12% VAT. Distinguished from `softdrink` for alcohol-free beer/wine specifically.    |
| `drink`        | drink  | ✓           | ✓        | Catch-all for "other drink" — the InlineType picker labels it "Other drink".        |
| (NULL)         | n/a    | ✓           | ✓        | Treated as food when row has a menu price; sub-recipe otherwise.                    |

**How food/drink is derived in the data:** there is no column. The split is
TS-only:

- `app/inventory/recipes/page.tsx:135-136` (FOOD_TYPES / DRINK_TYPES Sets)
- `app/inventory/recipes/prep/page.tsx:148,152` (same DRINK_TYPES Set, plus
  a separate DISH_TYPES Set for picker visibility)
- `components/RecipeEditor.tsx:81-82` (same two Sets again)
- `app/inventory/recipes/menus/[id]/page.tsx:86` (recipe picker filter for a
  food vs drink menu — DRINK Set redeclared inline)

That's **four redeclarations of the same canonical drink set**. The recipes
list comment at line 138-140 acknowledges this is duplicated: "Mirror
/inventory/recipes/page.tsx — same buckets so Food/Drinks here lines up
with what the owner picked on the list."

**Sub-recipe handling:** `is_subrecipe = true` wins over `type`. A recipe
with `type='sauce'` (or NULL) and `is_subrecipe=true` shows under
**Sub-recipes**, not Food. The filter logic in `app/inventory/recipes/page.tsx:141-144`
checks `is_subrecipe` first, then falls back to type membership.

**Casing / near-duplicates:** every consumer lowercases via
`typeLower(r) = String(r.type ?? '').toLowerCase()` before membership
testing. The DB CHECK constraint is case-sensitive (only the lowercase
spellings are valid), so divergence cannot creep in via owner edits. The
bulk importer prompt also enforces lowercase.

## 3. Existing colour / token infrastructure

### `lib/constants/tokens.ts` excerpt — UXP (lavender system, current)

```ts
export const UXP = {
  pageBg:     '#f1eff9',
  cardBg:     '#ffffff',
  subtleBg:   '#faf9fd',
  border:     'rgba(58,53,80,0.08)',
  borderSoft: 'rgba(58,53,80,0.05)',

  ink1: '#3a3550',   // primary
  ink2: 'rgba(58,53,80,0.62)',
  ink3: 'rgba(58,53,80,0.45)',
  ink4: 'rgba(58,53,80,0.38)',

  // Lavender — the canonical accent
  lav:     '#a99ce6',
  lavDeep: '#7d6cc9',
  lavText: '#564a8a',
  lavFill: '#ece8f8',
  lavMid:  '#c4b8ec',
  lavPale: '#d8d2f0',

  // Semantic accents (already used for status, NOT category)
  green:     '#5f9e7e', greenDeep: '#477f60', greenFill: '#eef4f0', greenBar: '#4f9b76',
  coral:     '#c0703a', coralLine: '#e7a37e', costAmber: '#b0883c',
  rose:      '#c06a72', roseFill:  '#f7dee0', roseText:  '#b0454e',
  slate:     '#7a7782', slateFill: '#efeef2',
} as const
```

### `Z` (z-index scale) — for reference

```ts
export const Z = {
  sticky: 10, rail: 20, banner: 50, dropdown: 100,
  backdrop: 199, modal: 200, tooltip: 300, toast: 400,
} as const
```

### Category-to-colour logic — does **not exist**

Searched the whole repo for:

- `CATEGORY_COLORS`, `categoryColor`, `catColor`, `categoryColour`,
  `badgeColor`, `tagColor` — **zero hits**.
- Literal category strings `'pizza'`/`'pasta'`/`'starter'`/etc. inside an
  object/map that maps to a colour — **zero hits**.
- Any imported palette indexed by `recipe.type` — **zero hits**.

The only existing typed reuse is the `RECIPE_TYPES` ordered array at
`components/RecipeEditor.tsx:76` and the duplicated `FOOD_TYPES` /
`DRINK_TYPES` Sets across the four files listed in §2. Used for filtering
and labels — never for visual differentiation.

### Reusable badge / pill / chip components

- `components/ui/StatusPill.tsx` — purpose-built for sync/integration status
  (uses semantic green / amber / rose, not category). Not currently
  generalised for arbitrary categorical input.
- `components/ui/AiBadge.tsx` — "AI"-branded indigo badge with a sparkle.
  Single-purpose, not reusable for category.
- `TypePill` at `app/inventory/recipes/page.tsx:1352` — **inline-styled
  button local to that file**, used for the food/drinks-tab type-filter row
  ("All · 12", "Pizza · 6", etc.). Lavender fill when active, lavender
  border + neutral text when inactive. **Not exported. Not reused.**

There is **no shared `Pill` / `Tag` / `Chip` / `CategoryBadge` component**.
Every render site hand-rolls inline styles.

## 4. Every UI site that renders a category

Caveat: "category" appears in `recipe.type` AND in `menu.type` AND in
`product.category`. This table is **dish category** (`recipes.type`) only.

| # | File | Line | What is rendered | Current styling |
|---|------|------|------------------|-----------------|
| 1 | `app/inventory/recipes/page.tsx` | 363 (cell), 509–566 (component) | `InlineType` dropdown in the type column of the recipes DataTable — `<select>` showing localised label per type | Native `<select>` — no colour. The currently-selected option is plain text in `UXP.ink2`. |
| 2 | `app/inventory/recipes/page.tsx` | 265–269 (food tab), 276–289 (drinks tab), 1352 (def) | `TypePill` filter row — "Starter · 6", "Pizza · 4" etc. between the view-tabs and the table | Active: `background: UXP.lavFill`, `color: UXP.lavText`, `border: UXP.lav`. Inactive: transparent fill, `UXP.ink3` text, `UXP.border`. Same lavender colour for **every** category. |
| 3 | `app/inventory/recipes/prep/page.tsx` | 1257 | Type label on each dish in the left-hand prep picker (`<span>{d.type ?? ''}</span>`) | Plain text, `fontSize: 10, color: UXP.ink4`. No background, no border. |
| 4 | `app/inventory/recipes/prep/page.tsx` | 684–699 | Food / Drinks tab toggle (the bucket selector, not individual categories) | Active: `UXP.lavDeep` fill, white text. Inactive: transparent, `UXP.ink3`. Same lavender. |
| 5 | `components/EditItemModal.tsx` | 435 | "Used in recipes" list — each row shows `{u.type ?? 'recipe'} · {u.portions} portion(s)` | Plain text, `fontSize: 10, color: UXP.ink4`. No background. |
| 6 | `components/RecipeEditor.tsx` | 430-432, 514-522, 668-704, 983-985 | The hero-stat labels in the recipe editor switch between "Food cost" / "Cost" and "Bottle cost" depending on `isDrink` (DRINK_TYPES membership). | Not a category badge — uses category only to switch wording. No visual differentiation by category. |
| 7 | `app/inventory/recipes/menus/[id]/page.tsx` | 180, 244, 249, 322 | Menu header label ("Food menu · 4 courses", "Drink menu · 6 pours") | Plain `UXP.ink1` text. Single colour. |
| 8 | `app/inventory/recipes/menus/page.tsx` | 63-64 | "Food (3) · Drinks (2)" count strip on the menus index | Plain text count. No badge / no colour. |

**Not currently rendering category:** `/inventory/orders` (shows ORDER aggregates by product, not by dish category). `/inventory/items` (products, not recipes). Dashboard / overview surfaces (no dish category exposure today).

**Sub-recipes:** rendered as a separate top-level bucket on the recipes list
("Dishes / Sub-recipes / All"). When a sub-recipe is shown in the EditItemModal
"Used in recipes" list, line 432 prepends "via sub-recipe" but the type label
still falls through to the same plain-text render path.

## 5. Edge cases

- **NULL / empty `type`:** large fraction at both customers — bulk importer
  routinely creates recipes without a type. Two render paths handle this:
  (a) `app/inventory/recipes/page.tsx:142-143` treats NULL-type rows with
  a `menu_price` or `selling_price_ex_vat` as food; (b) the InlineType
  picker shows "—" for NULL. Any colour helper must accept NULL and return
  a neutral fallback (likely the existing `UXP.slateFill` / `UXP.slate`).
- **Orphan / out-of-set values:** impossible **at the row level** — the
  CHECK constraint rejects anything outside the 16-value whitelist. But
  the TS code lowercases before comparison, so a legacy uppercase row from
  pre-CHECK history (if any exists) would pass DB validation only if it
  happens to equal a lowercase canonical value. Worth a one-shot DB query
  to confirm there are zero stale-case rows before shipping.
- **Free text / huge cardinality:** **cannot happen** while M127 is
  applied. The CHECK constraint is the hard floor. Confirmed M127 is in
  `MIGRATIONS.md` as applied.
- **Per-org categories:** not supported. Owners cannot define their own
  dish categories today.
- **Fallback colour for unmapped categories:** technically not needed
  given the CHECK constraint, but defensible to ship one anyway for: (a)
  NULL `type`, (b) `sauce` if we decide that sub-recipes don't get a
  category colour, (c) `other` and `drink` which are semantically "I don't
  know" buckets. Recommend a `slate` neutral for all three.

## Surprises / risk flags

1. **The drink-set whitelist is duplicated in four files.** This isn't a
   colour problem but it would BECOME a colour-correctness problem
   immediately — if a future contributor adds, say, `'mocktail'` to the DB
   CHECK and one render site's hardcoded Set, but not the others, the
   colour would silently fall back to the "unknown" neutral. The colour
   helper should source its category-to-group mapping from ONE shared
   constants file and the four call sites should consume it. (Outside the
   scope of the colour build per se, but it's the right pre-condition.)
2. **`InlineType` is a `<select>` element.** Native selects don't render
   coloured option fills consistently across browsers — the current
   selection looks like body text, options look like browser defaults.
   The colour would only be visible on the cell itself, not inside the
   dropdown. If we want a coloured pill in the recipes table cell, the
   cell needs to wrap or replace the select with a pill+chevron pattern,
   not just style the select.
3. **`sauce` is the only `is_subrecipe`-implying type.** All other
   sub-recipes use `type=NULL` + `is_subrecipe=true`. The colour map
   should probably treat `sauce` as the **sub-recipe colour** (neutral
   slate?) rather than a food colour, because owners reading the recipes
   list see "Dishes / Sub-recipes / All" buckets and a green `sauce`
   pill in the All view would read as "this is a starter" by analogy.
4. **No reusable Pill component.** Five render sites hand-roll inline
   styles, each with slightly different padding/radius. Shipping a
   `CategoryPill` component as part of the colour build kills five birds
   with one stone but doubles the diff size. Worth a conversation before
   the build.
5. **The `TypePill` filter row uses lavender for the ACTIVE state, not
   for the category identity.** Today it communicates "this filter is
   selected", not "this is a pizza-flavoured pill". When category gets
   colours, those filter pills should probably show the category colour
   when ACTIVE (e.g. pizza-red for the active "Pizza" filter) so colour
   meaning is consistent across "the category label on a recipe" and
   "the active filter for that category".

---

*Source files inspected: sql/M084-RECIPES.sql, sql/M127-DRINK-TYPES.sql,
lib/constants/tokens.ts, lib/inventory/categories.ts, components/RecipeEditor.tsx,
components/EditItemModal.tsx, app/inventory/recipes/page.tsx,
app/inventory/recipes/prep/page.tsx, app/inventory/recipes/menus/page.tsx,
app/inventory/recipes/menus/[id]/page.tsx. No DB queries executed.*
