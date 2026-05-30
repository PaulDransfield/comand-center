# Claude Code — VAT Channel-Misrouting Hotfix

## Purpose

Stop the confirmed live bug: the code infers **sales channel** (dine-in vs takeaway) from **VAT rate**, treating "6% moms" as takeaway. Since Sweden's food-goods rate dropped to 6% on 2026-04-01, generic 6% food revenue (e.g. Vero's new account 3053 "Försäljning varor 6% moms Sv") is being mis-bucketed into `takeaway_revenue` (~48,468 SEK, April, still firing). Fix the cause, not just the symptom: **VAT rate must never determine channel.** Then re-derive affected periods.

This is a code change on a **live, paying system**. Investigation-first, feature branch + Vercel preview, no prod deploy without review.

## Root-cause principle (the whole fix in one sentence)

Pre-2026-04-01, "6% = takeaway" was a safe proxy. It no longer is. **Channel (dine-in vs takeaway) must be decided by real signals — the platform/delivery account (Wolt/Foodora/Uber, e.g. account 3072), explicit takeaway accounts, or the POS `is_take_away` flag — never by VAT rate.** VAT rate goes back to being VAT only (moms reporting).

## Step 0 — Investigate before editing

Confirm the current behaviour and produce a short written plan before changing code:
- The canonical classifier `lib/fortnox/classify.ts:119-132` (`classifyByVat`) and its **four** call sites: `lib/fortnox/api/voucher-to-aggregator.ts:250-256` (the live path), `lib/fortnox/resultatrapport-parser.ts:696`, `app/api/fortnox/extract-worker/route.ts:811-816` (+ system prompt :387-393), and `lib/pos/personalkollen.ts:307-323`.
- Confirm the supplier-invoice **cost** path is NOT affected (it routes by BAS/supplier, not VAT) — do not touch it.
- Confirm whether reclassifying into the existing `dine_in` subcategory avoids any new enum/CHECK value (preferred — no DB migration for a hotfix). If a new bucket is genuinely needed, DB CHECK + TypeScript must land in the **same commit** (per `feedback_check_constraint_drift`).

## Step 1 — Centralise VAT knowledge

Create `lib/sweden/vat.ts` as the single source of VAT-rate truth:
- Constants: `STANDARD = 25`, `FOOD_SERVICE_DINEIN = 12`, `REDUCED_6 = 6`, `ZERO = 0`.
- A date-effective helper for the temporary food-goods cut: foodstuffs sold as goods = **6%** for `2026-04-01 .. 2027-12-31`, else **12%** — so the rate is resolved by invoice/voucher date, never hard-coded.
- Explicit doc comment: **these rates are for VAT/moms purposes only and must not be used to infer sales channel.**

New code paths consume this module. You need not refactor all ~7 legacy literal sites in this hotfix, but every site you touch below must route through it.

## Step 2 — Remove VAT→channel inference at every site (delete, don't layer)

1. **`lib/fortnox/classify.ts`** — split responsibilities:
   - Remove the `6% moms → takeaway` line and the rate→subcategory mapping that conflates VAT with channel.
   - Provide `vatRateFromLabel(label)` returning a *rate* only (for moms).
   - Provide `salesChannelFromAccount({ account, label })` returning `dine_in` | `takeaway` based on **account + platform keywords** (`wolt|foodora|uber\s*eats`, dedicated takeaway/delivery accounts like 3072) — **not** rate. Default revenue → `dine_in` when no takeaway signal.
2. **`voucher-to-aggregator.ts:250-256`** (live path) — replace the `classifyByVat(label)` subcategory tag with `salesChannelFromAccount(...)`. A 6%-moms revenue row with no platform/takeaway signal must land in `dine_in`, not `takeaway`.
3. **`resultatrapport-parser.ts:696`** — reverse the priority: account/label channel signal wins; VAT no longer overrides it. Delete the `vatHint` precedence for revenue/food_cost channel.
4. **`extract-worker/route.ts:811-816`** — same precedence fix. **And rewrite the system prompt (:387-393):** remove the instruction that "6% moms → takeaway"; instruct the model that since 2026-04-01 food goods are 6%, so 6% alone is NOT takeaway — takeaway is Wolt/Foodora/Uber or an explicit takeaway/delivery account.
5. **`personalkollen.ts:307-323`** — stop using the 6% VAT branch to set takeaway. Use the POS `is_take_away` flag (and product type) for channel; VAT only distinguishes food vs drink, not channel. Delete the "prefer VAT-rate over `is_take_away`" comment/logic.

## Step 3 — Re-derive affected periods (repair existing rows)

Fixing forward won't repair the wrong rows already written (e.g. Vero April).
- Identify affected `(business_id, period)` pairs: any revenue rows since 2026-04-01 that were tagged `takeaway` purely from a 6%-moms label with no platform/takeaway account.
- **Dry-run first:** produce a report of exactly what would move (per business/period, SEK moving from `takeaway_revenue` → `dine_in_revenue`) and show it for review **before** writing.
- On approval, re-run the existing apply/rollup path (do **not** hand-edit `tracker_data`/`tracker_line_items`) so the corrected classification flows through the same validated, idempotent pipeline.

## Step 4 — Tests & verification

- Unit: a 6%-moms food label dated ≥ 2026-04-01 with no platform signal classifies as `dine_in`; a Wolt/Foodora/Uber or 3072 row still classifies as `takeaway`; `vatRateFromLabel` still returns 6 for moms.
- Regression on Vero April: account 3053's 48,468 SEK moves out of `takeaway_revenue`; takeaway% drops 12.1% → ~7.8%.
- Confirm `momsrapport` (Box 12 / 0.06) is unchanged and still correct — route its literals through `lib/sweden/vat.ts` only if trivially safe; otherwise leave it (it's already correct) and note it.
- Confirm the supplier-invoice cost path numbers are unchanged.

## Open decision to confirm with Paul / the accountant (flag, don't guess)

Generic 6% food-goods revenue (account 3053 "Försäljning varor 6% moms") — should it sit in **dine_in** (this hotfix's default), or warrant a **new `food_goods` revenue bucket**? If a new bucket: that's a new enum value → DB CHECK + TypeScript same commit, and UI updates. Default to `dine_in` for the hotfix unless told otherwise.

## Hard constraints

- Feature branch + Vercel preview URL; **no prod deploy without review**.
- **Delete** the old VAT→channel logic — do not add new logic on top of it.
- Don't touch the supplier-invoice cost categorisation (unaffected).
- Re-derive is dry-run-reviewed before any write; idempotent; via the existing pipeline.
- Any new enum/CHECK value lands DB + TypeScript in one commit.
