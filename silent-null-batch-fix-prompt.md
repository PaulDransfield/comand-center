# Claude Code — Fix the Silent-Null Batch Bug (items API + codebase scan)

## Purpose

The Needs-attention "no_price epidemic" (954 Chicce / 930 Vero) was a **false alarm produced by the items API itself**, not a data problem. The catalogue is healthy (genuinely ~1 Chicce + ~3 Vero items lack a price). Root cause: the items API batches ~500 UUIDs into `.in('id', [...])`, exceeds the ~16 KB HTTP header limit, and **supabase-js silently returns `{ data: null }` with no thrown error** — so the alias/price maps come back empty and most products falsely flag `no_article` + `no_price`.

The real lesson is NOT "batch size" — it's **a silent empty result was trusted as truth.** The fix has three parts, and the error-checking is the load-bearing one.

Feature branch + preview, no prod deploy without review.

## Part 1 — The immediate fix (items API)

In `app/api/inventory/items/route.ts`, both locations (preflight alias-count loop + the alias-id→product loop):
1. **Reduce batch size 500 → 100** for the `.in('id', [...])` calls, so the URL/header stays well under the limit.
2. This alone makes ~770 Chicce + ~930 Vero products resolve to their real (already-correct) prices and the Needs-attention filter show its TRUE (small) number.

## Part 2 — The load-bearing fix: fail-fast on every supabase-js call in this route

The batch size stops *this* instance; this stops the *next* silent-null from masquerading as a finding.
- On **every** supabase-js call in `app/api/inventory/items/route.ts`, check `error` and fail fast (throw / return a real error) rather than proceeding with `data` that may be null.
- **Additionally:** where a query is known to be over a non-empty input set (e.g. we just passed N product IDs and expect N-ish rows), treat an unexpectedly-empty/null result as **suspect** — log it loudly, don't silently render it as "these products have no price/article." A `{ data: null }` on a query we know should return rows is a transport failure, not a data fact.
- The principle to encode: **never let a silent empty result become a data story.** An empty result on a query that should have rows is an error condition, not a finding.

## Part 3 — Scan for the same pattern elsewhere (the cheap insurance)

This bug got caught because it produced a visibly absurd number (950). The same `.in('id', [large array])` pattern elsewhere might be **silently under-returning right now with no 950-shaped tell.**
1. Grep the codebase for `.in(` calls (especially `.in('id', ...)` / any `.in()` fed a potentially-large array — alias loops, product-id batches, recipe-id batches, the prep/order builders, the overhead backfill).
2. For each, assess: could the input array exceed ~100–200 elements in production? If yes, it's at risk of the same header-limit silent-null.
3. **Report a list** of at-risk call sites (file:line, what it batches, max plausible array size). Apply the same batch-100 + error-check fix to any that are clearly at risk; flag any ambiguous ones for review rather than blanket-changing.
4. Special attention to anything that, like the items API, would **silently produce a wrong-but-plausible result** (a partial price map, a partial order list, a partial prep aggregation) rather than an obvious error — those are the dangerous ones because they have no alarm.

## Hard rules
- Part 2 (fail-fast error-checking) is the core fix, not an extra — the batch size is the symptom, the unchecked silent-null is the disease.
- Don't blanket-rewrite every `.in()` — fix the items API + clearly-at-risk sites, report the ambiguous ones.
- No cost-layer changes (it's correct — `getProductLatestPricesLeaf` already prefers total/qty per M094), no re-extraction, no schema work.
- Feature branch + preview; verify the Needs-attention count drops to its true value before merge.

## Deliverable
The items-API fix (batch 100 + fail-fast on every call) + the codebase scan report (at-risk `.in()` sites with max array sizes + which were fixed vs flagged), on a feature branch + preview.

Three-line chat summary:
1. Post-fix, what's the TRUE Needs-attention count per business (no_article / no_price / unreliable / no_supplier) — confirming the catalogue is healthy and the worklist is now real and small;
2. The fail-fast pattern is in on every supabase-js call in the items route — a silent `{ data: null }` now errors loudly instead of becoming a false finding;
3. The codebase scan: how many other `.in()` sites are at risk of the same silent under-return, which were fixed, which flagged for review.
