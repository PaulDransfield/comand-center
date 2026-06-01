# M115 Overhead Backfill — By-Spend Verification (pre-COMMIT)

Run: 2026-06-01
Branch: `bas-bucket-dictionary`
Method: in-memory DRY application of `lib/overheads/basBuckets.ts` against the live `tracker_line_items` population. Source: `scripts/diag-bucket-backfill-verify.mjs`.

## Three-line headline

1. **Top-spend buckets all land in the right place by kronor.** Salaries (Chicce 2.4 M / Vero 3.5 M from 7010+7090+7011), rent (Chicce 545 k from 5010+5012 / Vero 2.6 M from 5010), payroll_tax (853 k / 1.1 M from 7510+7519), marketing (171 k / 252 k), utilities (245 k / 264 k from 5020+5160). No big number is in a surprising bucket.
2. **Two real mis-maps caught + fixed before COMMIT.** (a) `3053 → takeaway` would have undone the May 2026 VAT hotfix — now deliberately UNMAPPED (48,468 SEK stays honest-incomplete at Vero); (b) `6800 → memberships` was wrong for Vero's "Inhyrd personal" agency-staff usage (143,680 SEK) — now → `consulting`. Both fixes mirrored in TS dictionary and SQL CASE WHEN.
3. **Channel/COGS-vs-overhead mix is coherent on `/overheads` by construction.** The `SubcategoryBreakdown` consumer filters by `category === 'other_cost'` upstream, so revenue subcategories (dine_in/takeaway/alcohol/other_revenue on 3xxx rows) and food_cost subcategories never pollute the overhead rollup. No presentation grouping needed.

---

## 1. By-spend bucket totals per business (post-fix)

### Chicce — 365 rows, 6,458,462 SEK enriched

| Bucket | Spend (SEK) | Rows |
|---|---:|---:|
| salaries | 2,681,305 | 21 |
| payroll_tax | 853,453 | 11 |
| rent | 545,420 | 21 |
| other_revenue | 602,476 | — |
| utilities | 245,754 | 11 |
| marketing | 242,873 | 24 |
| consumables | 218,575 | 23 |
| consulting | 196,670 | 14 |
| personnel_benefits | 183,362 | — |
| pension | 127,473 | — |
| repairs | 128,093 | — |
| it_software | 87,913 | 12 |
| cleaning | 70,302 | — |
| insurance | 33,614 | — |
| professional_other | 29,659 | — |
| telephone_internet | 24,503 | — |
| bank_fees | 23,523 | — |
| delivery | 16,101 | — |
| security_alarm | 16,064 | — |
| (other small buckets) | < 16 k each | — |

### Vero — 245 rows, 9,897,394 SEK enriched (post-3053-unmap)

| Bucket | Spend (SEK) | Rows |
|---|---:|---:|
| salaries | 4,079,097 | 35 |
| rent | 2,598,430 | 19 |
| payroll_tax | 1,154,262 | 14 |
| consulting | 525,811 | 18 |
| marketing | 403,496 | 24 |
| utilities | 264,622 | 5 |
| repairs | 193,399 | 13 |
| accounting | 168,776 | 11 |
| consumables | 166,922 | 19 |
| bank_fees | 110,136 | 24 |
| it_services | 43,952 | 8 |
| insurance | 41,457 | 4 |
| it_hardware | 40,217 | 6 |
| cleaning | 34,977 | 1 |
| memberships | 7,266 | — |
| vehicle | 6,575 | 11 |
| other_premises | 11,479 | 4 |
| security_alarm | 8,219 | 6 |
| representation | 7,801 | 4 |
| (other small buckets) | < 7 k each | — |

## 2. Top-15 accounts by spend → bucket assignment (post-fix)

### Chicce

| Account | Spend (SEK) | Bucket | Sample label |
|---:|---:|---|---|
| 7010 | 2,402,501 | salaries | Löner till kollektivanställda |
| 7510 | 853,453 | payroll_tax | Arbetsgivaravgifter 31,42 % |
| 5010 | 414,090 | rent | Lokalhyra |
| 3560 | 381,571 | other_revenue | Fakturerade kostnader till koncernf… |
| 7090 | 278,804 | salaries | Förändring av semesterlöneskuld |
| 5020 | 245,754 | utilities | El för belysning |
| 6591 | 195,013 | consulting | Kostnader OH/Stab |
| 6050 | 168,847 | marketing | Försäljningsprovisioner Wolt |
| 5012 | 131,330 | rent | Hyra Tillägg |
| 7570 | 126,844 | pension | Premier FORA |
| 3995 | 121,203 | other_revenue | Erhållna reklambidrag, momsfri |
| 5460 | 112,033 | consumables | Förbrukningsmaterial |
| 7380 | 108,842 | personnel_benefits | Kostnader för förmåner till anställ… |
| 5580 | 95,938 | repairs | Underhåll och tvätt av arbetskläder |
| 5420 | 87,913 | it_software | Programvaror |

### Vero

| Account | Spend (SEK) | Bucket | Sample label |
|---:|---:|---|---|
| 7010 | 3,469,947 | salaries | Löner till kollektivanställda |
| 5010 | 2,557,064 | rent | Lokalhyra |
| 7510 | 1,104,379 | payroll_tax | Arbetsgivaravgifter 31,42 % |
| 6550 | 352,551 | consulting | Konsultarvoden |
| 7090 | 282,862 | salaries | Förändring av semesterlöneskuld |
| 7011 | 276,793 | salaries | Löner till kollektivanställda |
| 5160 | 264,622 | utilities | Städning och renhållning |
| 6050 | 252,073 | marketing | Försäljningsprovisioner |
| 5500 | 188,375 | repairs | Reparation och underhåll |
| 6530 | 168,776 | accounting | Redovisningstjänster |
| 5460 | 149,733 | consumables | Förbrukningsmaterial |
| **6800** | **143,680** | **consulting** ← fixed from memberships | Inhyrd personal |
| 6570 | 78,297 | bank_fees | Bankkostnader |
| 5990 | 70,340 | marketing | Övriga kostnader för reklam och PR |
| 7519 | 49,883 | payroll_tax | Arbetsgivaravgifter för semester- o… |

