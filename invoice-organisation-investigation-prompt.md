# Claude Code — Invoice Organisation: Fortnox-Grounded Investigation (READ-ONLY)

## Purpose

We want to "clean up and organise all our invoices." The key insight: **Fortnox already categorises everything** — every invoice is booked to a BAS account by the accountant, which is a complete, authoritative categorisation we should *read*, not re-derive. So the project is NOT re-categorising. It's two distinct jobs:

- **Job 1 — Data integrity:** are we capturing every Fortnox invoice completely and correctly? This is where the mess we've found lives (sync gaps, multi-page loss, empty lines, extraction failures, passthrough). Upstream of everything.
- **Job 2 — Organisation:** map Fortnox's BAS categorisation onto an **operator-facing cost structure** (food / beverage / labour / rent / utilities / services / fees / etc.) and surface it. Mostly reading-and-grouping, NOT inference — because Fortnox already did the categorising. The value CC adds is translating accountant-categories into operator-categories an owner acts on.

This investigation produces the **plan**, not the fix. It is **read-only** and **bounded to characterising the shape of the problem** — size each category of gap, don't enumerate every affected invoice.

## HARD RULES

- **READ-ONLY.** `SELECT`, schema/metadata inspection, Fortnox **GET** probes (if cheap and decisive). No writes, no re-sync, no re-extraction, no migrations.
- **Bound the scope:** characterise problem *shape and magnitude*, not an exhaustive invoice-by-invoice list. If something needs full enumeration to fix later, say so — but here, size it.
- Print every query / endpoint. Don't dump PDF content.
- Scope: all businesses with Fortnox (Vero, Chicce — note Rosali has no Fortnox), whole invoice population.
- Deliverable: `docs/investigation/invoice-organisation-plan.md` + a three-line chat summary. **No fix, no build** — a scoped plan.

## Part 1 — What Fortnox already gives us (read, don't re-derive)

Map the categorisation/structure already available so we build on it instead of reinventing:
1. **BAS account coverage:** across captured invoices, what % carry a reliable BAS account (`account_number`, now also via the voucher back-fill `account_source`)? Which populations are well-coded vs null/unknown? (We know voucher cache = ground truth; quantify coverage.)
2. **The BAS chart in use:** what distinct BAS accounts actually appear across the invoice population, and at what spend volume each? This is the raw material for the operator mapping — the real chart of accounts these restaurants use, not the theoretical full BAS.
3. **Richer supplier-side structure:** some suppliers print their own categorisation (the M&S `ÖVERSIKT KONTERING` block — DELSUMMA per sub-category mapped to 4011/4012/4014/5460). How common is supplier-provided sub-categorisation, and is it richer than the voucher account alone for those suppliers?
4. **Fortnox fields we're underusing:** does the Fortnox supplier-invoice / voucher API expose categorisation, cost-centre, project, or dimension data we're not currently capturing that would help the operator structure? (GET-probe a couple if decisive.)

## Part 2 — Data-integrity audit (the cleanup — size each gap class)

Characterise, across the whole population, where captured invoice data is incomplete or wrong. We've found these gap classes piecemeal — now size them system-wide:
1. **Coverage gap (sync):** invoices in Fortnox not captured in our DB at all. Estimate magnitude + any date-window signature (we found a ~2025-pre-Nov M&S gap; is it broader / other suppliers?).
2. **Empty/summary lines:** lines with no itemisation. Split by the causes we identified — genuinely source-blank (account-total only), no_pdf (manual bookings / credit notes), multi-page/passthrough loss. How big is each, per business?
3. **Extraction quality:** invoices where the captured line detail doesn't reconcile to the header (over/under-extraction, the `over_extraction`/`total_mismatch` flags). How many, which suppliers?
4. **Multi-page / passthrough:** beyond Marini/Rima — how many multi-page invoices still likely lose later pages? (Cross-check the rebill/passthrough fix coverage.)
5. **Attribution correctness:** any invoices whose `business_id` looks wrong (note the rule: Fortnox attribution is authoritative — so this is "does ours match Fortnox", not re-derivation).
6. **Rank the gap classes by spend and by count** — so the eventual cleanup is prioritised by what's actually biggest, not by what we happened to notice first.

## Part 3 — What a BAS → operator-cost-structure mapping would take

Scope (don't build) the organisation layer:
1. **Propose the operator cost structure** — the buckets an owner reads (e.g. Food COGS / Beverage COGS / Alcohol / Labour / Rent / Utilities / Professional services / Marketing / Security / Bank & fees / Other). Ground it in the actual BAS accounts found in Part 1.2.
2. **The mapping:** how cleanly do the real BAS accounts map to those buckets? Mostly 1:1 (account → bucket, trivial), or are there multi-bucket invoices (e.g. the Carlsson & Åqvist rent invoice with rent + fastighetsskatt + serviceavgift + marknadsföring + el as sub-lines that belong in *different* buckets)? Size how often sub-line splitting is needed vs a clean account→bucket roll-up.
3. **The consumer question (important):** is there a surface today that consumes an operator cost structure (a P&L / cost-structure view), or would the mapping be built before its consumer exists? Check `tracker_line_items` and any P&L-side tables — is overhead/cost-structure reporting already partially built, already-in-Fortnox-just-read-it, or genuinely absent? This determines whether Job 2 is "build a mapping for an existing report" or "we'd be building a categoriser with nothing reading it yet."
4. **Inference vs read:** estimate how much of Job 2 is pure reading-and-grouping of clean BAS data (the hoped-for majority) vs genuine categorisation CC must add (e.g. multi-bucket sub-line splitting, or accounts too coarse for the operator view).

## Deliverable — the plan

`docs/investigation/invoice-organisation-plan.md`:
- **Part 1:** what Fortnox already categorises (BAS coverage %, the real chart of accounts by spend, supplier-provided sub-categorisation, underused Fortnox fields).
- **Part 2:** the data-integrity gap classes, each sized by count + spend, ranked — the prioritised cleanup backlog.
- **Part 3:** the proposed operator cost structure, how cleanly BAS maps to it, whether a consumer surface exists, and the read-vs-inference split.
- A **recommended sequence**: what to fix/build first (almost certainly data-integrity before organisation, since organisation reads off clean data), and what's "already done in Fortnox, just surface it" vs genuinely net-new.

Three-line chat summary: (1) how much of categorisation is already done by Fortnox's BAS coding we should just read (coverage %), vs genuinely needing CC inference; (2) the biggest data-integrity gap classes by spend/count — the real cleanup priorities; (3) does an operator-cost-structure consumer surface exist yet, or would mapping be built ahead of its consumer — i.e. is Job 2 next, or does Job 1 (cleanup) come first.
