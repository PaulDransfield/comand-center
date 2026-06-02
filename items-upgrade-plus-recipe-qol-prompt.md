# Claude Code — Items Surface Upgrade + Recipe-Drawer Quality-of-Life (combined)

## Purpose

Two related pieces that together form a **fix-the-library loop** plus the authoring conveniences that feed it. They're bundled because they're interdependent — the inline "Create item" (Part B) is only safe *because* the Needs-attention filter (Part A) catches what it creates.

The audit confirmed CC already has an Items list (`/inventory/items`) and the EditItemModal exists. So this is gap-fills and small QoL additions on existing surfaces — not new surfaces.

**Nav: Option C — fill gaps in place.** No rename to "Recipes & Items", no new sub-tab framework. Take QVANTI's *capabilities*, keep CC's design.
**Explicitly deferred (do NOT build):** standalone Supplier Articles surface; Purchase Lists persistence (draft/sent/received); the deferred `products` columns (cost_group, inventory_list, can_be_inventoried, description, tags — no consumer, stay deferred).

Investigation-light, feature branch + preview, `UXP.*`/`Z.*` tokens, Swedish formatting, no prod deploy without review.

---

## PART A — Items surface: "Needs attention" filter + modal launch

### A1 — "Needs attention" filter on `/inventory/items`
Surface the incomplete signals we *already compute* as a filterable worklist:
- **No connected article** (no active `product_aliases` row).
- **No price** (no `latest_price` / `price_override`, or `observation_count` = 0).
- **Unreliable extraction** — recent price from an extraction flagged `over_extraction` / `total_mismatch`.
- **No default supplier** (`default_supplier_name` null AND no fallback resolvable).

Requirements:
- A "Needs attention" filter chip (alongside the existing category filter) with a **count badge** so it reads as a worklist.
- Each flagged row shows **which** signal(s) fired (small reason tag: "no article" / "no price" / "unreliable" / "no supplier") — actionable, not just a flag.
- Compute signals **server-side** in the existing items-list query (no per-row N+1). Mirror the honest-incomplete signals used elsewhere (`missing_prices`, the extraction guard flags).
- Sort by most-incomplete so the worst offenders surface first.

This is the cockpit for the yield/supplier backfill that's the current manual priority.

### A2 — Launch the existing EditItemModal from the Items list
- Wire the **existing** `<EditItemModal>` to open from a row on `/inventory/items` (and/or the item detail page) — the second mount point it was designed for (only the recipe mount got wired).
- Reuse the existing `/api/inventory/items/[id]/edit-context` reader + the modal's save/connect/repoint/disconnect paths. **No changes to the modal itself** — add a mount point only.
- On save, refresh the affected row; fixing an item should visibly drop it off the "Needs attention" filter (the satisfying loop).
- Confirm propagation holds from this entry point (same component + endpoints already verified — just confirm the inventory mount triggers the same recompute path).

---

## PART B — Recipe-drawer quality-of-life (two small additions)

### Step 0 (confirm before building these two)
- **Per-row commit:** does the recipe drawer's inline ingredient editing already have a clear per-row save affordance, or does it rely on blur/autosave? (Determines whether B1 is a real add or redundant.)
- **Inline-create path:** what currently happens if a needed item isn't in the catalogue while authoring — is there any create path, and if an item were created inline, would it get the correct `business_id`, land in `products`/the catalogue, and automatically pick up the Needs-attention flag (no article / no price)? This is the load-bearing detail for B2.

Report a short findings block, then build B1/B2 accordingly.

### B1 — Green-tick per-row commit (QVANTI reference: the checkmark on an edited row)
If the drawer's inline editing lacks a clear commit affordance: add a per-row **confirm (green tick)** to commit that row's quantity/waste edit, removing the "did that save?" ambiguity. If clear autosave already exists, note it and skip (don't add redundant UI).

### B2 — Grounding-aware inline "Create item" in the picker (QVANTI reference: "Create 'gra'")
Let the owner type a name in the ingredient picker and, if no match, **create the item inline** so authoring isn't blocked by a missing catalogue item.

**The grounding rule (load-bearing — this is why it's safe):**
- An inline-created item is **born needs-attention-flagged** — it has no connected article and no price, so it must immediately appear in the Part A "Needs attention" filter ("no article", "no price"). Create-now, ground-later.
- It must NOT silently produce a confident-looking recipe cost. The recipe using it shows **incomplete cost** for that line (the honest-incomplete rule) until the item is grounded via the EditItemModal.
- Created with the correct `business_id`, landing in the catalogue (`products`) so it's a real item, not free-text — just an *ungrounded* real item the cleanup loop will catch.
- This preserves the "link, don't type" principle: inline-create is a deferred link, not a bypass of grounding. The convenience is real; the grounding debt is tracked, not hidden.

**Why B2 depends on A1:** without the Needs-attention filter, inline-created items would spawn ungrounded and forgotten (exactly the QVANTI screenshot where every line is a warning + N/A cost). With A1, every inline-created item lands on the worklist. Build them together.

---

## Hard rules
- Option C nav — fill in place, no rename, no new tab framework, no QVANTI-layout mimicry.
- Reuse the existing EditItemModal + edit-context endpoint — add a mount point, don't fork the modal.
- "Needs attention" surfaces already-derivable signals — no new schema, no deferred columns.
- Signals server-side (no N+1).
- **Inline-created items born needs-attention-flagged + incomplete-cost — never silently ungrounded.** This is the rule that keeps B2 from eroding the grounding the costs depend on.
- Supplier Articles standalone + Purchase Lists persistence: NOT built, deferred.
- Feature branch + preview; no prod deploy without review.

## Deliverable
Part A (Needs-attention filter with count + reason tags; EditItemModal mounted on the items list) + Part B Step-0 findings then B1/B2 as warranted, on a feature branch + preview.

Three-line chat summary:
1. How many items flag "Needs attention" per business, by signal (no article / no price / unreliable / no supplier); does fixing one via the modal drop it off the filter with propagation intact.
2. Recipe drawer: did B1 (green-tick commit) get added or was clear autosave already present; does B2 (inline create) produce an item that's born needs-attention-flagged and shows incomplete-cost on its recipe line (not a silent confident cost).
3. Confirm no regression on the recipe-drawer mount of the EditItemModal, and that inline-created items land in the catalogue with correct business_id.
