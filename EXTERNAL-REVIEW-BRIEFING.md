# CommandCenter — External Review Briefing
> Generated 2026-05-04 for outside review.
> Paste this into a fresh Claude conversation alongside a request for analysis.

---

## What CommandCenter is

CommandCenter is a SaaS for Swedish restaurants (expanding to Norway + UK)
that consolidates the operational + financial systems an independent
restaurant runs on into one product:

- **Personalkollen** (PK) — staff scheduling + payroll. Source of truth for
  hours and per-shift cost.
- **Fortnox** — Swedish accounting. Source of truth for the legal P&L
  (revenue, food cost, staff cost, overheads, depreciation, financial
  result, net profit).
- **POS** — Personalkollen aggregate, plus optional connectors for Onslip,
  Ancon, Swess, Caspeco. Source of daily revenue + covers + per-dept
  splits.

Owners get a unified dashboard, monthly P&L tracker, weekly AI memo,
budget targets, scheduling suggestions, and an overhead-audit / cost-
intelligence layer on top of Fortnox. Each AI surface is rule-anchored
+ uses Claude (Sonnet 4.6 for analysis, Haiku 4.5 for cheap agents)
through tool-use rather than free-form JSON.

Live URL: https://www.comandcenter.se

## Stack

| Layer | Choice |
|---|---|
| Web framework | Next.js 14.2 App Router |
| Hosting | Vercel Pro (EU regions, Frankfurt/Stockholm preferred) |
| DB | Supabase Pro (Frankfurt). Pure Postgres + RLS + Realtime + Storage |
| Auth | Supabase Auth (`@supabase/ssr`) |
| AI | Anthropic Claude (Sonnet 4.6 for assistant + analysis; Haiku 4.5 for cron agents). Tool-use everywhere. Prompt caching on `/api/ask`. |
| Payments | Stripe (price IDs not yet wired — only blocker for first paid customer) |
| Email | Resend on `comandcenter.se` (Gmail Workspace for inbox, SPF/DKIM/DMARC pass) |
| i18n | `next-intl` v4. Three locales (`en-GB`, `sv`, `nb`). Cookie-based, country-routed |
| Observability | Sentry (errors), structured `console.log` JSON via `lib/log/structured.ts`, Vercel runtime logs |
| Org formation | Pending registration (UK or SE) — blocks Anthropic ZDR, Fortnox dev programme, sub-processor DPAs |

## Data model — the bits that matter

```
organisations  — billing root, has org_number + Stripe customer
businesses     — restaurants within an org (multi-restaurant groups OK)
                 country (SE/NO/GB), opening_days JSONB, business_stage,
                 cost targets, currency, address
organisation_members — user ↔ org (with role: owner/manager/viewer +
                       business_ids[] for scope-limited managers + locale)
integrations   — provider creds (encrypted), config JSONB, status
                 (connected/error/needs_reauth/disconnected)
revenue_logs   — per-provider, per-day revenue with food/bev/dine-in
                 /takeaway split. Multi-source per business by design.
staff_logs     — per-shift cost + hours + OB supplement + lateness
daily_metrics  — aggregator-built summary (POS revenue priority + PK staff
                 priority, dedup'd).
monthly_metrics — same shape, monthly. THE single source of truth read
                  by /api/tracker, Performance page, AI prompts.
                  Every row carries rev_source / cost_source codes that
                  surface the aggregator's decision.
tracker_data   — Fortnox-derived monthly P&L (revenue subsets, costs,
                 financial, net_profit). Written ONLY by
                 lib/finance/projectRollup.ts (single-writer invariant).
tracker_line_items — every Fortnox line, period-tagged, source-tagged.
fortnox_uploads — PDF queue; supersede chain; SHA-256 dedup.
extraction_jobs — async PDF parser/Claude extraction queue.
ai_request_log — per-request cost telemetry; atomic quota gate via RPC.
ai_forecast_outcomes — accuracy reconciler input.
```

## Architecture invariants ("don't break these")

These are documented in detail in CLAUDE.md but summarised here:

