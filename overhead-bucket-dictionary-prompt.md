# Claude Code — Phase B: BAS → Operator-Bucket Dictionary (light up /overheads)

## Purpose

The invoice-organisation investigation established: categorisation is ~95% read-and-roll-up (Fortnox's BAS coding is authoritative), the restaurants use a tiny ~19-account working chart per business, and the **consumer surface already exists** — `/overheads` reads `tracker_line_items.category/subcategory` and renders breakdown + drilldown + PDF, but the subcategory field is mostly `?`.

So Phase B is **enrichment, not a new build**: a small static dictionary mapping the real BAS accounts → operator-facing buckets, applied to populate the empty subcategory field, so `/overheads` shows a real cost structure. CC adds ~zero genuine categorisation — it's translating the accountant's BAS coding into the buckets an owner reads.

Grounded in the **actual** chart, not invented. Investigation-first, additive, feature branch + preview, no prod deploy without review.

## Step 0 — Read the real chart from the prior findings (don't invent it)

Before writing any mapping:
1. Pull the actual working-chart accounts from `docs/investigation/invoice-organisation-plan.md` (Part 1.2 — the distinct BAS accounts appearing across the population, by spend). Use THAT list — ~19 per business — not a guess from sample invoices.
2. Confirm where the operator structure is stored and read: `tracker_line_items.category` / `subcategory` — what values does `/overheads` expect, what's the current distribution (how much is `?`), and how does the surface group them? Read `/overheads` + its data source so the dictionary outputs values the surface already understands.
3. Confirm the **operator buckets** the surface renders (or should): ground them in the real accounts found — e.g. Food COGS / Beverage / Alcohol / Wine / Rent / Utilities / Professional services / Marketing / Security / Bank & fees / Deposits (pant) / Other. Adjust to match what the 19-account chart actually contains per business (don't create buckets no account maps to).

Report a short findings block: the real account list, the target buckets, the current `?` distribution, and the read/write path for `subcategory`. Flag any account that doesn't map cleanly.

## Step 1 — Build the dictionary

A static `BAS → operator-bucket` map in a sensible location (e.g. `lib/overheads/basBuckets.ts`), keyed on BAS account number:
- One entry per real account in the working chart → its operator bucket. ~50 lines, deterministic, no inference.
- **Per-business awareness where it matters:** we learned the same-meaning-everywhere rule (global dict only for accounts that mean the same thing at every business; multi-purpose accounts get per-business handling). Most BAS accounts are universal (4010 = food everywhere) — but if any account in the chart is used differently across Vero/Chicce, handle it per-business, not globally. Surface any such account from Step 0.
- Accounts with no clean bucket → an explicit `'other'` / `'uncategorised'`, never a silent wrong bucket.

## Step 2 — Handle the multi-bucket sub-line case (size first, then decide)

Some single invoices split across buckets — the Carlsson & Åqvist rent invoice has sub-lines: base rent, fastighetsskatt, serviceavgift, marknadsföring, preliminär elkostnad — which belong in *different* operator buckets (rent / property / service / marketing / utilities) even though it's one invoice on (likely) one rent account.
1. From Step 0's data, **size how often this occurs** — is multi-bucket sub-line splitting common or a handful of rent-type suppliers?
2. If rare: handle the common case (one account → one bucket via the dictionary) cleanly, and leave multi-bucket invoices in their dominant bucket with a flag/note (honest-incomplete: "contains mixed sub-lines") rather than mis-splitting. Don't over-engineer sub-line parsing for a handful of invoices.
3. If common enough to matter: propose (don't build yet) a sub-line mapping approach and flag it as a follow-up. Phase B's win is the 95% clean account→bucket roll-up; the multi-bucket tail shouldn't block it.

## Step 3 — Apply the enrichment

- Populate `tracker_line_items.subcategory` from the dictionary for the existing `?` rows where a BAS account resolves. Idempotent (re-run = no-op), additive, business-scoped, ownership-checked (`current_user_org_ids()`).
- **Honest-incomplete preserved:** a line with no reliable BAS account stays `?` / uncategorised — never force a bucket without the account signal. (This is why Vero's no_pdf 452 just leaves those invoices uncategorised at `/overheads` until recovered — correct, not a bug.)
- Make it a **persistent rule too**, not just a one-time backfill: new invoices ingesting with a BAS account should get their subcategory set via the same dictionary, so `/overheads` stays populated going forward (mirror the inventory back-fill + matcher-rule pattern — one-time fills the past, the rule keeps the future clean).

## Step 4 — Verify on the surface

- Dry-run the backfill (count rows that would resolve, by bucket, per business) → review → apply.
- Confirm `/overheads` now renders a real breakdown (Vero especially, given its 83.9% BAS coverage) — buckets with sensible spend, drilldown intact, PDF access intact.
- Confirm the uncategorised remainder is honestly shown (the no_pdf / no-account lines), not hidden or mis-bucketed.

## Hard rules
- Dictionary grounded in the real 19-account chart (Step 0), not invented.
- Global dict only for same-meaning-everywhere accounts; per-business for any multi-purpose account.
- No account silently mis-bucketed — unmapped → explicit `other`/`uncategorised`.
- Honest-incomplete: no BAS account → stays uncategorised, never force-bucketed.
- One-time backfill + persistent ingest rule (past + future), idempotent, ownership-checked, additive.
- Multi-bucket sub-line: size it; handle the common roll-up, flag the tail, don't over-build.
- Feature branch + preview; dry-run before apply; no prod deploy without review.

## Deliverable
Step 0 findings (real chart, target buckets, `?` distribution, multi-bucket frequency). Then the dictionary + backfill + persistent rule on a feature branch + preview, with Step 4 verification: `/overheads` rendering a real cost structure, the dry-run counts by bucket, and the honestly-uncategorised remainder.

Three-line chat summary: (1) how many `?` subcategory rows resolved to real buckets, by business; (2) does `/overheads` now show a real operator cost structure; (3) the uncategorised remainder (no-account / no_pdf lines) honestly shown, and whether multi-bucket sub-line splitting needs a follow-up.
