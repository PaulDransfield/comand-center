# Claude Code — Phase 1: Harden the Categorization Learning Loop

## Purpose

The categorization learning loop already exists (`product_aliases` + the 5-step matcher + `inventory_review_outcomes`). It only ever **adds** knowledge — nothing pulls a wrong rule back, nothing checks the confident auto-matches, and there's no metric to tell if accuracy is improving or regressing. This phase adds the three missing halves, all on the shipped infrastructure. **No new pipeline; extend what's there.**

This is a code + schema change on a **live, paying system.** Investigation-first, feature branch + Vercel preview, **no prod deploy without review.** Provide all SQL formatted for the Supabase SQL Editor (per CLAUDE.md §3), idempotent (`IF NOT EXISTS`).

## What already exists (read it before changing it)

- `lib/inventory/matcher.ts` — the 5-step ladder. Steps 3 (trigram >0.80 same supplier) and 4 (trigram >0.85 cross-supplier) **auto-link and insert a `product_aliases` row with no human check.** `createProductFromLine()` (~:415-498) writes owner-confirmed aliases (`match_method='owner_confirmed'`, `match_confidence=NULL`).
- `product_aliases` (M075) — two **partial** unique indexes; writes use **SELECT-then-INSERT with 23505 retry**, never `.upsert`. Carries `match_method`, `match_confidence`.
- `inventory_review_outcomes` (M099) — records `(ai_action, ai_confidence, owner_action, agreed)`; already fed back as in-context examples to `/api/inventory/review/ai-suggest`.
- `supplier_invoice_lines.match_status` (`needs_review` / `not_inventory` / matched) + `product_alias_id`; owner edits tag `source='owner_correction'`.
- Review surfaces: `/inventory/review`, `/api/inventory/needs-review`, `/api/inventory/review/ai-suggest`, `/api/inventory/review/learn`.
- `lib/inventory/normalise.ts` is **bedrock** — do not change it (it would corrupt the alias unique index without a re-normalization migration).

## Step 0 — Investigate, then plan

Before editing, confirm and write a short plan covering: the exact current columns/CHECKs on `product_aliases`, `inventory_review_outcomes`, and the `match_status` / `match_method` value sets; where the matcher reads aliases (the exact SELECT in Steps 1-2); and where owner corrections currently land. Flag anything that contradicts the assumptions below.

## Deliverable 1 — Demotion & decay

Today a wrong alias lives forever. Add the pull-back.

- **Schema (additive to `product_aliases`):** `is_active boolean DEFAULT true`, `corrections_against int DEFAULT 0`, `last_applied_at timestamptz`, `last_corrected_at timestamptz`. All nullable/defaulted — backward compatible.
- **Matcher read path:** Steps 1-4 must only match `is_active = true` aliases. A demoted alias is skipped, so the line falls through to a better alias or to `needs_review`. **Never hard-delete** an alias — deactivate (keep the row for audit/history).
- **Demotion signal:** when an owner overrides an auto-linked line (re-sorts it to a different product, or marks the supplier/line `not_inventory`), increment `corrections_against` on the alias that produced the wrong link and set `last_corrected_at`. A rejected AI suggestion (`inventory_review_outcomes.agreed = false`) is the same signal.
- **Demotion threshold:** deactivate the alias when `corrections_against >= 2` (locked decision). An `owner_confirmed` alias requires the owner's own re-correction to deactivate (same business, so this is automatic) — don't let a single stray click nuke a confirmed rule.
- **Decay (gentle, flag — never auto-delete):** a nightly/weekly job flags **cross-supplier (Step 4) auto-aliases** that haven't been applied in a long window (`last_applied_at` stale) or were never corroborated, surfacing them for re-confirmation rather than trusting them indefinitely. Decay lowers standing to "needs re-confirm," it does not deactivate on its own.

## Deliverable 2 — Audit of confident auto-links

The trigram auto-links (Steps 3-4) are the silent risk: a confident-wrong match is invisible today.

- **Sampling policy:** surface ~**5%** (locked decision) of recent confident auto-links into a lightweight spot-check queue. **Bias the sample toward risk:** cross-supplier (0.85) over same-supplier (0.80); newer aliases; aliases applied to high-value or high-volume lines.
- **Surface:** reuse the existing review UI pattern — a "Spot-check these auto-matches" queue parallel to `needs_review` (don't build a new design language; consume `UXP.*` / `Z.*` tokens). One-tap confirm / correct.
- **Outcomes feed the loop:** write audit results to `inventory_review_outcomes` (add a `context`/`source` discriminator if one isn't present — `'audit_sample'` vs `'needs_review'`; new enum value → DB CHECK + TypeScript in the **same commit**). A confirm promotes (raises confidence / marks audited-good); a correction feeds Deliverable 1's demotion.

## Deliverable 3 — Accuracy measurement

So tuning and rollback are evidence-based, not vibes.

- **Metrics (per business + global, rolling window):** auto-link precision (from audit-sample confirmations vs corrections), AI-suggestion agreement rate (`inventory_review_outcomes.agreed`), `needs_review` rate, demotion rate.
- **Storage:** a small `inventory_accuracy_snapshots` table (RLS via `org_id = ANY(current_user_org_ids())`) written by a daily job, so trends are visible and a regression after any change is detectable. Compute-on-read from existing tables where cheap; snapshot the rest.
- **Surface:** a simple internal metrics view (owner-facing summary can come later) — the point now is that *you* can see the numbers move.

## Ride-along — close the four prod-truth unknowns (READ-ONLY)

While you're in prod, answer these (SELECT/catalog only, print the queries) and add to the plan doc — they gate Phases 2-3:
1. Are migrations **M097 / M098 / M100 / M104 actually applied?** (`pg_tables WHERE tablename IN ('pos_sales','fortnox_supplier_invoices',...)`)
2. Is **`document_chunks.embedding` populated**, and by which provider?
3. Are the Fortnox **`supplier` and `article` scopes** actually pullable with current grants?
4. The **`tracker_line_items` schema** (`\d+ tracker_line_items`).

## Hard rules & reuse

- Feature branch + Vercel preview; **no prod deploy without review.**
- Additive schema only; idempotent; any new enum/CHECK value lands **DB + TypeScript in one commit** (`feedback_check_constraint_drift`).
- New writers to `product_aliases` use **SELECT-then-INSERT**, not `.upsert` (partial uniques).
- Do **not** touch `normalise.ts`. Do **not** hard-delete aliases. Demotion/decay must be conservative (deactivate/flag).
- RLS `current_user_org_ids()` on any new table; model strings only from `lib/ai/models.ts`; new AI calls via direct `fetch()` (SDK 0.24 drops cache headers).
- Thresholds (`corrections_against >= 2`, 5% audit sample, decay window) as named constants, not magic numbers.

## Verification

- An owner correcting an auto-linked line increments `corrections_against`; at the threshold the alias deactivates and the matcher stops returning it (re-run the same line → falls to review or a better alias).
- The audit queue surfaces ~5% of recent confident auto-links, risk-weighted; outcomes land in `inventory_review_outcomes`.
- The accuracy snapshot computes against known outcomes and persists a daily row.
- Existing correct matches are unaffected; no regression in the 5-step ladder for already-good links.
