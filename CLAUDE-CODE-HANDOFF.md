# CLAUDE CODE HANDOFF — CommandCenter remediation, Sprint 1
> Generated 2026-04-26 from an external code review.
> Companion document: `REVIEW.md` (read this first — it's why we're here).

---

## Context for you (Claude Code)

You are working on **CommandCenter**, a Next.js 14 + Supabase + Anthropic + Stripe SaaS for Swedish restaurants. Two paying customers run on it (Vero, Rosali). Owner-operator is Paul. The codebase recently completed a Tier-2 rebuild of the Fortnox financial extraction pipeline (single writer, single sign convention, deterministic Resultatrapport parser). An external review has identified critical bugs and security gaps that need to be fixed before the next customer onboards.

Your job: work through the tasks below **in order**, one task per commit, updating `FIXES.md` as you go. Do not skip ahead. Do not refactor adjacent code unless the task says so.

---

## Pre-flight — do these before writing any code

1. Read `CLAUDE.md` end-to-end. Honour every rule there, especially the auto-push hook, the session protocol, and the Supabase query footguns in §10b.
2. Read `REVIEW.md` (this package). Don't act on every finding — only the ones explicitly listed below. The rest are deferred to later sprints.
3. Run `npx tsc --noEmit` and capture baseline TypeScript errors. After each task, re-run and confirm you haven't introduced new ones.
4. Do **not** start Task 1 until Paul confirms M028–M031 have been applied to Supabase (see Task 0).

---

## Hard constraints — do not violate

- **Never change the sign convention in `lib/finance/conventions.ts`.** Storage = revenue positive, costs positive, financial signed. If a fix appears to require flipping a sign somewhere else, you've misunderstood the bug — stop and ask.
- **Never change the formula `net_profit = revenue − food − staff − other − depreciation + financial`.** Same reason.
- **Never bypass `projectRollup` for tracker_data writes.** It is the single writer. New code reads `tracker_data` verbatim.
- **Never disable RLS** on any table. If RLS is in your way, the API route should use `createAdminClient()` (service role) which bypasses RLS by design.
- **Never widen `@ts-nocheck`.** You may *remove* it from a file as part of a task, but never add it.
- **Never commit without a meaningful message.** "fix" is not a commit message. Reference the FIXES.md section.
- **Never skip updating `FIXES.md`** after a fix. New section at the top, dated 2026-04-26, following the existing §0a–§0s style (Symptom / Root cause / Fix / Why this should hold).
- **Never run destructive SQL.** All migrations are written to a file and applied manually by Paul in Supabase SQL Editor. You write the SQL and stage it; Paul runs it.

---

## Task 0 — confirm migrations are applied [BLOCKS Task 1+]

**Owner:** Paul (not Claude Code).

Before any of the following tasks run in production, M028–M031 must be applied to Supabase. Verify by asking Paul:

> "Have M028, M029, M030, M031 been run in the Supabase SQL Editor? Reply yes/no."

If no — stop. Tell Paul: "I can't proceed safely. The new Fortnox apply path writes to columns these migrations create. Please apply them and reply when done."

If yes — proceed. Update the `MIGRATIONS.md` header to flip the four entries from "pending" to "applied 2026-04-26" and commit that change as a separate single-line commit before Task 1.

---

## Task 1 — fix `middleware.ts` [CRITICAL, ~30 min]

**Why:** It only protects `/dashboard`, the "session check" is a substring match on cookie names (set a cookie called `auth` and you pass), and it console-logs every cookie name on every request. Either it does its job or it doesn't exist.

**Decision:** delete it. Per-route `getRequestAuth` already enforces auth on every API call, and the page server components already redirect via their own checks. Adding a real JWT-validating middleware is more work than the value warrants right now (and will be revisited when SSR auth is consolidated).

**Steps:**

1. Read `middleware.ts` and confirm what's actually there matches what `REVIEW.md §2.7` describes.
2. Read 3 page server components (e.g. `app/staff/page.tsx`, `app/tracker/page.tsx`, `app/financials/performance/page.tsx`) and confirm they redirect to `/login` when unauthenticated. If any do not, **stop** and tell Paul — that page is publicly leaking layout shell and we need a different approach.
3. If the page-level redirects are in place: delete `middleware.ts`. That's it. Next.js will simply have no middleware.
4. Verify the build still works: `npm run build`.
5. Manually test: open an incognito window, hit `https://comandcenter.se/dashboard` — should redirect to `/login`. Same for `/staff`, `/tracker`, `/admin`. (Paul does this; you write the test plan into `FIXES.md`.)
6. Add `FIXES.md §0t` documenting the change.

