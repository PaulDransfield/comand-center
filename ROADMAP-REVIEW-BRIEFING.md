# CommandCenter — Roadmap Review Briefing
> Generated 2026-05-07 for outside review.
> Paste this into a fresh Claude.ai conversation alongside a request to help prioritise the roadmap.

---

## What CommandCenter is

CommandCenter is a SaaS for Swedish restaurants (expanding to Norway + UK) that consolidates the operational + financial systems an independent restaurant runs on into one product:

- **Personalkollen** (PK) — staff scheduling + payroll. Source of truth for hours and per-shift cost.
- **Fortnox** — Swedish accounting. Source of truth for the legal P&L (revenue, food cost, staff cost, overheads, depreciation, financial result, net profit).
- **POS** — Personalkollen aggregate plus optional connectors for Onslip, Ancon, Swess, Caspeco. Source of daily revenue + covers + per-dept splits.

Owners get a unified dashboard, monthly P&L tracker, weekly AI memo, budget targets, scheduling suggestions, and an overhead-audit / cost-intelligence layer on top of Fortnox. AI surfaces are rule-anchored + use Claude (Sonnet 4.6 for analysis, Haiku 4.5 for cheap agents) through tool-use rather than free-form JSON.

Live URL: https://www.comandcenter.se

## Stack

| Layer | Choice |
|---|---|
| Web | Next.js 14.2 App Router |
| Hosting | Vercel Pro (EU regions) |
| DB | Supabase Pro (Frankfurt). Postgres + RLS + Realtime + Storage |
| Auth | Supabase Auth (`@supabase/ssr`) |
| AI | Anthropic Claude — Sonnet 4.6 (assistant + analysis), Haiku 4.5 (cron agents). Tool-use everywhere. Prompt caching on `/api/ask`. |
| Payments | Stripe (price IDs not yet wired — only blocker for first paid customer) |
| Email | Resend on `comandcenter.se` (Gmail Workspace inbox, SPF/DKIM/DMARC pass) |
| i18n | `next-intl` v4. Locales: `en-GB`, `sv`, `nb` |
| Org formation | Pending registration (UK or SE) — blocks Anthropic ZDR, Fortnox dev programme, sub-processor DPAs |

## Pricing (live since 2026-04-23)

| Plan | Price/mo | Daily AI cap | Restaurants | Notes |
|---|---|---|---|---|
| Founding | 995 kr | 30 | 1 | 24-mo lock, 10 spots only |
| Solo | 1 995 kr | 30 | 1 | |
| Group | 4 995 kr | 100 | 5 | "Most popular" |
| Chain | 9 995 kr | unlimited (500/day safety) | unlimited | |

Free trial retired — paid from day one.

## Cost model (key constraint: AI is the only variable per-customer cost)

**Fixed infra** ≈ 500 kr/mo total (Vercel Pro $20 + Supabase Pro $25 + Gmail Workspace ~$12). Doesn't scale per customer.

**Variable AI cost per customer** (modeled, current rates):

| Plan | Expected COGS | Worst case (Sonnet-only) | Modeled margin |
|---|---|---|---|
| Founding | ~60 kr/mo | ~120 kr/mo | 88% |
| Solo | ~60 kr/mo | ~120 kr/mo | 94% |
| Group | ~210 kr/mo | ~420 kr/mo | 92% |
| Chain | ~900 kr/mo | ~2 100 kr/mo | 79% |

Hard ceiling per plan in `lib/ai/usage.ts` (founding/solo 150, group 500, chain 1 500). Above it → block with "contact support".

Live spend visible at `GET /api/admin/ai-usage`.

---

## State of the product (last ~3 weeks)

### Session 16 (2026-05-03) — data-source guardrails
Triggered by two production data-quality incidents (Vero showing 2× revenue from aggregator double-count; Rosali showing impossible 13.6% labour ratio from a rogue manual tracker row + partially-backfilled PK).

Shipped:
- Aggregator dedup extended to ALL full-business POS providers (per-date, source-priority-aware: `personalkollen > onslip > ancon > swess`)
- Two-signal PK staff agreement gate (coverage AND 70–130% Fortnox match) — outside the band → use Fortnox with `cost_source='fortnox_pk_disagrees'`
- Source-agnostic admin alerts (`lib/admin/disagreements.ts` + 06:30 UTC cron emailing ops digest)
- M047: `tracker_data.created_via` origin tag, `fortnox_uploads.pdf_sha256` dedup, CHECK constraints on financial columns
- Fortnox apply chokepoint: 10 rule-based validators + Haiku second-opinion auditor BEFORE any tracker_data write. Returns 422 with structured findings; UI renders as inline checklist
- 06:45 UTC `manual-tracker-audit` cron flags rogue manual writes

