# Claude Code — M&S no_pdf 64-Cluster Verification (READ-ONLY)

## Purpose

The empty-line recovery investigation found that **64 of 110 Martin & Servera Vero invoices (58%) marked `no_pdf` have NO parent row in `fortnox_supplier_invoices`** (sample: given_numbers 8358 / 8274 / 8365). This is the one finding that could undermine Rule (b) — the persistent matcher rule now terminal-stating source-blank empties to `not_inventory`.

The crux: there are **two very different reasons** a line is `no_pdf`, and they look identical in our data:
- **(A) Truly no PDF** — Fortnox genuinely has no document for the invoice. Un-itemizable. Rule (b) correctly terminal-states it. No action.
- **(B) Supplier-sync gap** — the invoice (and its PDF) exist in Fortnox, but our sync never ingested the parent record, so the extractor never had a chance to find the PDF. The `no_pdf` flag is then an *artifact*, the data is **recoverable**, and Rule (b) is quietly burying invoices we should keep.

**Settle which one the 64-cluster is.** Rule (b) stays live regardless (it's correct for the genuine (A) majority) — this determines whether there's an upstream sync hole feeding it that needs fixing.

## HARD RULES

- **READ-ONLY.** Verification only — `SELECT`, Fortnox **GET** probes, metadata checks. No writes, no re-sync, no re-extraction, no migrations, no changes to Rule (b).
- Fortnox calls are **GET-only**, rate-limit-aware, off-peak (don't collide with the live sync). Use the existing Fortnox client/auth; reuse the fresh-token path from the scope-probe work if tokens have expired.
- Never print secrets. Print every query/endpoint.
- Scope: **Vero**, Martin & Servera supplier, the `no_pdf` + missing-parent cluster.
- Deliverable: `docs/investigation/ms-nopdf-cluster-verdict.md` + a three-line chat summary. **No fix** — verdict only; if it's (B) we scope the sync fix separately.

## Step 1 — Characterize the cluster precisely (READ-ONLY, DB)

1. Confirm the count: of M&S Vero invoices flagged `no_pdf`, how many have **no parent** in `fortnox_supplier_invoices`? How many lines do they represent, and how many are currently terminal-stated by Rule (b) vs still `needs_review`?
2. **Age/pattern:** are the missing-parent invoices systematically *older* than the successfully-synced ones (e.g. the reference invoice 9339 / 78592617 that extracted perfectly)? Plot given_number / date ranges — a clean cutoff date is the signature of a sync-window gap, not random PDF-absence.
3. Pull the Fortnox supplier-invoice identifiers (number/series/date) for **5–10 sample** missing-parent invoices to probe in Step 2.

## Step 2 — Probe Fortnox directly for the samples (READ-ONLY, GET)

For each of the 5–10 samples, hit Fortnox and answer:
1. **Does the invoice exist in Fortnox at all?** (`GET /supplierinvoices/{n}` or the list endpoint by number.) If it exists in Fortnox but not in our `fortnox_supplier_invoices` → **confirmed sync gap (B)** for that invoice.
2. **Does Fortnox hold a PDF / attached file for it?** (Check the invoice's file/attachment reference — the same mechanism the extractor uses to find PDFs.) If a PDF exists in Fortnox for an invoice our system marked `no_pdf` → the `no_pdf` flag is an artifact, the document is **recoverable**.
3. Tabulate the samples: exists-in-Fortnox? has-PDF-in-Fortnox? present-in-our-DB? → classify each as (A) truly-no-PDF or (B) sync-gap-recoverable.

## Step 3 — The verdict + extrapolation

- Classify the cluster: predominantly (A), predominantly (B), or mixed — with the sample evidence.
- If (B): estimate how many of the 64 (and any lines Rule (b) has already terminal-stated) are recoverable, and identify the likely **sync-window cause** (date cutoff? a sync that silently stopped paginating? supplier added after a certain date?). Scope — don't build — what the sync fix would entail.
- If (A): confirm Rule (b) is sound for this cluster and the `no_pdf` is honest; close the concern.
- Either way: state whether the manual pass should wait on a sync fix (if a meaningful chunk is recoverable, don't hand-key/accept-terminal-stating lines a sync fix would restore wholesale) or proceed (if the cluster is genuinely (A)).

## Deliverable

`docs/investigation/ms-nopdf-cluster-verdict.md` + chat summary, three lines:
1. Of the 5–10 M&S samples, how many exist in Fortnox with a PDF but are missing from our DB (= sync gap, recoverable) vs truly no PDF;
2. Is the missing-parent cluster a clean date-cutoff signature (→ sync-window gap) or random (→ genuine no-PDF);
3. Does this gate the manual pass (recoverable enough to fix sync first) or is Rule (b) sound as-is and the pass proceeds.

Every query/endpoint listed. No writes, no fix.
