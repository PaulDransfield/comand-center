# CommandCenter — Architectural Review

> Reviewer: Claude · Date: 2026-04-26
> Scope: snapshot zip provided 2026-04-26 covering `app/`, `lib/`, `components/`, root migrations, docs.
> Style: honest, prioritised, citing files+lines so you can verify each finding.

---

## TL;DR — what to do this week

1. **Apply M028–M031 to production before the new code path serves real traffic.** `MIGRATIONS.md` header still says "M028 pending · M029 pending · M030 pending · M031 pending" but `lib/finance/projectRollup.ts` writes to columns those migrations create (`tracker_data.depreciation`, `financial`, `alcohol_cost`). If a customer triggers a Fortnox apply before the SQL is run, the upsert errors out and the upload gets stuck.
2. **Fix `middleware.ts`.** It only protects `/dashboard`, "session check" is a string-match for cookie names (not JWT validation), and it logs every cookie name on every request. Either delete it or make it real.
3. **Fix `.single()` in both auth helpers.** A user with membership in 2 orgs cannot log in — `.single()` throws and `getRequestAuth` returns null. Unblocks accountant/multi-org use cases you'll want for v2.
4. **Fix the `supersedes_id` overwrite in multi-month apply.** Each period in the loop overwrites the previous one's link; only the last supersede target is recorded. The chain is broken for any prior multi-month upload that gets corrected by another multi-month upload.

Everything else can wait but I'd attack the AI-quota TOCTOU and the Stripe `'solo'` plan default in the same sprint.

---

## What's genuinely good

Before the criticism — these are not boilerplate, you put thought into them:

- **`lib/finance/conventions.ts` + `projectRollup.ts`** — single-writer, single-formula, comments cite Square Books / pgledger / Beancount as references. This is exactly the pattern an accounting platform needs and you adopted it before it bit you in production. Keep going.
- **The Resultatrapport parser** — `lib/fortnox/resultatrapport-parser.ts` is a serious piece of engineering. The DOMMatrix polyfill + worker-disable comment block is exactly the kind of context future-you needs when this breaks at 3am. The split classifiers shared with `extract-worker` is the right pattern.
- **`SCOPE_NOTE` in `lib/ai/scope.ts`** — preventing the AI from misattributing business-wide numbers to departments is subtle and correct. Most teams don't notice until a customer makes a wrong staffing decision.
- **Stripe webhook idempotency via `stripe_processed_events`** — most teams ship without this and find out the hard way when Stripe retries.
- **Timing-safe secret comparisons in `lib/admin/check-secret.ts`** — and you actively verify scope (org_id + business_id) on top of secret presence in `requireAdmin`. That defends against the "stolen ADMIN_SECRET → tenant-swap" attack.
- **The `current_user_org_ids()` RLS function** — array-returning, `STABLE`, `SECURITY DEFINER`, with `set search_path = public`. All four details matter; you got them all right.
- **Structured logs (`lib/log/structured`) + Sentry user attachment in `getRequestAuth`** — you'll thank yourself when something goes wrong at customer #20.

---

## 1. Architectural smells

### 1.1 Two competing auth helpers (HIGH)
`lib/auth/get-org.ts::getOrgFromRequest` and `lib/supabase/server.ts::getRequestAuth` do the same job differently. CLAUDE.md says prefer the latter. The former still exists and is easy to grab by autocomplete. Eventually they will drift and a route will end up with weaker auth than the one next to it. **Pick one, delete the other, search-and-replace.**

Also: both use `.single()` on `organisation_members` (lines 80 and 112 respectively). Multi-org users error out. Switch to `.maybeSingle()` and add an org-selection mechanism (a `current_org_id` cookie or `?org=` param respected only when the user has membership). Without this you can't onboard accountants or consolidating-group customers.

### 1.2 51% of TS files have `@ts-nocheck` (HIGH)
148 of 287 files. You're paying TypeScript's compile cost and losing its benefit. The biggest wins from un-nocheck-ing are in `lib/finance/`, `lib/fortnox/`, `lib/auth/`, `lib/sync/`, and `app/api/fortnox/apply/route.ts` — your load-bearing files. Expect 2–3 days to get from 148 → ~30. Keep `@ts-nocheck` on legacy admin pages and the patch-py output, drop it everywhere money flows.

