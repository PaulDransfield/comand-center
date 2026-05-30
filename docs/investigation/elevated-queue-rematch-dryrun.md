# Elevated Queue — Rematch Dry-Run

Run: 2026-05-31 (post-P2.0 voucher back-fill + full Vero rematch)
Script: `scripts/diag-elevated-queue-rematch-dryrun.mjs`
Read-only — no writes performed.

## Methodology

For every line currently at `match_status='needs_review'` across Chicce and Vero, simulated the production matcher ladder (Gate 0 + Steps 1–4) via the same SELECTs / `inventory_trigram_search` RPC the real matcher uses, but **never persisted**. Bucketed each outcome:

- **A** — would auto-resolve on rematch (Step 1 article match, Step 2 description match, Step 3 same-supplier trigram > 0.80, Step 4 cross-supplier trigram > 0.85). **Zero owner input.**
- **B** — top trigram candidate in 0.30 ≤ similarity ≤ auto-threshold. Collapses onto an existing product but below auto-confidence. **One-tap confirm.**
- **C** — no plausible existing match (top similarity < 0.30 or no candidates). **Genuinely new product.**

Bucket C lines were then deduplicated by `(supplier_fortnox_number, normalised_description)` to count **distinct new products** — the actual review work, separated from repeat-purchase line volume.

Population split by `account_source`:
- **P0** — pre-existing review queue (account_source ≠ 'voucher_backfill' OR NULL)
- **P1** — elevated by P2.0 back-fill (account_source = 'voucher_backfill')

## Headline numbers (P1 — the elevated queue)

| | Chicce | Vero |
|---|---:|---:|
| P1 elevated lines | 172 | 3,099 |
| Auto-resolve on rematch (bucket A) | **0 (0.0%)** | **0 (0.0%)** |
| One-tap-confirm (bucket B) | 16 (9.3%) | 805 (26.0%) |
| Genuinely-new (bucket C) | 156 (90.7%) | 2,294 (74.0%) |
| **Distinct new products in C** | **56** | **581** |
| Line-to-distinct-product ratio | 2.8× | 3.9× |

**0% auto-resolve rate** at both businesses. The earlier rematch was complete and exhaustive — these lines genuinely don't match against any existing alias. Another rematch pass changes nothing without owner input.

But the **581 distinct-new-products at Vero** is the real measure, not the 3,099 lines. Each distinct product appears ~4 times on average — a single confirm clears 4 lines.

## Per-business breakdown

### Chicce

- P0 (pre-existing): 828 lines
  - A: 0 | B: 214 (25.8%) | C: 614 (74.2%) → 68 distinct
- P1 (elevated): 172 lines
  - A: 0 | B: 16 (9.3%) | C: 156 (90.7%) → 56 distinct
- **Combined distinct-new for Chicce: 113**

P1 is small at Chicce (172 lines) because Chicce's Fortnox posts `AccountNumber` at supplier-invoice receipt time; most of its needs_review queue is P0 (pre-existing inventory ambiguity), not back-fill elevation.

### Vero

- P0 (pre-existing): 74 lines
  - A: 0 | B: 6 (8.1%) | C: 68 (91.9%) → 25 distinct
- P1 (elevated): 3,099 lines
  - A: 0 | B: 805 (26.0%) | C: 2,294 (74.0%) → 581 distinct
- **Combined distinct-new for Vero: ~600** (some P0/P1 overlap on normalised descriptions)

Vero is the entire story. P1 dominates because Vero's Fortnox didn't post `AccountNumber` on supplier-invoice creation — every elevated line is one P2.0 back-filled. The 581 distinct-new is the residual to confirm.

## Top distinct-new products (Vero, by line count — what dominates the queue?)

