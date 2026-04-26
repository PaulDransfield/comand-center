# CLAUDE.md — Working Guidelines
> Last updated: 2026-04-26 | Session 13 — PK auto-recovery + Fortnox Tier 2 rebuild
> See ARCHITECTURE-PLAN.md for the full audit + phased roadmap.

> **Session 13 invariants (2026-04-26):**
>   • **Single writer, trusted reads.** `lib/finance/projectRollup.ts` is the only function that turns extracted Fortnox data into a `tracker_data` row. /api/tracker, the Performance page, and the aggregator all read the persisted values verbatim — no recompute. If the formula changes, change `projectRollup` + re-apply existing extractions (their `extracted_json` is immutable, projection is idempotent).
>   • **Sign convention lives in `lib/finance/conventions.ts` and nowhere else.** Storage uses: revenue positive, costs positive, financial signed (negative = interest expense). `net_profit = revenue − food − staff − other − depreciation + financial`. Display layer translates if it needs different signs.
>   • **Swedish VAT rates ARE the revenue classifier.** 25 % = alcohol, 12 % = dine-in food, 6 % = takeaway (Wolt / Foodora / Uber Eats). Storage columns: `dine_in_revenue`, `takeaway_revenue`, `alcohol_revenue` — each a subset of `revenue`, never additive. `classifyByVat` in extract-worker enforces this; downstream readers trust the rollup. Don't lump 6 % into food anywhere.
>   • **fortnox_uploads supersede chain.** Re-uploading a corrected PDF for the same period marks the old upload `status='superseded'` and links via `supersedes_id` / `superseded_by_id`. Line items cleared by `source_upload_id` (NOT period_month — that filter was the multi-month reject bug). Reject walks the chain backwards: predecessor restored to 'applied'.
>   • **PK sync `needs_reauth` auto-probe.** Every sync entry point uses `lib/sync/eligibility.ts::filterEligible()`. Includes connected + due-for-probe needs_reauth (last attempt > 6 h). Don't filter `.eq('status','connected')` directly anywhere new.
>
> Infra plans (as of 2026-04-23):
>   • Supabase: **Pro** — daily backups, PITR, 8GB DB, no-pause
>   • Vercel: **Pro** — sub-daily crons, Rolling Releases, preview password protection
>   • GitHub: Free (fine at current scale)
>   • Email: Gmail Workspace on `comandcenter.se` — paul@ mailbox + 11 aliases, SPF/DKIM/DMARC all PASS
>
> Key additions (2026-04-23, session 12):
>   • New page: `/financials/performance` — unified Revenue / Food / Labour / Overheads / Net-margin view with Week/Month/Quarter/YTD granularity, period picker, compare dropdown, waterfall + donut + trend sparklines + "What's tunable" attention panel. Replaced the dead `/cashflow` route entirely.
>   • AI layer upgrade: `lib/ai/rules.ts` (shared benchmarks / scheduling-asymmetry / voice / forecast-anchor), tool-use replaces regex-JSON on 4 agents, prompt caching on /api/ask, `lib/ai/outcomes.ts` + budget_coach feeds the accuracy loop, `lib/ai/contextBuilder.ts` consolidates /api/ask enrichment
>   • PK hardening: `include_drafts=1` (scheduling AI no longer silently empty), timezone-tagged timestamps (endOfDay always emits `Z`), sync cursors (M024 pending), `work_time` net-of-breaks, COGS + staff_uid + sale_center + staff employments captured
>   • Sync engine: resets `status='connected'` on every successful sync (fixes FIXES §0i), typed `PersonalkollenAuthError` → `needs_reauth` + dedup-email (M022)
>   • UX: sticky sidebar, action-pill on scheduling AI, "why is AI advice missing" explanations
>   • Admin: 4 routes locked down (SEC-2026-04-22, FIXES §0g), customer-list cache-bust (§0h), new /admin/diagnose-pk UI
>
> Key architecture additions (2026-04-21 → 22):
>   • Job queue: extraction_jobs + dispatcher/worker/sweeper pattern (M017)
>   • Tenant isolation: RLS on 5 previously-exposed tables + current_user_org_ids() (M018)
>   • Realtime: fortnox_uploads + extraction_jobs pushed via supabase_realtime (M019)
>   • AI learning: ai_forecast_outcomes + capture hook + accuracy reconciler + owner feedback UI (M020)
>   • pg_cron firing extraction worker every 20s + 1-min stale-release (M021)
>   • Extraction rebuilt: Sonnet 4.6 + extended thinking + tool use + prompt caching + validation
>   • Budget AI hardened: historical anchor, current-month rule, data-gap handling, code-level clamps
>   • Billing correctness: stripe_processed_events dedup + org_rate_limits persistence
>   • Reusable helpers: requireAdmin(), orgRateLimit(), withTimeout(), log (structured)
>   • Observability: structured JSON logs across every scheduled cron + hot API route
>   • Data-flow fix: aggregator now merges Fortnox revenue + costs into monthly_metrics;
>     /api/fortnox/apply triggers re-aggregation; /api/admin/reaggregate backfills history
>   • User-scoped queue sweep (/api/fortnox/sweep) — auto-kick stuck jobs from UI

