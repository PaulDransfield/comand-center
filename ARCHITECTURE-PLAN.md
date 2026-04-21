# ARCHITECTURE-PLAN.md — Path to a Production-Grade CommandCenter

> Written: 2026-04-21 after a three-audit review (API surface, integrations, multi-tenant isolation)
> Audience: Paul + Claude (co-founder pair); nobody else should need it
> Status source of truth: this file. Update as items ship.

---

## 0. Why this exists

The Fortnox PDF extraction ordeal exposed that the extraction pipeline was **request-bound, single-shot, and silently unreliable**. Asking "what other parts of the product have the same pattern" surfaced eight more. This document names every architectural risk currently sitting in the codebase, ranks them by blast radius, and lays out the work in three time horizons.

The goal is **correct architecture**, not "cheapest that works today". We build for the 50-customer target in CLAUDE.md, not for the 2 customers we have now.

---

## 1. Principles this plan leans on

1. **Defence-in-depth on tenant isolation.** Code-side `eq('org_id', ...)` AND database-side RLS on every org-scoped table. One is not enough.
2. **Any work >5s must be decoupled from HTTP requests.** Dispatcher → worker → sweeper, with retries and a dead-letter state. Already shipped for Fortnox PDF extraction (M017); same pattern for every other long job.
3. **External systems are untrusted.** Every external call has a timeout, idempotent write path, and a retry strategy (or explicit "this is fire-and-forget and I accept the risk").
4. **Silent failures are the enemy.** Every `catch(() => {})` is a decision to be invisible in production. Log to Sentry; show to the user where it matters.
5. **Cost caps are not optional.** Any paid external API (Anthropic, Stripe, Fortnox) must have per-org and global ceilings.
6. **RPCs for anything atomic.** Supabase client chains are not transactions. Race conditions are silent; `FOR UPDATE SKIP LOCKED` is loud and correct.

---

## 2. The 12 findings, ranked

### CRITICAL — fix before onboarding customer #3

| # | Finding | Files | Why it's critical |
|---|---|---|---|
| C1 | Five tables have no RLS (`auth_events`, `bankid_sessions`, `email_log`, `gdpr_consents`, `onboarding_progress`) | `supabase_schema.sql` | One bad query → full cross-tenant leak. Code-side filters are fallible. |
| C2 | `/api/admin/connect` trusts `org_id` from request body | `app/api/admin/connect/route.ts:16,27` | One admin can sabotage another tenant's integrations |
| C3 | `/api/admin/customers/[orgId]/impersonate` has no "admin allowed for this org" check | `app/api/admin/customers/[orgId]/impersonate/route.ts` | Any admin can impersonate any user |
| C4 | Stripe webhook returns 200 on DB errors → lost events | `app/api/stripe/webhook/route.ts:52-60` | Subscription state drifts silently |
| C5 | Stripe checkout has no per-org rate limit → $1000/hr worst-case | `app/api/stripe/checkout/route.ts:34-36` | Bug or compromised session = uncapped cost |
| C6 | `current_org_id()` returns `LIMIT 1` row → multi-org users see partial data | `supabase_schema.sql:396-412` | Non-deterministic data visibility when we onboard group accounts |

### HIGH — fix this month

| # | Finding | Files | Why high |
|---|---|---|---|
| H1 | Fortnox OAuth token doesn't auto-refresh; expires mid-sync | `lib/sync/engine.ts:1021`, `app/api/integrations/fortnox/route.ts:495` | Silent sync failures after 1h |
| H2 | `cost-intelligence` agent bypasses `checkAiLimit()` | `lib/agents/cost-intelligence.ts` | Batch Fortnox apply = 50 unchecked Haiku calls |
| H3 | `/api/ask`, `/api/invoices/extract`, `/api/budgets/generate` block HTTP on Claude | those routes | Concurrent users time out each other |
| H4 | Stripe webhook has no event-ID dedup → duplicate billing events possible | `app/api/stripe/webhook/route.ts:65-185` | Rare but real idempotency gap |
| H5 | `/api/cron/personalkollen-sync` has no per-integration timeout | `app/api/cron/personalkollen-sync/route.ts:37-197` | One broken integration blocks all 49 other tenants |
| H6 | `/api/ask` trusts `business_id` from body without verifying org ownership | `app/api/ask/route.ts:82-96` | Weak but present attack surface |
| H7 | Multi-month Fortnox `/apply` can end in mixed state (4/12 applied, upload marked applied) | `app/api/fortnox/apply/route.ts:49-86` | Manual recovery required |

