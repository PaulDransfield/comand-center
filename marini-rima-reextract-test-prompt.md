# Claude Code — Re-Extract the 5 Marini/Rima Invoices: Test, Classify, Decide

## Purpose

The passthrough-scaling fix is live and **safe** (guards mean nothing bad persists), but we don't yet know if it **works** — i.e. whether Haiku reliably populates the new `passthrough_scaling` fields and produces a recovery that **reconciles**. Re-trigger extraction on the 5 known Marini/Rima passthrough invoices, classify each outcome, and decide per-invoice whether Step 3 proceeds or we escalate to Sonnet.

The acceptance bar is **reconciliation, not row count.** 45 rows that sum to the wrong total are worse than the current 1-line summary (the summary is honestly incomplete; 45 wrong-priced rows look complete and feed false costs into recipes and the Edit-Item modal). So: a recovery counts only if its scaled line totals sum to the invoice header within öresavrundning.

Safe to run freely — the over_extraction / total_mismatch / 5%-sanity guards block any bad persist. Feature branch / preview workflow as established; report before any state is treated as final.

## The 5 invoices

The confirmed Marini/Rima passthrough set (from the multipage investigation): the 2 Laweka (e.g. supplier inv 1385 = given 3174; 1422) + 3 Eventcenter. Use the actual given_numbers from `docs/investigation/multipage-extraction-loss.md`.

## Step 1 — Re-trigger extraction on the 5 (one at a time)

Re-run extraction for each via `/admin/v2/tools` (or the equivalent re-extract path). For each invoice, capture:
- Did the model populate `passthrough_scaling` (page1_header_total, page2_grand_total, column_used)?
- Did the server apply scaling (`proportional_scaling_applied`) or reject it (`passthrough_scaling_rejected`)?
- How many rows landed?
- **Do the scaled line totals sum to the invoice header within öresavrundning?** (the reconciliation check — the real bar)

## Step 2 — Classify each invoice into one of three outcomes

- **(GOOD) Reconciling recovery:** `proportional_scaling_applied`, items present (~45 for Laweka 3174), scaled totals sum to header within rounding. → eligible for Step 3.
- **(INERT) No fix:** stayed a 1-line summary; model didn't populate the fields or scaling didn't trigger. Safe but unfixed. → escalate to Sonnet (Step 3-alt).
- **(REJECTED) Caught lying:** `passthrough_scaling_rejected` — model's claimed page-2 total didn't match its own row sum. Safe but unfixed, and a sign Haiku can't read this shape consistently. → escalate to Sonnet.

Report the per-invoice classification table.

## Step 3 — Decide per invoice

- **GOOD invoices:** proceed to persist/accept the recovered lines (idempotent, via the existing pipeline), confirm they flow through the normal matcher/categorization path (they're real Laweka passthrough food — catalogue + cost seed). Confirm the per-invoice line sum still reconciles to the header post-persist.
- **INERT or REJECTED invoices → Step 3-alt (Sonnet force-cascade):** this is a **likely branch, not a remote one** — this Marini/Rima shape has now stressed Haiku twice (per-line ppu×qty misread, then the grand-total read). At ~$0.03/invoice for a passthrough food supplier feeding recipe costs, forcing the more capable model on this one shape is trivially worth it.
  - Add a targeted force-to-Sonnet for the Marini/Rima shape (scoped to this layout/supplier signature — don't change the cascade for normal invoices).
  - Re-run the INERT/REJECTED invoices through Sonnet, classify again against the **same reconciliation bar**.
  - If Sonnet reconciles → proceed as GOOD. If even Sonnet can't reconcile → leave as 1-line summary and flag the invoice as "needs manual entry / unreliable extraction" (honest-incomplete, not silently wrong).

## Hard rules

- **Reconciliation is the acceptance bar**, per invoice — row count alone never qualifies a recovery.
- Anything that doesn't reconcile stays as the 1-line summary and surfaces as honest-incomplete (so the Edit-Item modal flags those items "price may be unreliable" rather than showing a confident wrong cost).
- Sonnet force-cascade scoped to the Marini/Rima shape only — don't alter the cascade for normal invoices.
- Recovered lines persist idempotently via the existing pipeline; re-runs are no-ops.
- Guards stay in force; nothing persists that fails over_extraction / total_mismatch / the 5% sanity check.

## Deliverable

`docs/investigation/marini-rima-reextract-results.md` + chat summary, three lines:
1. Of the 5, how many are GOOD (Haiku scaling reconciled) vs INERT vs REJECTED;
2. For the non-GOOD ones, did the Sonnet force-cascade recover them to a reconciling state, or do any need manual entry;
3. Final tally — how many of the ~225 hidden line items are now recovered-and-reconciling (real catalogue/cost seed), and how many invoices remain honest-incomplete pending manual entry.
