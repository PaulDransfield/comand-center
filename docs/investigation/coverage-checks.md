# Coverage Checks — Two Pre-Build Confirmations (READ-ONLY)

Run: 2026-06-01
Read-only follow-up to `docs/investigation/invoice-organisation-plan.md`. No fixes; no writes; no Fortnox token spend.
Source: `scripts/diag-coverage-checks.mjs`.

## Three-line headline

1. **Chicce — GREEN.** The 23.6 % BAS coverage figure was misleading for the recipe question. **82 % of Chicce's lines without BAS are product-matched (7,034 of 8,531)** — they have cost data via product_alias_id, which is exactly what the recipe-cost engine reads. The 1,497 remaining unmatched no-BAS lines are 98.6 % `not_inventory`, only 20 in the review queue. **Recipe foundation is clean; recipe-cost work proceeds.**
2. **The "M&S no_pdf cluster" is mis-labelled — it's a MIXED 452-invoice no_pdf class across many suppliers** (top 10: IL Molino 49, Axfood Snabbgross 48, Martin & Servera 46, Robertssons 36, Spendrups 28, Snabbgross Örebro 28, Martin Servera 22, Svensk Cater 34, Carlsson & Åqvist 11). 80 % are 2025-dated (likely pre-back-fill window), 100 % have `total_header=0` (we never extracted a header). 97.6 % have null error_message (Fortnox API said no PDF), 11 have http_4xx auth failures (token-expired during sync, possibly recoverable now).
3. **Recovery rate is UNKNOWN from local data** — Fortnox is the only authority for whether a PDF actually exists for each. Surfacing a 20-invoice sample (food + beverage + services + rent suppliers, May 2025 → Feb 2026) for owner Fortnox-UI spot-check. **The task resize depends on the spot-check**: if PDFs exist in Fortnox for ≥50 % of the sample, this is a real recovery worth automating (>200 invoices of detail); if mostly genuine-no-PDF, it's the close-it confirmation the original plan assumed.

---

## CHECK 1 — Where IS Chicce's missing BAS coverage?

### 1.1 The headline numbers

Chicce supplier_invoice_lines total: **9,429**

| Bucket | Lines | Spend (SEK) | What it means |
|---|---:|---:|---|
| **With BAS account** | 898 | 2,010,222 | Backfilled from voucher rows + a few native-Fortnox lines |
| **No BAS, product-matched** | 7,034 | 3,144,984 | **Recipe-relevant. Cost flows via product_alias_id, not BAS.** |
| **No BAS, `not_inventory`** | 1,477 | (mixed signs) | Already classified by description rules — correctly excluded |
| **No BAS, `needs_review`** | 20 | (small) | Genuine review queue — tiny |

The 23.6 %-by-spend BAS coverage number conceals the structural reality:
- **82 % of the no-BAS lines (7,034) are product-matched** → cost flows through `product_alias_id` to recipes. Recipe cost reads from `supplier_invoice_lines.total_excl_vat / quantity` for matched aliases — **BAS is irrelevant for recipe cost calculation**.
- The remaining 18 % are 1,497 unmatched lines, of which 98.6 % (1,477) are correctly flagged `not_inventory` by the matcher and 1.4 % (20) are in the owner review queue.

### 1.2 Of the 898 lines WITH BAS, where do they land?

| BAS range | Lines | Spend (SEK) | Bucket |
|---|---:|---:|---|
| 40xx food/COGS | 660 | 1,697,899 | Food — recipe-relevant if matched |
| 50xx premises/utilities | 177 | 131,818 | Overhead |
| 60xx admin/services | 61 | 180,498 | Overhead |

**73 % of the BAS-tagged lines are food** (40xx). So even the WITH-BAS slice skews to recipe-relevant — there's no hidden overhead concentration.

### 1.3 Chicce vs Vero — is this a back-fill not yet run?

| Business | source distribution | account_source distribution |
|---|---|---|
| Chicce | pdf_extraction 9,193 · fortnox_row 236 | fortnox_row 8,531 · voucher_backfill 898 |
| Vero | pdf_extraction 6,671 · fortnox_row 1,550 | fortnox_row 1,321 · voucher_backfill 6,900 |

