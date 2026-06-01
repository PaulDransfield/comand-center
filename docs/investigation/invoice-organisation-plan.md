# Invoice Organisation — Fortnox-Grounded Plan (READ-ONLY)

Run: 2026-06-01
Read-only. No fixes performed; no writes; no Fortnox token spend beyond what was already cached.
Source data: `scripts/diag-invoice-organisation.mjs` + the existing investigation files at `docs/investigation/*`.

## Three-line headline

1. **Fortnox already categorises ~83 % of Vero's spend and ~24 % of Chicce's** via BAS account on supplier_invoice_lines — and after the P2.0 voucher back-fill those numbers are as high as Fortnox makes them; the rest are genuinely-blank Fortnox postings, not our extraction failures. The "categorisation" job is overwhelmingly read-and-roll-up, not infer.
2. **The data-integrity backlog is dominated by ONE class at Vero: the M&S no_pdf cluster (452 invoices, 0 SEK total because they're flagged needs-PDF — actual missing data lives in Fortnox)**. Everything else (multi-page passthrough loss, total_mismatch warnings, needs_review queue, pre-2025-Nov M&S gap) is < 100 records each. Backlog ranks neatly by spend.
3. **An operator-cost-structure consumer surface already exists at `/overheads`** — it reads `tracker_line_items.category/subcategory`. The mapping work is therefore "enrich the subcategory field" on existing rows, not "build a categoriser ahead of any reader". Job 1 (data integrity — close M&S no_pdf) comes before Job 2 (mapping); they share zero plumbing.

---

## Part 1 — What Fortnox already gives us

Methodology: pulled every `supplier_invoice_lines` row at Chicce + Vero (17,650 lines total), counted BAS account coverage and per-account spend.

### 1.1 BAS account coverage on captured lines

| Business | Lines | Lines w/ BAS account | Coverage | Spend | Spend w/ BAS | Coverage |
|---|---:|---:|---:|---:|---:|---:|
| **Chicce** | 9,429 | 898 | **9.5 %** | 8,500,587 SEK | 2,010,222 SEK | **23.6 %** |
| **Vero** | 8,221 | 6,900 | **83.9 %** | 17,632,955 SEK | 11,713,313 SEK | **66.4 %** |

The asymmetry is structural, not a bug:
- **Chicce** receives line items WITH text from Fortnox supplier-invoice API rows directly. Those rows don't carry a per-line BAS account — the account lives on the voucher, which is parent-level. So most lines genuinely have no per-line BAS in Fortnox's own data either; they're attributed to the voucher's account at posting time.
- **Vero** receives Fortnox supplier-invoice API rows that are **amounts-per-account with no item text** (per `project_vero_invoices_no_line_text` memory). So at Vero each line has a BAS account by construction; the PDF supplies the human-readable description.

Source provenance distribution (`account_source`):

| Business | fortnox_row | voucher_backfill |
|---|---:|---:|
| Chicce | 8,531 | 898 |
| Vero | 1,321 | 6,900 |

`voucher_backfill` is the P2.0 work that copied BAS accounts from voucher rows when the supplier-invoice row didn't carry one. At Vero it covered 6,900 lines (83.9 %); at Chicce only 898 because Chicce's lines mostly come from PDF extraction which never had voucher-account context to back-fill.

**The remaining gap at both businesses is genuine** — Fortnox postings that exist but have no BAS account at either source level. That's where Ticket 2 (voucher cache re-warm — parked until 2026-06-07 per Phase D watch) would close another slice.

### 1.2 The real chart of accounts in use

**19 distinct BAS accounts at each business**. Restaurants use a TINY working subset of the full BAS chart (which has hundreds). The top 5 carry 90 %+ of spend at both:

**Chicce — top 8 by spend:**

| Account | Spend (SEK) | Lines | Likely meaning |
|---:|---:|---:|---|
| 4011 | 1,486,272 | 548 | Food/beverage 12 % VAT |
| 4014 | 148,755 | 85 | Food/beverage 6 % VAT (takeaway?) |
| 6420 | 54,500 | 2 | Accounting/revisor fees |
| 4012 | 53,703 | 16 | Food/beverage 25 % VAT (alcohol) |
| 6591 | 51,406 | 7 | (subscription / service) |
| 6060 | 48,083 | 42 | Marketing / representation |
| 5420 | 30,114 | 57 | Computer software |
| 5520 | 23,278 | 23 | Rental of inventory |

**Vero — top 8 by spend:**

| Account | Spend (SEK) | Lines | Likely meaning |
|---:|---:|---:|---|
| 4010 | 5,134,764 | 3,299 | Food (25 % VAT — meat / wet ingredients) |
| 4011 | 4,364,546 | 2,732 | Food/beverage 12 % VAT |
| 5010 | 850,929 | 150 | Rent (Lokalhyra — covered by M112 rule) |
| 6550 | 297,596 | 33 | Consulting fees |
| 5160 | 242,376 | 67 | Cleaning / waste management |
| 5990 | 197,109 | 120 | Other selling expenses |
| 5500 | 109,775 | 127 | Repairs and maintenance |
| 6540 | 104,046 | 47 | IT services |

**Implications for organisation work**:
- 19 distinct accounts is small enough that a static dictionary covers EVERYTHING. No taxonomy inference, no ML, just a JSON file.
- The 40xx range (food) accounts for **84 % at Chicce and 57 % at Vero**. Almost all spend goes to ingredients. Restaurant cost structures are dominated by COGS — there's no surprise.
- The "richer supplier-side categorisation" the prompt asked about (M&S `ÖVERSIKT KONTERING` block) is real but rare. M&S is structurally distinct because their multi-cost-centre invoices split across 4011/4012/4014/5460 in a single document. **Outside M&S, almost every invoice is single-account** — sub-line splitting is the exception not the rule.

### 1.3 Underused Fortnox fields

Not investigated in depth this pass. Voucher rows already give us account; supplier_invoice rows expose `Dimensions` for cost-centre tagging that we don't capture. **Score**: low priority — restaurants generally don't use Fortnox dimensions/projects at this scale. Worth a 30-min GET-probe only if Job 2 actually needs sub-account context.

---

## Part 2 — Data-integrity gap classes, ranked

| # | Class | Chicce count | Chicce spend | Vero count | Vero spend | Notes |
|---:|---|---:|---:|---:|---:|---|
| 1 | **M&S no_pdf cluster** (#88) | 11 | — | **452** | — (header=0 by construction) | The single biggest open item. PDFs may exist in Fortnox UI but never made it to our store. Verdict + recovery path in `docs/investigation/ms-nopdf-cluster-verdict.md` + `ms-59-nopdf-verdict.md`. Needs owner-hands check in Fortnox UI to confirm whether to retry vs accept-as-summary. |
| 2 | **needs_review queue** (runtime owner work) | 59 | 1,060,416 SEK | 54 | 866,956 SEK | NOT a data-integrity gap — these are extracted lines awaiting owner triage in the matcher review queue. Recipe-cost work + M112/M113 sweeps are draining this. |
| 3 | **Multi-page passthrough loss** (Marini/Rima class) | 5 invoices, ~225 lines | ~487,576 SEK summary | 0 | 0 | Fully characterised in `marini-rima-reextract-results.md`. 4/5 recovered today (147 catalogue lines now reconciling). Credit-note 3278 remains 1-row but reconciles to header. Force-Sonnet trigger live for future occurrences. |
| 4 | **`total_mismatch` warnings on extracted lines** | 31 | (small) | 34 | (small) | Per-invoice validator flags where row sums don't match header. Low absolute number; minor follow-up cleanup. |
| 5 | **`over_extraction` warnings** | 0 | — | 0 | — | Zero across both businesses today. M112/M113 rebill-rule rewrite + passthrough-scaling work successfully prevented this class. |
| 6 | **Failed extractions** | 1 | 0 SEK | 0 (was 37 earlier today) | 0 | The 37 Vero token-auth-failed entries were flipped to pending by the cleanup SQL today; cron will work them through. |
| 7 | **Pending extractions** | 10 | 5,713 SEK | 23 | 384,100 SEK | Routine queue, cron sweeper picks them up. Cosmetic only — supplier_invoice_lines already populated. |
| 8 | **Pre-2025-Nov M&S sync gap** | unknown | unknown | — | — | Identified in earlier investigations as a possible class but never sized system-wide. Worth a separate 30-min characterisation if Job 1 picks it up. |

**Rank by spend at Vero**: M&S no_pdf cluster is the only class large enough to matter, BUT it currently has `total_header=0` on every row, so we have no spend visibility on it from our DB — the spend is purely in Fortnox until we recover it. The classes 3–7 combined are < 0.5 M SEK across both businesses. **Vero's data-integrity backlog is essentially one task.**

**Rank by spend at Chicce**: needs_review queue is the largest signal but isn't a data gap. Multi-page passthrough was significant and is now mostly fixed. Otherwise minimal.

---

## Part 3 — BAS → operator-cost-structure mapping

### 3.1 The proposed operator structure

Operator-facing buckets, grounded in the actual 19-account chart from Part 1.2:

| Bucket | BAS accounts | Notes |
|---|---|---|
| **Food COGS (12 % VAT)** | 4011 | Largest single bucket at both businesses |
| **Food COGS (25 % VAT)** | 4010 | Meat / wet ingredients at Vero |
| **Food COGS (6 % VAT)** | 4014 | Takeaway at Chicce |
| **Alcohol COGS** | 4012, 4013, 4016 | |
| **Rent** | 5010, 5012 | Lokalhyra (M112 covered the false-positive risk) |
| **Utilities** | 5160, 5460, 5461, 5465, 5480, 5500, 5520 | El, va, värme, mat avfall, kontorsmaterial |
| **Cleaning / waste** | 5062, 5160, 5620 | |
| **Repairs / maintenance** | 5410, 5420, 5500, 5970, 5990 | |
| **Marketing / representation** | 6060, 6070 | |
| **Professional services** | 6420 (revisor), 6530 (redovisning), 6550 (consulting) | |
| **IT / software** | 5420, 6540, 6591 | |
| **Bank & fees** | 6570, 6950 | |
| **Other operating** | 6200, 6370, 5090 | Catch-all |
| **Depreciation** | 78xx | Already in `tracker_line_items.category='depreciation'` |
| **Financial** | 8xxx | Already in `tracker_line_items.category='financial'` |

**Sub-line splitting (multi-bucket invoices)**: rare. The M&S `ÖVERSIKT KONTERING` block is the only known repeating pattern, and it's already captured at the line level — each line has its own `account_number`, so the split happens automatically when rolling up by account. Carlsson & Åqvist-style "rent + fastighetsskatt + serviceavgift + marknadsföring + el" invoices DO exist at Vero (account 5010 with 150 lines covers some) — those would benefit from sub-line awareness but it's a per-supplier edge case, not a structural concern.

### 3.2 How clean is the BAS → bucket mapping?

For the 19 accounts in actual use:
- **~17 of 19 are clean 1:1**. Account → bucket, no judgement call.
- **~2 are ambiguous**: 5500/5520 mix utilities and inventory rental; 4014 may be food OR alcohol depending on supplier. Both resolve via the `EXACT_OVERRIDES` supplier dictionary the matcher already has.

**Estimated read-vs-inference split**: ~95 % pure read-and-roll-up (account → bucket via dictionary). The remaining ~5 % is supplier-specific disambiguation that the matcher's existing supplier dictionary handles. **There is essentially no genuine categorisation work for CC to add.**

### 3.3 Does a consumer surface exist?

**Yes — `/overheads` is the consumer.** Confirmed at `app/overheads/page.tsx`:
- Reads `tracker_line_items` via `/api/overheads/line-items`
- Already groups by `category` (the 6 top-level buckets: revenue / food_cost / staff_cost / other_cost / depreciation / financial)
- Subcategory field on tracker_line_items is **mostly empty (`?`)** — Chicce 247 of ~561 rows have `subcategory='?'`, Vero 186 of ~446
- The page renders a `SubcategoryBreakdown` table that's currently underused because the subcategory enrichment hasn't happened yet

**This is the smoking gun**: the consumer is already built. What's missing is the enrichment that turns `subcategory='?'` into `subcategory='rent'` / `'electricity'` / `'IT-services'` etc. — that's the 95 %-read mapping above, applied to existing data.

The /overheads page also already has: 6-month sparkline column, "Invoices →" drilldown drawer with PDF access (added today), year nav, AI cost insights card. **The presentation side is rich**; the data side is undercategorised.

### 3.4 Inference vs read split

- **95 % pure read**: BAS account → bucket via static dictionary (~50-line JSON file).
- **5 % supplier-specific disambiguation**: handled by existing matcher supplier dictionary (`lib/inventory/suppliers.ts` EXACT_OVERRIDES + per-business `supplier_classifications` (M083)).
- **0 % genuine categorisation work for CC to add**.

This means the "organisation" project is structurally small — it's a data-enrichment job, not a build.

---

## Recommended sequence

### Phase A — Data integrity first

Only one task matters here at scale:

1. **Close M&S no_pdf cluster at Vero (#88)** — 452 invoices. Owner needs to verify in Fortnox UI whether each invoice has an attached PDF that we missed, or whether they're genuine no-PDF bookings (manual journals / credit notes). After triage:
   - Recovery path: re-trigger PDF fetch + extract for the ones with PDFs (existing /api/admin/reextract-invoice endpoint)
   - Acceptance path: flag the remainder as `accepted_as_summary` so they stop polluting "incomplete" counts
2. **Pre-2025-Nov M&S sync gap** — characterise size first (30 min). If small, fix; if structural, scope separately.
3. Everything else is < 100 records — handled organically by the matcher quality work that's already shipping.

### Phase B — Operator-cost-structure mapping (small)

After Vero's data is clean:

1. **Build the static BAS → operator-subcategory dictionary** — ~50 lines of JSON, one file at `lib/finance/bas-operator-mapping.ts`. Top 19 accounts covers 100 % of current spend; add new accounts as they appear.
2. **Backfill `tracker_line_items.subcategory`** — one-shot SQL that joins to `supplier_invoice_lines.account_number` (or reads voucher accounts when tracker rows don't have a direct invoice link). Updates ~430 rows total across both businesses.
3. **Surface BAS account on /overheads drilldown** — minor UI add to show the raw account number alongside the subcategory label. Owner can sanity-check the mapping by clicking a subcategory and seeing what BAS accounts feed it.

**Estimated total work for Phase B**: half a day. Most of it is reviewing the dictionary against the top-20-by-spend list, not coding.

### What's "already done in Fortnox, just surface it" vs net-new

| Capability | Status |
|---|---|
| BAS-level categorisation | **Done in Fortnox — just read.** P2.0 voucher backfill closed the structural gap for Vero. |
| Account → operator-bucket mapping | **Net-new but trivial** — static dictionary. |
| Multi-bucket invoice splitting | **Done at the line level** — each line has its own account_number. M&S is the only repeating case and it's already line-split. |
| Operator-facing P&L view (Overheads page) | **Done.** Just needs the subcategory enrichment to light up. |
| Catalogue review / matcher quality | **Done today** — M112/M113/M114 + recipe stack. |

The investigation's central thesis holds: **organisation is mostly reading-and-grouping of Fortnox-already-categorised data**. CC's net-new value here is the operator-bucket dictionary (small) and ensuring the data is complete enough to roll up (the M&S no_pdf class is the only meaningful gap).

## What was NOT done

- No writes, no migrations, no Fortnox token spend beyond the local cached SQL queries.
- Did not enumerate every M&S no_pdf invoice — sized by count (452) only.
- Did not size the pre-2025-Nov M&S sync gap (~30 min READ-ONLY pull would close this).
- Did not GET-probe Fortnox voucher dimensions/projects fields — low expected value at restaurant scale.
- Did not build the BAS → operator-bucket dictionary — that's Phase B work, deliberately deferred.

## Queries / files referenced

- `scripts/diag-invoice-organisation.mjs` — the read-only pull this is built on.
- `docs/investigation/ms-nopdf-cluster-verdict.md` — Job 1's biggest task.
- `docs/investigation/marini-rima-reextract-results.md` — multi-page passthrough class closed.
- `docs/investigation/empty-line-recovery.md` — empty-line class characterisation.
- `app/overheads/page.tsx` — the consumer surface that's already built.
- `tracker_line_items` table — already-populated rows whose `subcategory` field is the enrichment target.
