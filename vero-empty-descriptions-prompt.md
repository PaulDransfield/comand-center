# Claude Code — Vero Empty-Description Lines: Characterize (READ-ONLY)

## Purpose

~500 `supplier_invoice_lines` at Vero have empty/blank descriptions. Before the 2026-06-07 Phase D read, we need to know what they are, because they affect how we interpret Vero's `needs_review` queue depth — extraction failures are noise we'd otherwise misread as real review work. **Characterize, don't fix.** The output decides the next move (retry extraction vs accept as `not_inventory`), it doesn't make it.

This is **READ-ONLY.** No writes, no re-extraction, no status changes. Print every query.

## HARD RULES

- `SELECT`-only; no `INSERT/UPDATE/DELETE`, no migrations, no extraction runs.
- Scope to **Vero Italiano**. Note if the same pattern exists at Chicce, but don't deep-dive it.
- Deliverable: `docs/investigation/vero-empty-descriptions.md` + a three-line chat summary. No remediation.

## The questions to answer

**1. How many, and what's their current state?**
- Exact count of Vero lines with empty/null/whitespace-only description.
- Their `match_status` breakdown (needs_review / not_inventory / matched) — how many are actually sitting in the queue vs already terminal.
- Their `account_source` breakdown (fortnox_row / voucher_backfill / null) and whether they have an `account_number`.

**2. Where did they come from — the decisive split.**
- **Ingestion path:** how many came via `source='fortnox_row'` (API backfill) vs `source='pdf_extraction'`? This is the core diagnostic:
  - `fortnox_row` + empty description → the Fortnox API row genuinely had no line description (some supplier invoices are header-only / single-line bookings). These are **genuinely blank at source** — accept as-is.
  - `pdf_extraction` + empty description → the **extractor failed** to pull a description that exists on the PDF. These are **extraction failures** — candidates for retry.
- Report the split clearly; it's the headline.

**3. Do they have other signal despite no description?**
- Of the empty-description lines, how many still have an `account_number` (from voucher back-fill) or a non-zero amount? A line with no description but a clean food account + amount is still classifiable; a line with neither is a true ghost.
- Cluster by supplier — are the empties concentrated in a few suppliers (suggests a per-supplier extraction or booking quirk) or spread evenly?

**4. Amount / value sanity.**
- Total SEK across the empty-description lines, and the distribution (are they tiny rounding lines, or material amounts?). Material amounts with no description are the ones worth recovering.

## Deliverable — the verdict

`docs/investigation/vero-empty-descriptions.md`:
- Count + current `match_status` / `account_source` state.
- **The headline split:** genuinely-blank-at-source (`fortnox_row`, no description on the API row) vs extraction-failure (`pdf_extraction`, description lost) — with counts.
- How many are still classifiable via account+amount despite no description.
- Supplier clustering + value distribution.
- **Phase D implication:** how many of Vero's `needs_review` lines are these empties, i.e. how much of the queue depth is this noise vs real review work — so the 2026-06-07 read can net them out.
- Every query. **No fix** — recommend the next move (retry extraction for the failures / accept the genuine blanks), don't execute it.

Three-line chat summary: (1) of the ~500, how many are genuinely blank at source vs extraction failures; (2) how many sit in `needs_review` (i.e. inflate the Phase D queue) vs already terminal; (3) how many are still classifiable despite no description.
