# Claude Code — Prep List (manual-covers → aggregated component prep)

## Purpose

19 real recipes now exist, with shared sub-recipes — enough to build a prep list that does the genuinely useful thing: **aggregate shared components across the dishes being made, so the kitchen sees "prep this much of each component today," not a per-dish checklist.** If pizza sauce feeds five pizzas, the prep list rolls those up into one "prep 4 kg sauce" line.

**v1 = manual expected covers** ("making 20 Margheritas + 15 Carbonaras today" → component prep quantities). This ships on exactly what exists now. **Demand-prediction (prep based on forecast sales) is deferred** — it needs a POS-dish→recipe link we haven't confirmed exists; building v1 manual-first avoids depending on unverified upstream data, and demand becomes a clean upgrade later.

Investigation-first (Step 0 gates the build), feature branch + preview, `UXP.*`/`Z.*` tokens, Swedish formatting, no prod deploy without review.

## Step 0 — Read-only checks before building (report, then proceed/flag)

Three things to confirm on the real data before designing around assumptions:

1. **Recipe cost-health on the 19** — the prep list inherits whatever's in the recipes, so flag any recipe with incomplete cost, unit mismatch, or implausible values. (Prep *quantities* don't need costs — but a unit mismatch in a recipe WILL produce a wrong prep quantity, so the unit-level issues matter here even if cost gaps don't.) List which of the 19 are clean vs need attention. This is the believability check we never ran on the authored set.

2. **Sub-recipe structure + quantity rollup** — how deeply do the 19 nest (e.g. pizza → dough → starter = 2 levels)? Which sub-recipes are shared across multiple dishes (the aggregation payoff)? And critically: does `loadRecipeIndex` / the existing graph-walk already resolve **quantity** rollup ("how much of component X is needed across these N dishes at these quantities"), or does it only walk the tree for *cost*? If quantity-rollup is net-new, scope it — it's the core of the prep list. Confirm the cycle-guard covers the quantity walk too.

3. **Demand link (for the future upgrade, not v1)** — does any POS / Personalkollen → recipe/dish link exist that could later drive predicted-covers? Just confirm presence/absence so we know whether the demand upgrade is "wire an existing link" or "build the link." Don't build it.

Report a findings block: the 19's cost/unit health, the sub-recipe nesting + shared-component map, whether quantity-rollup exists or is net-new, and whether a demand link exists. Flag anything that contradicts the v1 design.

## Step 1 — Build the manual-covers prep list

- **Input:** the owner enters expected production — either per-dish covers ("20 Margherita, 15 Carbonara") or a simpler total, your call on what's fastest; per-dish is the more useful default.
- **Core engine:** for the entered dishes × quantities, walk each recipe's ingredient tree and **aggregate by component** — every raw ingredient AND every shared sub-recipe rolled up to a total quantity needed. Pizza sauce used in 5 of the entered dishes → one summed "prep X kg sauce" line. This is the value; build it on the Step-0 quantity-rollup (existing or net-new).
- **Output: a prep list grouped sensibly** — sub-recipes/components to prep (with total quantity), and optionally the raw ingredients to pull. A cook should read it as "here's what to make and how much."
- **Units:** roll up in the component's natural prep unit (kg sauce, not grams-scattered-across-dishes); handle the unit conversions the recipes already encode. If a component's units don't reconcile across the dishes using it, flag that line rather than producing a wrong total (honest-incomplete, same rule throughout).
- **Honest states:** a recipe flagged in Step 0 (incomplete/unit-mismatch) should mark its contribution to the prep list as uncertain, not silently produce a wrong quantity.

## Step 2 — Keep it scoped

- v1 is manual-covers only. **Do NOT build demand-prediction** — leave a clean seam for it (the covers input is where predicted demand would later plug in), but don't depend on POS data.
- Don't over-build: no scheduling, no inventory-deduction-on-prep, no waste integration in v1 — those are downstream of a working prep list, same discipline as deferring the margin surface until recipes existed. A prep list that correctly aggregates components from manual covers is the whole v1.

## Hard rules
- Step 0 gates the build — confirm quantity-rollup exists or scope it; confirm the 19's unit-health.
- Aggregation by shared component is the core value — build that, not a per-dish checklist.
- Honest-incomplete: a unit-mismatched or incomplete recipe flags its prep contribution, never silently wrong quantities.
- Manual covers v1; demand-prediction deferred with a clean seam, not built.
- Reuse the existing recipe graph-walk/cycle-guard; don't reimplement tree traversal.
- Feature branch + preview; no prod deploy without review.

## Deliverable
Step 0 findings (19's health, sub-recipe/shared-component map, quantity-rollup exists-or-net-new, demand-link presence). Then the manual-covers prep list on a feature branch + preview: enter dishes×quantities → aggregated component prep list, with any flagged recipes' contributions marked uncertain.

Three-line chat summary: (1) of the 19, how many are clean vs unit/cost-flagged, and how many sub-recipes are shared (the aggregation payoff); (2) does quantity-rollup reuse the existing graph-walk or was it net-new; (3) does the prep list correctly aggregate a shared component (e.g. sauce) across multiple entered dishes into one prep quantity — the core v1 test.