### Session 15 (2026-05-02) — onboarding + auth + holidays
- Onboarding wizard rebuilt (Restaurant → Systems → Done). Captures opening days, business stage (`new`/`established_1y`/`established_3y`), org-nr (validated), country picker (SE/NO/GB)
- Email verification mandatory; signup → email verify → `/onboarding` → plan pick → app
- Two-gate AppShell: `OnboardingGate` BEFORE `PlanGate` (order is load-bearing)
- `OrgNumberGate` + `OrgNumberBanner` deleted (onboarding requires org-nr upfront)
- Holidays: pure-compute, country-routed, no DB. SE module shipped; NO + UK plug in as sibling files
- AttentionPanel surfaces next holiday (14d window); OverviewChart paints weekend/holiday X-axis labels red
- Wired into weekly memo prompt (21d) + scheduling cron (28d)
- **Production-down recovery (2026-05-01):** every page 500'd because `<CookieConsent />` was a sibling of `<NextIntlClientProvider>` instead of a child. Fix: one-line move + defensive `i18n/request.ts` `onError`/`getMessageFallback` so future regressions log a real cause

### Session 14 (2026-04-27) — Sprint 1 of external code review
- Middleware rewritten — structural JWT validation on 17 protected prefixes, no Supabase network call
- Multi-org `.single()` fixed → `.maybeSingle()` + deterministic-by-earliest membership
- Fortnox supersede chain join table (M032) — multi-month uploads now restore every parent on reject
- Atomic AI quota gate (M033) — closes TOCTOU window
- Kill-switch table-scan removed → RPC + indexes

### Side work (2026-05-04 → 2026-05-07)
- Norway + UK holiday modules shipped (full country expansion of the holidays primitive)
- Budget AI branches on `business_stage` — when stage='new', skip historical-anchor rule
- PK-canonical override on `/integrations` (per-business JSONB flag)
- i18n extraction: `/group` page + `AttentionPanel` shipped 2026-05-04; `/integrations` page shipped 2026-05-07
- Cost-control doc refreshed for the new pricing tiers
- `MONTHLY_COST_CEILING_SEK` map gained `founding`/`solo`/`chain` keys

---

## Architecture invariants ("don't break these")

1. **Single-writer + trusted reads** — `lib/finance/projectRollup.ts` is the only function turning a Fortnox extraction into `tracker_data`. Readers (tracker, Performance page, aggregator) trust persisted values verbatim.
2. **Sign convention** lives in `lib/finance/conventions.ts` only. Storage: revenue +, costs +, financial signed (negative = interest expense). `net_profit = revenue − food − staff − other − depreciation + financial`.
3. **Aggregator priority** — revenue per-date dedup picks one full-business aggregate; staff cost gated on coverage AND 70–130% Fortnox agreement; VAT rate classifies revenue (25%=alcohol, 12%=dine-in food, 6%=takeaway/delivery).
4. **Fortnox apply chokepoint (M047)** — validators + AI auditor BEFORE any tracker_data write. HARD errors (`org_nr_mismatch`, `period_mismatch`) never overridable.
5. **Auth gate order** — `OnboardingGate` BEFORE `PlanGate` in `AppShell`. Order is load-bearing.
6. **Multi-org** — both auth helpers use `.maybeSingle()` + `.order('created_at', asc).limit(1)`. User in ≥2 orgs lands in their oldest membership until an explicit switcher ships.
7. **Atomic AI quota** — user-facing `/api/ask` uses `checkAndIncrementAiLimit()` (atomic RPC). Cron agents may keep legacy two-step (deprecated) since they run serially under cron locks.
8. **next-intl provider scope** — every `useTranslations` consumer is a child of `<NextIntlClientProvider>`. Sibling placement crashes SSR with masked `Error(void 0)` on every page.
9. **Holiday module convention** — pure-compute, country-routed, no DB. Adding a country = one file + one router-line.

---

## Roadmap — what's in flight or queued