**Acceptance criteria:**
- `middleware.ts` no longer exists.
- `npm run build` passes.
- Test plan in `FIXES.md §0t`.

---

## Task 2 — fix `.single()` blocking multi-org users [CRITICAL, ~45 min]

**Why:** `lib/auth/get-org.ts:80` and `lib/supabase/server.ts:112` use `.single()` on `organisation_members`. A user belonging to ≥2 orgs throws an error and `getRequestAuth` returns null, so they appear unauthenticated forever. This is invisible today (Paul has one org) but will block onboarding the first accountant or consolidating-group customer.

**Steps:**

1. In `lib/supabase/server.ts:108–112`, change `.single()` to `.maybeSingle()`. Adjust the no-membership branch (currently the `if (!m) return null` on line 114) to handle the multiple-membership case.
2. Same change in `lib/auth/get-org.ts:80`.
3. Decide on org selection. For Sprint 1, deterministically pick the org with the **earliest `created_at`** (i.e. the first one the user ever joined). This is a stable, predictable choice that doesn't require new schema. Implement by changing the query to `.select(...).eq('user_id', user.id).order('created_at', { ascending: true }).limit(1).maybeSingle()`.
4. Add a comment block above the change explaining: "TODO: replace with explicit org selection (cookie or query param) when we add multi-org users. Today this picks the user's earliest membership; that's deterministic but won't let an accountant switch between client orgs."
5. **Do not** delete the duplicate auth helper yet — that's Task 6.
6. Run `npx tsc --noEmit` to confirm no type regressions.
7. Add `FIXES.md §0u`.

**Acceptance criteria:**
- Both helpers use `.maybeSingle()` with an `.order('created_at', { ascending: true }).limit(1)` chain.
- No TypeScript errors introduced.
- Comment block in place flagging future work.
- `FIXES.md §0u` written.

---

## Task 3 — fix `supersedes_id` overwrite in multi-month apply [CRITICAL, ~2 hours]

**Why:** `app/api/fortnox/apply/route.ts` loops periods and calls `applyMonthly`, which writes `supersedes_id` on the current upload row each iteration. Twelve periods → twelve overwrites → only the last supersede target is recorded. The chain is broken.

**Approach:** introduce a join table. `supersedes_id` / `superseded_by_id` columns on `fortnox_uploads` are kept for backwards compatibility with single-month uploads but are no longer written by the multi-month path.

**Steps:**

1. Write `M032-FORTNOX-SUPERSEDE-CHAIN.sql` at repo root:
   ```sql
   CREATE TABLE IF NOT EXISTS fortnox_supersede_links (
     child_id     UUID NOT NULL REFERENCES fortnox_uploads(id) ON DELETE CASCADE,
     parent_id    UUID NOT NULL REFERENCES fortnox_uploads(id) ON DELETE CASCADE,
     period_year  SMALLINT NOT NULL,
     period_month SMALLINT NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     PRIMARY KEY (child_id, parent_id, period_year, period_month)
   );
   CREATE INDEX IF NOT EXISTS idx_supersede_child  ON fortnox_supersede_links (child_id);
   CREATE INDEX IF NOT EXISTS idx_supersede_parent ON fortnox_supersede_links (parent_id);
   ALTER TABLE fortnox_supersede_links ENABLE ROW LEVEL SECURITY;
   -- Service-role only; no policy needed.
   ```
   Add the migration to `MIGRATIONS.md` under "Pending — apply when ready" with the same level of detail as M028–M031.

2. Modify `applyMonthly` in `app/api/fortnox/apply/route.ts`:
   - When a prior applied upload is found (the existing supersede block at lines ~290–317), **also** insert a row into `fortnox_supersede_links` with `(child_id=uploadId, parent_id=priorApplied.id, period_year=year, period_month=month)`.
   - Keep the existing `supersedes_id` / `superseded_by_id` writes for the single-month path. They remain accurate when only one period is involved.
   - On the multi-month path: the per-period link table is the source of truth. The column-level `supersedes_id` will end up holding the **last** period's parent — that's fine, it's now a non-load-bearing field, but document this in a comment.

