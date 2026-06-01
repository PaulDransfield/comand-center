# Claude Code — Two Coverage Checks Before the Overhead Build (READ-ONLY)

## Purpose

The invoice-organisation plan is mostly great news (categorisation ~95% read-and-roll-up, `/overheads` consumer already exists). But two numbers in it carry assumptions worth confirming before we build on them — both cheap, both read-only:

- **Chicce's BAS coverage is 23.6%** (vs Vero's 83.9%). The plan calls Chicce's backlog "essentially empty," but 23.6% means most of Chicce's spend lacks a reliable BAS account. **Chicce is the recipe-cost foundation business** — the one we're about to author recipes against. So the question that matters: is the missing coverage concentrated in *overheads* (fine for recipes) or does it hit *food/inventory* lines (the data recipes cost from)?
- **The M&S no_pdf cluster is now 452 invoices** (was 59 when we last looked). The plan treats it as "one task, owner Fortnox-UI check." At 452 the stakes changed — if a non-trivial fraction are recoverable (PDF exists in Fortnox, we just didn't capture it), that's meaningful Vero detail uncaptured, not a 5-minute eyeball.

Answer both. **Read-only — no fix, no build, no writes.** Output a short findings block + three-line summary; this gates whether the overhead dictionary build proceeds on a trusted foundation and resizes the M&S task.

## HARD RULES
- READ-ONLY: `SELECT`, metadata, cheap decisive Fortnox GETs only. No writes/sync/re-extraction/migrations.
- Print every query/endpoint. Don't dump PDF content.
- Bound to answering the two questions — don't enumerate every record; sample and characterise.
- Deliverable: `docs/investigation/coverage-checks.md` + three-line chat summary.

## Check 1 — Where is Chicce's missing BAS coverage? (food vs overhead)

The recipe work assumes Chicce's *food/inventory* data is clean. Confirm or refute:
1. Of Chicce's `supplier_invoice_lines` lacking a reliable BAS account (the ~76% not covered), **split by line type** — how much is inventory/food (lines that match or would match to products / food BAS families like 40xx) vs overhead/non-inventory (rent, services, fees)?
2. Specifically: of the lines that are **currently matched to products** (the catalogue feeding recipes) or that *would* be food, what fraction carry a reliable cost + BAS? I.e. is the recipe-relevant slice of Chicce well-covered even though overall coverage is 23.6%?
3. Compare to Vero: is the difference a structural reason (e.g. Vero got the P2.0 voucher back-fill, Chicce didn't — so Chicce's gap is a *back-fill not yet run* rather than genuinely missing data)? If Chicce just hasn't had the equivalent voucher back-fill, that reframes 23.6% from "data missing" to "back-fill pending" — note that clearly.
4. **The verdict that matters:** is Chicce's food/recipe-relevant data clean enough to author recipes against now, or does the low coverage touch the lines recipes depend on? (This is the "is Chicce actually ready" question the recipe work rests on.)

## Check 2 — Size the 452-invoice M&S no_pdf cluster properly

At 452 invoices, sample real enough to estimate the recoverable rate (not a handful):
1. **Characterise the 452** — date distribution, balance/paid status, document types (how many are credit notes / manual bookings — legitimately no PDF), and how many lines / how much spend they represent.
2. **Pattern split:** do they cluster (a date-window / pre-back-fill signature → likely systematic, possibly recoverable) or spread evenly (more consistent with genuine manual-entry / no-PDF)?
3. **Sample for recoverability** — take a representative sample across the date range (e.g. 15-20, spanning old/new and any credit-note vs normal split) and, via Fortnox GET (or flag for owner UI check if creds blocked), determine for each: does Fortnox actually hold a PDF we failed to capture (= recoverable), or genuinely none (= leave as honest-incomplete)?
4. **Estimate the recoverable rate** across the 452 from the sample, and the magnitude (lines / spend) if recovered.
5. **Resize the task:** is this a "close it, genuinely no PDF" 5-minute confirmation, OR a real recovery task (sync/lookup fix recovering N invoices of detail)? State which, with the sample evidence.

## Deliverable

`docs/investigation/coverage-checks.md` + three-line chat summary:
1. **Chicce:** is the 23.6% gap concentrated in overheads (recipe data clean, proceed) or does it hit food/inventory lines — and is the gap "data missing" or "voucher back-fill not yet run" (i.e. the same fix Vero already got);
2. **M&S 452:** estimated recoverable rate from the sample — is it a close-it confirmation or a real recovery task, with magnitude;
3. **Net:** does the overhead-dictionary build proceed on a trusted foundation now, and what (if anything) — a Chicce voucher back-fill, the M&S recovery — should be sequenced first.

Every query/endpoint listed. No writes, no fix, no build.