### A. Revenue-blocking (must ship first)
1. **Stripe price IDs.** All 7 needed (founding + solo + group + chain × monthly + annual where applicable). Without these, the first paid customer's checkout 500s. Steps documented in `lib/stripe/config.ts`.
2. **Plan-aware AI quota.** Today the daily cap is org-level via `plans[planKey].ai_queries_per_day` but cost ceilings only differ by plan key — there's no per-plan model-tier policy. A Founding customer can theoretically burn through Sonnet-heavy queries the same way a Chain customer does. Worth gating Sonnet to higher tiers, or applying tier-aware `MAX_TOKENS`?
3. **Bolagsverket cross-check at onboarding.** Verify the org-nr matches a real registered Swedish company; auto-fill registered name + fiscal year start. Prevents typo'd org-nrs and gives onboarding a "this is real" moment.

### B. i18n coverage gaps
Done: `/group`, `/integrations`, `/auth/handle`, `/onboarding`, `/dashboard`, `/forecast` (mostly), `/departments` (mostly), `AttentionPanel`.

Still mostly-English:
- `app/overheads/upload/page.tsx`
- `app/overheads/review/page.tsx`
- `app/notebook/page.tsx`
- `app/scheduling/page.tsx` (hardcoded weekday names; high volume)
- `app/departments/[id]/page.tsx`
- `app/weather/page.tsx`
- Legal pages (privacy / terms / security) — deferred to a doc-translation workflow rather than key-by-key
- `sv` + `nb` files mostly flagged `awaiting_review` — needs native-speaker pass before public launch

### C. Country expansion phase 2 (deferred until first non-SE customer)
- Currency formatter (every `fmt(n)` hardcodes `kr`; needs locale-aware NOK/GBP)
- Org-nr validator router (`lib/sweden/orgnr.ts` is hardcoded SE format)
- VAT rate table (SE 25/12/6 baked into `classifyByVat`)
- Country-specific accounting integrations (Tripletex/Visma Norge for NO; Xero/QuickBooks for UK)
- Country-specific payroll integrations (Tripletex/UniMicro for NO)
- Sub-processor DPA per jurisdiction (blocked on company formation either way)

### D. Operations + resilience
- **Silent-fail detection** — crons run on a quiet 5–8 UTC window. If a cron silently fails for a week (returns 200 but did 0 work) detection latency is 7+ days. What's the right alert layer between Sentry-catches-errors and structured-logs-catch-warnings?
- **Sub-daily aggregation lock (M027)** — lease pattern in place; needs a stress test
- **Backup restore drill** — Supabase Pro has daily backups + PITR. Never tested a real restore.
- **Org switcher** — multi-org users currently land deterministically in their oldest membership. Cookie or query-param switcher needed before any multi-org B2B sale.

### E. Customer journey gaps
- "I uploaded a PDF, when do I see the result?" moment — extraction takes 30–90s; current UI shows queued/processing but no ETA
- First-integration-sync failure modes (PK API key wrong, Fortnox OAuth expired, partial backfill) — error surfaces are inconsistent across providers
- "I'm a manager, not an owner" — M043 added roles + scope-limited `business_ids[]` but the UI hasn't surfaced them everywhere; managers still see the owner upgrade banner
- Email verification → `/onboarding` redirect has 4 hops; one transient failure breaks the chain

### F. Deferred follow-ups (lower priority)
- VAT-inclusion explicit detector (subset-cap covers most cases today)
- Multi-system reconciliation cron — quarterly digest (the daily disagreements alert covers most of this)
- Cross-business sanity sweep — peer comparisons noisy; lower leverage
- Per-day holiday-name tooltip in OverviewChart
- Doc consolidation — 13 active root markdown docs; structural overlap between `ARCHITECTURE-PLAN.md`, `Admin-Console-Rebuild-Plan.md`, `AI-AGENTS-MASTER-PLAN.md`

---

## Cron schedule (Vercel — current)

