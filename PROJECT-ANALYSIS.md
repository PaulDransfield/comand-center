# PROJECT-ANALYSIS.md — CommandCenter end-to-end audit

> Last updated: 2026-04-17
> Scope: every major area of the codebase — data, integrations, frontend, AI/cron, security, sync engine, ops
> Method: six parallel Explore agents, each focused on one dimension. Findings cross-referenced and synthesised here.
> Read alongside: `LEGAL-OBLIGATIONS.md`, `ROADMAP.md`, `FIXES.md`, `MIGRATIONS.md`, `CLAUDE.md`.

This is a warts-and-all audit. The product is further along than most founders' side projects at this stage — there is real functionality, a working admin surface, six live AI agents, seven integrations, EU-hosted infrastructure. But there are specific ship-blockers that must be closed before the first paying customer, and a handful of structural patterns that will compound as the user count grows. Both are documented below with file:line references so anything is one jump away from the fix.

---

## 1. Executive summary

### Where we actually are
- Platform foundation (multi-tenant, auth, EU hosting, admin panel, audit log, encryption at rest, hard-delete cascade) is **in place**.
- Seven integrations adapt data into the canonical shape: Personalkollen, Fortnox, Inzii, Ancon, Caspeco, Swess, Onslip. Six AI agents run on schedule. Stripe + Resend are wired.
- Legal paperwork (privacy, terms, security page, imprint, sub-processor list) is drafted and live.
- A lot of marked-"complete" work in ROADMAP.md is real. A material fraction is not: there are 12 tables with no migration, 4 integrations with no test-connection, one customer-facing page (/covers) that 404s, a page (forecast) that renders half-built, and an AI agent that bypasses every cost/feature gate.

### Top three things going right
1. **Architectural discipline is real in the newest work.** The `lib/admin/*` helpers (TOTP, audit, oauth-link, encryption) are clean, zero-dep, cleanly unit-testable, and used consistently. The hard-delete cascade is comprehensive. The Onslip adapter is a good template.
2. **Multi-tenant data shape is consistent.** Every customer-facing table carries `org_id` + `business_id`. Every adapter writes to the same `revenue_logs` / `staff_logs` / `covers` shape.
3. **Cost discipline on AI.** Model routing through `lib/ai/models.ts`, per-plan query limits in `ai_usage_daily`, summary-table pattern that keeps AI context small. Projected $5–10/month at 50 customers is realistic for the agents that actually obey the rules.

### Top three things to fix before a paying customer
1. **`.env.local` is tracked in git with real-looking secrets** (`ADMIN_SECRET=admin123`, `CRON_SECRET=dev_cron_secret_123`, mock keys). This is the same failure mode as the ANTHROPIC_API_KEY leak that triggered GitHub push-protection last week. Must be scrubbed from history and added to `.gitignore`.
2. **Tenant leakage in `app/api/tracker/route.ts:29`** — the GET query filters by `business_id` only, no `org_id`. If a user can name another org's business_id they read that org's P&L. Combined with the "service role key bypasses RLS everywhere" pattern, this is a live cross-tenant read risk, not a theoretical one.
3. **Two unauthenticated routes handle sensitive operations**: `/api/invoices/extract` (file upload + Claude Vision call, anyone can trigger spend) and `/api/onboarding/confirm-email` (accepts arbitrary `org_id` and emails whoever you point it at).

---

## 2. Strengths — what's structurally solid

| Area | Strength | Evidence |
|------|----------|----------|
| **Encryption** | `lib/integrations/encryption.ts` — AES-256-GCM, random IV, auth tag verified, fail-fast if key missing | Integration API keys never touch the DB in plain text |
| **Admin helpers** | `lib/admin/totp.ts` (RFC 6238, zero deps), `lib/admin/oauth-link.ts` (timing-safe HMAC verify, replay-safe), `lib/admin/audit.ts` (consistent recordAdminAction) | Added this session; applied across 8 admin routes |
| **Model routing** | `lib/ai/models.ts` centralises `AI_MODELS` + `MAX_TOKENS` constants | Most agents obey it (exceptions below) |
| **Summary-table pattern** | `monthly_metrics`, `daily_metrics`, `dept_metrics` via `lib/sync/aggregate.ts` keeps dashboard queries cheap | Dashboard + tracker + forecast now read from these instead of raw logs |
| **AI labelling** | `components/ui/AiBadge.tsx` + visible badges on alerts, scheduling, budget | EU AI Act Art. 52 transparency hook is in place |
| **GDPR DSAR** | `/api/gdpr` returns comprehensive JSON export; hard-delete cascade covers 40+ tables + orphan auth users | Matches what LEGAL-OBLIGATIONS.md claims |
| **EU data residency** | Supabase Frankfurt, Vercel EU region | Privacy-policy claim is defensible |
| **Integration adapter shape** | Every POS/HR adapter exports a `testConnection()` + `getDailySummary()` pair | New adapters drop in against the same template |
| **Admin panel UX** | Pipeline view + god-page + audit log + agents + health + impersonation magic-link flow | Operator tooling is complete for support workflows |