```
269×    14,223 SEK  Snabbgross    "PANT ALUMINIUMBURK 1KR"        ← deposit, not product
127×     1,960 SEK  Spendrups     "EUR-PALL GODKÄND"              ← pallet deposit
120×         0 SEK  Robertssons   ""                              ← empty (PDF extraction gap)
 87×         0 SEK  Snabbgross    ""                              ← empty
 84×         0 SEK  IL Molino     ""                              ← empty
 82×         0 SEK  Martin Servera ""                             ← empty
 68×         0 SEK  Svensk Cater  ""                              ← empty
 61×         0 SEK  Spendrups     ""                              ← empty
 41×       400 SEK  Spendrups     "PLASTPALL SRS 1/2"             ← pallet
 38×     4,000 SEK  SVENSK CATER  "PANT Retur SRS back"           ← deposit return
 27×     1,840 SEK  Snabbgross    "PBA RETURLÅDA HEL SRS"         ← deposit crate
 27×    11,949 SEK  Snabbgross    "PED PROSCIUTTO 400G SK"        ← REAL PRODUCT
 25×     9,310 SEK  Snabbgross    "RAM MAT 1L 15%"                ← REAL PRODUCT
 25×     4,828 SEK  Snabbgross    "FAN ORANGE 33CL BURK"          ← REAL PRODUCT
```

**Of the top 14 by line-count at Vero, only 3 are real products.** The rest are deposits (PANT, EUR-PALL, PBA, etc.), empty descriptions, and packaging — all of which slipped past the rebate pattern because they don't start with "Pant" (`^pant\M` doesn't match `PANT` mid-line, and doesn't match `EUR-PALL`).

## Top distinct-new products (Vero, by SEK value — what costs the most?)

```
87,200 SEK    1× Alden Ventures      "Konsultarvode"               ← CONSULTING, not inventory
57,120 SEK    3× Spräng o bax        "Arbete / konsultation Oktober" ← CONSULTING
51,600 SEK    1× Mathias Aldén       "Konsultarvode November"      ← CONSULTING
44,640 SEK    1× Rosalis Aspholmen   "Såser+bakverk 26/12-25-26/2-26" ← cross-business?
44,640 SEK    1× Rosalis Aspholmen   "såser lev från rosalis…"     ← cross-business?
44,640 SEK    1× Rosalis Aspholmen   "Säser+bakverk 26/8-26/10"    ← cross-business?
44,640 SEK    1× Rosalis Aspholmen   "Säser+bakverk 26/10-26/12"   ← cross-business?
32,640 SEK    1× Citriclabs          "Konsult"                     ← CONSULTING
20,700 SEK    1× Agera & Partners    "Företag Diskning"            ← outsourced dishwashing, not inventory
16,547 SEK   12× Snabbgross          "SCA OXKIND MENU CA5KGVV"     ← REAL PRODUCT (oxkind)
15,000 SEK    1× Cake on Cake AB     "Logotype inkl grafiskt maner" ← MARKETING, not inventory
```

