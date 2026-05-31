# Vero Empty-Description Lines — Characterise (READ-ONLY)

Run: 2026-05-31
Read-only. No remediation.

## Three-line headline

1. **Of Vero's 1,550 empty-description lines, ALL 1,550 are `source='fortnox_row'` — genuinely blank at the Fortnox API source.** Zero are PDF extraction failures. There's nothing to retry; this is the structural shape of Vero's Fortnox setup (the API returns account-level row totals with no per-line product text).
2. **656 of the 1,550 sit in `needs_review` — 29.9% of Vero's 2,197-line needs_review queue is empty-description lines.** Net them out of the Phase D queue-drain signal: they're structural and won't drain via fuzzy matching.
3. **612 of the 656 (93%) are still classifiable via account_number + amount.** True ghosts (no account, no amount): zero. Real food/drink wholesaler invoices (Robertssons Charkuteri, Snabbgross, IL Molino, Martin Servera, Spendrups, Svensk Cater) booked at account-level totalling 3.8M SEK — material amounts that need owner action via either per-supplier override or per-invoice approval, not extraction retry.

## Detailed findings

### 1. Volume + current state

- **Total Vero `supplier_invoice_lines`:** 8,192
- **Empty/whitespace `raw_description`:** 1,550 (18.9%)
- **By `match_status`:**
  - `not_inventory`: 894 (already terminal)
  - `needs_review`: 656 (inflates Phase D queue)
  - `matched`: 0 (matcher correctly doesn't auto-match empty descriptions)
- **By `source` (M078 column):**
  - `fortnox_row`: **1,550 (100%)**
  - `pdf_extraction`: 0
  - `owner_correction`: 0
- **By `account_source`:**
  - `voucher_backfill`: 792 (back-filled from voucher cache during P2.0)
  - `fortnox_row`: 758 (Fortnox API posted account at receipt time)

### 2. Headline split

**All Vero empties come from `source='fortnox_row'`.** This is a categorical answer: there are NO extraction failures hiding in the queue. Every empty line is the result of Fortnox's `/supplierinvoices/{n}` endpoint returning a row with `Description=''`. This happens when the supplier invoice is booked as a header-only total against an account, with no per-line item text on the API row. Note that the PDF attachment may carry richer detail — but for Vero, no PDF-extraction job has ever been run for these invoices (the PDF extraction pipeline at `lib/inventory/pdf-extractor.ts` exists but hasn't been invoked on Vero's empty-row invoices yet).

For Phase D: the queue-drain signal cannot expect these to clear via owner one-tap confirmation since there's no descriptor to match against. They need either:
- a per-supplier `supplier_classifications` rule ("all invoices from Robertssons Charkuteri at Vero = food"), or
- per-invoice owner-side mapping ("this invoice maps to product X"), which is more effort, or
- PDF extraction kicked on the parent invoices (if the PDFs carry line detail — possible follow-up after Phase D)

### 3. Classifiability of `needs_review` empties

Of the 656 empties in needs_review:

| Class | Count | % |
|---|---:|---:|
| HAVE account_number + non-zero amount (classifiable by account+amount) | 612 | 93.3% |
| HAVE one signal only (account OR amount, not both) | 44 | 6.7% |
| NEITHER account_number NOR non-zero amount (true ghosts) | **0** | 0% |

Zero true ghosts — every empty has at least account or amount. This is good: the lines are real and traceable; they just lack a descriptor. The 612 with both signals are immediately classifiable if owner sets per-supplier category rules; the 44 with one signal need slightly more context.

### 4. Supplier clustering

| Lines | SEK | Supplier |
|---:|---:|---|
| 108 | 352,006 | Robertssons Charkuteri |
| 87 | 368,789 | Snabbgross Örebro |
| 84 | 968,070 | IL Molino AB |
| 82 | 331,696 | Martin Servera Restauranghandel AB |
| 61 | 797,382 | Spendrups |
| 60 | 172,168 | SVENSK CATER AB |
| 27 | 110,236 | Martin & Servera |
| 15 | 35,178 | Dala Washtek AB |
| ... | ... | ... (34 distinct suppliers total) |

The top 7 suppliers account for ~78% of the empty lines and they're ALL food/drink wholesalers. This concentration is what suggests the per-supplier `supplier_classifications` override is the high-leverage remediation: 7 owner actions ("all invoices from these suppliers = food") would terminal-state ~516 of the 656 lines.

### 5. Value distribution

- **Total SEK across the 656 empties:** 3,821,225 (material — not rounding noise)
- **Median amount:** 2,849.60 SEK
- **90th percentile:** 16,409 SEK
- **Maximum:** 76,767 SEK
- **Lines >= 1,000 SEK:** 461 (70% of empties)
- **Zero-amount lines:** 2
- **< 10 SEK lines:** 3

These are real, sizeable invoices. Not micro-line rounding artifacts.

### 6. Phase D queue context

| Metric | Value |
|---|---:|
| Vero `needs_review` total (post-Fix-2) | 2,197 |
| Vero `needs_review` empty-description lines | 656 |
| **% of queue that is structural empties** | **29.9%** |

**Implication for the 2026-06-07 read:** when interpreting Vero's queue-drain trend over the 7-day watch, subtract the empties from the denominator. The "drainable via owner confirmation" portion is closer to **~1,541 lines** (2,197 − 656 empties), not 2,197. If the queue drops by 200 over the week, that's 13% drainage on the realistic denominator (1,541), not 9% on the gross.

### 7. Chicce comparison (light touch)

- Total Chicce `supplier_invoice_lines`: 9,288
- Chicce empties: 239 (2.6%)
- Chicce empties in needs_review: 200
- All `source='fortnox_row'` (same pattern as Vero)

Same shape, dramatically smaller scale. Chicce's Fortnox setup posts more per-line detail at receipt time. This explains why Vero has 30% of queue as empties but Chicce barely has any — it's a per-customer accounting-setup characteristic, not a system bug.

---

## Bonus: EAN availability check (Phase 3 open question 2)

`supplier_invoice_lines.article_number` was scanned for EAN-pattern numeric strings (8/12/13/14-digit) at both businesses. This determines how much of the assortment Open Food Facts could enrich by barcode lookup.

| Business | Total lines | With non-empty article_number | EAN-pattern article_number | % of lines | % of SEK spend |
|---|---:|---:|---:|---:|---:|
| Chicce | 9,288 | 8,510 (91.6%) | **500** | **5.4%** | **0.9%** |
| Vero | 8,192 | 3,517 (42.9%) | **387** | **4.7%** | **0.4%** |

**Top EAN-bearing suppliers** are concentrated (Trädgårdshallen for Chicce, SVENSK CATER for Vero) — likely supplier-internal numeric codes that happen to have 8 digits, not true GS1-issued EAN-13. Sample EANs include `60000002`, `60000018`, `13140217`, `87000313` — many don't match real EAN-13 country-prefix patterns (Sweden = 73, Netherlands = 87).

**Phase 3 implication:** Open Food Facts enrichment via EAN would cover **at most ~5% of lines and <1% of spend** — the slice is even smaller than the pattern-match suggests because many of those numeric codes are likely supplier-internal, not real GS1-registered EANs. This strengthens the Phase 3 sourcing recommendation toward:
- **Option 4 (self-built alias network)** as the moat — bigger relative weight
- **Option 3 (GS1/Validoo)** as the authoritative source — worth the inquiry call (it has foodservice coverage OFF lacks AND knows which codes are real GS1)
- **Option 2 (OFF)** drops to "minor enrichment for branded retail SKUs only" — still free, still worth wiring, but ~1% of spend, not the headline source

The data here doesn't decide Phase 3; it makes the sequencing argument in the analysis document stronger.

## Queries run

All `SELECT`-only:
1. `supplier_invoice_lines` full pull per business (id, supplier_fortnox_number, supplier_name_snapshot, fortnox_invoice_number, raw_description, article_number, quantity, total_excl_vat, account_number, account_source, match_status, source, created_at)
2. In-script aggregation for empty/match_status/source/account_source breakdown, supplier clustering, value distribution
3. EAN pattern match via JS regex `^\d{8}$|^\d{12,14}$` on `article_number`

Script: `scripts/diag-vero-empties-and-ean.mjs`. No writes anywhere.

## Recommendation (not executed)

The next move depends on owner judgement and Phase D outcome, but the data narrows it:

1. **Don't retry PDF extraction** for the 656 empties. They're not extraction failures — they're genuinely blank at the API source. PDF extraction on Vero would be a separate Phase 3-adjacent project (does the PDF carry per-line detail when the API doesn't? unknown; needs a probe on a few sample invoices) and not the right response to this specific queue depth.
2. **Most leveraged path: per-supplier `supplier_classifications` rules for the top 7 wholesalers.** Owner spends ~7 minutes setting "all invoices from Robertssons Charkuteri at Vero = food" et al., and ~516 lines terminal-state to not_inventory or matched-via-supplier-classifier. Massively shrinks the queue. (Caveat: these are real food invoices; "skip all" via per-business override would be wrong unless the owner accepts they're tracking at account-level not product-level for these suppliers.)
3. **Net the 656 out of Phase D queue-drain reading.** The realistic drainable denominator is ~1,541, not 2,197.
4. **Don't bias Phase 3 toward Option 2 (OFF)** on the strength of the catalogue-sourcing analysis alone. The EAN data here says OFF would cover <5% of lines. Option 4 (self-built alias network) is the relatively bigger moat than the prior analysis credited.