---

## 0. HARD RULE — Update MD Files at Context Limit

**At 95% of context window capacity, Claude MUST:**
1. Update `CLAUDE.md` — session status, any new rules or decisions
2. Update `ROADMAP.md` — what was completed, what is in progress, what is next
3. Update `MIGRATIONS.md` — any SQL run or pending, mark statuses
4. Update `FIXES.md` — any new bugs found or fixed

This is non-negotiable. Do not wait to be asked. Do it automatically before context runs out.

---

## 1. Role Definition

**You are**: Paul Dransfield — business owner, product visionary, decision-maker.
**Claude is**: Technical co-founder and lead developer.
**Dynamic**: You set direction. Claude builds and explains. Always confirms before major changes.

---

## 2. Hard Rules (non-negotiable)

### Auto-push rule
**At the end of every Claude response, all changes are automatically committed and pushed to GitHub.**
This is enforced by a `Stop` hook in `.claude/settings.json` — it runs `git add -A && git commit && git push` after every response if there are any uncommitted changes.

**Why**: Work must always be recoverable from any computer. Context window fills up, sessions end, computers change. GitHub is the source of truth.

**Manually trigger if needed**:
```bash
git add -A && git commit -m "manual checkpoint" && git push
```

---

## 3. Session Protocol (every session, in order)

1. Read `ROADMAP.md` and this file before writing a single line of code
2. Ask clarifying questions if requirements are not clear
3. State the plan — what will be built, why, what you will see — get confirmation
4. Write code with plain-English comments explaining why
5. Explain how to test — specific steps to verify it works
6. Provide SQL for any DB changes, formatted for Supabase SQL Editor
7. Update this file at the end of every session AND at 95% context (see Rule 0)

---

## 3. Project Identity

**Product**: CommandCenter — restaurant group business intelligence SaaS
**Live URL**: https://comandcenter.se
**Stack**: Next.js 14 + Supabase (Frankfurt) + Vercel (EU) + Anthropic Claude API + Stripe + Resend
**Local dev**: C:\Users\pauld\Desktop\comand-center\
**Supabase project**: https://llzmixkrysduztsvmfzi.supabase.co
**Vercel org**: paul-7076s-projects/comand-center

### Key IDs
| Item | Value |
|------|-------|
| Org ID (test org) | e917d4b8-635e-4be6-8af0-afc48c3c7450 |
| Test business 1 (Vero) | 0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99 |
| Test business 2 (Rosali) | 97187ef3-b816-4c41-9230-7551430784a7 |
| Integration 1 | 2475e1ef-a4d9-4442-ab50-bffe4e831258 |
| Integration 2 | 1c3278cc-7446-4fcd-9078-e380c73e52fb |