---

## 3. Critical issues (ship-blockers)

### 3.1 `.env.local` tracked in git
- **Where:** `.env.local` at repo root. Contains `ADMIN_SECRET=admin123`, `CRON_SECRET=dev_cron_secret_123`, mock Anthropic/Stripe keys.
- **Why critical:** Already on disk, already in git history. Trivially discoverable by anyone who clones the repo, including the public sub-agents we ran earlier.
- **Fix:**
  1. Add `.env.local` to `.gitignore` (verify it's ignored).
  2. `git filter-branch` or `git filter-repo` to scrub history (same pattern we used for `.env.vercel` last week).
  3. Rotate every secret currently in the file, even the mock-looking ones. We cannot assume they're truly dummy.
  4. Replace committed file with `.env.example` containing placeholders only.

### 3.2 Tenant leakage in tracker GET
- **Where:** `app/api/tracker/route.ts:29` — `db.from('tracker_data').select('*').eq('business_id', businessId).eq('period_year', year)`. No `.eq('org_id', auth.orgId)`.
- **Why critical:** Service role client bypasses RLS. The only isolation is the `.eq('org_id', …)` clause. This route forgets it. A user who learns another org's `business_id` (UUID, hard but not impossible to acquire — sidebar loads it into the URL on every page) reads that org's P&L.
- **Fix:** Add `.eq('org_id', auth.orgId)` and audit every other route in `app/api/**` for the same omission. Writing a lint rule against `from('<tenanted-table>')` without an org_id filter is worth two hours.

### 3.3 Unauthenticated invoice extraction
- **Where:** `app/api/invoices/extract/route.ts:13` — POST accepts file upload, calls Claude Vision, writes to Supabase Storage at `invoices/${timestamp}-${filename}` with **no org_id prefix** and **no auth check**.
- **Why critical:** (a) cost — anyone can trigger Claude Vision spend on our Anthropic bill; (b) isolation — uploaded invoices land in a shared namespace, path traversal can enumerate; (c) PII — customer invoices contain supplier personal data, stored by us on behalf of others; GDPR Art. 28 obligations kick in.
- **Fix:** Require `getRequestAuth()`, prefix storage path with `${orgId}/`, enforce per-org upload rate limits.

### 3.4 Unauthenticated onboarding confirm-email
- **Where:** `app/api/onboarding/confirm-email/route.ts:7` — accepts arbitrary `org_id` in body, sends confirmation email to whatever address is on the org.
- **Why critical:** email-injection / phishing primitive. Attacker can trigger our domain to email any customer.
- **Fix:** Require either a signed token (same pattern as `oauth-link`) or CRON_SECRET header.

### 3.5 Demo-mode auth bypass
- **Where:** `lib/auth/get-org.ts:18-33` — returns `{ orgId: 'mock-org-id-456', userId: 'mock-user-id-123' }` when `NODE_ENV === 'development'` OR the Supabase URL contains `"mock-supabase-url"`.
- **Why critical:** any Vercel deploy accidentally carrying `NODE_ENV=development` (staging, preview, rolled-back env) makes every route unauthenticated. The URL-string check is even scarier — if someone's `NEXT_PUBLIC_SUPABASE_URL` temporarily contains that substring, same outcome.
- **Fix:** Delete the bypass. If a dev-time mock is needed, gate it behind an explicit `ENABLE_AUTH_MOCK=1` env var that never ships.

### 3.6 `customer-health-scoring` cron bypasses every gate
- **Where:** `app/api/cron/customer-health-scoring/route.ts` + `lib/agents/customer-health-scoring.ts:60–71`.
- **What it violates:** no `isAgentEnabled()` check, no `checkAiLimit()` call, hardcoded `max_tokens: 1000`, `JSON.parse(content.text)` with no try-catch. Runs weekly against every customer regardless of plan/flag/limit.
- **Why critical:** (a) cost — uncontrolled Claude spend; (b) breaks the "customer can disable agents" DPA promise; (c) one malformed Claude response kills the entire cron.
- **Fix:** retrofit against the same shape as `scheduling-optimization`: feature flag → usage check → try/catch JSON.parse → centralised token limit.

### 3.7 Fortnox OAuth state is not CSRF-protected
- **Where:** `app/api/integrations/fortnox/route.ts:87–98` — state is base64(JSON{orgId, businessId}). Callback decodes it but never verifies it originated from our server.
- **Why critical:** attacker can craft a state that binds their Fortnox account to a victim org. When admin/customer completes the flow, attacker's Fortnox creds land in the victim's `integrations` row.
- **Fix:** sign the state with HMAC-SHA256 using ADMIN_SECRET (reuse `lib/admin/oauth-link.ts`). Verify signature in callback before writing.

### 3.8 Upsert keys without guaranteed unique constraints
- **Where:** `lib/sync/engine.ts` — upserts on `revenue_logs` (`org_id,business_id,provider,revenue_date`), `staff_logs` (`pk_log_url`), `covers` (`business_id,date`). No migration found that creates the matching `UNIQUE` constraint.
- **Why critical:** without the constraint, `onConflict` is a no-op and the upsert becomes a plain insert → silent duplicates in the source-of-truth tables. This is the kind of bug that looks fine for months until an anomaly triggers and the number doesn't add up.
- **Fix:** write M011 SQL adding the four missing unique constraints. Before applying, run a dedupe query to collapse existing duplicates.

### 3.9 Nullable `business_id` breaks integration upsert
- **Where:** `app/api/integrations/personalkollen/route.ts:57`, Supabase schema.
- **Why:** Postgres treats `(org_id, NULL, provider)` as always DISTINCT from `(org_id, NULL, provider)`. Any integration with a null business_id duplicates on every reconnect.
- **Fix:** either make `business_id` NOT NULL (and backfill), or add a partial unique index `CREATE UNIQUE INDEX ... WHERE business_id IS NULL`.

### 3.10 `ADMIN_TOTP_SECRET` is optional in production
- **Where:** `app/api/admin/auth/route.ts:33–40` — 2FA only required if env var is set. If unset, falls back to password.
- **Why critical:** single-factor admin access is the single largest lateral-movement risk in the app. Once `Dransfield Invest AB` is registered and TOTP is enrolled (per my earlier step-1 plan), this becomes moot — until then it's a latent risk.
- **Fix:** refuse to start the server in production if `ADMIN_TOTP_SECRET` is unset. The 15 seconds of inconvenience is the whole point.

---

## 4. High severity — fix in the next 2–3 weeks

### 4.1 Twelve tables in code without a migration
`billing_events`, `invoices`, `invoices_with_status`, `feature_flags`, `support_notes`, `support_tickets`, `supplier_mappings`, `pk_sale_forecasts`, `financial_logs`, `api_credentials`, `api_probe_results`, `integration_health_checks`, `pos_connections`, `sync_log`, `customer_health_scores`, plus a `users` mirror of `auth.users`. These exist in production (because the code hits them and succeeds) but have no entry in `sql/M*.sql` or `MIGRATIONS.md`. If Supabase is ever reset, or a new developer reproduces locally, the schema diverges silently. Write M011–M014 migrations that `CREATE TABLE IF NOT EXISTS` each one, authoritatively documenting the shape that production has drifted into.

### 4.2 Dual audit tables (`admin_log` + `admin_audit_log`)
The new helper writes to `admin_audit_log`; legacy code (onboarding/setup-request) and the customer timeline still read/write `admin_log`. Forensic queries need to UNION both or miss events. Consolidate: write a one-time SQL migration copying legacy rows forward, switch readers to the new table, delete `admin_log`.

### 4.3 One bad upstream hangs master-sync
`app/api/cron/master-sync/route.ts:44–52` loops sequentially over all integrations; each handler has no timeout, so a single stuck adapter (Personalkollen response hanging) eats the whole 300-second Vercel budget. Wrap each per-integration call in `Promise.race` with a 60-second `AbortController`, and skip-with-error on timeout.

### 4.4 Sequential upserts inside per-provider loops
`lib/sync/engine.ts` has `for (let i = 0; i < rows.length; i += BATCH) { await ... }` patterns in at least five places. At 5000 shifts that's 100 DB roundtrips serially. Parallelise with `Promise.all(batches.map(...))`. Expect 3–5× throughput improvement per sync.

### 4.5 `/covers` page missing but still linked
`components/MobileNav.tsx:20`, tracker page, other places link to `/covers`. The directory was renamed to `/revenue` in session 6 but three link sites were missed. Users who tap "Covers" on mobile hit a 404.

### 4.6 Forecast page renders half-built
`app/forecast/page.tsx:76–80` has incomplete code. Depending on the data state users see a blank panel. Either finish it or guard with a "Forecasts coming when 60+ days of data is synced" empty state.

### 4.7 AskAI responses not labelled as AI
The assistant floats over dashboard/staff/tracker/revenue/forecast. The answer bubble has no visible AI badge. EU AI Act Art. 52 requires end-users to know they're looking at AI output. Wrap the response with `<AiBadge variant="block" />` — three-line change.

### 4.8 Rate limits only on `/api/ask`
`lib/middleware/rate-limit.ts` exists but only `/api/ask` calls it. `/api/auth/signup`, `/api/businesses/add`, `/api/budgets/generate`, `/api/invoices/extract`, and every admin route should be limited. Any of them can be spammed to drive cost or create denial-of-service.

### 4.9 CRON_SECRET comparison is not timing-safe
`app/api/cron/*/route.ts` use `!==` against `process.env.CRON_SECRET`. Replace with `crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))` — same helper already used correctly in `oauth-link.ts:59`.

### 4.10 Hardcoded model string in `live-api-prober`
`lib/agents/live-api-prober.ts:434` uses the string literal `'claude-3-5-sonnet'` instead of `AI_MODELS`. Besides violating the project's own rule (CLAUDE.md §11), it locks the prober to a deprecated model ID.

---

## 5. Medium severity

- **No RLS on customer-facing raw tables.** `revenue_logs`, `staff_logs`, `tracker_data`, `covers`, `forecasts`, `budgets`, `anomaly_alerts`, `integrations`, `organisations` rely entirely on application-layer org filtering. Defence in depth isn't free, but one RLS policy per table at ~10 minutes each buys us a second layer.
- **Test-connection missing for four supported providers.** Fortnox, Ancon, Caspeco, Swess are marked `supported: true` but the admin test-connection route throws "not implemented" for all four. The admin panel happily saves a bad key and discovers the problem on the next daily cron.
- **Inzii API path never verified live.** `lib/pos/inzii.ts` probes 9 candidate endpoints, every one of them returns 429 or auth errors against `api.swess.se`. We ship against an unconfirmed contract — first real sync may reveal we're pointing at the wrong URL entirely.
- **`nextjs/` folder is dead weight.** Old versions of dashboard/tracker/upgrade/integrations pages live there, not imported anywhere. Delete; it confuses grep and new contributors.
- **`/notebook/studio` is a placeholder.** Links from the sidebar lead to a "coming soon" page. Either ship it or hide the link.
- **Settings page mixes restaurants + supplier mapping + GDPR + digest opt-in.** Tabs or sub-pages would cut cognitive load for power users.
- **`/api/ask` doesn't write to `ai_request_log`.** Usage is gated by daily count in `ai_usage_daily` but we lose the per-request audit trail that would let us debug a spend spike.
- **Dashboard KPI grid doesn't collapse cleanly on mobile.** The `.kpi-row` fix was applied to some pages but not dashboard; tables fall back to horizontal scroll.
- **Tracker `onConflict: 'pk_log_url'` assumes every shift has a non-null pk_log_url.** Shifts created manually (no PK link) get an insert every run, duplicating.
- **No Sentry integration despite `@sentry/nextjs` in package.json.** The SDK is installed but nothing is captured. Vercel logs are ephemeral; production errors vanish after hours.

---

## 6. Meta-patterns — structural concerns

These aren't individual bugs. They're choices that keep generating bugs. Fixing them is higher leverage than fixing the individual symptoms.

### 6.1 Service role everywhere defeats RLS
Every server-side route uses `createAdminClient()` which holds the service role key and bypasses RLS. That means: (a) RLS policies on `daily_metrics` / `monthly_metrics` / `ai_usage_daily` are dead letters, never exercised; (b) correctness depends entirely on every route remembering to `.eq('org_id', auth.orgId)`; (c) one forgotten filter = tenant leakage (see tracker). The safer shape is to route customer-session queries through the anon key + session cookie (which exercises RLS automatically) and reserve the service role for genuinely cross-tenant admin and cron work.

### 6.2 "Supported" means "code compiles"
`lib/integrations/providers.ts` marks seven providers as `supported: true`. The reality per the integrations audit: four of them have no test-connection, one has an unverified API endpoint, one is blocked on OAuth approval, and one was wired this afternoon. We should either downgrade the flag to a more honest `adapter: true | false`, `test_connection: true | false`, `verified_live: true | false`, or accept that customers will see "supported" next to a provider that hasn't been proven against their actual API credentials.

### 6.3 Three AI-agent rules, partial enforcement
CLAUDE.md §11 says (a) never hardcode models, (b) always gate with `checkAiLimit`, (c) always gate with `isAgentEnabled`. Enforcement:
- Anomaly check: unclear (delegates to detector)
- Onboarding success: flag ✓ / cost ✗
- Monday briefing: flag ✓ (no Claude)
- Forecast calibration: flag ✓ (no Claude)
- Supplier price creep: flag ✓ (skeleton)
- Scheduling optimisation: flag ✓ / cost ✗ / expensive Sonnet
- Customer health scoring: flag ✗ / cost ✗ / hardcoded tokens
- Live API prober: hardcoded model

A rule that depends on every author remembering it is a rule we will violate. A linter pass that fails CI if it finds `anthropic.messages.create({ model: '` without going through `AI_MODELS` would stop this permanently.

### 6.4 Silent fallbacks swallow failures
Several places `try { … } catch { /* ignore */ }` or `.catch(() => null)` without logging. Examples: `admin_log` writes in `/api/admin/route.ts`, deletion-request writes, aggregate step in sync engine. When things go wrong in production we have nothing to grep. The rule should be: log every swallowed error at `console.error` minimum, Sentry ideally.

### 6.5 Upsert without verified constraints is a correctness bug class
The upsert patterns that assume unique constraints (revenue_logs, staff_logs, covers) aren't the only ones — every time we add a new adapter we'll reach for the same pattern. If the constraint is missing, onConflict is a silent no-op. Make migration authoring non-negotiable: no new table in code without a corresponding `M*.sql` file, and make the migration file the source of truth for constraints.

### 6.6 @ts-nocheck on the critical path
Per `FIXES.md §1`, `// @ts-nocheck` is the standard workaround for Vercel build errors. The cost is measurable: every `null | undefined` bug we don't catch at compile time is one we catch in production. Session 10 (TypeScript properly enabled) is in the roadmap — every month we wait, more surface area accumulates.

---

## 7. Build problems we'll hit as we grow

Ranked by when they'll bite, not how hard to fix.

### When we get to 5 customers
- **Master-sync will start timing out.** 5 customers × 7 integrations × sequential adapter calls is already on the edge of Vercel's 300-second maxDuration. Parallelising per-integration (section 4.3–4.4) buys us one order of magnitude.
- **Swedish character encoding drift.** `FIXES.md §2` documents that PowerShell edits corrupt UTF-8. New contributors on different machines will cause one of these per month.
- **One duplicate-on-upsert bug will surface** — probably in revenue_logs — and the fix requires both code and SQL migration rollout in lockstep.

### When we get to 20 customers
- **Anthropic cost spikes** as the interactive assistant usage ramps. The $5/month projection assumes ~1 Q/org/week. At 20 customers × 2 Q/day (realistic for engaged users) we're at $60+/month, and no one is watching.
- **Supabase row-count matters.** `revenue_logs` at 20 customers × 10 businesses × 365 days × 2 years = 146k rows. Still fine, but `staff_logs` at shift-granularity is ten times that. The `.limit(50000)` in `aggregate.ts` will silently cap. Pagination becomes mandatory.
- **Support ticket volume hits operator limits.** Admin audit log + customer timeline stays useful only if we actually read them. A weekly operator review cadence needs tooling.

### When we get to 50 customers (the plan target)
- **NIS2 threshold approach.** At 50 employees or €10M revenue, CommandCenter counts as an "important entity" under NIS2 (EU cybersecurity directive). Reporting obligations, formal ISMS, tested incident-response plan. Minimum three months' lead time.
- **GDPR DSAR volume.** 50 customers × ~15 employees each = 750 potential data subjects. Even if 1% exercise Art. 15 per year, that's 7–8 requests; each must be fulfilled within 30 days. Today it's manual.
- **Penetration test is overdue.** Budget ~50–80k SEK for a one-off test before year-end of 50-customer ramp. Delivery lead time 6–8 weeks.
- **AI Act classification must be documented.** We're "limited risk" (transparency only). Writing the 2-page assessment takes an afternoon; not writing it costs much more if regulators ask.

### When we exit trial-only and take paying customers
- **Everything in `LEGAL-OBLIGATIONS.md §10` "Before first paying customer"** is a hard gate. DPAs signed, Fortnox dev program approved, ZDR verified on Anthropic, hard-delete tested end-to-end, privacy policy accurate. Most of this is blocked on `Dransfield Invest AB` registration, which the user has explicitly flagged as pending.
- **Stripe webhook reliability.** `app/api/stripe/webhook/route.ts` writes to unmigrated `billing_events`. If the webhook is down or the table shape drifts, subscriptions can fall out of sync with auth state (paid customer locked out, or cancelled customer still active).
- **Resend deliverability.** Monday briefings and onboarding emails will go to customer decision-makers. Missing emails look worse than obvious missing features. No current bounce tracking.

---

## 8. Recommended remediation sequence

If I had the next 40 hours of focused work, I'd go in this order:

**Hours 0–4 — Stop the bleed.**
1. `.env.local` → .gitignore + history scrub + rotate secrets (1h)
2. Tenant leakage fix in `tracker/route.ts` + grep every tenanted table for missing org_id filter (1h)
3. Auth check on `/api/invoices/extract` + `/api/onboarding/confirm-email` (30min)
4. Delete demo-mode bypass in `lib/auth/get-org.ts` (15min)
5. Fail-fast on `ADMIN_TOTP_SECRET` unset in prod (15min)
6. Timing-safe CRON_SECRET compare everywhere (1h)

**Hours 4–10 — Data integrity.**
7. M011 migration: unique constraints on revenue_logs, staff_logs, covers, plus dedupe script (3h)
8. M012 migration: backfill the 12 orphan tables into MIGRATIONS.md as authoritative (2h)
9. Fix `business_id` nullable upsert on integrations (1h)

**Hours 10–18 — AI/sync discipline.**
10. Retrofit `customer-health-scoring` against the 3-rule template (1h)
11. Remove hardcoded model in `live-api-prober` + add eslint rule against hardcoded model strings (1h)
12. Per-integration timeout + parallel upserts in master-sync (3h)
13. Consolidate admin_log into admin_audit_log (2h)
14. Wire Sentry for captureException on every `catch` we currently swallow (1h)

**Hours 18–24 — UX + integrations polish.**
15. Fix `/covers` references (either restore page or rewrite every link) (30min)
16. Finish forecast page or guard with empty state (2h)
17. Wrap AskAI response in `<AiBadge variant="block" />` (15min)
18. Test-connection endpoints for Fortnox, Ancon, Caspeco, Swess (3h)

**Hours 24–40 — Hardening.**
19. OAuth state HMAC-sign on Fortnox callback (1h)
20. Rate limits on `/api/auth/signup`, `/api/businesses/add`, `/api/invoices/extract`, `/api/budgets/generate`, admin routes (2h)
21. RLS policies on customer-facing raw tables (3h)
22. Delete `nextjs/` folder, `/notebook/studio`, other dead code (1h)
23. TypeScript pass: remove `@ts-nocheck` from the 5 most-edited routes (4h)
24. Backup restore dry-run + documented runbook (2h)
25. Sentry integration wiring + environment config (1h)
26. `ai_request_log` write in `/api/ask` + dashboard surface for AI spend (2h)

Everything else waits for real customers. Priority is correctness → security → UX → scale, not the other way.

---

## 9. What this audit did not cover

- **Performance profiling under load.** No synthetic traffic has been run against the app. N+1 queries and missing indexes are inferred from code, not measured.
- **Bundle size + front-end perf.** Next.js App Router bundles not inspected; no Lighthouse pass.
- **Accessibility (WCAG).** Inline-styles-only pages are likely to score poorly on colour contrast and keyboard navigation.
- **Supabase schema dump.** I read migrations + inferred shape from code; I did not query `information_schema.columns` against the live project. Real constraint state may differ.
- **Third-party API contract verification.** Onslip, Inzii, Caspeco, Ancon are built against docs; live sandbox tests are pending.

Each of these would make a good half-day follow-up audit in its own right.

---

*Generated from six parallel Explore-agent audits: data layer, integrations, frontend UX, AI/cron, security/admin, sync engine/ops. See the task notification transcripts in the session log for the raw findings that back each section.*