```
05:00 UTC daily ─ master-sync                 full daily sync sweep
05:30 UTC daily ─ anomaly-check
06:00 UTC daily ─ health-check
06:30 UTC daily ─ data-source-disagreements-alert  (NEW — Session 16)
06:45 UTC daily ─ manual-tracker-audit             (NEW — Session 16)
07:00 UTC daily ─ ai-accuracy-reconciler
08:00 UTC daily ─ ai-daily-report
06:00 UTC Mon  ─ weekly-digest                owner memo email
07:00 UTC Mon  ─ scheduling-optimization
04:00 UTC 1st  ─ forecast-calibration         monthly
05:00 UTC 1st  ─ supplier-price-creep         monthly
06:00 UTC 2nd  ─ cost-intelligence            monthly
+ weekly: customer-health-scoring, api-discovery, industry-benchmarks,
          invoice-reconciliation, ai-log-retention
+ every 2m:    extraction-sweeper             kicks stuck PDF jobs
+ hourly 6-23: catchup-sync                   recent-period top-up
```

---

## Open questions where I'd value outside input on roadmap shape

### 1. What's the right next 2-week slice?
Given the state above, my instinct is:
- **Week 1:** Stripe price IDs + plan-aware AI quota + Bolagsverket cross-check (the three revenue-blockers)
- **Week 2:** i18n coverage push on `/scheduling` + `/notebook` + `/overheads/*` (final pre-launch sweep) + native-speaker pass on `sv` + `nb`

Is that the right order, or should something else jump the queue? In particular: does the org-switcher belong here, or is "deterministic-by-earliest" fine until after the first paid customer?

### 2. Country expansion timing
Phase 1 (data capture) shipped Session 15. Phase 2 is roughly 4–6 weeks of work spread across currency formatter, VAT tables, integrations, DPAs. Build it speculatively now while there's no customer pressure, or wait until the first NO/UK signup creates urgency? I lean wait — but what's the failure mode of waiting?

### 3. AI surface tuning
At 50 customers the modeled AI spend is ~$30–50/mo on the Sonnet+Haiku mix. Two specific questions:
- Should prompt caching be on every cron agent, not just `/api/ask`? Cron contexts repeat across days for the same business — caching could halve token cost
- Tool-use is on 4 agents now; should the remaining 5 (anomaly-check, supplier-price-creep, scheduling-optimization, weekly-digest, cost-intelligence) move from regex-JSON to tool-use too? Or is that engineering for engineering's sake?

### 4. Resilience drill
Crons silently failing is the scenario I'm least defended against. Options:
- (A) Cron health table: each cron writes `{name, last_run_at, last_status, last_row_count}` to a table; daily digest flags anything > 25h stale or `last_row_count = 0`
- (B) Synthetic monitor: separate daily cron that issues a probe through the same code path and pages on failure
- (C) Vercel cron failure logs alone (current — silent for "200 but did nothing")

I lean (A) for cost + simplicity. Pushback?

### 5. Hidden technical debt
Where in the codebase would you bet money the NEXT "Vero 2× revenue" or "Rosali 13.6% labour" surprise will surface? Specifically among:
- The aggregator's interaction with new POS connectors (Caspeco, Onslip, Ancon — currently inactive but partially wired)
- The Fortnox supersede chain on multi-year backfills
- The PK sync's break-net-of-shifts math
- The forecast calibration agent's accuracy reconciler write path

### 6. Customer journey moments
Are there moments in the journey that need an in-app explanation banner I haven't thought of? Specific candidates:
- After first PDF upload, before extraction completes
- After first integration connect, before first sync completes
- The week between "you have less than 14 days of data" and "we have enough to forecast"
- The transition from "stage = new" (no historical anchor) to "stage = established_1y" (anchored)

### 7. Revenue strategy
Founding tier (995 kr/mo, 24-mo lock, 10 spots) is the planned acquisition wedge. Without paid customers yet, what's the right validation step before Stripe wires up?
- Manual invoicing for first 3 customers, defer Stripe entirely?
- Stripe payment links (no checkout integration) for first 10?
- Full Stripe checkout + price IDs from day one?

---

## How to use this briefing

Paste it into Claude.ai with a prompt like:

> I run a Swedish restaurant SaaS. Here's a complete state-of-product briefing as of 2026-05-07. I want a roadmap review focused on the open questions at the end. Be direct: tell me what to do first, what I'm under-investing in, and what I should stop building. Where you have an opinion, give it. Where you'd want to see code or data before deciding, name what you'd want to see.

Companion docs in the repo for deeper context if needed: `CLAUDE.md` (working invariants), `ROADMAP.md` (full session-by-session log), `FIXES.md` (incident archive), `MIGRATIONS.md` (DB migration registry), `EXTERNAL-REVIEW-BRIEFING.md` (the prior 2026-05-04 technical-review-shaped briefing).