---

## 4. Architecture — What Is Actually Built

```
Customer browser
      │
      ▼
  Next.js 14 (Vercel EU)
      │
      ├── /dashboard — KPI cards, revenue chart, department breakdown
      ├── /staff — hours, costs, OB supplement, late arrivals
      ├── /departments — cost per department, colour-coded
      ├── /covers — daily revenue detail (rename to /revenue pending)
      ├── /tracker — monthly P&L, manual entry
      ├── /forecast — predicted revenue vs actual
      ├── /budget — cost targets
      ├── /invoices — Fortnox documents
      ├── /alerts — AI-detected anomalies
      ├── /ai — Claude assistant with business context
      └── /admin — customer management (requires ADMIN_SECRET)

      │
      ▼
  Supabase (Frankfurt)
      │
      ├── auth.users — email/password, session cookies
      ├── organisations — customers (multi-tenant root)
      ├── businesses — restaurants within an org
      ├── integrations — Personalkollen, Fortnox, etc.
      ├── staff_logs — shifts, costs, OB supplement, lateness
      ├── revenue_logs — daily revenue, covers, food/drink split
      ├── tracker_data — monthly P&L entries
      ├── forecasts — predicted revenue and costs
      ├── alerts — AI-detected anomalies
      └── ai_usage_daily — query limits per org

      │
      ▼
  External APIs
      │
      ├── Personalkollen — staff data, costs, OB types
      ├── Fortnox — invoices, suppliers (OAuth pending)
      ├── Stripe — billing, subscriptions
      ├── Resend — transactional emails
      └── Anthropic Claude — AI agents and assistant
```

---

## 5. AI Agents — All 6 Built ✅

| Agent | Schedule | Plan | Status | Notes |
|-------|----------|------|--------|-------|
| Anomaly detection | Nightly 06:00 | All | ✅ **COMPLETE** | Updated thresholds, email alerts |
| Onboarding success | On first sync | All | ✅ **COMPLETE** | Sends welcome email on first sync |
| Monday briefing | Monday 07:00 | Pro+ | ⏳ **BLOCKED** | Needs Resend domain verification |
| Forecast calibration | 1st of month | Pro+ | ✅ **COMPLETE** | Runs at 04:00 UTC, pure arithmetic |
| Supplier price creep | 1st of month | Pro+ | ✅ **SKELETON** | Waiting for Fortnox OAuth |
| Scheduling optimisation | Weekly | Group | ✅ **COMPLETE** | Monday 07:00 UTC, uses Sonnet 4-6 |

**Total cost at 50 customers**: ~$5/month using Haiku 4.5 (was $15 with Sonnet — 67% saving)
**Model used**: All agents use `claude-haiku-4-5-20251001` except scheduling optimisation which uses `claude-sonnet-4-6`
**Rule**: Never hardcode model strings — always import from `lib/ai/models.ts`

---

## 6. Database Schema — Key Tables

### Multi-tenant isolation
Every table has `org_id` and `business_id` columns. RLS policies enforce isolation.

### Core tables
- `organisations` — customers (Stripe customer ID, subscription plan)
- `businesses` — restaurants within an org (is_active flag)
- `organisation_members` — users who can access an org
- `integrations` — Personalkollen, Fortnox, etc. (encrypted API keys)

### Data tables
- `staff_logs` — shifts, costs, OB supplement, lateness
- `revenue_logs` — daily revenue, covers, food/drink split
- `tracker_data` — monthly P&L entries
- `forecasts` — predicted revenue and costs
- `alerts` — AI-detected anomalies

### AI tables
- `ai_usage_daily` — query limits per org
- `forecast_calibration` — accuracy and bias factors
- `scheduling_recommendations` — weekly optimisation results

---

## 7. Cron Jobs (Vercel)

