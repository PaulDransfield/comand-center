# Phase 1 — Harden the categorization learning loop

> Source prompts: `phase-1-harden-learning-loop-prompt.md` + `specs-reality-reconciliation.md`
> Pre-flight diagnostic: `scripts/diag-phase1-prereq.mjs` (read-only, ran 2026-05-30)
> Status: PLAN. Step 0 investigation findings below. No code changes yet.

---

## 0. Step-0 findings (prereq investigation, all from live prod data)

### 0.1 Four prod-truth unknowns from `specs-reality-reconciliation.md` §6 — CLOSED

| # | Question | Answer |
|---|---|---|
| 1 | M097/M098/M100/M104 applied? | M097 ✅ (`pos_menu_items`, `pos_sales` — both empty). M098 ✅ (`fortnox_supplier_invoices` 1,760 rows + `fortnox_sync_state` 2 rows). M100 ✅ (`staff_shifts` 1,655 rows, `staff_profiles` 131, `staff_shift_templates` 28, `schedule_ai_suggestions` 40, `staff_performance_signals` 0). **M104 ✗ NOT applied** (`review_insights_cache` 404). `MIGRATIONS.md` is stale for M097/M098/M100 — update it. |
| 2 | `document_chunks.embedding` populated? | **No.** 0 / 5 rows have an embedding. No `embedding_provider` / `embedding_model` column. pgvector + ivfflat index exists but is unused. **Decision:** do NOT add a vector store for Phase 1. The existing in-context-examples approach in `inventory_review_outcomes` works without embeddings. Reuse pgvector only when retrieval becomes the bottleneck. |
| 3 | Fortnox `supplier` + `article` scopes pullable? | Scopes ARE granted at OAuth time (per `app/api/integrations/fortnox/route.ts:69-88` — `supplier` and `article` both in the scope list). **Live probe deferred** (FORTNOX_CLIENT_ID/SECRET not in `.env.production.local`; needs a TS-side test that uses `getFreshFortnoxAccessToken`). Not blocking Phase 1; will be tested by the `lib/fortnox/api/suppliers.ts` build in Phase 2. |
| 4 | `tracker_line_items` schema | **Resolved.** Columns: `id, org_id, business_id, tracker_data_id, period_year, period_month, label_sv, label_en, category, subcategory, amount, fortnox_account, source_upload_id, created_at`. 1,552 rows. 6 distinct `category` values (revenue, food_cost, staff_cost, other_cost, depreciation, financial). 22 distinct `subcategory` values (food, takeaway, alcohol, goods, rent, utilities, …). |

### 0.2 Learning-loop state (prereq Step 0)

**`product_aliases`** (1,736 rows total; sample of 1,000 visible):

| `match_method` | count (in sample) |
|---|---|
| `owner_confirmed`           | 941 |
| `fuzzy_same_supplier` (>0.80) | 55 |
| `fuzzy_cross_supplier` (>0.85) | 4 |
| (article_number / description_exact don't insert new aliases — they only match existing ones, so they don't show here) |  |

**Auto-match confidence distribution** (deeper query, all rows):

- Same-supplier (threshold 0.80): 13 in 0.80–0.85, 7 in 0.85–0.90, 4 in 0.90–0.95, **59 at ≥0.95**
- Cross-supplier (threshold 0.85): 1 in 0.85–0.90, 0 in 0.90–0.95, **5 at ≥0.95**
- Total auto-matches: ~89

**Punchline:** ~95% of `product_aliases` are owner-confirmed, ~5% are auto-matched. The "silent confident-wrong auto-link" risk surface (Deliverable 2 of the prompt) is **small today** — but the ratio will invert as the matcher learns and auto-rate climbs.

**`supplier_invoice_lines.match_status`** (1,000 visible):

| status | count |
|---|---|
| `matched`       | 810 |
| `not_inventory` | 108 |
| `needs_review`  | 82 |

**`inventory_review_outcomes`** (1,000 visible):

| owner_action | count |
|---|---|
| `create_new`        | 533 |
| `approve_existing`  | 326 |
| `skip_non_inventory` | 141 |

**AI-vs-owner agreement rate: 61.3%** (613 / 1,000). Moderate. Room to improve.

**`inventory_review_suggestions`** (cached, 1,000 visible):

| ai_action | count |
|---|---|
| `create_new`        | 721 |
| `approve_existing`  | 137 |
| `skip_non_inventory` | 136 |
| `review`            | 6   |

AI suggests `create_new` more often than owners do (721 vs 533) — model leans conservative ("I don't recognise this, make a new product"). Owners are more willing to merge into an existing product. Worth noting but not actionable here.