### Single-writer + trusted reads
- `lib/finance/projectRollup.ts` is the **only** function that turns a Fortnox extraction into a `tracker_data` row.
- `/api/tracker`, the Performance page, and the aggregator all **read** persisted values verbatim — nothing recomputes.

### Sign convention
- Lives in `lib/finance/conventions.ts` and nowhere else.
- Storage: revenue positive, costs positive, financial signed (negative = interest expense). `net_profit = revenue − food − staff − other − depreciation + financial`.

### Aggregator source priority
- Revenue (per date): `pk_*`/`inzii_*` per-dept rows sum legitimately. Among full-business aggregates (`personalkollen > onslip > ancon > swess`) only ONE per date.
- Staff cost: PK wins ONLY when (a) oldest PK shift_date predates the period, AND (b) PK total is within 70-130% of Fortnox total. Outside the band → use Fortnox with `cost_source='fortnox_pk_disagrees'`. Owner can flip "PK is canonical" override on `/integrations`.
- Annual report flow uses VAT rate to classify revenue (25%=alcohol, 12%=dine-in food, 6%=takeaway/delivery — Wolt/Foodora/Uber Eats).

### Fortnox apply chokepoint (M047)
- Every PDF apply runs `validateExtraction()` (10 rule-based checks) + `auditExtraction()` (Haiku second-opinion) BEFORE any tracker_data write.
- HARD errors (`override_allowed: false`) — never overridable: `org_nr_mismatch`, `period_mismatch`.
- Returns 422 with `kind='validation_blocked'` + structured findings; UI renders as a checklist.
- Belt-and-braces: DB CHECK constraints, `tracker_data.created_via` origin tag, `fortnox_uploads.pdf_sha256` dedup, daily ops cron flagging rogue manual writes.

### Authentication chain
- `signup → email verify → /onboarding → plan pick → app`.
- Email verification mandatory (`email_confirm: false` + Resend-sent branded link via `lib/email/sendVerifyEmail.ts`).
- Implicit-flow handler at `app/auth/handle/page.tsx` reads URL fragment + sets session.
- AppShell renders `<OnboardingGate />` BEFORE `<PlanGate />`. Order is load-bearing — flipping them sends unfinished owners to /upgrade with empty profiles.

### Multi-org membership
- Both auth helpers use `.maybeSingle()` with `.order('created_at', ascending: true).limit(1)` on `organisation_members`. User in ≥2 orgs lands in their oldest membership. Future explicit-org-switcher is the only acceptable replacement.

### Atomic AI quota
- `/api/ask` uses `checkAndIncrementAiLimit()` via the `increment_ai_usage_checked` RPC (atomic INSERT … ON CONFLICT). Cron-driven AI agents may keep using legacy two-step (deprecated) since they run serially under cron locks.

### next-intl provider scope
- Every `useTranslations` / `useLocale` / `useFormatter` consumer MUST be a child of `<NextIntlClientProvider>`. Sibling placement crashes SSR with a wrapper-masked `Error(void 0)` on every page (incident 2026-05-01, ~1h to find — wrapper hid the real error).

### Holiday module convention
- Pure-compute, country-routed, no DB. `lib/holidays/<country>.ts` exports `get<Country>Holidays(year)`. Adding a country = one file + one router-line.

## Recent sprints (last ~3 weeks)

### Session 14 — Sprint 1 of external review (2026-04-27)
External review delivered a 10-task remediation list. Sprint 1 (tasks 1-5) shipped and migrations applied 2026-04-28:

- **Task 1 — middleware rewritten.** Cheap structural JWT validation on 17 protected prefixes. No Supabase network call in middleware. Cookie-parsing util handles all 3 `@supabase/ssr` shapes including chunked.
- **Task 2 — multi-org `.single()` fix.** Both auth helpers switched to `.maybeSingle()` + deterministic-by-earliest membership.
- **Task 3 — Fortnox supersede chain join table (M032).** `fortnox_supersede_links` so multi-month uploads preserve every period's parent on reject.
- **Task 4 — atomic AI quota gate (M033).** Closes the TOCTOU window where bursts could blow daily caps.
- **Task 5 — kill-switch table-scan removal.** RPC + indexes replacing per-call full-table scans.