```json
{
  "crons": [
    { "path": "/api/cron/master-sync", "schedule": "0 5 * * *" },
    { "path": "/api/cron/anomaly-check", "schedule": "30 5 * * *" },
    { "path": "/api/cron/health-check", "schedule": "0 6 * * *" },
    { "path": "/api/cron/weekly-digest", "schedule": "0 6 * * 1" },
    { "path": "/api/cron/forecast-calibration", "schedule": "0 4 1 * *" },
    { "path": "/api/cron/supplier-price-creep", "schedule": "0 5 1 * *" },
    { "path": "/api/cron/scheduling-optimization", "schedule": "0 7 * * 1" }
  ]
}
```

---

## 8. Environment Variables (.env.local)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://llzmixkrysduztsvmfzi.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# AI
ANTHROPIC_API_KEY=sk-ant-api03-...

# Email
RESEND_API_KEY=re_...

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...

# Security
CRON_SECRET=your-cron-secret-here
ADMIN_SECRET=your-admin-secret-here

# URLs
NEXT_PUBLIC_APP_URL=https://comandcenter.se
```

---

## 9. Development Commands

```powershell
# Start dev server
npm run dev

# Build for production
npm run build

# Deploy to Vercel
vercel --prod

# Run TypeScript check
npx tsc --noEmit

# Check Supabase connection
curl "https://llzmixkrysduztsvmfzi.supabase.co/rest/v1/" -H "apikey: $env:NEXT_PUBLIC_SUPABASE_ANON_KEY"

# Test cron endpoint
curl -X POST "http://localhost:3000/api/cron/anomaly-check" -H "Authorization: Bearer your-cron-secret"
```

---

## 10. Testing Checklist

### Before deploying
- [ ] All TypeScript errors resolved or `// @ts-nocheck` added
- [ ] Swedish characters display correctly (no `Ã¥`, `Ã¶`)
- [ ] Sidebar business switcher works on all pages
- [ ] Multi-tenant isolation works (org A cannot see org B data)
- [ ] AI query limits enforced (429 response after daily limit)
- [ ] Cron jobs return 200 OK with Bearer token

### After deploying
- [ ] Master sync runs at 06:00 UTC
- [ ] Anomaly detection runs at 06:30 UTC
- [ ] Weekly digest runs Monday 07:00 Stockholm time
- [ ] Forecast calibration runs 1st of month 04:00 UTC
- [ ] Scheduling optimisation runs Monday 07:00 UTC

---

## 10b. Supabase query footguns — MUST avoid

These two patterns have caused production outages. Every new query must follow them.

### Never chain `.gte().lte()` on a `date` column

Supabase/PostgREST silently drops top-boundary rows when both `.gte()` and `.lte()` are chained on a column of type `date`. No error, no warning, just missing rows. An `.eq()` on the same date works fine.

**Bad:**
```ts
db.from('revenue_logs').gte('revenue_date', from).lte('revenue_date', to)
```

**Good:**
```ts
const { data } = await db.from('revenue_logs').gte('revenue_date', from)
const rows = (data ?? []).filter(r => r.revenue_date <= to)
```

Applies to `revenue_date`, `shift_date`, `date`, `period_date` and any other `date`-type column. It does NOT (currently) bite on `timestamptz` columns like `created_at`. See `FIXES.md §0` for the 2026-04-18 incident.

### Always set `cache: 'no-store'` on live-data `fetch()` calls

Client-side `fetch()` responses are cached by the browser. `Ctrl+F5` reloads the HTML but does not reliably evict the fetch cache. Any API call that must reflect current DB state needs:

```ts
fetch('/api/metrics/daily?…', { cache: 'no-store' })
```

And the API route must also set the `Cache-Control` header:

```ts
return NextResponse.json(data, {
  headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' },
})
```

Both layers required — belt and braces against CDN / reverse-proxy / future browser quirks. See `FIXES.md §0a` for the 2026-04-18 dashboard-staleness incident.