The asymmetry is **structural, not a back-fill gap**:
- **Chicce's lines are 97.5 % PDF-extracted.** When a PDF extracts a line, no BAS account is captured — only the description + qty + price. BAS comes later from the voucher cache via the P2.0 back-fill.
- **The P2.0 back-fill DID run for Chicce** — 898 lines got `account_source='voucher_backfill'`. That's exactly the slice where Chicce's invoice→voucher join had a clean voucher account to copy. The remaining 7,633 PDF-extracted lines don't have a clean voucher account — Fortnox often booked the parent invoice to ONE account on the voucher, not per-line.
- **Vero is structurally different.** 1,550 of its lines come straight from the Fortnox supplier-invoice API rows (the "amounts-per-account with no item text" pattern per `project_vero_invoices_no_line_text` memory). Those rows DO carry an account at source — that's why Vero's BAS coverage is 83.9 %.

**Verdict for Check 1**: The 23.6 % figure is real but it's measuring the wrong thing for the recipe question. **Chicce's recipe-relevant data is clean** — 7,694 of 9,429 lines (82 %) are either product-matched or food-BAS-tagged. The recipe-cost engine doesn't need BAS; it needs product_alias_id + total_excl_vat + quantity, which is what those 7,694 lines have. Recipe-cost work is on solid ground.

What 23.6 % BAS coverage DOES matter for: the future overhead-bucket roll-up at Chicce. Phase B of the organisation plan (the BAS→operator dictionary) will only roll up the 898 Chicce lines that carry an account. The other ~5,000 overhead-relevant lines (the 1,477 not_inventory + the 660 40xx-tagged ones) would need either a separate Chicce-specific back-fill or PDF-side BAS inference. **Not blocking for the recipe foundation; relevant for when we ship Phase B.**

---

## CHECK 2 — Size the 452-invoice "M&S no_pdf" properly

### 2.1 It's not actually all M&S

Top 10 suppliers in the 452:

| Lines | Supplier |
|---:|---|
| 49 | IL Molino AB |
| 48 | Axfood Snabbgross |
| 46 | Martin & Servera |
| 36 | Robertssons Charkuteri |
| 28 | Spendrups |
| 28 | Snabbgross Örebro |
| 22 | Martin Servera Restauranghandel AB |
| 19 | SVENSK CATER AB |
| 15 | Svensk Cater |
| 11 | Carlsson & Åqvist |

Adding the Martin Servera + Svensk Cater variants: ~106 invoices (23 %). So the "M&S cluster" was a misnomer in the prior plan — the actual class spans every major supplier. **Net: ~452 invoices, supplier-diverse, food-dominated with some services (Carlsson & Åqvist rent, Telia phone, Apcoa parking, Hostek IT) sprinkled in.**

### 2.2 Date distribution

- **2025: 360 invoices (80 %)**
- **2026: 92 invoices (20 %)**

Skews to 2025 — consistent with a "pre-back-fill window" pattern, but also could just be that we have more invoice history captured in 2025 overall.

### 2.3 Header total + error signature

- **All 452 have `total_header=0`** — we never extracted a header because the PDF never ran. This means **we have zero spend visibility from our own data** for any of these; the actual amounts live entirely in Fortnox.
- **441 (97.6 %) have null `error_message`** — Fortnox supplier-invoice API returned no `pdf_file_id`. We legitimately couldn't find a PDF to fetch.
- **7 have `pdf_lookup_failed: http_429`** — rate-limit failure. Possibly recoverable on retry.
- **4 have `pdf_lookup_failed: http_401`** — token-expired. Possibly recoverable now that integration is reconnected.

