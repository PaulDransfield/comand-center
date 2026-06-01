# Claude Code — Edit-Item Modal ADDENDUM: Downstream Propagation (required, tested)

## Why this addendum

The whole value of the Edit-Item modal is that a change to an item — price, waste, or which article it's linked to — **actually reaches everything downstream that depends on it.** An editor that changes an item but leaves stale costs in recipes/margins is worse than none, because you'd believe you fixed something you didn't. Step 0 indicates recipe cost is computed **live** (no cost-snapshot columns; `getProductLatestPrices` + `loadRecipeIndex` on read) — which is the right architecture. This addendum makes propagation an explicit, **tested** requirement rather than an assumption, because there are TWO different propagation mechanisms and one cached-data risk, each needing its own proof.

This is additive to `edit-item-modal-prompt.md` — same feature branch, same hard rules, stop for review before merge.

## Mechanism 1 — Price/waste changes propagate by COMPUTATION (verify, don't assume)

A change to `price_override` / waste should require **no cascade** — nothing is cached, so the next recompute reads the new value. Prove this actually holds, including the case most likely to have a gap:

- **Direct consumer test:** edit an item's price in the modal (e.g. Parmigiano). Open a recipe that uses it **directly**. Confirm the recipe cost/margin reflects the new price on next render.
- **Transitive (sub-recipe) consumer test — the one that can break:** open a recipe that uses the item **through a sub-recipe** (e.g. a dish whose "Cabonara Base" contains Parmigiano). Confirm it ALSO re-costs. This depends on `loadRecipeIndex` walking the full ingredient tree and not short-circuiting on a stale/cached sub-recipe cost. If the nested case doesn't update, the propagation has a hole — report it.
- **Waste test:** same for a `default_waste_pct` / line waste change — confirm the yield inflation (`qty / (1 - waste/100)`) re-applies in the recompute.

Report: does one edit re-cost both the direct and the transitive consumers live, with no manual re-save of the recipes? That is the proof price propagation is real and computational.

## Mechanism 2 — Article repoint/disconnect propagates by RE-ATTRIBUTION (must actually run, and be bounded)

Changing **which article an alias points to** (the repoint endpoint) is NOT a recompute of derived data — it changes historical attribution of `supplier_invoice_lines`. This propagation only happens if the matcher-reapply explicitly fires. Requirements:

- **It must actually run and complete:** after a repoint/disconnect, the dependent `supplier_invoice_lines` are re-evaluated against the new mapping, and any recipe deriving cost from those lines now derives from the corrected attribution. Verify with a test repoint: the affected lines' product attribution changes, and a recipe whose cost came from those lines reflects it.
- **It must be bounded + idempotent:** repointing one alias must not trigger an unbounded synchronous cascade that re-costs large swaths of the menu behind the Save button and hangs the modal. Scope the reapply to the directly-dependent lines; if the dependent set is large, do it async / queued with a clear "updating…" state rather than blocking Save. Re-running the repoint must be a no-op.
- **Ownership/RLS:** the repoint is a cross-cutting write — enforce business-ownership (`current_user_org_ids()`) on the alias and the dependent lines. SELECT-then-validate (partial unique index hygiene), not `.upsert`.

Report: does a repoint re-attribute the dependent lines and reach the recipes that used them, without the Save hanging?

## Risk 3 — Audit for any cached cost OUTSIDE the live-compute path (the staleness trap)

Live-on-read propagation only protects surfaces that compute on read. **Any place that stored a derived recipe cost / margin / food-cost % won't update from an item edit** — it'd keep showing the old number. Audit for these and report:

- Is recipe cost / dish margin / food-cost % **ever persisted** anywhere — a snapshot table, a report/dashboard cache, `inventory_accuracy_snapshots`, an agent's stored view (Monday briefing, anomaly detection), a materialized aggregate?
- For each cache found: does it refresh on its own schedule (acceptable — note the lag), or would it show a stale cost indefinitely after an item edit (needs an invalidation/refresh path)?
- **If nothing caches recipe cost (all live-on-read)** — state that explicitly; that's the clean result and means Mechanism 1 fully covers cost propagation.
- If a cache exists and matters, propose the invalidation hook (don't necessarily build it in v1 — but it must be known and flagged, not silently stale).

## Deliverable

A propagation report appended to the modal's deliverable:
1. **Mechanism 1:** price + waste edits re-cost direct AND transitive consumers live (with the test evidence). Any hole in the transitive case flagged.
2. **Mechanism 2:** repoint/disconnect re-attributes dependent lines, reaches their recipes, is bounded (no Save hang), idempotent, ownership-checked.
3. **Risk 3:** the audit result — either "recipe cost is live-on-read everywhere, no cache, nothing to invalidate" (clean), or the list of caches that hold derived cost + whether each self-refreshes or needs invalidation.

Three-line chat summary: (1) does one price edit propagate to both direct and nested-sub-recipe consumers; (2) does an article repoint re-attribute downstream without hanging Save; (3) is recipe cost cached anywhere that would go stale after an edit, or is it live-on-read end to end.