### Session 15 — onboarding overhaul + auth + holidays (2026-05-02)

**Onboarding wizard rebuilt** to capture every business-context anchor the AI needs from day 1:

- M046 columns: `businesses.opening_days JSONB` + `businesses.business_stage` enum (`new` / `established_1y` / `established_3y`)
- 3 real steps now (Restaurant → Systems → Done; the marketing welcome slide was removed)
- Restaurant step collects: address, organisationsnummer (validated via `lib/sweden/orgnr.ts`), business stage, opening days (Mon-Sun toggles), cost targets, country picker (SE / NO / GB defaulted SE)
- Optional last-year P&L PDF upload on Systems step (only when stage ≠ 'new'); flows through existing `/api/fortnox/upload`
- Org-nr capture moved out of signup form to onboarding's Restaurant step. Signup is back to 4 fields (~30s). Single source-of-truth helper `lib/sweden/applyOrgNumber.ts` writes DB + Stripe metadata + tax_id sync; both `/api/onboarding/complete` and `/api/settings/company-info` POST through it.
- `OrgNumberGate` + `OrgNumberBanner` components DELETED — onboarding requires org-nr upfront.

**Auth flow + gate chain:**
- Email verification ON. `email_confirm: false` + Resend-sent link via `lib/email/sendVerifyEmail.ts`.
- Implicit-flow handler at `/auth/handle` (client-side hash parser).
- `OnboardingGate` mirrors `PlanGate` shape; mounted in `AppShell` BEFORE `PlanGate`.
- `/api/me/onboarding` endpoint backs the check (treats org as completed if `onboarding_progress.completed_at` set OR org has ≥1 business — legacy customers don't get surprise-redirected).
- Free-trial copy retired (Pricing memory: trial retired 2026-04-23).

**Holidays first-class data:**
- `lib/holidays/sweden.ts` (17 SE restaurant-relevant days, Easter via Anonymous Gregorian algorithm + Midsummer/All Saints' "first weekday in window")
- Country router (`getHolidaysForCountry`) + windowed lookup (`getUpcomingHolidays`)
- `/api/holidays/upcoming` endpoint, locale-named
- AttentionPanel surfaces next holiday inside 14d
- OverviewChart paints Sat/Sun + holidays red on the X-axis day labels
- Wired into weekly memo prompt (21d window) + scheduling cron (28d window)

**Production-down recovery (2026-05-01):**
- Every page 500'd because `<CookieConsent />` was a sibling of `<NextIntlClientProvider>` instead of a child. next-intl's runtime wrapper masked the SSR throw as anonymous `Error(void 0)`. Took ~1h to find. Fix: one-line move + defensive `i18n/request.ts` `onError` + `getMessageFallback` so future regressions log a real cause.

### Session 16 — data-source guardrails (2026-05-03)

Born from two production data-quality incidents:

- **Vero March 2026** — Performance page showed 2,842,948 kr revenue. PK reference: 1,422,650 kr. Exact 2× signature → aggregator double-count from PK aggregate stacking with another POS provider that the dedup didn't handle.
- **Rosali March 2026** — labour ratio 13.6%, net margin 57.5% (impossible). Two compounding bugs: (a) `tracker_data` row with `source='manual'` + no `fortnox_upload_id` (owner says they didn't enter it), (b) PK staff_cost was 33% of Fortnox value because PK was connected mid-April with partial historical backfill.

**Fixes (all shipped + applied):**
- Aggregator dedup extended to ALL full-business providers
- Two-signal PK staff agreement gate (coverage + 70-130% Fortnox match)
- `lib/admin/disagreements.ts` + daily 06:30 UTC ops email
- M047 migration: `tracker_data.created_via` origin tag + `fortnox_uploads.pdf_sha256` dedup + DB CHECK constraints
- Daily 06:45 UTC `/api/cron/manual-tracker-audit` flags rogue manual rows
- `lib/fortnox/validators.ts` (10 rule-based checks) + `lib/fortnox/ai-auditor.ts` (Haiku verdict) chokepoint at apply
- UI checklist in the review modal renders the structured 422 response

### Side work this week
- **Country selector phase 1** in onboarding (data capture only; SE/NO/GB)
- **Norway + UK holiday modules** + shared Easter math refactor
- **Budget AI branches on `business_stage`** — when stage='new', skip historical-anchor rule
- **PK-canonical override** on `/integrations` (per-business JSONB flag)
- **Sprint 2 close-out** (4 of 5 tasks were already done silently; Task 10 = move ~70 root files into `archive/`)

## Cron schedule (Vercel)

```
00:00  *  ─  *  *  *  master-sync           daily 05:00 UTC — full sync sweep
*/2    *  *  *  *  extraction-sweeper        every 2m  — kick stuck PDF extractions
00:00  6-23 *  *  *  catchup-sync           hourly during day — recent-period top-up
30:00  5  *  *  *  anomaly-check            daily 05:30 UTC
00:00  6  *  *  *  health-check             daily 06:00 UTC
30:00  6  *  *  *  data-source-disagreements-alert  daily 06:30 UTC (NEW)
45:00  6  *  *  *  manual-tracker-audit     daily 06:45 UTC (NEW)
00:00  7  *  *  *  ai-accuracy-reconciler   daily 07:00 UTC
00:00  8  *  *  *  ai-daily-report          daily 08:00 UTC
00:00  6  *  *  1  weekly-digest            Mon 06:00 UTC — owner memo email
00:00  7  *  *  1  scheduling-optimization  Mon 07:00 UTC
00:00  4  1  *  *  forecast-calibration     1st of month 04:00 UTC
00:00  5  1  *  *  supplier-price-creep     1st of month 05:00 UTC
00:00  6  2  *  *  cost-intelligence        2nd of month 06:00 UTC
[plus weekly: customer-health-scoring, api-discovery, industry-benchmarks, invoice-reconciliation, ai-log-retention]
```

## What's still on the running list

Three categories:

### Revenue-blocking
- **Stripe price IDs.** New tiers (Solo 1,995 / Group 4,995 / Chain 9,995 / Founding 995 SEK/mo) need their Stripe price IDs wired into the upgrade page. Without this, the first paid customer's checkout 500s.

### Phase 2 country expansion (deferred until first non-SE customer)
- Currency formatter (currently every `fmt(n)` hardcodes `kr`)
- Org-nr validator router (currently `lib/sweden/orgnr.ts` is hardcoded SE format)
- VAT rate table (SE 25/12/6 baked into `classifyByVat`)
- Country-specific accounting integrations (Tripletex/Visma Norge for NO, Xero/QuickBooks for UK)
- Country-specific payroll integrations (Tripletex/UniMicro for NO)
- Sub-processor DPA per jurisdiction

### i18n coverage gaps
- Big pages still on English literals: `app/integrations/page.tsx`, `app/overheads/upload/page.tsx`, `app/overheads/review/page.tsx`, `app/notebook/page.tsx`, `app/departments/[id]/page.tsx`, `app/weather/page.tsx`
- Legal pages (privacy/terms/security) deferred to a different workflow — full document translations rather than key-by-key
- sv + nb still flagged `awaiting_review` — needs native-speaker pass

### Other deferred
- **Bolagsverket cross-check at onboarding** — confirm the org-nr matches a real registered company; auto-fill registered name + fiscal year start
- **VAT-inclusion explicit detector** — current subset-cap check covers most cases
- **Multi-system reconciliation cron (quarterly)** — disagreements alert covers most of this
- **Cross-business sanity sweep** — peer comparisons noisy; lower leverage
- **Plan-aware AI quota** — currently org-level, not tier-aware (Founding gets same as Chain)

## Specific questions where I'd value outside review

These are the threads I'd most like a fresh set of eyes on:

### 1. Data-source priority + disagreement detection
The "single-writer + per-date dedup + two-signal staff agreement + owner override" stack is layered. Is this reasonable, over-engineered, or under-defended? Specifically:
- The 70-130 % PK-vs-Fortnox agreement band — is this the right shape, or should it be percentile-based (e.g. flag when PK is in the bottom 25% of historical PK/Fortnox ratio for this business)?
- Are there source-priority cases I haven't anticipated for Caspeco / Onslip / Ancon / Swess when they coexist?
- Should the disagreement digest ever cause a hard pause on the AI surfaces (budget/scheduling) for an affected business, or just flag-and-continue (current behaviour)?

### 2. Auth gate chain robustness
- Should `OnboardingGate` and `PlanGate` be middleware-level (Edge) instead of client-side useEffect redirects? Latency vs cost tradeoff?
- The implicit-flow handler at `/auth/handle` is pure client-side — what's the failure-mode catalogue I'm missing? (Browser blocks fragments? Tab closed mid-redirect? Token reused?)
- Email verification is mandatory but the flow has 4 distinct redirect hops (verify endpoint → callback → `/auth/handle` → `/onboarding`). Is that fragile?

### 3. Fortnox apply guardrails
- 10 rule-based checks + 1 Haiku auditor. Is the rule set complete? What do real-world accountants tell their clients to double-check that I haven't encoded?
- The HARD errors are `org_nr_mismatch` and `period_mismatch`. Should `scale_anomaly` (50% deviation from prior 6-month median) be HARD too? Currently it's soft (overridable with force).
- AI auditor cost: ~$0.0005 per apply. Worth the spend or noise?

### 4. AI surface design
- Cost budget at 50 customers: Sonnet 4.6 + Haiku 4.5 mix runs ~$30-50/month. Is the model choice the right one across surfaces?
- Tool-use everywhere (vs. JSON-mode regex parsing): are there surfaces where tool-use is overkill?
- Prompt caching is on `/api/ask` only — should it be on all the cron agents?

### 5. Country expansion (phase 2)
- Phase 1 captures country at onboarding. What's the right time to build phase 2? When the first NO/UK customer signs up?
- Is the per-country file pattern (`lib/sweden/orgnr.ts`, `lib/holidays/<country>.ts`) the right architecture, or should I move to a single localisation table per concern (orgnr, currency, VAT, holidays)?

### 6. Operations & resilience
- Crons run on a quiet 5–8 UTC window. If a cron silently fails for a week, what's my detection latency? (Honest answer: probably 7+ days.)
- Sentry catches errors, structured logs catch warnings. What's the right alert layer for "this cron returned 200 but did 0 work"?
- Sub-daily aggregation lock (M027): is the lease pattern correct, or am I missing edge cases?

### 7. Customer journey gaps I might be missing
- Onboarding is solid up to plan-pick. But what about:
  - First "I uploaded a PDF, when do I see the result?" moment
  - Failure modes for the first integration sync (PK API key wrong, Fortnox OAuth expired, etc.)
  - The "I'm a manager, not an owner" experience (M043 added roles but the UI hasn't surfaced them everywhere)
- Are there moments in the journey that need an in-app explanation banner I haven't thought of?

### 8. Hidden technical debt
- Where in the codebase would you bet money the next "Vero 2× revenue" or "Rosali 13.6 % labour" surprise will surface?
- The `archive/` move cleaned 70 files but the active root is still 13 markdown docs. Are there structural overlaps (eg. `ARCHITECTURE-PLAN.md` vs `Admin-Console-Rebuild-Plan.md` vs `AI-AGENTS-MASTER-PLAN.md`) that should be consolidated?

## What's NOT in the review (intentionally out of scope)

- Stripe price IDs — listed as known revenue-blocker; will tackle once outside review is in
- Marketing site / landing — separate concern
- Iterative customer support tooling — early days; current admin surface (`/admin/v2`) is functional
- Mobile app — not on the roadmap

---

## How to use this briefing

Paste it into Claude.ai with a prompt like:

> I run a Swedish restaurant SaaS. Here's a complete state-of-the-product
> briefing. I want a thorough technical + product review focused on
> sections 1-8 of the "Specific questions" block at the end. Be direct
> about gaps, missed defensive layers, scaling cliffs, and journey
> moments I haven't thought through. Where you have an opinion, give it.