3. Add `org_id` filter to the prior-applied lookup at line ~290:
   ```ts
   .eq('org_id', orgId)        // defence in depth — was missing
   .eq('business_id', businessId)
   ```

4. Update `app/api/fortnox/reject/route.ts` to walk the chain via `fortnox_supersede_links` instead of `supersedes_id` when restoring a predecessor. Test path: re-upload corrected PDF → reject → predecessor's status flips from 'superseded' back to 'applied' for **every** period the multi-month upload covered, not just one.

5. Add `FIXES.md §0v`.

**Acceptance criteria:**
- `M032-FORTNOX-SUPERSEDE-CHAIN.sql` exists, idempotent, with verification queries at the bottom.
- `MIGRATIONS.md` entry added.
- `applyMonthly` writes to `fortnox_supersede_links`.
- Reject path walks the join table.
- `org_id` is now part of the prior-applied lookup.
- `FIXES.md §0v` written.
- **Paul applies M032 before this code reaches production.** Flag this clearly in your handoff message.

---

## Task 4 — kill the AI-quota TOCTOU [HIGH, ~1.5 hours]

**Why:** `/api/ask` checks the limit, calls Claude (~30s), then increments. 100 parallel tabs all pass before any increment. Per-org daily cap is unenforceable under burst.

**Approach:** atomic check-and-increment via a Postgres RPC. The fallback path stays for graceful degradation.

**Steps:**

1. Write `M033-INCREMENT-AI-USAGE-ATOMIC.sql` at repo root, replacing the existing `increment_ai_usage` RPC if it exists with an atomic check-and-increment that returns the new count and a boolean for "was over limit":
   ```sql
   CREATE OR REPLACE FUNCTION increment_ai_usage_checked(
     p_org_id   UUID,
     p_date     DATE,
     p_limit    INT
   ) RETURNS TABLE(new_count INT, allowed BOOLEAN)
   LANGUAGE plpgsql
   AS $$
   DECLARE
     v_count INT;
   BEGIN
     INSERT INTO ai_usage_daily (org_id, date, query_count)
     VALUES (p_org_id, p_date, 1)
     ON CONFLICT (org_id, date)
     DO UPDATE SET query_count = ai_usage_daily.query_count + 1
     RETURNING query_count INTO v_count;

     RETURN QUERY SELECT v_count, (v_count <= p_limit);
   END;
   $$;
   ```
   Verify there's a unique constraint on `(org_id, date)`. If not, add it (idempotent `ALTER TABLE ... ADD CONSTRAINT IF NOT EXISTS ...`).

2. Refactor `lib/ai/usage.ts`:
   - Add a new exported function `checkAndIncrementAiLimit(db, orgId, planKey)` that:
     - Resolves the effective limit (existing `getEffectiveDailyLimit` logic).
     - Calls the new RPC.
     - If `allowed=false`, decrements (`UPDATE ai_usage_daily SET query_count = query_count - 1`) so the over-limit attempt doesn't count, and returns `{ ok: false, ... }` matching the existing `LimitGateBlocked` shape.
     - If `allowed=true`, returns `{ ok: true, used: new_count, limit, ... }`.
   - Keep the global kill-switch and monthly cost ceiling checks **before** the increment — those don't need to be atomic.
   - Keep the existing `checkAiLimit` + `incrementAiUsage` for non-burst-sensitive callers (cron-triggered AI agents). Mark `checkAiLimit` with `@deprecated — use checkAndIncrementAiLimit on user-facing endpoints`.

3. Update `app/api/ask/route.ts` to call `checkAndIncrementAiLimit` instead of the two-step check+increment. Note: the increment now happens **before** the Claude call, so on Claude failure you should still log the usage (the user did consume an attempt) — that's the desired behaviour for rate limiting, even though it's slightly punishing on transient Anthropic errors.

4. Add `FIXES.md §0w`.

**Acceptance criteria:**
- `M033-INCREMENT-AI-USAGE-ATOMIC.sql` exists with the unique constraint check.
- `lib/ai/usage.ts` exports `checkAndIncrementAiLimit`.
- `/api/ask` uses the new function.
- Old functions retained, deprecated, comment in place explaining why.
- `MIGRATIONS.md` updated with M033.
- `FIXES.md §0w` written.
- Paul applies M033.

