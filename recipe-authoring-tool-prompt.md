# Claude Code — Fast Recipe Authoring (the seeding tool, not a polished surface)

## Purpose

Phase 0 of the recipe-cost work found the blocker: the catalogue is seeded (~1,196 Chicce products) but almost no recipes consume it (2 toy recipes, 0 selling prices). The margin surface can't exist until recipes do. So the next build is the **recipe-authoring equivalent of the catalogue pass** — a fast, low-friction tool for the owner to type 20-30 real dishes in a sitting, linking the products already in the catalogue.

**This is a seeding tool for the owner, not an operator-facing product surface.** Optimise for speed of entry and correctness of the resulting data, not polish. The polished margin view comes later, once there are real recipes to display.

Scope to **Chicce** (better seeded). Investigation-first, feature branch + preview, no prod deploy without review. `UXP.*`/`Z.*` tokens; Swedish number formatting; no new component/chart libraries.

## The design principles (these are what made the catalogue pass work — carry them over)

1. **Link, don't type.** An ingredient is a **selection from the existing catalogue** (`products`), not free-text. Fast typeahead search over the ~1,196 Chicce products; pick the product, the cost comes with it. Authoring a recipe = picking products + quantities, not re-describing ingredients.
2. **Units match how invoices/kitchens express them.** Quantity entry must handle the real unit reality we saw on invoices (g, kg, st, "25kg sack", "8x125g") without the author fighting conversion. Enter the quantity in a sensible recipe unit; the engine converts to the product's stock unit for costing. If a conversion is ambiguous, flag it inline — don't silently guess.
3. **Reusable sub-recipes.** A sub-recipe (pizza sauce, a dough, a base) is authored once and **selectable as an ingredient** in other recipes (the composable-recipe model). Pizza sauce → ingredient in five pizzas, authored once. Respect the circular-dependency guard.
4. **Selling price is first-class.** Every dish needs a selling price field — it's the whole point (no price → no margin). Make it a required, prominent field, with the dine-in/takeaway VAT context per the recipe spec.
5. **Live cost feedback while authoring (the believability check, built in).** The moment ingredients are linked, show the running **dish cost** and **margin %** live as the author types. This is the trust mechanism: the author catches a mis-united or mis-mapped ingredient *while entering it* (a cost that's wildly off jumps out immediately), instead of discovering it later on a margin page. Verify the foundation AS it's created.

## Step 0 — Investigate the existing recipe schema (READ-ONLY) before building

Confirm what's really there before writing UI:
- The `recipes` / `recipe_ingredients` schema (M084): does an ingredient line point at a `product` AND optionally another `recipe` (sub-recipe)? Is there a `selling_price`, a `waste_pct` per line, a yield qty/unit?
- How does the existing costing engine compute a recipe cost today (the path the surface would have used) — so the live-cost feedback reuses it, not a reimplementation.
- Any `can_be_inventoried` / cost-group columns (flagged as "verify in CC" earlier) — confirm presence, don't assume.
- Report what exists vs what's net-new (e.g. if `selling_price` isn't on `recipes`, that's an additive column — same-commit DB+TS).

Report a short findings block; flag anything that contradicts the principles above.

## Step 1 — Build the authoring tool

- **Recipe list + create/edit** — fast create, inline edit, duplicate-an-existing (many dishes share structure).
- **Ingredient entry:** typeahead product search → pick → quantity + unit. Show the product's current unit cost and the line's contribution to dish cost immediately. Allow a sub-recipe in the same picker (clearly distinguished from a raw product).
- **Waste %** per line (default sensible, editable) with the yield maths `cost_qty = required_qty / (1 − waste_pct)`.
- **Selling price + live margin %** at the top of the dish, updating as lines are added. Margin % primary, kr secondary (the operator-reads-ratio-first precedent).
- **Honest incomplete states:** if an ingredient has no cost (unmapped product, stale cost), the dish shows "incomplete cost" — never a confident-but-wrong margin. Same trust rule as the surface.
- **Keyboard-fast:** this is a data-entry tool — minimise clicks, support tab-through, enter-to-add-line. The catalogue pass was fast because it wasn't fiddly; match that.

## Step 2 — Verify on real authoring (the checkpoint)

Before declaring done: the owner authors **3-5 real dishes** end-to-end through the tool. Confirm:
- Ingredients link from the catalogue without friction; units convert sensibly; sub-recipes compose.
- Live cost/margin appears and is **believable** for those real dishes (this is the Phase 0 check that couldn't run before — now it runs *as* recipes are created).
- Any unit/mapping issue surfaced live, not hidden.
Report which dishes authored cleanly and any friction or wrong-cost flags.

## Explicitly deferred — POS-proposed recipes (do NOT build now)

AI-proposed recipe compositions from Personalkollen POS dishes is the natural *next* step — but it depends on real authored recipes to learn the owner's patterns/portions from. With ~2 recipes it would guess from generic knowledge and waste more time in correction than it saves. **Defer until 20-30 real recipes exist**, then it has genuine patterns to extend and the cross-dish ingredient overlap becomes real signal. Note it as the planned follow-up; build nothing toward it now.

## Hard rules

- Seeding tool first, polished surface later — optimise entry speed + data correctness, not UI polish.
- Reuse the existing costing engine for live feedback; don't reimplement cost math.
- Additive schema only (e.g. `selling_price` if missing); same-commit DB+TS for any new column/CHECK.
- Cost basis stays latest invoice price. Honest incomplete-state over confident-wrong number.
- Feature branch + preview; no prod deploy without review.

## Deliverable

Step 0 findings (schema reality vs net-new). Then the authoring tool on a feature branch + preview URL, and a Step 2 report: 3-5 real dishes authored, with their live margins and any friction/wrong-cost flags. Once 20-30 real dishes are in, the recipe-cost surface (the previously-gated build) becomes viable — and POS-proposed recipes becomes the next candidate.
