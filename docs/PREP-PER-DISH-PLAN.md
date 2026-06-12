# Prep list — per-dish grouping + per-line waste + accountability

> Owner decisions locked 2026-06-12 (via the in-app prompt). Built incrementally; this tracks what's done vs next.

## The problem (owner's words)
- The waste log pops up only when the WHOLE prep list is finished — unworkable when several chefs share one list.
- Raw ingredients are one aggregated line ("Tomatoes 5kg") with no indication of which dish they're for, so 3 chefs working the same list might each pull the same thing.
- When a dish is prepped, the chef/bartender who did it must be logged for accountability.

## Decisions
- **Grouping:** per-dish sections (each dish shows its sub-recipes + raw ingredients with THAT dish's share) **plus a Totals tab** (the summed pull-once view, for bulk pulling / ordering).
- **Waste:** **tap-to-log per line** — a small "log waste" affordance on each row, used only when something was actually wasted. No end-of-list modal.
- **Scope:** both the staff tick-off view and the owner/manager prep page.
- **Accountability:** per-line `checked_by` (M153) at per-dish granularity → each chef who pulls a dish's items is recorded; when a dish is fully checked we show "Prepped by X".

## Data model (shipped)
- **M156** — `prep_session_lines.dish_recipe_id` + `dish_name_snapshot`. Lines are now materialised **per dish** (the engine runs once per dish, quantities frozen at save). A sub-recipe/ingredient used by two dishes becomes two lines, each under its dish. Totals are derived by summing `(kind, entity_id, unit)` across dishes.
- Legacy aggregated sessions (no `dish_recipe_id`) render as a single "All items" group — backward compatible.

## Phase 1 — backend + staff view ✅ SHIPPED (2026-06-12)
- `POST /api/inventory/prep-sessions` runs `aggregatePrepRequirements` per dish and stores per-dish lines (`dish_recipe_id` + `dish_name_snapshot`), positions continuous, flags de-duped across dishes.
- `GET .../[id]` returns the dish fields (spread through `enrichedLines`).
- **`components/inventory/StaffPrepView.tsx` rebuilt:**
  - **Dishes tab** — a section per dish (name, `done/total`, and "Prepped by X, Y" when all its items are checked), each line with checkbox + qty + "tap for method".
  - **Totals tab** — summed pull-once quantities (read-only reference for bulk pull / ordering); "make" vs "pull" + "N dishes" hint.
  - **Per-line waste** — a "+ log waste" affordance on each row opens an inline qty + reason form that POSTs one event to `/api/inventory/waste` (with `prep_session_id`); shows "waste logged ✓" after.
- **Fix:** `waste_log.created_by` was reading `auth.user?.id` (always null) → now `auth.userId`, so who logged waste is actually recorded (same class of bug as the stock-count `created_by`).

## Phase 2 — owner/manager prep page (NEXT)
The owner page (`app/inventory/recipes/prep/page.tsx`, ~3.3k lines) still works on per-dish lines (it consumes them per-row), but its display is not yet dish-grouped and it still uses the end-of-session waste modal. To finish the "both views" decision:
- [ ] Group the saved-session line lists (`sessionComponents` / `sessionProducts`, and the mobile `currentLines`) under dish section headers — mirror the staff view's Dishes/Totals split.
- [ ] Make the create-mode **preview** per-dish too (currently the aggregated engine `result`), so preview matches what's saved.
- [ ] Replace the completion waste modal (`completeSession` / `wasteModal`) with the same per-line tap-to-log affordance; keep "Skip & complete" as a plain complete.
- [ ] Surface per-dish "Prepped by X" in the owner view's session summary.

Lower urgency than Phase 1 because the owner page isn't the surface where multiple chefs work the list concurrently — that's the staff view, which is done.

## Notes / gotchas
- Quantities stay **frozen** at save (CLAUDE.md prep invariant) — the per-dish split is computed once at creation, not recomputed live.
- Components (sub-recipes) appear under each dish that uses them, but are actually batch-prepped once — the **Totals tab** is the place to read the real batch quantity. This is the inherent tension the owner accepted by choosing "per-dish + totals".
- Waste reasons in the staff form are a subset of the `waste_log` allow-list (spoilage / overproduction / spill / staff_meal / other).