**Correction-pattern sanity** (testing the prompt's locked `corrections_against >= 2` demotion threshold):

- 776 distinct `(business_id, group_key)` tuples in outcomes
- 224 (28.9%) touched 2+ times
- **0 flip-flops** — when an owner revisits a group, they always choose the same action again
- 0 touched 3+ times (likely PostgREST 1,000-row cap effect, not a true ceiling)

**Threshold decision:** with **zero observed flip-flops**, the `corrections_against >= 2` demotion threshold is **safe** at current scale. The original concern ("two distracted clicks nuke a legit alias") is not supported by the data. **Keep the locked decision.**

**Per-alias usage distribution** (489 matched aliases, sampled):

| line-items per alias | count |
|---|---|
| 1   | 303 (62%) |
| 2-5 | 158 (32%) |
| 6-20 | 28 (6%) |
| 21+ | 0 |

No high-volume aliases exist yet at current scale. The Deliverable 2 risk-weighting toward "high-volume aliases" will have little to bite on today; weight should bias to **cross-supplier (Step 4) + recent** instead.

### 0.3 Source-of-truth files (read before changing)

| File | Role |
|---|---|
| `lib/inventory/matcher.ts:70-224` | 5-step ladder. Steps 3-4 are the auto-insert path. `createProductFromLine()` (~:415-498) handles owner-confirm. |
| `lib/inventory/matcher.ts:121-156` | The exact Step 1-2 SELECTs the matcher uses to find existing aliases — these are the read-paths that the new `is_active` filter must extend. |
| `lib/inventory/matcher.ts:284-294` | `getSupplierOverride` (M083) — the per-business `not_inventory` override, gate-0. New demotion logic stays orthogonal. |
| `lib/inventory/matcher.ts:295-300` | `touchAlias()` — calls `inventory_touch_alias(alias_id)` RPC to bump `last_seen_at` + `seen_count`. Phase 1 extends to set `last_applied_at` (rename, or add a second field). |
| `lib/inventory/normalise.ts` | **BEDROCK — do not touch.** Changing it corrupts the partial unique index on `product_aliases`. |
| `app/api/inventory/review/learn/route.ts` | Where owner approve/override decisions land in `inventory_review_outcomes`. The new demotion-signal path hooks here. |
| `app/api/inventory/review/ai-suggest/route.ts` | Where Haiku reads recent outcomes as in-context examples. Will need to also read `audit_sample` outcomes once Deliverable 2 lands. |
| `sql/M075-INVENTORY-CATALOGUE.sql:89-141` | `product_aliases` DDL — two partial unique indexes. New columns are pure ADD, no CHECK changes needed. |
| `sql/M099-INVENTORY-REVIEW-AI.sql` | `inventory_review_outcomes` DDL. New `context` column needs CHECK widening — same-commit DB + TypeScript. |

### 0.4 Things the data changes about the original prompt

- **Audit-sample risk weighting:** prompt says "high-value or high-volume". 0 aliases have ≥21 usages today. Re-weight to **(a) cross-supplier > same-supplier, (b) newer aliases first, (c) lines with high `total_excl_vat` over lines with high alias-usage-count**. Re-evaluate once auto-link volume grows.
- **Demotion threshold:** prompt locks at 2; the data supports this (0 flip-flops). Keep.
- **Decay window:** prompt says "haven't been applied in a long window". Need a concrete number — propose **90 days** for cross-supplier (Step 4) aliases. Re-evaluable later.
- **Accuracy snapshot frequency:** prompt says "daily". With ~1,000 outcomes total and modest velocity, daily is reasonable. Cron at 02:30 UTC (after the AI log retention sweep at 03:30 — keeps the order intuitive).
- **Audit-sample percentage:** prompt locks at 5%. At ~89 auto-matches total, that's ~4-5 items in the queue at any time. Tiny but appropriate for current scale; will scale with auto-match growth.

---

## 1. Plan summary

Three deliverables, additive only, **one feature branch per deliverable** (so each can be reviewed + reverted independently if needed).

| # | Deliverable | Schema cost | Code cost | Risk |
|---|---|---|---|---|
| 1 | Demotion & decay | 4 new nullable columns on `product_aliases`; one nightly cron | Matcher read-path + owner-correction write-path + nightly worker | Low — additive; demoted aliases stay queryable for audit |
| 2 | Audit of confident auto-links | Add `context` column on `inventory_review_outcomes` (widens CHECK in same commit); new "audit queue" view | New API route + queue page + sampler cron | Low — read-from-existing, no new pipeline |
| 3 | Accuracy snapshots | One new table `inventory_accuracy_snapshots` with RLS; daily cron | Compute job + simple internal view | Lowest — pure observability |

**Sequencing:** ship in order 1 → 2 → 3. Each builds on the previous. Total scope: ~2-3 days of focused work; ~600 LOC across all three.

---

## 2. Deliverable 1 — Demotion & decay

### 2.1 Schema (idempotent, additive)

`sql/M105-PRODUCT-ALIASES-DEMOTION.sql`:

```sql
BEGIN;

ALTER TABLE public.product_aliases
  ADD COLUMN IF NOT EXISTS is_active            BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS corrections_against  INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_applied_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_corrected_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deactivated_reason   TEXT,
  ADD COLUMN IF NOT EXISTS deactivated_at       TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'product_aliases_deactivated_reason_chk'
  ) THEN
    ALTER TABLE public.product_aliases
      ADD CONSTRAINT product_aliases_deactivated_reason_chk
      CHECK (
        deactivated_reason IS NULL
        OR deactivated_reason IN ('owner_override', 'corrections_threshold', 'decay_stale', 'manual_admin')
      );
  END IF;
END $$;

-- Partial index for the matcher's hot-path (Steps 1-2 SELECTs already filter
-- on supplier_fortnox_number etc. — adding is_active=true to the WHERE means
-- the existing partial uniques still apply; this index speeds up the
-- new common case).
CREATE INDEX IF NOT EXISTS product_aliases_active_lookup
  ON public.product_aliases (business_id, supplier_fortnox_number)
  WHERE is_active = TRUE;

-- Decay-sweep helper index for cross-supplier Step 4 aliases.
CREATE INDEX IF NOT EXISTS product_aliases_decay_candidates
  ON public.product_aliases (last_applied_at NULLS FIRST)
  WHERE is_active = TRUE AND match_method = 'fuzzy_cross_supplier';

COMMIT;
```

### 2.2 Matcher read-path change

`lib/inventory/matcher.ts:121-156` — Steps 1-2 SELECTs. Add `.eq('is_active', true)` to every SELECT that pulls candidate aliases. Same change inside `fetchTrigramCandidates` (via the `inventory_trigram_search` RPC — update the RPC body to filter `pa.is_active = true`).

`inventory_touch_alias` RPC — extend to also set `last_applied_at = NOW()`:

```sql
CREATE OR REPLACE FUNCTION public.inventory_touch_alias(p_alias_id UUID)
RETURNS VOID LANGUAGE sql AS $$
  UPDATE public.product_aliases
     SET last_seen_at     = NOW(),
         seen_count       = seen_count + 1,
         last_applied_at  = NOW()
   WHERE id = p_alias_id AND is_active = TRUE
$$;
```

(`WHERE is_active = TRUE` so a touch on a demoted alias is a no-op — belt-and-braces, since the matcher will have stopped returning demoted aliases first.)

### 2.3 Owner-correction write-path (the demotion signal)

Two existing paths fire when an owner corrects an auto-link:

- `app/api/inventory/review/learn/route.ts` — owner agrees/disagrees with an AI suggestion. When `agreed=false` AND the suggestion's `product_id` was an auto-linked alias, increment `corrections_against` + set `last_corrected_at` on THAT alias.
- `PATCH /api/inventory/lines/[id]` — owner directly edits a line (changes product, marks not_inventory). When the line had `product_alias_id != NULL` AND the new attribution differs, same increment.

Threshold check on increment (atomic via RPC):

```sql
CREATE OR REPLACE FUNCTION public.product_aliases_record_correction(
  p_alias_id UUID, p_threshold INTEGER DEFAULT 2
) RETURNS BOOLEAN
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
  was_owner_confirmed BOOLEAN;
BEGIN
  UPDATE public.product_aliases
     SET corrections_against = corrections_against + 1,
         last_corrected_at   = NOW()
   WHERE id = p_alias_id
   RETURNING corrections_against, (match_method = 'owner_confirmed')
        INTO new_count, was_owner_confirmed;

  IF new_count IS NULL THEN RETURN FALSE; END IF;

  -- owner_confirmed aliases require the owner's own re-correction.
  -- Since same business + same owner, no special branching needed —
  -- threshold = 2 still applies. The protection is that owner_confirmed
  -- starts at 0 and only owner actions increment it.
  IF new_count >= p_threshold THEN
    UPDATE public.product_aliases
       SET is_active           = FALSE,
           deactivated_reason  = 'corrections_threshold',
           deactivated_at      = NOW()
     WHERE id = p_alias_id AND is_active = TRUE;
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END $$;
```

Named constant in app code:

```ts
// lib/inventory/demotion.ts
export const DEMOTION_THRESHOLD = 2
export const DECAY_DAYS_CROSS_SUPPLIER = 90
```

### 2.4 Decay (nightly cron, flag-only)

`app/api/cron/inventory-alias-decay/route.ts` — runs daily at 03:00 UTC (between the existing `recategorise-other` at 03:45 and `ai-log-retention` at 03:30). NOT a deactivator — it surfaces cross-supplier aliases that haven't been applied in 90 days as "stale, needs re-confirm" via a status field on the audit queue from Deliverable 2.

Pseudocode:

```ts
// SELECT id FROM product_aliases
//  WHERE is_active = TRUE
//    AND match_method = 'fuzzy_cross_supplier'
//    AND (last_applied_at IS NULL OR last_applied_at < NOW() - INTERVAL '90 days')
//
// For each → insert into inventory_audit_queue (Deliverable 2) with
// `reason='decay_stale'`. Idempotent — UNIQUE(business_id, alias_id, reason).
```

Hard rule: never deactivates on its own. Only the owner-correction threshold deactivates.

### 2.5 Files touched

- `sql/M105-PRODUCT-ALIASES-DEMOTION.sql` (NEW, ~30 lines)
- `lib/inventory/matcher.ts` — Steps 1-2 + `fetchTrigramCandidates` (~10 lines)
- RPC `inventory_touch_alias` (extend in M105 or a tiny M105b — 5 lines)
- RPC `product_aliases_record_correction` (NEW in M105, ~25 lines)
- `lib/inventory/demotion.ts` (NEW, ~10 lines — named constants)
- `app/api/inventory/review/learn/route.ts` — call the new RPC on `agreed=false` (~15 lines)
- `app/api/inventory/lines/[id]/route.ts` PATCH — call the new RPC on alias change (~15 lines)
- `app/api/cron/inventory-alias-decay/route.ts` (NEW, ~60 lines)
- `vercel.json` — add cron entry
- `scripts/test-demotion.mjs` (NEW, ~80 lines — assertion script per the VAT-fix pattern)

Total: ~250 LOC + 1 migration. ~1 day.

---

## 2b. Owner refinements folded in 2026-05-30 (post-D1 review)

D1 verified end-to-end on Chicce Jameson alias 23581bb9-… (see commit
`73767d8`). Owner review surfaced two adjustments for D2.

### 2b.1 Durable demotion history (REQUIRED before D2 ships)

The current D1 re-activation branch in `lib/inventory/matcher.ts::insertAlias`
resets `corrections_against = 0` and clears `deactivated_reason` /
`deactivated_at`. That preserves the alias row's lineage but **erases the
flip-flop signal** — once re-activated, "what aliases have been demoted
and why" queries no longer find it. A demote→reactivate→demote cycle looks
pristine each time.

The Step-0 diagnostic found 0 flip-flops at current scale (so D1 is safe
to ship as-is), but this design will make us blind to thrash exactly when
the matcher's auto-link share grows.

**Fix folded into D2 (M106):**

```sql
ALTER TABLE public.product_aliases
  ADD COLUMN IF NOT EXISTS times_demoted    INTEGER     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_demoted_at  TIMESTAMPTZ;
```

- `times_demoted` is **monotonic** — never reset, even on re-activation.
- `last_demoted_at` snapshots the most recent deactivation timestamp;
  survives re-activation as a historical reference.
- `product_aliases_record_correction` RPC extended to bump
  `times_demoted++` and set `last_demoted_at` at the moment of
  deactivation (the threshold-crossing path inside the RPC).
- `insertAlias` re-activation branch in `matcher.ts` continues to reset
  the WORKING counters (`corrections_against`, `deactivated_reason`,
  `deactivated_at`) but **never touches `times_demoted` /
  `last_demoted_at`** — those are the durable history.

Reporting query becomes:

```sql
SELECT id, raw_description, supplier_name_snapshot,
       is_active, times_demoted, last_demoted_at,
       corrections_against, deactivated_reason
  FROM product_aliases
 WHERE times_demoted > 0
 ORDER BY times_demoted DESC, last_demoted_at DESC;
```

This catches both currently-demoted and previously-demoted-but-reactivated
aliases — the thrash-detection signal the owner asked for.

### 2b.2 Adaptive audit sample rate (LOCKED, from §7.3)

Already specified above in §7.3 — restating here so it's visible alongside
the D2 work that consumes it:

```ts
// lib/inventory/audit-sampler.ts
function targetSampleRate(autoLinksInWindow: number): number {
  if (autoLinksInWindow <= 20)  return 1.00   // audit everything
  if (autoLinksInWindow <= 50)  return 0.50
  if (autoLinksInWindow <= 200) return 0.20
  return 0.05                                  // steady-state target
}
```

At today's ~89 total auto-matches with a 7-day recent window of maybe
5-15 items → 100% sample → queue useful from day one.

### 2b.3 D2 risk ordering (UPDATED with previously-demoted)

Risk-weighted from highest priority (most likely to be wrong) to lowest:

1. **cross-supplier** (Step 4 trigram, threshold 0.85) — confidence floor
   is lower than same-supplier; cross-supplier merges are the most
   speculative.
2. **previously-demoted** (`times_demoted > 0`) — this alias has been
   wrong before. Even if re-activated, it deserves elevated scrutiny.
   **NEW** in the ordering per owner guidance 2026-05-30.
3. **same-supplier** (Step 3 trigram, threshold 0.80) — high-volume
   auto-match path; mostly OK but the long tail bites.
4. **recent** (created within the last 7 days) — newer aliases have less
   real-world validation; prioritise.
5. **high-line-value** (line.total_excl_vat) — a wrong alias on a 50,000 kr
   line is worse than on a 14 kr line. Tiebreaker.
6. **(disabled today)** high-alias-usage — re-enable when any alias
   crosses `USAGE_WEIGHT_ACTIVATION_THRESHOLD` (20 usages). See
   `lib/inventory/demotion.ts`.

### 2b.4 D2 checkpoint (gate before D3) — PASSED 2026-05-30

Per owner 2026-05-30: "see the sampler actually surface a risk-weighted
batch on live data — with cross-supplier and previously-demoted aliases
ranked to the top — before D3's snapshot layers on."

Also per owner: "confirm that a confirm/correct in the UI actually
writes the audit outcome and it reads back into the ai-suggest
context. That round-trip is the real proof D2 works."

**Sampler checkpoint (verify-audit-sampler.mjs --local-run, executed 2026-05-30):**
- Chicce Slotsgatan: 89 fuzzy auto-match candidates → 20% adaptive
  rate → 18 sampled → 18 upserted into queue
- Top 6 by risk_score (all 10,021–10,036): cross-supplier
- Ranks 7–18 (risk 136–158): same-supplier
- Tier gap factor: ~63×. No bleed-through between cross and same tiers.
- Previously-demoted: 0 surfaced. Acceptable — the only demoted alias
  (Jameson) predates M106's extended RPC and is `is_active=FALSE`
  (filtered out of eligibility). Will validate naturally on first
  real demote-and-reactivate; failure mode is benign (missed risk bump,
  not a data error).

**Round-trip checkpoint (verify-audit-roundtrip.mjs --run, executed 2026-05-30):**
- Picked top queue item (Chiarlo Le Orme Barbera d'Asti,
  fuzzy_cross_supplier, score 10036)
- Replicated `confirm` action endpoint logic →
  `inventory_review_outcomes` row inserted with `context='audit_sample'`,
  `agreed=true`, `owner_action='approve_existing'`
- Marked queue row `reviewed_at=NOW, reviewer_decision='confirm'`
- Re-ran the SAME outcome-loading SELECTs that
  `lib/inventory/ai-suggest-core.ts` uses
- Before: 0 audit_sample outcomes in the 60-day window. After: 1.
- Generated learning text contains `[AUDIT — confirmed correct]` tag
  exactly as the production prompt builder produces.

**D2-done. UI + API + sampler + round-trip + tests + verify scripts all
landed on `learning-loop-phase1-2-audit`. Merging next.**

### 2b.5 Mental note (NOT for chasing now — log only)

The D1 verification surfaced an `Avtalsrabatt JAMESON 40%` line as a
demote candidate. That's a **contract-rebate, not a product** — it should
arguably not have entered the catalogue at all. Gate 0 (the
"is-this-inventory" check in `matcher.ts:74-109`) is occasionally letting
discount/rebate lines through. The D3 accuracy snapshot is the right
place to surface this as noise (rebate-pattern detection bumping
`needs_review` rate). **Not a D2 task; logged for the categorisation
quality pass later.**

---

## 3. Deliverable 2 — Audit of confident auto-links

### 3.1 Schema

`sql/M106-INVENTORY-AUDIT-QUEUE.sql`:

```sql
BEGIN;

-- Add a context discriminator on the outcomes table so audit outcomes are
-- distinguishable from needs_review outcomes when fed back to the AI.
ALTER TABLE public.inventory_review_outcomes
  ADD COLUMN IF NOT EXISTS context TEXT NOT NULL DEFAULT 'needs_review';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_review_outcomes_context_chk'
  ) THEN
    ALTER TABLE public.inventory_review_outcomes
      ADD CONSTRAINT inventory_review_outcomes_context_chk
      CHECK (context IN ('needs_review', 'audit_sample'));
  END IF;
END $$;

-- Lightweight queue table for spot-check candidates.
CREATE TABLE IF NOT EXISTS public.inventory_audit_queue (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id    UUID NOT NULL REFERENCES businesses(id)    ON DELETE CASCADE,
  alias_id       UUID NOT NULL REFERENCES product_aliases(id) ON DELETE CASCADE,
  line_id        UUID REFERENCES supplier_invoice_lines(id) ON DELETE SET NULL,
  reason         TEXT NOT NULL CHECK (reason IN ('confident_auto_match', 'decay_stale', 'manual_review')),
  sampled_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at    TIMESTAMPTZ,
  reviewer_decision TEXT CHECK (reviewer_decision IN ('confirm', 'correct', 'skip')),
  UNIQUE (business_id, alias_id, reason)
);

CREATE INDEX IF NOT EXISTS inventory_audit_queue_pending
  ON public.inventory_audit_queue (business_id, sampled_at DESC)
  WHERE reviewed_at IS NULL;

ALTER TABLE public.inventory_audit_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inventory_audit_queue_org ON public.inventory_audit_queue;
CREATE POLICY inventory_audit_queue_org ON public.inventory_audit_queue
  FOR ALL USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK         (org_id = ANY(current_user_org_ids()));

COMMIT;
```

### 3.2 Sampler cron

`app/api/cron/inventory-audit-sampler/route.ts` — runs daily at 03:15 UTC. For each business:

1. Find recently-created `fuzzy_*` aliases (`created_at > NOW() - INTERVAL '7 days'`).
2. Risk-weight: cross-supplier 3×, same-supplier 1×; multiply by line `total_excl_vat` (the highest-value line that uses the alias).
3. Random-sample 5% (`SAMPLE_PERCENT = 0.05` constant) weighted by risk.
4. Insert into `inventory_audit_queue` with `reason='confident_auto_match'`. Idempotent via the UNIQUE(business_id, alias_id, reason).

### 3.3 UI surface

`app/inventory/audit/page.tsx` — parallels `/inventory/review/page.tsx`. List of queue items per business: alias + linked product + raw_description + supplier + similarity score. Three buttons: **Confirm** / **Correct** / **Skip**.

On Confirm:
- Mark queue row `reviewed_at = NOW(), reviewer_decision = 'confirm'`
- Optionally: bump `match_confidence` slightly to mark "audited-good" — defer to v2

On Correct:
- Mark queue row reviewed
- Call `product_aliases_record_correction(alias_id, threshold=1)` — single audit-time correction is enough to demote because the auditor is explicitly reviewing
- Write a row to `inventory_review_outcomes` with `context='audit_sample'`, `owner_action='approve_existing'` (the new correct one), `agreed=false`

On Skip:
- Mark queue row reviewed with `reviewer_decision='skip'`
- No demotion, no outcome row (just a "looked at it, deferred")

### 3.4 AI feed-back

`app/api/inventory/review/ai-suggest/route.ts` currently pulls recent `inventory_review_outcomes` as in-context examples. Extend to also include `context='audit_sample'` outcomes (with a label "Recent audit corrections"). Same `agreed=false` rows weighted similarly.

### 3.5 Files touched

- `sql/M106-INVENTORY-AUDIT-QUEUE.sql` (NEW, ~40 lines)
- `app/api/cron/inventory-audit-sampler/route.ts` (NEW, ~100 lines)
- `app/inventory/audit/page.tsx` (NEW, ~150 lines)
- `app/api/inventory/audit/[id]/route.ts` (NEW, ~80 lines — confirm/correct/skip)
- `app/api/inventory/review/ai-suggest/route.ts` — extend in-context examples (~20 lines)
- `vercel.json` — add cron entry
- `lib/inventory/audit-sampler.ts` (NEW, ~60 lines — sampling logic, testable)
- `scripts/test-audit-sampler.mjs` (NEW, ~50 lines)
- `lib/nav/areas.ts` — add `/inventory/audit` to the inventory nav

Total: ~500 LOC + 1 migration. ~1 day.

---

## 4. Deliverable 3 — Accuracy snapshots

### 4.1 Schema

`sql/M107-INVENTORY-ACCURACY-SNAPSHOTS.sql`:

```sql
BEGIN;

CREATE TABLE IF NOT EXISTS public.inventory_accuracy_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  business_id     UUID REFERENCES businesses(id) ON DELETE CASCADE,    -- NULL = global
  snapshot_date   DATE NOT NULL DEFAULT CURRENT_DATE,
  window_days     INTEGER NOT NULL DEFAULT 30,

  -- Audit-sample precision: confirmations / (confirmations + corrections)
  audit_confirmations  INTEGER NOT NULL DEFAULT 0,
  audit_corrections    INTEGER NOT NULL DEFAULT 0,

  -- AI-suggestion agreement rate: agreed=true / total outcomes
  ai_agreed_total      INTEGER NOT NULL DEFAULT 0,
  ai_total_outcomes    INTEGER NOT NULL DEFAULT 0,

  -- needs_review rate: needs_review / all match_status (over window)
  needs_review_count   INTEGER NOT NULL DEFAULT 0,
  total_lines_count    INTEGER NOT NULL DEFAULT 0,

  -- demotion rate: aliases deactivated / aliases active at window-start
  demotions_in_window  INTEGER NOT NULL DEFAULT 0,
  active_aliases_start INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (org_id, business_id, snapshot_date, window_days)
);

CREATE INDEX IF NOT EXISTS inv_accuracy_snapshots_org_date
  ON public.inventory_accuracy_snapshots (org_id, business_id, snapshot_date DESC);

ALTER TABLE public.inventory_accuracy_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS inv_accuracy_snapshots_org ON public.inventory_accuracy_snapshots;
CREATE POLICY inv_accuracy_snapshots_org ON public.inventory_accuracy_snapshots
  FOR ALL USING      (org_id = ANY(current_user_org_ids()))
  WITH CHECK         (org_id = ANY(current_user_org_ids()));

COMMIT;
```

### 4.2 Daily computation

`app/api/cron/inventory-accuracy-snapshot/route.ts` — runs daily at 02:30 UTC (before audit sampler at 03:15 so today's numbers are stable when sampling decisions are made). For each business + a global row:

```
window = NOW() - 30 days

audit_confirmations  = COUNT(*) WHERE context='audit_sample' AND reviewer_decision='confirm'
audit_corrections    = COUNT(*) WHERE context='audit_sample' AND reviewer_decision='correct'
ai_agreed_total      = COUNT(*) WHERE created_at >= window AND agreed = TRUE
ai_total_outcomes    = COUNT(*) WHERE created_at >= window
needs_review_count   = COUNT(*) FROM supplier_invoice_lines WHERE created_at >= window AND match_status='needs_review'
total_lines_count    = COUNT(*) FROM supplier_invoice_lines WHERE created_at >= window
demotions_in_window  = COUNT(*) FROM product_aliases WHERE deactivated_at >= window
active_aliases_start = COUNT(*) FROM product_aliases WHERE is_active = TRUE  (as snapshot at window start — easiest: subtract demotions_in_window from current active count)
```

UPSERT into the table.

### 4.3 Internal surface

`app/admin/v2/inventory-accuracy/page.tsx` — simple table view per business + global. Sparkline per metric over last 90 days. Admin-only.

Derived metrics shown:
- **Auto-link precision** = `audit_confirmations / (audit_confirmations + audit_corrections)`
- **AI agreement rate** = `ai_agreed_total / ai_total_outcomes`
- **Needs-review rate** = `needs_review_count / total_lines_count`
- **Demotion rate** = `demotions_in_window / active_aliases_start`

### 4.4 Files touched

- `sql/M107-INVENTORY-ACCURACY-SNAPSHOTS.sql` (NEW, ~40 lines)
- `app/api/cron/inventory-accuracy-snapshot/route.ts` (NEW, ~100 lines)
- `lib/inventory/accuracy.ts` (NEW, ~80 lines — compute helpers, unit-testable)
- `app/admin/v2/inventory-accuracy/page.tsx` (NEW, ~120 lines)
- `vercel.json` — add cron entry
- `scripts/test-accuracy-compute.mjs` (NEW, ~50 lines)

Total: ~390 LOC + 1 migration. ~½ day.

---

## 5. Rollout

| Step | Action | Owner |
|---|---|---|
| 1 | ✅ Create feature branch `learning-loop-phase1-1-demotion` | done |
| 2 | Land M105 in Supabase (paste `sql/M105-PRODUCT-ALIASES-DEMOTION.sql` into SQL Editor — single transaction; the verification SELECTs at the end print the post-state) | owner |
| 3 | Verify M105 with the read-only scenario inspector: `node scripts/verify-demotion-end-to-end.mjs` (no flag = inspect mode; picks a low-risk candidate alias and prints what would change) | owner |
| 4 | Run the end-to-end demonstration: `node scripts/verify-demotion-end-to-end.mjs --apply --business <uuid> --alias <uuid>` (uses the candidate from step 3; types `DEMOTE` to confirm; demotes ONE alias and re-routes ONE line back to needs_review) | owner |
| 5 | After step 4 succeeds: open `/inventory/review` and confirm the demoted alias's line is back in the queue. The matcher will NOT re-link it because the alias is `is_active=FALSE`. | owner |
| 6 | Merge feature branch to main once steps 2-5 pass. Monitor `product_aliases.is_active=FALSE` count for 7 days post-merge. | dev |
| 7 | Repeat for D2 (M106 + audit sampler + UI) | — |
| 8 | Repeat for D3 (M107 + snapshot cron + admin view) | — |

**Code already on branch (this commit):**
- `sql/M105-PRODUCT-ALIASES-DEMOTION.sql` — schema + 3 RPCs (additive, idempotent)
- `lib/inventory/matcher.ts` — Steps 1+2 filter on `is_active=true`; `insertAlias` re-activates demoted rows on re-target
- `lib/inventory/demotion.ts` — named constants (`DEMOTION_THRESHOLD=2`, `DEMOTION_THRESHOLD_AUDIT=1`, `DECAY_DAYS_CROSS_SUPPLIER=90`, `USAGE_WEIGHT_ACTIVATION_THRESHOLD=20`)
- `app/api/inventory/lines/[id]/correct-attribution/route.ts` (NEW) — the demotion-signal hook
- `scripts/test-demotion.mjs` — 25 assertion tests, all pass
- `scripts/verify-demotion-end-to-end.mjs` — read-only inspector + gated `--apply` for the owner checkpoint

**No prod deploy without preview review.** Stop hook auto-pushes to this branch; do NOT auto-merge to main.

### 5b. End-to-end demonstration script — what owner sees

```
$ node scripts/verify-demotion-end-to-end.mjs

════════════════════════════════════════════════════════════════════════════
  MODE: inspect
════════════════════════════════════════════════════════════════════════════
Picked candidate alias:
  id:                <uuid>
  business_id:       <vero or chicce uuid>
  product_id:        <uuid>
  raw_description:   "<the row's invoice text>"
  supplier:          <supplier name>
  match_method:      fuzzy_same_supplier  confidence: 0.83
  line refs:         2

[…shows current is_active=true, lines matched to it…]

INSPECT mode — done. Re-run with --simulate to dry-run the RPC, or --apply to execute.
To apply on this specific alias:
  node scripts/verify-demotion-end-to-end.mjs --apply --business <uuid> --alias <uuid>
```

Then run with `--apply` (with the printed `--business` and `--alias`).
The script prints the before-state, asks for `DEMOTE` confirmation, calls
the RPC, flips the line, prints the after-state, and proves the matcher
would now skip the alias. Total time: ~10 seconds.

## 6. Verification

Per the prompt's three verification points + a few additions from the data:

| Verification | How |
|---|---|
| Owner correction increments `corrections_against`; threshold 2 deactivates | `scripts/test-demotion.mjs` + manual on Vero — find any owner_confirmed alias, simulate two corrections via the learn endpoint, confirm `is_active=FALSE` |
| Matcher stops returning deactivated aliases | After demotion: re-run the matcher on the same line (POST to `/api/inventory/lines/[id]/rematch`) and confirm it falls through to needs_review or a different alias |
| Audit queue surfaces ~5% of recent confident auto-links, risk-weighted | After sampler cron runs once, queue should have ~5% of the past 7 days' `fuzzy_*` insertions. With ~89 auto-matches total → expect 4-5 in the queue at any time |
| Accuracy snapshot computes against known outcomes + persists daily row | After cron runs, query `inventory_accuracy_snapshots` for today's row per business + global |
| Existing correct matches unaffected | Baseline `supplier_invoice_lines.match_status` distribution (810/108/82) should be unchanged in the day-1 delta after D1 ships |

## 7. Owner decisions (LOCKED 2026-05-30)

### 7.1 Agreement-rate monitor — relative-first, absolute backstop

The primary regression signal is **relative** (drop from trailing-30-day
baseline), not absolute. Reason: a drop 61% → 52% is a real regression but
clears the 50% absolute floor.

- **Soft alert:** agreement drops **≥5pp** below the trailing-30-day rate
- **Hard alert:** drops **≥10pp** below
- **Absolute backstop:** soft <55% / hard <50% (these are the original
  numbers — kept as the floor)
- **Minimum sample guard:** don't fire either signal on **<50 new outcomes**
  in the window (noise otherwise)
- **Framing:** post-deploy keep/rollback monitor, NOT a pre-ship gate.
  A classifier change ships to preview, accrues outcomes, then rolls back
  if the relative or absolute thresholds trip.
- **Don't anchor on 61.3% as "overall accuracy".** It's measured on the
  residual hard cases that already fell through the deterministic matcher
  (Steps 1-2 of the ladder). Real overall accuracy on the full ladder is
  much higher — 61.3% is the AI's hit-rate on what's *left* after the
  exact-match path.

This lives in Deliverable 3's snapshot job and surfaces as a soft/hard
warning row in the admin metrics view.

### 7.2 Surface = admin-only

Confirmed. Accuracy metrics describe **our model's performance**, not the
owner's business. "Our AI is 61% accurate" is easy to misread and quietly
becomes an implied promise.

The owner-facing version comes later as a separate, reframed surface:
**"X% of your invoices auto-sorted, Y waiting on you"** — that's about
the owner's workload and progress, not our precision. **Don't conflate
the two.** Build the workload-progress surface as its own thing when
prioritised.

### 7.3 Audit sampling — adaptive rate + flagged usage-weight reintro

Confirmed: cross-supplier > same-supplier > recent > high-line-value;
drop high-alias-usage from the weighting today (0 aliases have ≥21
usages).

**Adaptive sample rate** (replaces the prompt's flat 5%):

```ts
// lib/inventory/audit-sampler.ts
function targetSampleRate(autoLinksInWindow: number): number {
  if (autoLinksInWindow <= 20)  return 1.00   // audit everything
  if (autoLinksInWindow <= 50)  return 0.50
  if (autoLinksInWindow <= 200) return 0.20
  return 0.05                                  // steady-state target
}
```

At today's ~89 total auto-matches, the recent-7d window has maybe 5-15
items → 100% sample → useful audit data accumulates fast. Tapering kicks
in once the matcher learns and auto-link volume grows.

**Forward-compat flag (NOT in D2 v1):** once any alias crosses ~20 usages,
reintroduce high-usage weighting (a wrong alias applied 50× is
high-impact). Add a TODO + constant in `lib/inventory/audit-sampler.ts`
so the trigger is obvious when the data warrants. Re-evaluate quarterly.

### 7.4 RPC naming

`inventory_touch_alias` keeps its name. Adding `last_applied_at` alongside
`last_seen_at` is a semantic addition, not a rename. Call sites stay clear.

---

## 7b. Carry-forwards from the findings (not blocking)

1. **AI leans `create_new` (721) over `approve_existing` (137).** Model
   spawns duplicate products rather than recognising existing ones. The
   accuracy snapshot will track this. **Strong Phase 3 candidate:** give
   the model better existing-product context in its in-context prompt
   (retrieval improvement) so it merges more. Not a Phase 1 deliverable.

2. **Auto-links are only 5% of aliases today.** Therefore D1 (demotion)
   and D3 (accuracy baseline) are the **real near-term value**. D2 (audit)
   is **cheap insurance** for when the matcher's share grows. The 1→2→3
   order stands, but **don't over-invest in D2 tuning** until auto-link
   volume warrants it.

3. **Decay (originally part of D1) deferred to D2.** D1 lands `last_applied_at`
   on `product_aliases` (the data needed for decay detection). D2 adds
   the audit queue and the decay-sweep cron that surfaces stale
   cross-supplier aliases as "needs re-confirm". D1 ships strictly the
   demotion mechanism — simpler scope, faster ship.

4. **D1's demotion signal is narrowed.** Only PATCH /api/inventory/lines/[id]
   (direct alias_id change) increments `corrections_against`. The
   AI-rejection demotion path (from `inventory_review_outcomes.agreed=false`)
   is deferred to D2, when the audit queue gives us a cleaner signal.
   Rationale: the AI-rejection-to-alias linkage is indirect (ai_product_id
   is a product, not an alias; a product can have multiple aliases —
   demoting the right one requires more state than we have today).

## 8. Out of scope (separate plans)

- **`MIGRATIONS.md` staleness correction** — M097/M098/M100 are applied but marked pending. Mention in same PR as M105, or do as a doc-only PR before. Suggest doc PR first (5 min change).
- **Live Fortnox `/suppliers` + `/articles` probe** — Phase 2 work per the reconciliation. Will require the FORTNOX_CLIENT_ID/SECRET to be available where the diagnostic runs.
- **`document_chunks.embedding` population decision** — defer until retrieval becomes a bottleneck.
- **Phase 2 of the VAT fix** (per-business `revenue_account_mapping`) — independent; same Phase 2 timing as the supplier master.

---

*End of plan. Pre-flight diagnostic at `scripts/diag-phase1-prereq.mjs` (read-only). Awaiting owner go-ahead to start Deliverable 1.*