### 1.3 Massive root-directory cruft (MEDIUM, but blocks LLM-assisted dev)
The repo root contains:
- 105 `patch_*.py` files (looks like archive of one-off codegen)
- 21 `.html` files (prototypes? deployment dashboards?)
- 14 `.ps1` PowerShell scripts
- Dozens of root-level `.js` files (`bankid-implementation.js`, `ai-service.js`, `integration-manager.js`, `monitoring.js`, `trial-middleware.js`, `stripe-checkout.js`…) that aren't imported by `app/`.

Two harms:
- **For Claude Code / future you:** any LLM scanning the repo wastes context on these and produces worse suggestions.
- **For Vercel deploys:** the deployment includes them in the source tree (Next.js skips them at build, but they balloon the function lambdas via outputFileTracingIncludes if any get caught).

Action: `mkdir archive/` → move everything that isn't currently imported by `app/`, `lib/`, or `components/` into it. Add `archive/` to `.vercelignore`. One afternoon.

### 1.4 Migrations live in two places (LOW)
M008–M016 in `sql/`, M017–M031 at repo root. Pick one — and ideally move to `supabase/migrations/` so you can run `supabase db push` instead of pasting SQL into the Supabase SQL Editor. The "M028 pending" footgun goes away the moment migration application is part of the deploy pipeline.

### 1.5 No tests (HIGH-impact, LOW-effort)
`tests/fortnox-fixtures/` is just a README. Zero unit tests in 287 source files. For a codebase with this much numerical logic (sign conventions, supersede chains, VAT splits, classification rules), this is the single highest-ROI gap.

Minimum viable test set, ranked:
1. `lib/finance/conventions.ts` — sign discipline. ~20 tests, all pure functions, takes an hour.
2. `lib/fortnox/classify.ts` — account/label/VAT classification. ~30 tests.
3. `lib/finance/projectRollup.ts` — golden-file tests over a few synthetic extractions.
4. `lib/fortnox/resultatrapport-parser.ts` — wire up real PDFs in `tests/fortnox-fixtures/` with `expected.json`. You already designed for this; just write the harness.

Use vitest, not jest — vitest is faster and integrates with Next.js better. Run on commit via a Vercel preview check. One full day for items 1–3, another for item 4.

### 1.6 `pdfjs-dist` is a transitive dependency (LOW)
`lib/fortnox/resultatrapport-parser.ts` imports it directly, but it's not in `package.json` — it gets pulled by `pdf-parse`. The day `pdf-parse` updates and drops it, your parser explodes. Add it as a direct dep.

### 1.7 `@anthropic-ai/sdk` is at `^0.24.0` (LOW)
That's an old version. Newer SDKs have better cache control, tool-use ergonomics, and improved error types. You won't get value if you stay on `0.24` while writing code that assumes newer behaviours.

---

## 2. Specific bugs

### 2.1 `supersedes_id` overwrite in multi-month apply (HIGH)
`app/api/fortnox/apply/route.ts:65–82` loops periods and calls `applyMonthly`. Inside the helper (lines 290–311), each call does:

```ts
await db.from('fortnox_uploads')
  .update({ supersedes_id: priorApplied.id })
  .eq('id', uploadId)
```

If a 12-month upload supersedes 12 different prior single-month uploads, the column gets overwritten 12 times — only the last one survives. The supersede chain is lost.

**Fix:** move the relationship to a separate table:

```sql
CREATE TABLE fortnox_supersedes (
  child_id  UUID REFERENCES fortnox_uploads(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES fortnox_uploads(id) ON DELETE CASCADE,
  period_year SMALLINT NOT NULL,
  period_month SMALLINT NOT NULL,
  PRIMARY KEY (child_id, parent_id)
);
```

Then `supersedes_id` becomes derived ("first parent") and the reject walker queries this table.

### 2.2 Tenancy not enforced on supersede lookup (MEDIUM, defense-in-depth)
Same file, lines 290–298: the prior-applied lookup filters `business_id` + `period_year` + `period_month` + `status='applied'` but **not** `org_id`. In practice `business_id` is a UUID so cross-org collision is astronomically unlikely. Still add `.eq('org_id', orgId)` — defence in depth, costs nothing.

### 2.3 `'solo'` is not a real plan (MEDIUM)
`app/api/stripe/webhook/route.ts:126`:

```ts
const plan = sub.metadata?.plan || 'solo'
```

Your plan keys per `lib/auth/get-org.ts:14` are `'trial' | 'starter' | 'pro' | 'enterprise' | 'past_due'`. `'solo'` doesn't exist. If a Stripe subscription arrives without `metadata.plan` (e.g. created from the Stripe Dashboard rather than your checkout flow), you write `plan='solo'` to `organisations.plan`. Downstream gates that switch on plan will silently behave like trial (because `getPlan('solo')` falls through), and the Performance/Forecast pages may render with trial limits for a paying customer. **Fix:** look the plan up from the subscription's `price.id` (deterministic), or 5xx if metadata is missing.

### 2.4 Stripe webhook dedup-DELETE failure mode (LOW, but real)
Lines 66–88, 102–113: insert dedup row → if work fails, DELETE the dedup row + 5xx. If the DELETE itself fails (network blip, transient DB error), the dedup row stays and Stripe's next replay sees it as already-processed and skips. **Fix:** make dedup two-phase — `INSERT processed_at=NULL`, do work, `UPDATE SET processed_at = now()`. Replays hit "row exists with `processed_at` not null → skip; row exists with `processed_at` null + older than 5 min → take over". This is the canonical pattern.

### 2.5 TOCTOU on AI quota (HIGH)
`app/api/ask/route.ts:108–139`: check limit, call Claude (~30s), then increment. A user firing 100 parallel tabs all pass the check before any of them increment. Your global kill switch and monthly cost ceiling protect Anthropic spend at the company level, but per-org per-day enforcement is broken under bursts.

**Fix options:**
- Use the `increment_ai_usage` RPC (which you have a fallback path for in `lib/ai/usage.ts:485`) and have it `INSERT INTO ai_usage_daily ... ON CONFLICT DO UPDATE SET query_count = query_count + 1 RETURNING query_count`. Then check `query_count > limit` after the increment and reject + decrement (or use a Postgres function that does the comparison atomically and only increments when under limit).
- Or guard with `lib/middleware/org-rate-limit.ts` which you already have for Stripe checkout — add a bucket `ai_burst` with `max=10, windowMs=10_000` to bound concurrent bursts.

### 2.6 `checkAiLimit` does a 24-hour table scan on every AI call (HIGH at 50 customers)
`lib/ai/usage.ts:160–166`:

```ts
const { data: globalRows } = await db
  .from('ai_request_log')
  .select('total_cost_usd')
  .gte('created_at', since)
const globalSpend = (globalRows ?? []).reduce(...)
```

At 50 customers × ~50 AI calls/day = ~2,500 rows fetched into Node memory and summed in JS — on every single AI call. Today that's invisible (you have ~2 customers). At 50 customers and a year of history this is the first thing that falls over.

**Fix:** `SELECT SUM(total_cost_usd) FROM ai_request_log WHERE created_at > now() - interval '24 hours'` as a Postgres RPC. Returns one row. Or a 1-min materialised view. Or push to Redis if you ever add Upstash.

### 2.7 Middleware doesn't protect most authenticated pages (CRITICAL — but mitigated)
`middleware.ts` only redirects `/dashboard` to login when the cookie is absent. `/staff`, `/tracker`, `/forecast`, `/budget`, `/alerts`, `/financials/performance`, `/scheduling`, `/departments`, `/invoices`, `/admin`, `/integrations`, `/notebook`, `/onboarding`, `/settings`, `/group`, `/overheads`, `/revenue`, `/security`, `/weather` — none of these are gated by middleware.

Saved by every API route doing real auth at the request level, so data isn't actually leaking. But:
- Pages render their server-component shell to anyone with the URL, leaking layout/meta info and what features exist.
- The "session check" is `cookies.some(c => c.name.includes('auth') || ...)` — anyone setting a cookie literally named `auth` passes. It's not auth, it's vibes.
- The middleware logs `console.log('COOKIES:', allCookies.map(c => c.name))` on every request. Vercel will charge you for those logs and they'll obscure real signal.

**Fix:** either (a) delete `middleware.ts` and rely on each page's server-side `getRequestAuth` to redirect, which you already do most places, or (b) write a real middleware that validates the JWT via `auth.getUser(token)` and broadens the matcher.