---

## Task 5 — replace 24h `ai_request_log` table scan [HIGH, ~30 min]

**Why:** `lib/ai/usage.ts:160–166` selects every row in `ai_request_log` from the last 24 hours and sums in JS. At 50 customers × 50 calls/day this is 2,500 rows fetched and summed on **every AI call**. Falls over before you reach 50 customers.

**Steps:**

1. Add to `M033-INCREMENT-AI-USAGE-ATOMIC.sql` (same migration):
   ```sql
   CREATE OR REPLACE FUNCTION ai_spend_24h_global_usd()
   RETURNS NUMERIC
   LANGUAGE sql STABLE
   AS $$
     SELECT COALESCE(SUM(total_cost_usd), 0)::NUMERIC
     FROM ai_request_log
     WHERE created_at > now() - interval '24 hours';
   $$;

   CREATE INDEX IF NOT EXISTS idx_ai_request_log_created_at
     ON ai_request_log (created_at DESC);
   ```

2. Replace lines 160–166 of `lib/ai/usage.ts` with `const { data: globalSpendData } = await db.rpc('ai_spend_24h_global_usd'); const globalSpend = Number(globalSpendData ?? 0)`.

3. Same migration: add a partial index on `ai_request_log` for the monthly cost ceiling query (`WHERE created_at >= date_trunc('month', now())` is also a hot path).

4. No new `FIXES.md` section needed if this lands in the same commit as Task 4 — extend §0w with a "while we're in here" note.

**Acceptance criteria:**
- RPC exists, function in `lib/ai/usage.ts` uses it.
- Index added.
- No behavioural change otherwise.

---

## Tasks 6–10 — DEFERRED to Sprint 2

The following are documented in `REVIEW.md` and matter, but are not in this sprint:

- Task 6: consolidate the two auth helpers (delete `lib/auth/get-org.ts`).
- Task 7: Stripe webhook `'solo'` plan default → look up plan from `price.id`.
- Task 8: standardise on `checkCronSecret` in the 3 inline-`!==` handlers.
- Task 9: wrap aggregator fire-and-forget in `waitUntil`.
- Task 10: move root cruft to `archive/`.

**Do not touch these** unless Paul explicitly requests. Task 6 in particular looks deceptively simple but every API route using `getOrgFromRequest` needs to be migrated and re-tested.

---

## End-of-sprint checklist

After Tasks 1–5 land:

1. Run `npx tsc --noEmit` — should be clean (or no worse than baseline).
2. Run `npm run build` — should succeed.
3. Update `CLAUDE.md`:
   - Bump the "Session N" line at the top to the new session number.
   - Add a new invariants block summarising what changed (middleware deleted, multi-org support deterministic-by-earliest, fortnox supersede via join table, AI quota atomic).
4. Update `MIGRATIONS.md` header — M032 and M033 should appear under "Pending" until Paul applies them, then move to "Applied" with the date.
5. Update `ROADMAP.md` — mark Sprint 1 items complete, surface Tasks 6–10 as Sprint 2.
6. Final commit: `chore: sprint 1 docs (CLAUDE.md, ROADMAP.md, MIGRATIONS.md)`.

---

## What to ask Paul if you get stuck

- Migration not applied → "Has M032/M033 been run in Supabase? I can't proceed without it."
- Type error you can't resolve cleanly → "I need to add `@ts-nocheck` to retain progress, or refactor the surrounding types. Which?"
- Test reveals existing data is malformed → "Found N rows of inconsistent X. Backfill SQL or skip?"
- Anything that smells like a sign-convention question → **stop and ask, don't guess.**

---

## What success looks like

By end of sprint:
- `middleware.ts` is gone.
- A user with multi-org membership can log in (deterministically into their oldest org).
- Multi-month Fortnox upload supersede chains are intact across reject/restore cycles.
- A user firing 100 parallel /api/ask requests can no longer exceed their daily cap.
- `checkAiLimit` no longer scans the full `ai_request_log` table.
- 5 entries in FIXES.md (§0t–§0w + the M033 extension).
- 2 new migrations (M032, M033) applied.
- Zero new TypeScript errors.
- Zero new files with `@ts-nocheck`.

Good luck. Read CLAUDE.md and REVIEW.md before you write a line.
