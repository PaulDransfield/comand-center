# Claude Code — Recipe Editor: Full-Page Restructure (presentation, not logic)

## Purpose

Restructure the recipe-editing experience from the current right-side slide-in drawer into a **full-page editor** with sectioned layout, inline-editable ingredient rows, and a consistent create+edit surface — the QVANTI recipe-editing feel, in CC's own lavender design.

**Critical framing: the editing LOGIC and data flows are correct and STAY. This restructures the PRESENTATION around them.** The current drawer works — live cost recompute, sub-recipe handling, yield math (M111), honest-incomplete badges, article-connect, the EditItemModal launch, frozen-vs-live boundaries — all of that is right and must be preserved exactly. This is a re-housing into a better layout, NOT a rebuild of recipe costing or the ingredient model. The risk to manage is regressing working behavior while changing the shell; don't.

This IS a real UI build in the locked design system → **read `/mnt/skills/public/frontend-design/SKILL.md` first** for the design tokens/constraints. Use `UXP.*`/`Z.*` tokens, the locked palette (`#f1eff9` page / `#fff` cards / lavender primary `#a99ce6` / deep `#7d6cc9`), Swedish number formatting, no new component/chart libraries. Feature branch + preview, no prod deploy without review.

## Step 0 — Map what exists (READ-ONLY) before restructuring

Inventory the current recipe-editing implementation so the restructure re-houses it rather than reinventing:
1. The current drawer component(s) for editing a recipe — what it renders, the sections it already has, the state it holds, the save/recompute paths it calls.
2. The current **new-recipe** flow (the centered modal box) — its fields (name, type, selling_price_ex_vat, vat_rate, channel, portions) and create path.
3. The ingredient-row editing — how inline edits commit today (the green-tick B1 work — confirm it's there), how the live cost recomputes, how sub-recipes/products are distinguished, how honest-incomplete renders.
4. The EditItemModal launch from within a recipe (must keep working).

Report what exists; confirm the restructure can reuse all the logic/endpoints and only changes layout/shell.

## Step 1 — The full-page editor structure

Replace the drawer with a dedicated full-page recipe editor (route like `/inventory/recipes/[id]`), sectioned:

- **Header:** recipe name (inline-editable), type, and the live cost summary always visible — food cost, food %, GP %, GP kr, menu price (the numbers that recompute live). Save / Duplicate / Back. Honest-incomplete state shown here if any ingredient is ungrounded ("Incomplete cost" — never a confident wrong margin).
- **Items & sub-recipes section — ALWAYS EXPANDED** (this is the heart of the editor; you're always working in it; do NOT hide it behind an accordion). The ingredient table with inline-editable rows.
- **Secondary sections — collapsible** (default collapsed or remembered): General info (name/type/tags/description), Selling price & VAT (selling_price_ex_vat primary, inc-VAT+rate converter, channel — VAT rate and channel INDEPENDENT per the locked rule), Recipe cost calculation (the GP breakdown), Connected sales articles.

Rationale for the asymmetry: QVANTI accordions everything, but the ingredients section is the one you touch constantly — keep it always-open, collapse only the secondary stuff. (Flag if you'd rather accordion everything.)

## Step 2 — Inline-editable ingredient rows + green-tick commit

- Each ingredient/sub-recipe row: name, qty, unit, waste %, line cost, edit/remove — **inline-editable** (edit qty/unit/waste in place).
- **Green-tick commit** on an edited row (the B1 pattern) so the save is explicit and unambiguous; live cost recomputes after commit.
- Persistent **add-row** at the top of the table (item-or-subrecipe picker + qty + unit + waste + Add) — the QVANTI pattern, with the grounding-aware inline "Create item" (B2) preserved: inline-created items born needs-attention-flagged, recipe line shows incomplete-cost until grounded.
- Sub-recipe rows visually distinguished from raw-product rows; clicking a row's edit opens the existing EditItemModal (keep that launch working).
- Honest-incomplete per line: an ungrounded/unpriced/yield-less ingredient renders its line as incomplete, never a fabricated number.

## Step 3 — Unify create + edit (the consistency fix)

- **Creating a recipe takes you to the same full-page editor** (empty/new state), NOT a separate centered modal. One recipe surface for both create and edit — resolves the drawer-vs-centered-box inconsistency.
- The new-recipe fields (name, type, selling_price_ex_vat / inc-VAT+rate / channel, portions) become the General + Price sections of the editor, pre-focused on name for a new recipe.
- Recipe list "+ Add recipe" → navigates to the new full-page editor in create mode.

## Hard rules
- **Preserve all editing logic/data flows** — live cost recompute, M111 yield math, sub-recipe recursion + cycle guard, honest-incomplete, frozen-vs-live boundaries, article-connect, EditItemModal launch. Re-house, don't rebuild.
- VAT rate and channel INDEPENDENT (the locked rule); selling_price_ex_vat is the stored truth, inc-VAT+rate a converter.
- Read frontend-design SKILL.md; locked lavender tokens; Swedish formatting; no new libraries.
- Items section always expanded; secondary sections collapsible.
- Create + edit = one full-page surface (no separate centered modal).
- No regression: verify a fully-costed recipe (e.g. Margherita) shows identical numbers to the current drawer, and an incomplete one (e.g. Carciofi with Aioli) still shows "Incomplete cost", before merge.
- Feature branch + preview; no prod deploy without review.

## Deliverable
Step 0 map (current implementation, confirmation logic is reusable). Then the full-page recipe editor on a feature branch + preview: sectioned layout (Items always-open, rest collapsible), inline rows + green-tick, unified create/edit. Verify against current behavior.

Three-line chat summary:
1. Does the full-page editor render a recipe with identical live cost/GP numbers to the old drawer (no logic regression) — checked on a complete recipe and an incomplete one;
2. Are inline ingredient edits + green-tick commit + the EditItemModal launch + inline-create-grounding all working in the new layout;
3. Is create now the same full-page surface as edit (the consistency fix), and does the Items section stay expanded while secondary sections collapse.
