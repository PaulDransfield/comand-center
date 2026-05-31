# VAT Channel-Misrouting — Hotfix Status Check

Run: 2026-05-31
Read-only. No fix attempted.

## Status verdict

| Question | Verdict | Evidence |
|---|---|---|
| **Shipped?** | **YES** | Commit `8806ed9` on `main` (2026-05-30 17:52:50 +0200). `lib/sweden/vat.ts` created with date-effective logic. All 5 inference sites converted. Vero April corrective backfill SQL also ran (`sql/backfill-vero-april-vat-misrouting.sql`). |
| **Still firing today?** | **NO** | Vero April 2026 takeaway% = **7.8%** (88,833 / 1,135,074), down from the inflated ~12% pre-fix. Account 3053 ("Försäljning varor 6% moms Sv") is now subcategory=`null` in `tracker_line_items`, not `'takeaway'`. Zero 6%-labelled revenue lines anywhere in Vero 2026 are tagged `'takeaway'`. |
| **Spread to Chicce?** | **NO** | Chicce has zero 6%-labelled revenue lines in 2026 (the accountant hasn't added a 6% account). Chicce `takeaway_revenue` = 0 for every month Jan–Apr 2026. Stays clean. |

## Part A — Code + git evidence

### A1. `lib/sweden/vat.ts` exists with the correct semantics

Created 2026-05-30 17:52 (commit `8806ed9`). Carries:
- Constants `SWEDEN_VAT.STANDARD=25 / RESTAURANT_DINE=12 / FOOD_GOODS=6 / ZERO=0`
- Date-effective helpers `isFoodVatCutActive(dateIso)` + `foodVatRateAt(dateIso)`
- Constants `TEMP_FOOD_CUT_START='2026-04-01'` + `TEMP_FOOD_CUT_END='2027-12-31'`
- **Explicit principle in the doc comment**: *"Code that needs to map `6 %` to a revenue subset MUST consult an explicit signal (platform name, per-business account override, or POS `is_take_away` flag) — never assume."*

### A2. Inference sites — all five converted

| Site | Status | Evidence |
|---|---|---|
| `lib/fortnox/classify.ts:141-150` | ✓ fixed | `classifyByVat()` returns 25%→alcohol, 12%→food (dine_in); **no 6%→takeaway rule**; only explicit Wolt/Foodora/UberEats names get tagged takeaway. Comment block (lines 114-140) documents the rule change. |
| `lib/fortnox/api/voucher-to-aggregator.ts:250-256` | ✓ fixed | Delegates to `classifyByVat()` (now fixed upstream). No own 6% logic. |
| `lib/fortnox/resultatrapport-parser.ts:696` | ✓ fixed | Delegates to `classifyByVat()` (now fixed upstream). |
| `app/api/fortnox/extract-worker/route.ts:381-407` (AI system prompt) | ✓ fixed | Documents *"6 % moms → AMBIGUOUS after 2026-04-01"* and *"ONLY tag a 6 %-moms revenue line as takeaway_revenue when the label explicitly names Wolt, Foodora, or Uber Eats. Otherwise leave the revenue subset UNCLASSIFIED"*. |
| `app/api/fortnox/extract-worker/route.ts:824-826` (code path) | ✓ fixed | Calls `classifyByVat()` (now fixed). |
| `lib/pos/personalkollen.ts:295-325` | ✓ fixed | PK ticket's `is_take_away === true` is authoritative for dine-in/takeaway split. VAT only discriminates food vs alcohol. Food at ANY rate (6 or 12) routes by `is_take_away` flag. Comment explicitly cross-references `VAT-MISROUTING-FIX-PLAN.md Phase 1`. |

### A3. Git log

Per `git log --since="2026-05-20" -- lib/sweden/vat.ts lib/fortnox/classify.ts app/api/fortnox/extract-worker/route.ts lib/pos/personalkollen.ts`:

| File | First commit touching it (since 2026-05-20) |
|---|---|
| `lib/sweden/vat.ts` | `8806ed9` 2026-05-30 17:52 (file created) |
| `lib/fortnox/classify.ts` | `8806ed9` 2026-05-30 17:52 |
| `app/api/fortnox/extract-worker/route.ts` | `8806ed9` 2026-05-30 17:52 (+ earlier `f9d924b` 2026-05-25 unrelated AI quota gate work) |
| `lib/pos/personalkollen.ts` | `8806ed9` 2026-05-30 17:52 |
| `lib/fortnox/api/voucher-to-aggregator.ts` | no recent commit (was already clean — delegates to `classifyByVat`) |
| `lib/fortnox/resultatrapport-parser.ts` | no recent commit (same reason) |

The hotfix is one commit on main (`8806ed9`), shipped to production via the auto-deploy pipeline on 2026-05-30. The fix has been live for ~1 day.

## Part B — Data evidence

### B1. Vero monthly revenue split, Jan–Apr 2026

```
period | revenue   | dine_in   | takeaway  | alcohol   | takeaway%
2026-01 |   1,817,099 |    669,610 |     74,127 |  1,062,068 | 4.1%
2026-02 |   1,644,161 |    638,889 |     73,852 |    923,121 | 4.5%
2026-03 |   1,603,919 |    654,312 |     57,096 |    885,783 | 3.6%
2026-04 |   1,135,074 |    479,852 |     88,833 |    517,921 | 7.8%
```

April takeaway% = 7.8% (88,833 SEK = Wolt/account 3072 only). Pre-fix it was inflated to ~12% (137,301 SEK = 88,833 Wolt + 48,468 misrouted from 3053). **The step-up that was the bug signature is gone.** The 7.8% number matches the predicted post-fix value in the backfill SQL header.

(May 2026 tracker row shows rev=0/ta=0, last updated 2026-05-25 — month not yet meaningfully ingested. The hotfix code is what would run on the next sync; nothing to verify here.)

### B2. Vero account 3053 — current subcategory

```
period | account | subcategory   | amount     | label
2026-04 | 3053    | null          |     48,468 | Försäljning varor 6% moms Sv
```

One row, subcategory=`null` (correctly unclassified). The backfill SQL fixed Vero April; the code fix prevents recurrence on future syncs.

### B3. All Vero 2026 6%-labelled revenue lines

```
1 row found
⚠️  Tagged 'takeaway' subcategory: 0
Other subcategory (correctly unclassified): 1
  2026-04 acct=3053 sub=null amount=48,468 "Försäljning varor 6% moms Sv"
```

**Zero lines tagged takeaway.** Clean.

### B4. Chicce — spread check

```
Chicce tracker_data Jan-Apr 2026:
period | revenue | dine_in | takeaway | alcohol | takeaway%
2026-01 | 780,416 | 625,974 |        0 | 147,302 | 0.0%
2026-02 | 755,618 | 608,381 |        0 | 138,560 | 0.0%
2026-03 | 866,796 | 677,528 |        0 | 180,856 | 0.0%
2026-04 | 839,378 | 666,137 |        0 | 164,341 | 0.0%

Chicce '6%' labelled lines: 0
```

Chicce stays clean. No 6%-moms revenue accounts. `takeaway_revenue` = 0 for every month. The accountant has not added a 6% account at Chicce yet; if they ever do, the fixed code will correctly leave 3053-equivalent lines unclassified rather than auto-bucketing as takeaway.

### B5. Latest ingest

```
Vero latest 5 tracker_data updates:
  2026-04 updated=2026-05-30T15:53:39 source=fortnox_api ta=88833 rev=1,135,074
  2026-05 updated=2026-05-25T13:28:52 source=fortnox_api ta=0 rev=0
  2026-03 updated=2026-05-25T13:27:07 source=fortnox_api ta=57,096 rev=1,603,919
  2026-02 updated=2026-05-25T13:22:35 source=fortnox_api ta=73,852 rev=1,644,161
  2026-01 updated=2026-05-25T13:19:14 source=fortnox_api ta=74,127 rev=1,817,099
```

The most recent Vero `tracker_data` write was 2026-05-30 15:53 — that's the corrective backfill on April, source=`fortnox_api`. The hotfix shipped at 17:52 the same day; subsequent syncs would use the fixed code. No misroute pattern in any update.

## Conclusion

Hotfix is shipped, verified clean in production data, and not firing today. Nothing to scope as remediation.

Two notes for future awareness:
- **The 48,468 SEK on account 3053 stays in `revenue` (correct — total revenue isn't affected) but is unclassified to `dine_in_revenue` / `takeaway_revenue`.** Phase 2 of the original VAT plan was an admin UI for the owner to explicitly map ambiguous 6% accounts (account 3053 → dine_in or takeaway by owner choice). That UI hasn't shipped — it's a deliberate follow-up, not a regression. The current state is honest: the line contributes to total revenue, not to a specific subset.
- **The hotfix is a code+data fix, not a "wait and verify" — it can't drift.** `lib/sweden/vat.ts` and the 5 inference sites are deterministic. Unless someone reintroduces a `6% → takeaway` rule, the misrouting cannot recur.