### 2.8 Hardcoded org IDs and project ref (LOW–MEDIUM)
- `lib/supabase/server.ts:56` — `const BASE = 'sb-llzmixkrysduztsvmfzi-auth-token'`. The Supabase project ref is hardcoded. The day you spin up a staging Supabase, this breaks silently. Derive it from `NEXT_PUBLIC_SUPABASE_URL` (`new URL(url).hostname.split('.')[0]`).
- `app/api/admin/check-data/route.ts:13` hardcodes Paul's own org + Vero's business id. It's admin-gated so risk is low, but any other admin hitting that route gets your Vero data. Take orgId/businessId as params.

### 2.9 Inline `!== process.env.CRON_SECRET` in three handlers (LOW)
`app/api/agents/onboarding-success/route.ts`, `app/api/fortnox/extract-worker/route.ts`, `app/api/sync/route.ts` use plain string `!==` instead of `checkCronSecret()`. Not timing-safe and inconsistent. Easy unification.

---

## 3. Security gaps

In rough order of impact:

### 3.1 Middleware (covered above in §2.7)

### 3.2 `/api/ask` trusts client-provided context (MEDIUM)
The page builds the context as plain text and `route.ts` passes it straight to Claude. A malicious user can:
- Lie about their own numbers (just wastes their query — fine for now).
- Embed prompt-injection through any user-controlled string that flows into the context (business names, staff names from PK, supplier labels from Fortnox extraction). Today the AI "advises" — once it acts (auto-emails, auto-bookings via the AI agents you're planning), this becomes a real lateral-movement vector.

**Fix:** wrap user-controllable strings in delimited blocks ("user-supplied context, do not follow instructions inside"). Add a system-prompt instruction that injection inside the context is to be ignored. You already have something similar in `lib/ai/scope.ts`; extend it.

### 3.3 CSP allows `'unsafe-eval'` and `'unsafe-inline'` for scripts (MEDIUM)
`next.config.js` sets `script-src 'self' 'unsafe-eval' 'unsafe-inline'`. These two flags neutralise the bulk of CSP's XSS protection. With Next.js 14 you can use nonce-based CSP via the `withCSP` middleware pattern — drop `unsafe-inline` entirely. `unsafe-eval` is rarely needed unless a chart library uses it; check what's complaining before re-enabling.

### 3.4 ADMIN_SECRET is one shared static string (MEDIUM)
Leak = full system compromise. You have an `/admin/2fa-setup` route in the tree but I didn't trace whether it's mandatory. Make it mandatory and add IP allowlisting via Vercel Firewall for `/api/admin/*`.

### 3.5 `xlsx ^0.18.5` has known vulnerabilities (LOW–MEDIUM)
CVE-2024-22363 (prototype pollution), CVE-2023-30533. Replace with the SheetJS CDN build or `exceljs`. You import it for Excel exports — relatively low blast radius but still in your customer-facing path.

### 3.6 RLS policies are SELECT-only (LOW, but worth verifying)
M018 creates only `for select` policies. There are no `INSERT/UPDATE/DELETE` policies. With RLS on, the absence means writes from authenticated clients are denied. That's fine **if** all writes go through API routes using the service-role client (`createAdminClient()`). Spot-check that no client-side `supabase` calls do mutations. From what I saw, your client lib doesn't expose a write path, so this is probably fine — but worth a single `grep -rn "from\\(.*\\)\\.insert\\|\\.update\\|\\.delete\" components/ app/` to confirm no one wires up a direct write from a client component.

### 3.7 Trusting `x-vercel-cron: 1` as auth (acceptable, but note)
`lib/admin/check-secret.ts:47` accepts `x-vercel-cron=1` as proof-of-Vercel. Vercel does strip incoming `x-vercel-*` headers from external requests, so this is safe today. Defence-in-depth would be to **also** require `Authorization: Bearer ${CRON_SECRET}` and only accept the header as a fallback when the bearer is absent. If Vercel ever changes this behaviour you're not exposed.

---

## 4. Performance — what falls over at 50 customers

In rough order of "you'll see this fail first":

1. **`checkAiLimit` 24-hour table scan** (covered §2.6) — first thing to break.
2. **`/api/fortnox/uploads` listing without pagination** — I didn't read the route in detail, but a customer with 24 months of monthly + several annual uploads will pull dozens of rows per page render. Verify it has `LIMIT` and an index on `(org_id, created_at DESC)`.
3. **`master-sync` cron at 06:00 UTC** runs all customers in one Vercel function execution. Vercel Pro has a 5-minute (300s) max. At 50 customers each needing a PK fetch + Fortnox + aggregation, you'll bump up against the wall. **Fix when you have time:** chunk by org_id mod N and have multiple cron entries (06:00, 06:05, 06:10).
4. **No timeouts on external API calls.** `lib/sync/with-timeout.ts` exists but a `grep -r "withTimeout" app/ lib/` will tell you which call sites use it. PK or Fortnox going slow today means your function eats its full `maxDuration` and you pay for it.
5. **Aggregator fire-and-forget on Fortnox apply.** `app/api/fortnox/apply/route.ts:122` calls `aggregateMetrics(...).catch(...)` without `waitUntil`. On Vercel, the response returns to the client and the function may be killed before the aggregation completes. M027's advisory lock helps with concurrency, but you may end up with apply calls that look like they succeeded while the aggregation never ran. **Fix:** wrap in `waitUntil(aggregateMetrics(...))` from `@vercel/functions` (you import it elsewhere). You have the dep; just use it here.
6. **The `ai_request_log` table itself.** It grows every AI call. Without retention (and I see `ai-log-retention` cron exists, good), and without partitioning, queries against it (admin overview, monthly usage) get slower over time. Verify the cron actually deletes; I didn't read it.
7. **`stripe_processed_events` grows unboundedly.** Add a 90-day retention.
8. **Sentry `captureError` from inside `incrementAiUsage`** — fine at 2 customers, will rate-limit on Sentry's side at 50 with a real outage. Wrap with sampling.

---

## 5. Priorities — given limited time

If I had a week of your engineering time, I'd spend it like this:

**Day 1 (production correctness):**
- Apply M028–M031 in production. Verify with the migration verification queries.
- Fix `middleware.ts` (delete or replace).
- Fix `.single()` → `.maybeSingle()` in both auth helpers.
- Fix `supersedes_id` overwrite in multi-month apply.
- Add `org_id` filter to the supersede lookup.

**Day 2 (resilience):**
- Replace 24h `ai_request_log` scan with an RPC.
- Switch `/api/ask` to atomic increment-and-check OR add `org_rate_limit('ai_burst', 10/10s)` on top.
- Stripe webhook: kill the `'solo'` default, look up plan from price_id.
- Wrap aggregator fire-and-forget in `waitUntil`.
- Standardise on `checkCronSecret` everywhere.

**Day 3 (debt reduction with the highest ROI):**
- Move root cruft to `archive/`, add to `.vercelignore`. Half a day.
- Remove `@ts-nocheck` from `lib/finance/`, `lib/fortnox/`, `lib/auth/`, `lib/sync/`, and `app/api/fortnox/apply/route.ts`. Half a day if there are real type errors; a few hours if not.

**Day 4 (sleep at night):**
- Vitest setup. Tests for `lib/finance/conventions.ts` and `lib/fortnox/classify.ts` — both are pure functions, easy to cover. Add `npm test` to predeploy.
- Drop one annual + one monthly real Resultatrapport into `tests/fortnox-fixtures/` and write the parser regression test you already designed for.

**Day 5 (what to do instead of building features):**
- Set up `supabase/migrations/` and the Supabase CLI so M032 onwards is `supabase db push`, not paste-into-editor. This single change eliminates the "code references pending column" footgun forever.
- Add `pdfjs-dist` as a direct dep. Bump `@anthropic-ai/sdk` and re-test caching behaviour. Replace `xlsx`.

---

## A note on the development pattern

Looking at FIXES.md §0 through §0s — twenty-something incidents in roughly six weeks — there's a noticeable cadence of *recurring categories*: VAT classification drift, sync-state stuckness, sign-convention disagreements between writer and reader, multi-month vs single-month edge cases. The Tier 2 rebuild today (single-writer, single sign convention, deterministic parser) addresses the meta-pattern. Good — but the only durable defence is **the test set you don't have yet**. Without tests, the next refactor regresses something already fixed and FIXES.md grows another section. Day 4 above is the single highest-leverage item on this whole document.

You've built something genuinely impressive for a single developer running two restaurants. The financial pipeline rebuild today is the kind of work most teams put off until customer #20 forces it. Don't let "ship the next feature" delay tests.