### MEDIUM — fix before 10 customers

| # | Finding | Why |
|---|---|---|
| M1 | 38 routes lack `export const maxDuration` | Unpredictable behaviour on external-API latency spikes |
| M2 | Cron auth inconsistent (query string vs header vs dual) | `CRON_SECRET` leaks via CDN logs when in query string |
| M3 | Webhooks don't verify `x-vercel-cron` header | Authenticated user with `CRON_SECRET` = unintended trigger |
| M4 | `businesses/delete` silently swallows 9 table delete errors | Orphan records |
| M5 | `logAiRequest()` failures are `catch(() => {})` | Cost tracking gaps unseen |
| M6 | Polling (3s `setInterval`) instead of Supabase Realtime | Costs 20 req/min/user at scale |

---

## 3. Target architecture — what "good" looks like

### 3.1 Data flow

```
┌──────────┐    ┌────────────────┐    ┌──────────────────┐
│ Browser  │──▶ │ Dispatcher API │──▶ │ Job queue (PG)   │
└──────────┘    └────────────────┘    └──────────────────┘
       ▲                                        │
       │                                        ▼
       │        ┌──────────────────────────────────────┐
       │        │ Worker functions (own 300s budget)   │
       │        │ • Fortnox PDF extraction             │
       │        │ • Invoice PDF extraction             │
       │        │ • Monday memo generation             │
       │        │ • Long /ask questions                │
       │        │ • Budget generation (AI)             │
       │        └──────────────────────────────────────┘
       │                                        │
       │                                        ▼
       │                          ┌──────────────────────┐
       │                          │ Supabase Postgres    │
       └────── Realtime push ◀──── │ RLS enforced        │
                                  │ + updated_at/by     │
                                  │ + audit_log table   │
                                  └──────────────────────┘
                                           ▲
                                           │
                                  ┌──────────────────────┐
                                  │ Sweeper cron (2 min) │
                                  │ • Resets stale jobs  │
                                  │ • Retries failures   │
                                  │ • Alerts on DLQ      │
                                  └──────────────────────┘
```

Every long-running path uses the queue. The HTTP request from the browser is always fast.

### 3.2 Multi-tenant discipline

- **Every org-scoped table** has `ENABLE ROW LEVEL SECURITY` + a `SELECT` policy + explicit `INSERT`/`UPDATE`/`DELETE` policies where mutation is user-driven.
- **`createAdminClient()` is allowed only** when the immediate next line filters by an `org_id` that came from `getRequestAuth()` — never from the request body.
- **Admin surfaces** go through a single `requireAdminForOrg(userId, orgId)` helper that checks the admin's scope.
- **`current_org_id()` RPC** replaced with `current_user_org_ids()` returning `UUID[]` — policies use `org_id = ANY(current_user_org_ids())`.
- **Audit log** (`admin_actions`) records every admin action with full context before the action runs, not after.

### 3.3 External integrations

- **Fortnox**: auto-refresh tokens before each sync; exponential backoff on 401; encrypted token storage stays.
- **Stripe**: webhook handler returns 5xx on real errors (Stripe retries); event-ID dedup table `stripe_processed_events`; all mutations in a single DB transaction via RPC.
- **Personalkollen**: per-integration timeout (60s) even in the sync cron; per-integration error logging.
- **Anthropic**: every call through `logAiRequest()` + `checkAiLimit()`; cost-intel agent behind a feature flag + quota check.

### 3.4 Observability

