# Claude Code — Shared "Edit Item" Modal (in-context article + cost + recipe-ripple)

## Purpose

Build a single reusable **"Edit item" modal** that lets the owner edit everything about an ingredient/article in one place — its details, its **supplier-article connection** (with live cost + price trend), and **"Used in recipes"** (every recipe consuming it, at what quantity). Mount it in **two** places, same component:
1. **Inside recipe authoring** (`/inventory/recipes`) — fix an ingredient in place without leaving the dish. "Used in recipes" = the cost-ripple of the change.
2. **In the inventory/article surface** — adjust an article's price/waste/link directly. "Used in recipes" = a blast-radius preview of which dishes you're about to affect before saving.

Benchmark reference: QVANTI's "Edit item" modal (one place to edit item + article link + see recipe usage). **CommandCenter keeps its own design** — lavender system (`UXP.*`/`Z.*` tokens, `#f1eff9` page / `#fff` cards / lavender primary), Swedish number formatting (space-grouped, single `kr`), no new component/chart libraries. Take the *structure and behaviour* from the benchmark, not the styling.

Investigation-first, feature branch + preview, no prod deploy without review.

## Step 0 — Confirm what the schema supports (READ-ONLY) before building

Some of the benchmark's fields exist in CC; some are "verify, don't assume":
- **Confirmed present** (from M109 + existing schema): item name, unit, default price, waste % (`recipe_ingredients.waste_pct`), sub-recipe composition (`subrecipe_id`), product cost via `getProductLatestPrices`.
- **Verify / likely net-new:** `cost_group` and `inventory_list` (flagged "verify in CC" earlier — confirm if columns exist; if not, they're additive, same-commit DB+TS, but **do not block the modal on them** — render only what exists).
- **The article connection:** how is a `product` linked to a supplier article today (the matcher / `product_aliases` layer)? Confirm how to read the current link, the article's latest price, and the price trend ("X% last week") — and how to **change/connect** the link from the UI (search the catalogue, pick an article, persist the link via the existing path — SELECT-then-INSERT for partial uniques, no `.upsert`).
- **"Used in recipes":** confirm the query — given an item, which recipes (and sub-recipes) consume it and at what quantity. The costing engine already resolves this; reuse it.

Report a short findings block: what's renderable now, what's net-new, and the exact read/write paths for the article link. Flag anything that contradicts the design below.

## Step 1 — Build the shared component

A single `<EditItemModal>` (or equivalent) with three regions, mirroring the benchmark's information architecture in CC's design:

**A. Item details (left):**
- Name (required), unit, default price, default waste %, optional description, and `cost_group` / `inventory_list` **only if those columns exist** (Step 0).
- Show the item's **current cost + price trend** prominently at the top (e.g. "331,10 kr/kg · → 0,0% senaste veckan") — read from the article's latest price.
- **Honest cost state:** if the item's cost is unreliable (no connected article, no recent price, or the price comes from a known-incomplete extraction), show **"ofullständig kostnad / incomplete cost"** rather than a confident number. Never display a precise price built on a missing/unreliable input. (Reuse the `missing_prices` / `unit_mismatch` signals the costing engine already returns.)

**B. Supplier article connection (right, top):**
- Show the currently connected article (name, supplier, article code, latest price). 
- A **"Connect article" search** to change/set the link — typeahead over the catalogue, pick, persist via the existing matcher/alias path. Connecting or changing the article updates the item's cost.
- This is the in-context mapping fix — the moat layer, editable at point of use.

**C. Used in recipes (right, below):**
- List every recipe consuming this item, with the quantity used (e.g. "Parmesan Sauce Chicce · 0,5 kg"), link-out to each.
- This is the **ripple/blast-radius** view — identical data in both entry points; framed as "what this change affects."

**Actions:** Save / Cancel / Delete (delete = archive via `archived_at`, not hard delete, preserving referential integrity — per the recipe spec).

## Step 2 — Mount in both entry points (same component, different invocation)

- **Recipe authoring** (`/inventory/recipes`): clicking an ingredient's edit opens the modal. On save, the recipe's live cost/margin recomputes (it already reloads after save).
- **Inventory/article surface:** opening an article opens the same modal. On save, note in the UI that connected recipes' costs will update.
- The component must not assume which context it's in beyond the framing copy — same data, same behaviour, one source of truth.

## Hard rules

- **One shared component**, two mount points — no duplicate editors (they'd drift).
- Render only fields the schema actually supports (Step 0); additive columns land same-commit DB+TS if you add `cost_group`/`inventory_list`.
- Article-link writes via the existing matcher/alias path (SELECT-then-INSERT, not `.upsert` — partial unique indexes).
- **Honest incomplete-cost state** over confident-wrong numbers — especially for items backed by known-incomplete extractions (the Laweka/passthrough per-line issue isn't fixed yet; those items must show incomplete, not a wrong price).
- Delete = archive, never hard delete.
- CC design tokens only; Swedish formatting; no new libraries; feature branch + preview, no prod deploy without review.

## Deliverable

Step 0 findings (renderable-now vs net-new, the article read/write paths). Then the shared `<EditItemModal>` on a feature branch + preview, mounted in both recipe authoring and inventory, with a short summary: which fields render, how the article-connect works, and confirmation the "used in recipes" ripple shows in both contexts. Note which suppliers' items show trustworthy prices vs incomplete-cost (the per-line-extraction-pending ones).
