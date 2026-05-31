# Claude Code — Recipe-Cost Surfaces (foundation-first)

## Purpose

Build the operator-facing surfaces that USE the recipe-costing engine: a **dish-level margin view** (actual margin per dish, computed from real seeded ingredient costs) and **ingredient-price-spike alerts** (flag a dish when one of its ingredients jumps). This pays off the whole invoice → article → recipe pipeline.

**But the surface is only as trustworthy as the costs underneath it.** A margin page that shows confidently-wrong numbers (a mis-mapped or mis-united ingredient) is worse than no page — operators make pricing decisions on it. So this build is **gated**: verify the engine produces believable margins on real dishes FIRST, then build the surfaces on confirmed ground.

Scope the build to **Chicce** (the better-seeded business post manual-pass). Investigation-first, feature branch + preview, no prod deploy without review. Consume `UXP.*` / `Z.*` tokens; model strings from `lib/ai/models.ts`.

## PHASE 0 — Verify the cost foundation (READ-ONLY, STOP for review)

Do NOT build any surface until this passes. The question: **for real Chicce dishes, does the costing engine produce a margin number a human would believe?**

1. **Pick ~10 real Chicce dishes** that have recipes with ingredients entered (favour high-menu-frequency / high-cost dishes — the ones whose margin matters most). If few/no real recipes exist with ingredients, STOP and report that — it means the catalogue/recipe seeding isn't deep enough yet and the surface would have nothing real to show.
2. For each dish, trace the full cost chain and report it legibly:
   - Each ingredient line → which `product`/article it maps to → current unit cost → source of that cost (latest invoice price; which invoice/date).
   - **Unit normalization sanity** — this is where it breaks. Confirm pack-size/unit conversions are right: a "25kg SÄCK" of flour, an "8x125g (1kg)" mozzarella, a per-kg meat line. Flag any ingredient where the cost-per-recipe-unit looks off by an order of magnitude (the classic sign of a unit mis-parse).
   - Waste % applied (the `cost_qty = required_qty / (1 − waste_pct)` yield maths).
   - Resulting **dish cost** and, against its selling price, **dish margin** (ex-VAT, per the recipe spec).
3. **The believability check:** present the ~10 dishes' margins as a table. For each, is the number plausible for that dish? Flag every dish where an ingredient is unmapped, mis-united, has a stale/missing cost, or the margin is implausible.
4. **STOP and report.** The gate:
   - **If most dishes produce believable margins** (ingredients mapped, units sane, costs current) → proceed to Phase 1, noting which dishes/ingredients are clean vs need attention.
   - **If a material share are broken** (unmapped ingredients, unit mis-parses, stale costs) → STOP. The real next move is more seeding / unit-normalization fixes, not a surface that would display wrong numbers. Report what's broken so we can decide.

Report Phase 0 as a findings block and **wait for the owner's go** before Phase 1.

## PHASE 1 — Dish-level margin view (only after Phase 0 passes)

Build the operator surface showing actual margin per dish:
- Per dish: cost, selling price, **margin % and margin kr** (ex-VAT; respect the dine-in/takeaway VAT toggle from the recipe spec where relevant). Operators read **margin % first** — make it the primary number, kr secondary (mirror the labour-% precedent: ratio first, money second).
- Cost transparency on demand: expand a dish to see the ingredient breakdown and where each cost came from (the Phase 0 trace, surfaced) — so a surprising margin is auditable, not a black box.
- **Honest empty/uncertain states** — a dish with an unmapped or stale-cost ingredient must show "incomplete cost" rather than a confident-but-wrong margin. Never display a fabricated-looking precise number built on a missing input. This is the trust-preserving rule; it matters more than coverage.
- Swedish number formatting (space-grouped, single `kr`); `UXP.*`/`Z.*` tokens; no new chart/component libraries (inline per house style).

## PHASE 2 — Ingredient price-spike → dish alerts

- When an ingredient's latest cost jumps beyond a threshold vs its recent baseline, flag the **dishes that use it** with the margin impact ("X spiked Y% → Dish Z margin down N pp"). Reuse the existing price-creep signal/agent rather than building a new detector.
- Threshold as a named constant, not magic. Alert is **advisory** (informational), not auto-acting.
- Show the before/after margin so the operator sees the consequence, not just the price move.

## Hard rules

- Phase 0 gates everything — no surface ships on an unverified cost foundation.
- Feature branch + preview; no prod deploy without review.
- Do not modify the costing engine's math in this task — if Phase 0 finds unit/mapping bugs, report them; fixing them is a separate, scoped change (don't silently patch costs under a surface build).
- Cost basis stays **latest invoice price** (the shipped reality) — don't introduce weighted-average here.
- Honest-state-over-coverage: an incomplete cost shows as incomplete, never as a confident wrong number.

## Deliverable

Phase 0: a findings block — the ~10 dishes traced, margins, believability flags, and the gate verdict (proceed / stop-and-seed). **Stop here for owner go.**
Then (on go) Phase 1 + 2 on a feature branch with a preview URL, and a short summary of which dishes surface clean margins vs show incomplete-cost states.
