# Claude Code — Mobile: Recipe-List Table Overflow + Systemic Overlay Positioning

## Purpose

Two mobile breaks are visible on live screens the owner is actively using (screenshots reviewed):

1. **Recipe-LIST table still overflows** (recipes index page) — "RECIPE / TYPE / INGREDIENTS" with the ingredients column cut off and a horizontal scrollbar under the row. Phase 2 converted the recipe *editor's* ingredient table to `<DataTable>`, but the recipe *list* table on the index appears NOT converted — still desktop-table-squeezed.
2. **A dropdown/popover renders OFF the left edge of the viewport** — a menu (page-section selector or filter) opens half off-screen on mobile, partially unusable. Layout primitives (`<CardGrid>`, `<DataTable>`) cover grids and tables but **overlays — dropdowns, popovers, menus, modals — are a separate category the responsive system hasn't addressed.** If one dropdown opens off-screen, they likely ALL do — this is probably **systemic**, the mobile equivalent of "one silent-null means the same bug everywhere."

Investigate both; fix the recipe-list table; for overlays, determine if it's systemic and whether it needs a viewport-aware fix or a shared overlay primitive. Read `/mnt/skills/public/frontend-design/SKILL.md`. Locked lavender tokens, Swedish formatting, no new libraries. Feature branch + preview, no prod deploy without review.

## Part A — Recipe-list table overflow

1. **Confirm scope:** is the recipe-list table (the index/list page, not the editor) converted to `<DataTable>` or still a raw desktop table? Was it simply missed in Phase 2 (which did the editor), or is the list a separate surface still owed?
2. **Fix:** convert the recipe-list table to the existing `<DataTable cards>` primitive — table on desktop, card-per-row on mobile/tablet (recipe name as card title, GP%/Incomplete badge prominent, type + ingredient count + menu/food cost as meta). Same primitive already proven on the editor; this is reuse, not new logic.
3. Confirm the GP%/food%/Incomplete-cost values render identically — layout only, no data change.

## Part B — Overlay positioning (the likely-systemic one — investigate FIRST)

This is the more important finding because it's probably not one dropdown — it's every overlay.

1. **Inventory the overlay patterns:** how do dropdowns / popovers / menus / modals position themselves across the app? Fixed pixel offsets? Anchored to a trigger with absolute positioning? A shared component, or per-page hand-rolled? Find the pattern(s).
2. **Determine if it's systemic:** does the off-screen break affect ONE dropdown or the whole class? Test a few different overlays at phone width (the page-section selector, any filter dropdowns, the item/ingredient pickers, any modal). Report which break and which don't.
3. **Root cause:** why does the seen dropdown open off the left edge — absolute position assuming desktop space to the right/left, no viewport-edge detection, fixed width wider than the phone?
4. **Fix shape — scope, then apply:**
   - If there's a **shared overlay/dropdown component**, fix it once (viewport-aware: on mobile, open full-width or as a bottom-sheet, clamp to viewport edges, never spill off-screen) → fixes all consumers at once. **Best case.**
   - If overlays are **hand-rolled per page**, that's the systemic problem — propose a small shared overlay primitive (a `<Popover>`/`<Menu>` that's viewport-aware by construction) so this gets fixed everywhere and future overlays inherit it, consistent with the Phase 1 primitives philosophy. Convert the visibly-broken ones now; flag the rest for a sweep.
   - Mobile pattern: dropdowns/menus should open as **full-width or bottom-sheet** on mobile rather than a desktop-anchored floating box — clamp to the viewport, never render off-edge.
5. Don't over-build: if it's a shared component, one fix. If hand-rolled everywhere, build the primitive + convert the broken ones + plan the sweep — don't convert all overlays blindly in one pass.

## Hard rules
- Part B (overlays) investigated first — it's likely systemic and higher-impact than the single table.
- Recipe-list table uses the EXISTING `<DataTable>` primitive — reuse, don't rebuild.
- Overlays: fix the shared component if one exists; else propose/build a viewport-aware overlay primitive and convert the broken ones, plan the rest. No new libraries.
- Layout/positioning only — no data/logic changes; all values + honest-incomplete states identical.
- Read frontend-design SKILL.md; locked lavender tokens; Swedish formatting.
- Feature branch + preview; verify at phone width (overlay opens on-screen, table card-per-rows) before merge.

## Deliverable
Part A: recipe-list table converted to `<DataTable>` (was it missed or owed — state which). Part B: overlay investigation (shared vs hand-rolled, which break, root cause) + the fix (shared-component fix OR new overlay primitive + broken ones converted + sweep plan). Feature branch + preview.

Three-line chat summary:
1. Recipe-list table — was it missed in Phase 2 or a separate owed surface, and is it now card-per-row on mobile;
2. Overlays — is the off-screen dropdown systemic (how many overlay types break), and is the fix a one-shot shared-component fix or a new viewport-aware overlay primitive + sweep;
3. What's fixed now vs flagged for a follow-up sweep, and whether overlays need their own phase like the scheduling grid does.