Applies to: `/api/metrics/*`, `/api/tracker`, `/api/forecast`, `/api/budgets`, `/api/departments`, `/api/staff`, `/api/revenue-detail`, `/api/scheduling*`, and any future live-data endpoint.

---

## 10c. AI scope — business-wide vs department-level

Some data lives at the **business** level (Fortnox P&L, whole-business PK totals) and some lives at the **department** level (POS providers tagged per-dept, staff assigned to a department). AI answers must never attribute business-wide numbers to a single department — the figures do not support that split and the owner will act on the answer.

**Rule:** every AI prompt that could see both scopes must include the shared `SCOPE_NOTE` from `lib/ai/scope.ts` in its system prompt or prompt preamble.

```typescript
import { SCOPE_NOTE } from '@/lib/ai/scope'

const SYSTEM_PROMPT = `You are ... ${SCOPE_NOTE}`
```

Business-wide (from `SCOPE_NOTE`):
- `tracker_data` fields: `revenue` (Fortnox), `food_cost`, `staff_cost`, `other_cost`, `depreciation`, `financial`, `net_profit`, `margin_pct`
- every row in `tracker_line_items`
- `monthly_metrics`, `daily_metrics` aggregates

Department-level:
- department-tagged revenue from POS (`pk_bella`, `pk_carne`, …)
- `staff_logs` rows assigned to a dept
- `/api/departments` aggregates

Department margin is `dept_revenue − dept_staff_cost`. It does NOT include food_cost or overheads (those only exist at the business level). When writing AI surfaces, if a question needs a business-wide number to answer a department-scoped question, the AI must say so explicitly instead of pretending.

**Business-wide data IS encouraged for predictive modelling at the business scope** — forecasts, budgets, seasonality, cost-trend analysis, benchmarking against industry norms. Fortnox history is the richest signal we have for whole-business prediction; lean into it. The ban is on misattributing business-wide figures to a specific department, not on using them where they genuinely apply.

Predictive endpoints that now carry `SCOPE_NOTE`:  `/api/ask`, `/api/budgets/generate`, `/api/budgets/analyse`, `/api/budgets/coach`, `/api/tracker/narrative`, `lib/agents/cost-intelligence.ts`. Any new predictive or generative AI surface must do the same.

---

## 11. AI Model Routing — always follow this

Never hardcode model strings. Always import from `lib/ai/models.ts`.

```typescript
// lib/ai/models.ts
export const AI_MODELS = {
  AGENT:     'claude-haiku-4-5-20251001', // Background agents — 70% cheaper
  ANALYSIS:  'claude-sonnet-4-6',          // Complex multi-step reasoning
  ASSISTANT: 'claude-sonnet-4-6',          // Interactive AI assistant
} as const

export const MAX_TOKENS = {
  AGENT_EXPLANATION: 150,
  AGENT_SUMMARY:     300,
  AGENT_RECOMMENDATION: 400,
  ASSISTANT: 2000,
} as const
```

| Use case | Model | Max tokens |
|----------|-------|-----------|
| Anomaly explanation (1 sentence) | Haiku 4.5 | 150 |
| Monday briefing (1 paragraph) | Haiku 4.5 | 300 |
| Onboarding welcome email | Haiku 4.5 | 300 |
| Supplier / scheduling alerts | Haiku 4.5 | 400 |
| Scheduling optimisation (complex) | Sonnet 4.6 | 600 |
| Interactive AI assistant | Sonnet 4.6 | 2000 |

**Cost comparison** (per 1,000 agent calls, avg 500 input + 150 output tokens):
- Haiku 4.5: ~$1.25 total
- Sonnet 4.6: ~$3.75 total
- Saving: 67% per agent run

At 50 customers, all agents running: ~$15/month with Haiku vs ~$45/month with Sonnet.

---

*Read at the start of every session. Companion files: ROADMAP.md · FIXES.md · MIGRATIONS.md*