The 11 with http_4xx errors are the smallest subset and most clearly recoverable — they should auto-retry on next supplier-sync cron tick now that the Vero Fortnox integration is back to status=connected (from earlier today's cleanup).

The 441 with null error_message are the real question — **does Fortnox actually hold a PDF we missed, or were these genuinely PDF-less postings (manual journals, credit notes, system-generated)?**

### 2.4 Owner spot-check sample (20 invoices spanning the date range)

Surfacing for owner Fortnox-UI verification — we can't pull this from our DB. For each, owner opens in Fortnox UI and notes whether an attached PDF exists.

| Invoice | Date | Supplier | attempts |
|---:|---|---|---:|
| 8362 | 2025-05-01 | IL Molino AB | 1 |
| 8386 | 2025-05-01 | Carlsson & Åqvist | 1 |
| 8311 | 2025-05-13 | Axfood Snabbgross | 1 |
| 8340 | 2025-05-26 | Apcoa Parking | 1 |
| 8372 | 2025-06-07 | Axfood Snabbgross | 1 |
| 8392 | 2025-06-19 | Telia | 1 |
| 8426 | 2025-07-03 | Spendrups | 1 |
| 8464 | 2025-07-18 | SVENSK CATER AB | 1 |
| 8455 | 2025-07-31 | SVENSK CATER AB | 1 |
| 8527 | 2025-08-09 | Snabbgross Örebro | 1 |
| 8563 | 2025-08-25 | Snabbgross Örebro | 1 |
| 8633 | 2025-09-25 | IL Molino AB | 1 |
| 8729 | 2025-10-16 | Agera & partners AB | 1 |
| 8797 | 2025-11-14 | Robertssons Charkuteri | 1 |
| 9006 | 2025-12-01 | Hostek | 1 |
| 8987 | 2025-12-10 | Martin & Servera | 1 |
| 8983 | 2025-12-29 | Robertssons Charkuteri | 1 |
| 9107 | 2026-01-19 | Martin Servera Restauranghandel AB | 1 |
| 9230 | 2026-02-04 | Martin Servera Restauranghandel AB | 1 |
| 9209 | 2026-02-19 | IL Molino AB | 1 |

**What to look for in Fortnox UI per invoice**:
1. Does the invoice exist? (yes for all 20 — Fortnox is where we got the metadata)
2. Is there an attached PDF file? (the load-bearing question — `Bilagor` or `Filer` section)
3. If yes: how was it added (uploaded vs scanner vs OCR)?
4. If no: is this a manual entry, credit note, or system journal?

### 2.5 Estimated recoverable rate

**Unknown without the spot-check.** The local data tells us *we couldn't fetch a PDF*; only Fortnox knows whether one *exists*. Two plausible distributions:

- **Optimistic case** (≥50 % recoverable): 220+ invoices with detail to re-extract. That's a real recovery task — adapt the `/api/admin/reextract-invoice` pattern from today's Marini/Rima work + retry the original PDF fetch via the supplier-sync cron. Would meaningfully improve Vero's catalogue + cost coverage.
- **Pessimistic case** (<10 % recoverable): mostly manual journals / credit notes that legitimately have no PDF. Close as honest-incomplete, set a flag to suppress them from cost-completeness reporting.

Sample is across the full date range + every major supplier class — owner can verify 5 of the 20 in ~10 minutes to triangulate.

---

## Recommended sequence change

The original plan called Phase A "close the M&S no_pdf cluster, owner-hands check." That framing under-sized the task. New framing:

### A1 — Owner spot-check (~10 min, owner)
Open 5 of the 20 sample invoices in Fortnox UI, note PDF-present-yes/no. **Decision gate**: ≥3 of 5 with PDFs = real recovery task; ≤1 with PDFs = close-as-honest-incomplete.

### A2-a — IF recoverable (real recovery task)
Build a one-off sync trigger that retries the PDF fetch + extraction for the 452 invoices. Reuses today's `/api/admin/reextract-invoice` infrastructure. Estimated half-day if PDF fetch path is clean; longer if Fortnox's PDF API has the "files exist but not via supplier-invoice endpoint" structural quirk (would need Fortnox `Files/Inbox/Archive` API exploration, the 3-scope expansion noted in `reference_fortnox_scopes` memory).

### A2-b — IF mostly genuine no-PDF (close-it)
Update the documentation + add a `no_pdf_acknowledged` flag on `invoice_pdf_extractions` so these stop polluting completeness counts. ~30 minutes.

### B — BAS → operator-bucket dictionary (unchanged from original plan)
Half-day. Proceeds on a trusted foundation now that Check 1 has verified Chicce's recipe data integrity.

**Net for the central question** (does the overhead-dictionary build proceed on a trusted foundation?): **YES for Chicce's recipe layer. PENDING owner spot-check for the no_pdf class — but the no_pdf 452 doesn't block Phase B; they only affect the completeness side of /overheads at Vero. Phase B can ship in parallel with the no_pdf triage.**

## What was NOT done

- No writes, no migrations, no Fortnox API calls beyond the cached metadata in our DB.
- Did not sample sub-line bucket-splits — outside scope of these two checks.
- Did not characterise the pre-2025-Nov M&S sync gap separately — would need a different query against Fortnox's supplier-invoice listing API.
- Did not propose the actual BAS-bucket dictionary content — that's Phase B work.

## Queries / files referenced

- `scripts/diag-coverage-checks.mjs` — the full read-only pull this is built on.
- `docs/investigation/invoice-organisation-plan.md` — the parent plan this checks against.
- `docs/investigation/ms-nopdf-cluster-verdict.md` + `ms-59-nopdf-verdict.md` — prior investigations of this class.
- `project_vero_invoices_no_line_text` memory — explains the Chicce/Vero structural asymmetry.
- `reference_fortnox_scopes` memory — the PDF-trio scope expansion that may be needed for the A2-a recovery path.
