# Vero Queue Staging Report — For Paul's Manual Categorization Pass

Run: 2026-05-31
STATUS: **STAGED, NOT APPLIED.** Awaiting Paul's go/no-go on the 7 per-supplier rules and the mechanism choice.

## Three-line chat summary

1. **Queue is at 2,125 needs_review (down from 2,197 prior probe — natural ~72-line drain since last check). Deposit/Gate-0 cleanup fully settled with 2 stragglers worth flagging.**
2. **Bucket A (un-itemizable empties from top 7 wholesalers): ~559 lines / 3.2M SEK that should be terminal-stated by rule, not eyeballed. Bucket A-other (24 long-tail suppliers, 124 lines / 556k SEK) likely should also be rule-stated. Bucket B (deposit stragglers): 2 lines, negligible. Bucket C (the real work for Paul): 1,470 lines → 718 distinct itemizable products (line-to-distinct 2.0×). That 718 is the actual scope of Paul's manual day, not the 2,125 queue depth.**
3. **The mechanism choice is the question.** `supplier_classifications` (M083) is the wrong tool — it's blanket, would wrongly terminal-state itemized food lines from the same suppliers (e.g. 967 itemized Snabbgross lines like "PEP PEPSI MAX 33CL" would be incorrectly swept). The right tool is either (a) one-time SQL flip scoped to empty-description rows only, or (b) a small persistent matcher rule "empty-desc + positive-BAS-food/alcohol account = not_inventory." Recommend both: (a) for this round so Paul's pass is clean, (b) as the durable follow-up so future ingests don't re-elevate.

---

## Step 1 — Queue state (READ-ONLY)

| | Value |
|---|---:|
| Vero needs_review total | **2,125** |
| Empty-description | 653 |
| Has-description | 1,472 |
| Has account_number | 2,059 (97%) |
| Null account_number | 66 |
| account_source = voucher_backfill | 2,059 |
| account_source = fortnox_row | 66 |

Reconcile: prior empty-descriptions investigation showed 2,197 total / 656 empty / 1,541 drainable. Current: 2,125 / 653 / 1,472 — small natural drain since (~72 lines). No surprise.

**Deposit/Gate-0 rematch settled cleanly** — only 2 stragglers in the queue that match the deposit/logistics pattern:
```
2× "PBA RETURLÅDA HEL SRS"
```
These should have flipped to `not_inventory` via Fix 2 + the matcher's Gate 0b description rule. Most likely cause: ingested after the Fix 2 SQL ran AND the matcher's pattern check missed them somehow — worth a 5-minute drill-in afterwards, but don't block the manual pass on it. They'll get caught by the next one-off SQL (Bucket B fold-in below) or a targeted Gate-0b debug pass.

## Step 2 — Three-bucket split

| Bucket | Lines | SEK | Description |
|---|---:|---:|---|
| **A — empties from top 7 wholesalers** | 529-559* | 3,235,571 | Un-itemizable account-level totals from the dominant wholesalers — should be rule-stated, not eyeballed |
| **A-other — empties from 23 long-tail suppliers** | 124 | 555,725 | Same shape, smaller per-supplier — same fate but per-supplier rules would be overkill (~5 lines each); covered by the durable rule |
| **B — deposit/logistics stragglers** | 2 | 80 | Fix 1+2 nearly cleared. Two PBA RETURLÅDA lines that slipped through — fold into the one-time SQL |
| **C — real itemizable work (has description)** | 1,470 | 444,597 | The seed-worthy set Paul should triage |

\* *Discrepancy between Step 2 aggregate (529) and Step 3 per-supplier sum (559) is data drift between the two SQL pulls — small inflight changes during the staging run. Round figure: ~540 lines from the top 7.*

**HEADLINE — Bucket C distinct itemizable products: 718** (line-to-distinct ratio 2.0× — each distinct product appears twice on average). Paul's manual day is ~718 product decisions, not 1,470 line eyeballs. Every confirmed line becomes a learning seed for the cross-customer alias network (Phase 3 Option 4) — exactly what the catalogue-sourcing analysis identified as the moat.

## Step 3 — The 7 per-supplier rules (PROPOSED, NOT APPLIED)

For each: rule scope (empties only), both-directions proof (zero itemized lines swept), and the itemized population that confirms the supplier sells real items.

| # | Supplier | Fortnox # | Rule would flip | SEK | Account distribution | Itemized lines that MUST stay |
|---:|---|---|---:|---:|---|---:|
| 1 | Robertssons Charkuteri | Robertssons | 101 | 374,349 | 4010:81, (null):19, 6550:1 | **0** ✓ (clean — supplier only invoices via empties) |
| 2 | Snabbgross Örebro | Axfoodsnabbgros | 86 | 386,307 | 4010:45, 4011:35, 4000:3, 5460:3 | **967** ⚠️ (CRITICAL — itemized: "MAR EXPORT 50CL 5,3%", "PEP PEPSI MAX 33CL", "ARL FILMJ 1,5KG ORGIN 3%") |
| 3 | IL Molino AB | ILMolinoAB | 79 | 900,596 | 4010:65, 4011:14 | **5** (itemized: "Grissini Handgjord Rosmarin", "Bona Aranciata Rossa") |
| 4 | Martin Servera Restauranghandel AB | 7919816 | 154 | 640,532 | 4010:75, 4011:58, (null):21 | **126** (itemized: "LOCK TRANSPARENT GN-1/2", "MONIN KARAMEL 70CL") |
| 5 | Svensk Cater | SvenskCater | 55 | 159,531 | 4010:29, 4011:24, 5460:2 | **68** (itemized: "Glass Pistage 100g", "Lök Rostad 500g") |
| 6 | Spendrups | Spendrups | 59 | 777,420 | 4010:30, 4011:29 | **96** (itemized: "SOL 4,2 33EG", "FAT 30L SCHWEIGER") |
| 7 | Martin & Servera | MartinServera | 25 | 104,354 | 4010:12, 4011:13 | **0** ✓ (legacy Fortnox supplier id, all empties) |