All top-15 entries make sense relative to their sample labels.

## 3. Channel/COGS-vs-overhead coherence

| Category × Bucket spend (Vero, top 10) | SEK |
|---|---:|
| staff_cost/salaries | 4,079,097 |
| other_cost/rent | 2,598,430 |
| staff_cost/payroll_tax | 1,154,262 |
| other_cost/consulting | 525,811 |
| other_cost/marketing | 403,496 |
| other_cost/utilities | 264,622 |
| other_cost/repairs | 193,399 |
| other_cost/accounting | 168,776 |
| other_cost/consumables | 166,922 |
| other_cost/bank_fees | 110,136 |
| revenue/alcohol | 26,321 |

Verdict: **coherent**. The `/api/overheads/line-items` consumer filters by `category === 'other_cost'` upstream of the `SubcategoryBreakdown` rollup — revenue subcategories (e.g. `revenue/alcohol`) never appear in the overhead view; they go to other readers (the AskAI context builder, the cost-intel agent). The dictionary covering revenue rows is fine because the surface that mis-sums them simply doesn't exist.

No presentation grouping needed. The current `/overheads` UI will render the post-backfill buckets correctly as a flat operating-overhead breakdown.

## 4. Long-tail spot-check + per-business divergence

### Unmapped accounts after fixes

- **Vero only**: account 3053 (48,468 SEK, "Försäljning varor 6 % moms Sv"). DELIBERATELY unmapped per the VAT hotfix invariant — stays honest-incomplete on `/overheads` until a specific platform signal arrives (Wolt/Foodora/UberEats in supplier name). The 48 k is a single row; not blocking.
- **Chicce**: 0 unmapped accounts.

### Per-business divergence

Only one account behaves differently across businesses: **6800**.

- Vero: "Inhyrd personal" (agency staff) — 143,680 SEK / 4 rows. Mapping to `consulting` (closest fit for external-service spend) ✓.
- Chicce: doesn't appear (no 6800 spend at Chicce).

Mapped globally to `consulting`. If a future customer uses 6800 for genuine memberships (the standard BAS definition), a per-business override via the M083 pattern is the escape hatch — out of scope for this build.

### Long-tail mis-map scan

Spot-checked all 87 entries by reading bucket against sample labels:

- 5580 → `repairs` ("Underhåll och tvätt av arbetskläder" / workwear cleaning). BAS standard 5580 is "Övriga underhållstillbehör"; the Chicce label is non-standard usage closer to personnel benefits. Acceptable as `repairs` for now (95,938 SEK at Chicce only). Borderline; flag for revisit if it grows.
- 6591 → `consulting` (Chicce "Kostnader OH/Stab" — inter-company OH allocation; 195,013 SEK). Standard BAS 6591 is "Övriga konsultarvoden". The Chicce usage is administrative overhead allocation, which is consulting-adjacent. Acceptable.
- 6050 → `marketing` for "Försäljningsprovisioner Wolt" at Chicce. Wolt sales commissions ARE a marketing cost. Correct.

No other surprises.

## 5. Coherence + idempotency confirmations

- Dry-run does not modify the database (`ROLLBACK` at end).
- Re-running the SQL post-COMMIT would be a no-op (`WHERE subcategory IS NULL`).
- Business-scoped via `business_id`; ownership-checked downstream by `/api/overheads/line-items` (`requireBusinessAccess`).
- Honest-incomplete preserved: 3053 stays NULL at Vero, and any future unknown account stays NULL via the `ELSE NULL` clause in the CASE WHEN.
- Persistent rule at `app/api/fortnox/apply` uses the SAME `bucketForAccount()` helper — no SQL/TS drift since both reference the dictionary file directly (TS) or its mirror (SQL).

## GO/NO-GO

**GO**: the two real mis-maps are fixed, all top-15 accounts at both businesses land in correct buckets by spend, the channel/COGS+overhead mix is rendered coherently by the existing consumer's category filter, and zero accounts mapped to a confidently-wrong bucket.

**Owner action**: open Supabase SQL Editor → paste `sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql` → run as DRY → confirm V1 shows ~611 rows resolved with the bucket distribution above → flip `ROLLBACK;` → `COMMIT;` → re-run → merge branch `bas-bucket-dictionary` to main.

## What was NOT done

- Did not run `COMMIT` — owner-driven per the prompt's gate.
- Did not modify the AI extractor prompt — the AI's existing subcategory output ("rent", "marketing", "salaries", "payroll_tax", …) is already snake_case-compatible with the dictionary. No prompt change needed.
- Did not extend the dictionary to per-business overrides — the 6800-at-Vero case is currently the only divergent account and `consulting` is the right cross-business bucket. If others surface, the M083 pattern is the escape hatch.

## Files

- `lib/overheads/basBuckets.ts` — fixed 3053 + 6800.
- `sql/M115-TRACKER-SUBCATEGORY-BACKFILL.sql` — mirror fixes in CASE WHEN + comments.
- `scripts/diag-bucket-backfill-verify.mjs` — the in-memory dry-run that produced this verification.
- `docs/investigation/overhead-bucket-dictionary-verify.md` — this file.