**Of the top 11 by SEK, 8 are clearly NOT inventory** (consulting, dishwashing service, marketing). These got elevated because the voucher posted them to 4xxx food accounts (a categorisation choice by Vero's accountant — booking professional services as food cost). The BAS-routing trusts that account, the supplier-name classifier wasn't given a chance to override, and the matcher elevated.

Rosali sauce purchases (5 entries × ~44,640 SEK each) are real inventory but represent an inter-business transfer — likely should consolidate to a single product, not 5 distinct entries.

## Cross-business overlap (P0 + P1 combined, bucket C)

| | Count |
|---|---:|
| Vero distinct-new | 600 |
| Chicce distinct-new | 113 |
| **Overlap (same normalised description)** | **16** |

Only **14% of Chicce's distinct-new** also appears at Vero. And the overlap is dominated by:

```
plastpall srs 1 2                 ← pallet
eur pall godkand                  ← pallet
pant for dm pledge for dm 40kr    ← deposit
fakturatolkning                   ← Fortnox SaaS fee
leveransavgift                    ← delivery fee
e faktura ta emot                 ← Fortnox SaaS fee
europapalle 4 vejs 1200x800x144   ← pallet
```

**Zero real food/alcohol products overlap.** A shared catalogue across Vero + Chicce (the future P2a/Phase 3 supposition) would pre-seed almost nothing on the real-residual front. Vero's supplier mix and SKU language is essentially disjoint from Chicce's.

## What the elevation actually exposed

Decomposing the 2,294 Vero genuinely-new lines roughly:

| Category | Approx. lines | Distinct | Real work? |
|---|---:|---:|---|
| Empty descriptions (PDF extraction gap) | ~500 | ~10 | No — extractor bug |
| Deposits / pallets / packaging | ~800 | ~50 | No — should be excluded at Gate 0 |
| Service fees / consulting on 4xxx accounts | ~150 | ~50 | No — categorisation error by accountant |
| Real food/alcohol new products | **~850** | **~470** | **Yes** |

The real review residual at Vero is closer to **~470 distinct new products**, not 581. The remaining ~110 distinct are noise classes (deposits, services, empty) that could be filtered with sharper Gate-0 rules.

## Auto-resolve rate — answer to the prompt's headline question

> "Of the ~1,572 elevated lines, what % auto-resolve on a rematch with zero owner input?"

**0%.** None auto-resolve. The matcher already ran exhaustively over them in the post-P2.0 rematch and they genuinely don't match against existing aliases. Another rematch pass produces nothing.

The "would auto-resolve on next rematch" hypothesis was framed against the possibility that some lines got processed BEFORE other lines inserted aliases that would later have matched them. That race scenario doesn't show up empirically — every line had its full ladder shot.

## Operational and billing safety

The elevated lines' presence in `needs_review` is a **categorisation queue state only**. No financial impact:
- `tracker_data` totals (revenue, food_cost, staff_cost, etc.) are unaffected
- `monthly_metrics` aggregates are unaffected
- Owner-facing P&L surfaces are unaffected
- Cost-path columns (qty, price, total_excl_vat, currency) untouched by the back-fill (V7 regression guard ran clean)

The queue size is throughput pressure on owner attention, not data-integrity urgency. Triage at any pace.

## Three-line summary (chat headline)

1. **0% auto-resolve** at both businesses. The post-P2.0 rematch was complete; no additional rematch pass clears the elevated queue without owner input.
2. **Distinct new products to confirm: ~56 at Chicce, ~581 at Vero** (3,271 total lines collapse to ~637 distinct). Line-to-distinct ratio 2.8× / 3.9× — each confirm clears ~3-4 lines.
3. **Half of Vero's residual is noise, not real work** — top items by line-count and SEK value are dominated by deposits (PANT, EUR-PALL), empty descriptions, and consulting/service fees that ended up on 4xxx accounts. A handful of high-frequency deposit codes and ~5 obvious non-inventory suppliers would clear ~30-40% of the residual with a few owner skips. Real food/alcohol residual is closer to ~470 distinct products at Vero — a few afternoons of focused triage, not weeks.

## Follow-ups surfaced

Not for this run, but worth noting:

1. **Rebate pattern misses non-Avtalsrabatt deposits.** `PANT ALUMINIUMBURK` (269 lines), `EUR-PALL GODKÄND` (127 lines), `PBA RETURLÅDA`, `Plockavgift`, distribution fees — all currently land in needs_review. Extending the rebate guard pattern to catch these (or routing pallet/deposit lines to a `'not_inventory'` Gate-0 rule based on description) would shrink the elevated queue ~800 lines at Vero alone.
2. **Service fees on 4xxx accounts.** Consulting (Alden, Citriclabs), outsourced dishwashing (Agera), marketing (Cake on Cake) all got booked to 4xxx and elevated. Either (a) extend `supplier_classifications` overrides per-business, or (b) build the matcher to consider supplier-name classification AFTER BAS-routing as a sanity check rather than before. Currently BAS-routing wins on a `4xxx → food` default; a supplier-name `not_inventory` classifier doesn't get to veto.
3. **Empty descriptions from PDF extraction.** ~500 lines at Vero have empty `raw_description`. Either the PDF extractor failed on these or the line text is genuinely blank in the source. Worth a sample inspection to decide whether to retry extraction or accept as not_inventory.