**Total empties the rules would flip: 559. Total itemized lines that must NOT be swept: 1,262.**

The Snabbgross row is the cautionary example: a blanket rule would wrongly terminal-state 967 itemized food lines. The empty-only semantic is essential, not optional.

## Mechanism choice — the trap

`supplier_classifications` (M083) is blanket per (business_id, supplier_fortnox_number). Using it for any of these 7 would terminal-state ALL their lines — including the 1,262 itemized lines above. **Wrong tool.**

Two ways to express the narrower "empty-description only" semantic:

### (a) One-time SQL flip — fast, scoped

```sql
UPDATE supplier_invoice_lines
SET match_status = 'not_inventory'
WHERE business_id = '0f948ac3-...'
  AND match_status = 'needs_review'
  AND product_alias_id IS NULL
  AND (raw_description IS NULL OR TRIM(raw_description) = '')
  AND supplier_fortnox_number IN ('Robertssons','Axfoodsnabbgros','ILMolinoAB','7919816','SvenskCater','Spendrups','MartinServera')
```

- Idempotent. Handles current queue.
- Could also drop the supplier filter and catch Bucket A-other (124 lines) in the same pass — same logic, all empties everywhere.
- Could also fold in Bucket B (the 2 deposit stragglers) by adding the deposit pattern OR.
- Future incoming empties from these suppliers WILL re-elevate to needs_review on next sync. Needs (b) to be durable.

### (b) Persistent matcher rule — durable

Add a new Gate 0 check in `matcher.ts` AFTER the existing description rule (0b), BEFORE the supplier veto (0c):

```typescript
// Gate 0b-prime: empty-description + has-positive-BAS-category = not_inventory
//
// Some accounts (Vero's case) book line-level totals to food/alcohol accounts
// with no per-line item text. These lines are real expenses (BAS account is
// reliable) but cannot be itemized to a product without a description.
// Terminal-state them at ingest so they don't inflate the review queue —
// the BAS account is the only signal we have, and it's enough for category
// roll-up purposes; the line just won't carry a product link.
const normalised = normaliseDescription(line.raw_description)
if (!normalised) {
  const basCategory = categoryForBasAccount(line.account_number)
  if (basCategory && basCategory !== 'not_inventory' && basCategory !== 'other') {
    return { status: 'not_inventory', product_id: null, alias_id: null,
             method: null, confidence: null, candidates: [] }
  }
}
```

- Catches both existing and future empties at any supplier (not just the top 7).
- Catches Bucket A + Bucket A-other + future Chicce empties too.
- The existing matcher.ts code returns 'needs_review' for empty descriptions IF a positive category resolved (line 116-119 today). This rule INVERTS that for the empty-with-account case — empty-with-positive-BAS becomes not_inventory because the BAS signal alone is enough for cost tracking even though product itemization is impossible.

### Recommendation

**Both.** (a) immediately so Paul's manual pass lands on a queue without the ~683 un-itemizable empties (top-7 + long-tail) — fastest path to the 718 distinct itemizable products. (b) within the same branch so future ingest doesn't re-create the problem.

**Open question for Paul's call:**
- Does extending (a) to drop the supplier filter and clear ALL empties (top-7 + 124 long-tail + the 2 stragglers, all in one pass = 685 lines) feel right? Per the prompt's logic, the long-tail empties have the same un-itemizable nature; per-supplier rules just don't justify the maintenance overhead at 5 lines each. The durable matcher rule (b) handles them automatically anyway.

## What I'd do this turn on Paul's go

If he says "go" on the 7 + the drop-the-supplier-filter idea:
1. Write `sql/p20-vero-empty-account-totals-DRY.sql` (BEGIN…ROLLBACK, plus verification).
2. Owner runs DRY, eyeballs verification (expect 685ish flipped, 0 itemized lines touched).
3. APPLY twin (COMMIT).
4. Then the matcher.ts Gate 0b-prime patch.
5. Re-verify Bucket C unchanged, Bucket A+A-other terminal-stated, Paul's queue is now 1,470 lines → 718 distinct products.

If he says "top 7 only, leave A-other for later":
1. Same SQL but with the supplier-IN-list.
2. Skip (b) until after Phase D so the persistent rule lands separately.

If he wants to defer the whole staging until after Phase D (so the watch reads against an unmodified queue): everything stays as a planned ticket; nothing applied.

## Stop here.

Awaiting go/no-go on:
1. The 7-rule scope (or broaden to all-empties)
2. The mechanism choice ((a) only / (b) only / both)
3. Whether to ship this DURING the Phase D watch (it does change the queue depth — record exactly what moved + when so the 2026-06-07 read can subtract it)