- **Sentry** already instruments errors — audit what's actually going through. Every `catch(() => {})` replaced with `catch(e => captureException(e, { tags: {...} }))`.
- **Structured logging** on every cron/worker: `console.log(JSON.stringify({ route, op, status, duration_ms, org_id }))` so Vercel logs are queryable.
- **Dashboard**: `/admin/health` shows live queue depth, sweeper status, last sync per integration, AI cost burn rate.

---

## 4. Execution roadmap

### Phase 1 — CRITICAL (this week)

**Ship order matters: RLS before admin-bypass fixes, so tightening code doesn't rely on yet-to-exist policies.**

1. ☑ **RLS migration** — `M018-RLS-GAPS-MIGRATION.sql` enables RLS on the 5 missing tables + policies. Ran successfully 2026-04-21.
2. ☑ **`current_user_org_ids()` migration** — array-returning function shipped; `current_org_id()` kept as backwards-compat alias.
3. ☑ **Admin org-scope helper** — `lib/admin/require-admin.ts`. `/api/admin/connect`, `/api/admin/customers/[orgId]/impersonate`, and `/api/admin/customers/[orgId]/integrations/[integId]` migrated.
4. ☑ **Stripe webhook correctness** — returns 5xx on DB errors + `stripe_processed_events` dedup table. Shipped.
5. ☑ **Stripe checkout org-rate-limit** — 5/hr + 20/day via `org_rate_limits` table. Shipped.
6. ☑ **Fortnox token auto-refresh in sync engine** — `ensureFreshFortnoxToken()` called before every sync.

### Phase 2 — HIGH (next 2 weeks)

7. ☐ **Async jobs for AI-heavy routes** — deferred. `/api/ask`, `/api/invoices/extract`, `/api/budgets/generate` all run fine under their current `maxDuration` ceilings. Revisit when a specific route actually trips 300 s.
8. ☑ **`cost-intelligence` agent gated** — `checkAiLimit()` wrap in place; returns `{ insights: [], reason: 'ai_limit_blocked' }` on quota hit.
9. ☑ **Per-integration timeout** in `/api/cron/personalkollen-sync` via shared `lib/sync/with-timeout.ts`. 60 s per integration.
10. ☑ **Multi-month Fortnox apply correctness** — pragmatic fix (check per-period errors, abort before marking applied, leave idempotent upserts for retry). Full transactional RPC deferred; retry path already works.
11. ☑ **`/api/ask` business-id verification** — 403s if `business_id` isn't in `auth.orgId`.
12. ☑ **`maxDuration` on every external-call route** — swept 10 routes touching Claude/Stripe/Personalkollen/Open-Meteo. DB-only routes left on defaults (noise reduction).

### Phase 3 — MEDIUM / scaling (next month)

13. ☑ **Standardise cron auth** — `checkCronSecret()` now accepts `x-vercel-cron=1` as authoritative; 5 routes with custom checks migrated to the helper.
14. ◐ **Sentry-tag every silent catch** — worst offenders done (`businesses/delete`, `onboarding/setup-request`, `admin/integrations/delete`). Remaining silent catches are mostly safe body-parsers and intentional fetch-null-on-network-error. Ongoing sweep recommended.
15. ☑ **Supabase Realtime** for `/overheads/upload` (fortnox_uploads + extraction_jobs subscription). Remaining: `/tracker`, `/dashboard` — low urgency because neither polls aggressively today.
16. ☑ **Structured logging helper** — `lib/log/structured.ts` with `log.{debug,info,warn,error}()` and `timed()` wrapper. `/api/cron/extraction-sweeper` is the first consumer. Roll out to other crons incrementally.
17. ☑ **`/admin/health` live dashboard** — extraction queue counters, Stripe webhook dedup activity, org rate-limit hits surfaced alongside existing cron/sync/AI-cost panels.
18. ☑ **Validation runbook** — `VALIDATION-RUNBOOK.sql` with nine read-only checks for RLS, dedup, queue health, AI burn, sync freshness, token expiry, rate-limit counters, and stuck-work detection. Run periodically; replaces the heavier integration-test-framework approach for current scale.

### Post-session follow-ups (2026-04-22)

Surfaced during live use of the queue + Realtime architecture:

- ☑ **Fortnox revenue flow into monthly_metrics** — aggregator only merged cost fields from tracker_data; revenue sat in tracker_data but never reached monthly_metrics. Every downstream surface (budgets, forecast, memo, cashflow, tracker, anomaly detector) went blind for Fortnox-only months. Fix in `92f41a1`: aggregator now merges revenue + staff + food + rent + other, and `rev_source`/`cost_source` mark which feeder won.
- ☑ **Apply triggers aggregation** — `/api/fortnox/apply` now fires `aggregateMetrics()` for the affected year. No 24h wait for master-sync. `92f41a1`.
- ☑ **Budget generator belt-and-braces merge** — reads both monthly_metrics AND tracker_data, prefers Fortnox row-for-row. `6b1d301`. Defense-in-depth if aggregation lags.
- ☑ **Historical backfill endpoint** — `POST /api/admin/reaggregate { business_id, from_year, to_year }` forces the aggregator for pre-fix uploads that never saw the corrected merge. `503c57c`.
- ☑ **Queue lifecycle conflict** — old 5-min stale-reset in `/api/fortnox/uploads` was fighting the new queue (which uses 10-min sweeper resets + up to 12-min retry backoff). Removed; queue now owns lifecycle. `317a1d0`.
- ☑ **Smarter retry guard** — dispatcher's concurrency check now treats a 'processing' job >10 min as stale so user-triggered retry unblocks without waiting for the sweeper. `317a1d0`.

### Phase 2 / H3 — intentionally deferred after review

The audit flagged `/api/ask`, `/api/invoices/extract`, `/api/budgets/generate` for async-queue treatment. On reflection these are all interactive (user waits for the response), and async-ifying them would be a UX regression — the user has to navigate away and come back, with no net latency improvement. All three fit comfortably under their `maxDuration` ceilings with the current architecture. Revisit only if a specific route starts tripping 300 s in production.

### Phase 4 — beyond 10 customers

19. ☐ **Move from custom queue to Vercel Queues or Supabase Queues (pgmq)** — both were released during this build-out. The custom `extraction_jobs` pattern proves the shape; swap the backend when the batch SLA matters.
20. ☐ **Rolling Releases** for risky deploys (Stripe webhook changes, RLS tweaks) — built into Vercel Pro.
21. ☐ **Rate-limit middleware** — single `lib/middleware/rate-limit.ts` enforced at routing level, not per-handler.
22. ☐ **Secret rotation policy** — `CRON_SECRET`, `ADMIN_SECRET`, Stripe signing secret rotate on a schedule with overlap.

---

## 5. What NOT to do

- **Don't rewrite for `pgmq` right now.** The Postgres-table queue we just shipped is perfectly adequate for 50 customers. Moving is a 1-day task when we need it.
- **Don't add a separate worker service** (Render/Fly/Railway) until we genuinely exceed Vercel's 300s ceiling on a hot path. Haiku + compact schema means we don't.
- **Don't introduce Kafka, RabbitMQ, or any dedicated message broker.** Complexity multiplier without value at this scale.
- **Don't add a GraphQL layer.** PostgREST + typed RPCs is enough and stays aligned with RLS.
- **Don't migrate off Vercel or Supabase** on architectural grounds. The gaps above are fixable within the current stack and moving vendors doubles the work without solving them.

---

## 6. Definition of done for Phase 1

Phase 1 is complete when:

- RLS is enabled on 100% of org-scoped tables (automated check: `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (... our list ...) AND rowsecurity=false` returns 0 rows)
- No admin route reads `org_id` or `business_id` from the request body without re-verification
- Stripe webhook returns 5xx on DB errors (grep: no `return 200` inside a catch block)
- Stripe checkout has org-rate-limit in addition to user-rate-limit
- Fortnox sync engine refreshes expired tokens automatically

Once Phase 1 ships, CommandCenter is **safe to onboard its first paying customer outside the founding cohort.** Until then, every new tenant compounds the above risks.

---

*This plan supersedes the prior "Fortnox PDF extraction" focus. Every other priority — UX polish, new features, marketing pages — waits until Phase 1 lands. Paul's call on whether Phase 2 interleaves with product work.*
