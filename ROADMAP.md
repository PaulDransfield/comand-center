# ROADMAP.md — CommandCenter
> Version 8.6 | Updated: 2026-05-02 | Session 15 ✅ (onboarding overhaul + auth-gate chain + holidays)
> Active focus: TBD (Sprint 2 from external review still queued)
> UX redesign: phase 10 shipped (Performance page replaces Cashflow)
> Read alongside CLAUDE.md and FIXES.md

---

## Session 15 — 2026-05-02 shipped (onboarding + auth + holidays)

Three threads landed this session, all interlocking:

**A. Onboarding wizard overhauled — single source of business data**
- M046 migration: `businesses.opening_days JSONB`, `businesses.business_stage TEXT` enum (`new` | `established_1y` | `established_3y`).
- Wizard restructured to 3 real steps (Restaurant → Systems → Done; the marketing welcome slide was removed). Restaurant step now collects address + organisationsnummer + business stage + opening days (Mon–Sun toggles) + cost targets. Optional last-year P&L PDF upload on the Systems step (only when stage ≠ 'new'); flows through the existing `/api/fortnox/upload` pipeline.
- Org-nr capture moved out of the signup form. Signup now takes only email + password + name + org name (~30s). Single source-of-truth helper `lib/sweden/applyOrgNumber.ts` handles DB write + Stripe metadata + tax_id sync; both `/api/onboarding/complete` and `/api/settings/company-info` POST through it.
- `OrgNumberGate` + `OrgNumberBanner` components DELETED. Onboarding requires org-nr upfront; the 30-day grace path is dead code. Locale keys (`misc.orgGate`, `settings.orgNumberBanner`) removed from all 3 locale JSONs.

**B. Auth flow + gate chain**
- Email verification ON. `/api/auth/signup` creates auth users with `email_confirm: false` and emails a Supabase-generated confirmation link via Resend with our branded template + locale-aware copy (`lib/email/sendVerifyEmail.ts`). Signup form no longer auto-signs-in; shows "Check your inbox" screen. Verification link routes through `/api/auth/callback?next=/onboarding`.
- `OnboardingGate` component (mirrors `PlanGate` shape) added to `components/AppShell.tsx`. Mounted BEFORE `PlanGate` so unfinished owners get sent to `/onboarding` rather than `/upgrade`. New `/api/me/onboarding` endpoint backs the check (treats org as completed if `onboarding_progress.completed_at` set OR org has ≥1 business — legacy customers don't get surprise-redirected).
- Final canonical flow: signup → email verify → onboarding wizard → plan pick → app.
- Free-trial copy retired across signup form (en-GB / sv / nb). Pricing memory had said free-trial was retired but signup subtitle still advertised "30-day free trial · No credit card required" — now reads "Set up in minutes — pick a plan after onboarding" (and locale equivalents).

**C. Swedish public holidays — first-class data**
- `lib/holidays/sweden.ts` computes 17 SE restaurant-relevant days/year (public + observed). Easter via Anonymous Gregorian algorithm; Midsummer + All Saints' via "first weekday in window". Verified 2025/2026.
- `lib/holidays/index.ts` exposes country router (`getHolidaysForCountry`) + windowed lookup (`getUpcomingHolidays`). Norway / UK plug in as sibling files later — no overlap.
- `/api/holidays/upcoming` endpoint returns locale-named upcoming holidays for the active business's country.
- Dashboard AttentionPanel surfaces the next holiday inside 14 days as the top item, with `high` (peak demand) / `low` (most close) impact tags.
- OverviewChart X-axis day labels render Sat/Sun/holidays in red (#dc2626 + semibold), matching the printed-calendar convention. "Today" highlight (green + bold) wins overlap.
- AI awareness wired in: weekly memo prompt (21-day window) + scheduling-optimization cron (28-day window). Both fail-tolerant — empty placeholder if lookup throws.

**Bug fix — production-down recovery**
- 2026-05-01 incident: every page on production 500'd because `<CookieConsent />` was rendered as a sibling of `<NextIntlClientProvider>` instead of a child. The next-intl runtime wrapper masked the SSR throw as anonymous `Error(void 0)`, so neither build prerender failures nor runtime logs surfaced the real cause. ~1 hour to find. Fix: one-line move (CookieConsent inside provider). Prevention layer: `i18n/request.ts` now wires `onError` + `getMessageFallback` so future failures log a useful `[next-intl] CODE: msg` line. Memory saved at `feedback_next_intl_provider_scope.md`.

**Privacy scrub** — replaced `Vero Italiano` / `Paul Dransfield` / `paul@veroitaliano.se` / `Storgatan 12, 114 51 Stockholm` placeholders across signup + onboarding + settings + admin tools (3 locales). Also fixed the Fortnox extract-worker AI prompt that was leaking "Vero restaurant" to Anthropic on every PDF call (no ZDR yet — `project_company_formation_pending` memory).

**Migrations applied this session:** M046 ✅.

**Follow-ups deliberately deferred:**
- Norway + UK holiday modules (`lib/holidays/norway.ts`, `lib/holidays/uk.ts`) — waiting on country-picker UX decision.
- Inject `business_stage` into the budget AI prompt — when stage = 'new', skip the historical-anchor rule (no last-year actuals exist) so the AI doesn't anchor on zero.
- Per-day holiday name in OverviewChart tooltip (currently the red number tells you it IS a holiday, but not which one — would need a tooltip hover state).

---

## Session 14 — 2026-04-27 shipped (Sprint 1 of external code review)

External code review (`REVIEW.md`) flagged 5 critical/high issues. All landed this session. See `CLAUDE-CODE-HANDOFF.md` for the original tasking.

- **Task 1 — middleware rewritten** (FIXES §0t). Original task was "delete middleware" — pre-flight check found pages are `'use client'` with no server-side redirect, so deletion would have regressed `/dashboard` from "redirect to login" to "broken shell + 401 fetches". Rewrote `middleware.ts` to do cheap structural JWT validation (~88 lines, no `console.log`, no Supabase network call) on an explicit allowlist of 17 protected prefixes. New `lib/auth/session-cookie.ts` handles all three @supabase/ssr cookie shapes including chunked cookies. Cryptographic check stays in `getRequestAuth`.
- **Task 2 — multi-org `.single()` fix** (FIXES §0u). Both `lib/supabase/server.ts` and `lib/auth/get-org.ts` switched to `.maybeSingle()` with `.order('created_at', ascending: true).limit(1)` on `organisation_members`. A user with ≥2 org memberships no longer 401s; they land in their oldest org. Comment block flags the future explicit-org-switcher work.
- **Task 3 — Fortnox supersede chain join table** (FIXES §0v, M032 pending). New `fortnox_supersede_links(child_id, parent_id, period_year, period_month)`. apply() inserts one row per period iteration; reject() walks the table to restore EVERY parent on multi-month uploads. Pre-fix the column-level `supersedes_id` was overwritten on every iteration, leaving multi-month chains with only the last period's parent recorded.
- **Task 4 — atomic AI quota gate** (FIXES §0w, M033 pending). `/api/ask` switched from two-step `checkAiLimit + incrementAiUsage` to atomic `checkAndIncrementAiLimit()` via new `increment_ai_usage_checked` RPC. Closes the TOCTOU window where 100 parallel requests could blow the per-org daily cap by the burst factor. Cron-driven AI agents keep using the legacy two-step (now `@deprecated`) since they run serially under cron locks.
- **Task 5 — kill-switch table-scan removal** (FIXES §0w extension, same migration). New `ai_spend_24h_global_usd()` RPC + `idx_ai_request_log_created_at` (DESC) + `idx_ai_request_log_org_created_at`. Replaces the prior `db.from('ai_request_log').select('total_cost_usd').gte('created_at', since)` table scan that fetched ~2,500 rows per AI call at 50 customers.

**Migrations pending Paul application in Supabase:** M032, M033.

**Sprint 2 (Tasks 6–10, deferred from this sprint):**
- Task 6 — consolidate the two auth helpers (delete `lib/auth/get-org.ts`); requires migrating every API route using `getOrgFromRequest`.
- Task 7 — Stripe webhook `'solo'` plan default → look up plan from `price.id`.
- Task 8 — standardise on `checkCronSecret` in the 3 inline-`!==` cron handlers.
- Task 9 — wrap aggregator fire-and-forget in `waitUntil`.
- Task 10 — move root cruft to `archive/`.

Sprint 2 owner pick is Paul's call — Task 7 is the most user-visible (wrong plan = wrong AI quota), Task 6 is the largest blast radius.

---

## Session 12 — 2026-04-23 shipped

- **New `/financials/performance` page** replacing the dead `/cashflow` page. Unified Revenue / Food / Labour / Overheads / Net-margin view with Week/Month/Quarter/YTD granularity, period picker, compare dropdown, waterfall + donut + trend sparklines + template-driven "What's tunable" attention panel. No new endpoints — reads existing `/api/tracker` + `/api/overheads/line-items` + `/api/metrics/daily`.
- **AI layer upgrade** — `lib/ai/rules.ts` centralises domain rules across 9 surfaces; tool-use replaces regex-JSON on weekly-manager, budgets/generate, budgets/analyse, cost-intelligence; prompt caching on /api/ask (~80% input-token saving); `ai_forecast_outcomes` writes added to budget_coach; new `lib/ai/contextBuilder.ts`.
- **PK hardening** — `include_drafts=1`, timezone-tagged timestamps, sync-cursor plumbing (M024 pending), scheduled-break correctness, COGS + staff_uid + sale_center + staff employments captured.
- **Sync engine status reset** — every successful sync now resets `status='connected'` (fixes the stuck-in-error footgun, M023 applied).
- **Email infra** — comandcenter.se Gmail Workspace fully live, 11 aliases, SPF/DKIM/DMARC all PASS.
- **Admin hardening** — 4 routes locked down (SEC-2026-04-22), customer-list cache-bust, new /admin/diagnose-pk UI.

See CLAUDE.md header + FIXES.md §0g/0h/0i/0j for detail.

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Complete — live in production, tested with real data |
| 🔄 | In progress |
| ⏳ | Blocked — waiting on external dependency |
| 📋 | Planned — session and priority confirmed |
| 💡 | Backlog — will build when relevant |

---

## What Is Live Right Now (Session 5 complete)

### Platform foundation ✅
- Multi-tenant architecture: org → businesses → integrations
- Auth (Supabase email/password), session cookies, route protection
- Sidebar with business switcher — all pages react to switch
- UX design system: `lib/constants/colors.ts`, `deptColor()`, uniform card styles
- GDPR: privacy policy, consent banner, data export API, deletion requests
- Onboarding: 4-step flow, sends setup request email to support
- Admin panel `/admin`: see all customers, connect APIs, trigger syncs
- Daily cron 06:00 UTC: syncs ALL connected integrations automatically

### Analytics pages ✅
- `/dashboard` — KPI cards, revenue chart, department breakdown
- `/staff` — hours, costs, OB supplement, late arrivals (reads from staff_logs DB)
- `/departments` — cost per department, colour-coded
- `/covers` — daily revenue detail (rename to /revenue pending)
- `/tracker` — monthly P&L, manual entry
- `/forecast` — predicted revenue vs actual
- `/budget` — cost targets
- `/invoices` — Fortnox documents
- `/alerts` — AI-detected anomalies
- `/ai` — Claude assistant with business context

### Data integrations ✅
- **Personalkollen adapter**: shifts, costs, OB types, food/drink split, covers
- **Sync engine**: per-integration, auto-detects business_id, upserts to DB
- **Master cron**: all businesses, all orgs, daily, zero config for new customers

### Database schema ✅
- All tables have org_id + business_id for multi-tenant isolation
- RLS policies on all tables
- Encrypted API key storage (AES-256-GCM)
- staff_logs columns: hours_worked, cost_actual, ob_supplement_kr, ob_type, is_late, late_minutes, costgroup_name, staff_name, staff_group, shift_date, real_start, real_stop
- revenue_logs columns: revenue, covers, food_revenue, drink_revenue, tip_revenue, dine_in_revenue, takeaway_revenue

---

## Session 6 — COMPLETED ✅

### Phase 1 — Must do (ALL COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| 1. Terms of service | ✅ **COMPLETE** | Live at `/terms` — Version 1.0 effective 11 April 2026 |
| 2. Admin password → env var | ✅ **COMPLETE** | Using `ADMIN_SECRET` env var in `.env.local`, checked via `/api/admin/auth` |
| 3. Signup confirmation email | ✅ **COMPLETE** | According to user confirmation |
| 4. Forecast empty state | ✅ **COMPLETE** | Loading state with "Loading forecasts..." message |
| 5. Sync status visible | ✅ **COMPLETE** | "Synced just now" / "Synced Xh ago" in sidebar with green indicator |
| 6. Onboarding completion state | ✅ **COMPLETE** | `setupPending` state in dashboard with "Setting up your data..." banner |
| 7. Wire Stripe billing | ✅ **COMPLETE** | Checkout flow in `/upgrade` page calling `/api/stripe/checkout` |

### Phase 4 — Clean up (ALL COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| Delete beta, changelog, notebook pages | ✅ **COMPLETE** | All directories removed: `/beta`, `/changelog`, `/notebook` |
| Delete VAT, revenue-split pages | ✅ **COMPLETE** | Directories removed: `/vat`, `/revenue-split` |
| Delete orphaned API routes | ✅ **COMPLETE** | Routes removed: `/documents`, `/pos-connections`, `/supplier-mappings`, `/chat` |
| Fix or disable weekly digest cron | ✅ **COMPLETE** | Updated to use POST method and Bearer token authorization |

### AI cost control (PARTIALLY COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| 25. Enforce AI query limits at API level | ✅ **COMPLETE** | Implemented in `/api/ask/route.ts` with daily counter and 429 response |
| 26. AI add-on upsell (+299 kr/mo) | ✅ **COMPLETE** (2026-04-17) | `AiLimitReached` card in AskAI panel with trial vs paid branches; `/upgrade?focus=ai` scroll+highlight; Booster card visible to trial users with "upgrade a plan first" state |

---

## Session 7 — COMPLETE ✅

| Item | Description | Status |
|------|-------------|--------|
| 8. Public landing page | Marketing page at comandcenter.se | ✅ **COMPLETE** — live at `/`, logged-in users redirect to `/dashboard` |
| 9. Sentry error monitoring | Know about issues before customers do | ✅ **COMPLETE** |
| 10. Fix sync timeout | Chunked backfill — one month per call | ✅ **COMPLETE** |
| 11. Contextual AI on every page | "Ask AI" button on staff, tracker, dashboard | ✅ **COMPLETE** |
| 12. Rename /covers → /revenue | "Covers" is wrong term for this page | ✅ **COMPLETE** |
| 13. Mobile dashboard, staff, tracker | KPI cards must stack on phones | ✅ **COMPLETE** (2026-04-17) — `.kpi-row` class with 4→2→1 breakpoints applied to dashboard, staff, tracker; landing page nav fixed at <480px; AI FAB repositioned above mobile bottom nav |
| 14. Schema migrations log | MIGRATIONS.md — record every SQL change (file created) | ✅ **COMPLETE** |

### Session 7 — Inzii POS Integration

| Item | Status | Notes |
|------|--------|-------|
| Inzii POS adapter (`lib/pos/inzii.ts`) | ✅ Built | Tries 8 endpoint patterns against api.swess.se |
| Multi-department DB schema (M005) | ✅ Complete | `department` column + partial unique indexes |
| Admin panel — add dept modal | ✅ Built | InziiDeptModal in `/admin` page |
| Sync engine — Inzii provider | ✅ Built | Stores as `inzii_bella`, `inzii_brus` etc. in revenue_logs |
| Admin panel — show depts | ✅ **NOT A BUG** | Diagnose-inzii endpoint confirmed all 6 depts correctly attached to Vero Italiano — see FIXES.md |
| Inzii API endpoint | ⏳ Unknown | api.swess.se responds but correct path not confirmed |

**Resolved 2026-04-17:** The "0 departments" report was a misread — all 6 Inzii depts are correctly attached to Vero Italiano (Rosali Deli is a separate business with only PK). Expanding Vero's card in the admin panel shows all 6 as expected. Built `/api/admin/diagnose-inzii?org_id=…` for future investigations of this kind.

---

## Session 8 — COMPLETE ✅ (2026-04-17 · data integrity + polish)

This session focused on fixing data-source bugs exposed once tracker_data vs monthly_metrics divergence surfaced, plus closing the remaining items from Session 7's pending list.

### Infrastructure / security
| Item | Status | Notes |
|------|--------|-------|
| M003 SQL run in Supabase | ✅ | `forecast_calibration`, `scheduling_recommendations`, `briefings` tables + `integrations.onboarding_email_sent` column |
| Resend domain verified | ✅ | `comandcenter.se` verified; `digest@commandcenter.se` typo → `digest@comandcenter.se` |
| Git history cleanup | ✅ | Removed `.env.vercel` from 14 local commits after GitHub push-protection blocked; ANTHROPIC_API_KEY rotated |
| Vercel CLI installed + project linked | ✅ | `vercel logs`, `vercel env pull`, `vercel ls` now available |

### Data-source audit (tracker_data → monthly_metrics)
Root cause: aggregate reads were hitting `tracker_data` (only holds manual P&L entries), not `monthly_metrics` (auto-aggregated POS + PK sync). For Vero Italiano this meant e.g. April revenue = 115k (manual) shown instead of 485k (real). Fixed across:

| File | Fix |
|------|-----|
| `app/api/forecast/route.ts` | Actuals from monthly_metrics, tracker_data fallback for food_cost |
| `app/api/budgets/route.ts` | Same pattern, plus fixed page shape mismatch (`{year, months}` vs array) |
| `app/forecast/page.tsx` | Normalised `depts` to string[] so drill-down expansion renders dept breakdown |
| `lib/sync/engine.ts → generateForecasts` | History from monthly_metrics so rolling avg is ~1.7M kr/mo not 38k |
| `lib/alerts/detector.ts` | Anomaly baseline no longer fires false positives against empty 2024 manual rows |
| `lib/ai/buildContext.ts` | AI assistant answers with real synced revenue, not partial manual entries |
| `app/api/cron/forecast-calibration/route.ts` | Calibration actuals + DOW factors from monthly/daily_metrics |

### AI agent cleanup
| Item | Status | Notes |
|------|--------|-------|
| Onboarding-success cron bugs | ✅ | `integration_type` → `provider`, `users` table → `auth.admin.getUserById`, `subscription_plan` → `plan`, added 48h safety window so the cron can never mass-email ancient integrations |
| Enhanced Discovery cron | ✅ | Status filter `active` → `connected`, rewrote `fetchSampleData` to do live PK API sample fetch instead of broken `sync_logs` query, skipped integrations get `last_enhanced_discovery_at` stamped so they rotate |
| AI usage tracking unified | ✅ | New `lib/ai/usage.ts` with `checkAiLimit` / `incrementAiUsage` — applied to `/api/ask`, `/api/budgets/generate`, `/api/budgets/analyse`; all AI calls now count against daily plan limit |

### New features
| Feature | Notes |
|---------|-------|
| Budget: "Generate with AI" | `/api/budgets/generate` — reads last year + forecasts + YTD, Claude Haiku returns 12-month budgets with reasoning; review modal with Apply-all |
| Budget: per-month "Analyse" | `/api/budgets/analyse` — conditional prompt only includes metrics with data (no food-cost commentary if food_cost is 0); verdict-tinted modal with color-coded metric cards + recommendations |
| Scheduling redesign | Bar charts removed; labour % hero + 7-day scorecard cards + clickable drill-down modal; W/M navigator replaces date picker; new `/api/scheduling/day-details` endpoint |
| Departments redesign | Bar chart removed; table matches dashboard style with new Profit column; rows sorted by revenue |
| Landing page copy | Value-focused wording (removed Personalkollen/Fortnox specifics from hero + meta); mobile nav fits on 375px |

### Outcome
Everything from the original Session 7 build list is now live. Product is functionally complete. Next phase is UX redesign.

---

## Session 9 — Admin Panel ✅ COMPLETE (2026-04-17 · Phase 1 + 2)

Full operator tooling for customer support + agent management. Replaces the flat org-list view in /admin with a lifecycle-aware pipeline and per-customer god-pages.

### Phase 1 — Customer tooling
| Item | Status |
|------|--------|
| `/admin/customers` pipeline view (New · Setup · Active · At Risk · Churned) | ✅ |
| `/admin/customers/[orgId]` god-page (header · setup request · team · integrations · alerts · agents · timeline · notes) | ✅ |
| Impersonation via Supabase magic-link | ✅ |
| Per-customer agent feature flags (enable/disable) + enforcement in all 6 agents | ✅ |
| Manual "Run now" agent triggers sending real emails | ✅ |
| Internal support notes | ✅ |
| Timeline event feed (signup · setup · integrations · syncs · alerts · admin actions · notes) | ✅ |
| Onboarding metadata capture (M008 — step + metadata columns) | ✅ |

### Phase 2 — System tooling
| Item | Status |
|------|--------|
| `/admin/overview` KPI dashboard (MRR, signups, at-risk, cron strip, critical alerts, recent signups + setup requests) | ✅ |
| `/admin/agents` cross-customer agent runs dashboard | ✅ |
| `/admin/health` cron status + AI spend + sync success rate + integration error feed | ✅ |
| Shared `AdminNav` component across all admin pages | ✅ |

### Phase 3 (future — not urgent)
- Broadcast email to all customers
- Signup funnel analytics
- Plan-change UI (currently Stripe dashboard link-out)

---

## Session 10 — AI differentiation + chart rebuild 🔄 (2026-04-19 → 2026-04-20)

Session pivoted from the original UX-redesign plan (docs/ux-redesign-spec.md) to executing `docs/AI-ROADMAP.md` once Paul decided the product's differentiation story was weaker than its build quality. UX redesign remains queued after this.

### Feature 1 — Weekly AI Manager ✅ SHIPPED
| Item | Status |
|------|--------|
| 12-week context packer (daily_metrics + dept + alerts + budget) | ✅ |
| Strict-constraint memo prompt (≤200 words, 3 SEK-cited actions) | ✅ |
| Template HTML replaced with AI narrative | ✅ |
| Thumbs 👍/👎 feedback loop in emails → `memo_feedback` table (M016) | ✅ (2026-04-20) |
| Two-step feedback UX (confirm → optional comment) to dodge Gmail prefetch | ✅ |
| Admin memo-preview page for QA + demos | ✅ |
| Admin agents card shows 30-day up/down rollup + last comment | ✅ |
| Schedule AI-comparison page (replaces PK write-back idea) | ✅ |

### Feature 4 — Weather-aware intelligence ✅ MOSTLY SHIPPED
| Item | Status |
|------|--------|
| Open-Meteo fetcher, city-coord lookup, WMO→label mapping | ✅ |
| Weather in weekly memo (forecast + historical correlation) | ✅ |
| Historical backfill + `weather_daily` + `/weather` correlation page | ✅ |
| Weather-adjusted scheduling target hours | ✅ |
| Forecast-day horizon bumped 10 → 16 (was cutting off next-week Thu–Sun) | ✅ (2026-04-20) |
| Live `getForecast()` fallback in scheduling (weather_daily forecast rows go stale) | ✅ (2026-04-20) |
| Revenue/weather regression | ⏳ Gating on data volume (3 months) |
| Anomaly-detection false-positive suppression | ⏳ Needs a daily anomaly detector first — current is monthly |

### Scheduling AI — asymmetric cuts-only policy ✅ (2026-04-20)
Liability rule: never recommend adding hours. A cut that's too aggressive still saves money; an add-suggestion that doesn't pay off makes the customer worse off. Enforced in three places:
- `/api/scheduling/ai-suggestion` — `targetHours = min(currentHours, modelTarget)`, delta ≤ 0
- `/scheduling/ai` table — KPI becomes "Saving" (never "extra cost"); note-days show soft language
- Memo prompt — "all actions must be cost-saves / mix shifts / pricing / supplier asks, never staff up"

Also merged `/scheduling/ai` into `/scheduling` (one page, prominent indigo CTA banner + inline AI-suggested schedule card below the pattern grid). Legacy route → redirect.

### Dashboard overview chart rebuilt ✅ (2026-04-20)
Three iterations in one session:
1. Added predictions + weather + margin info on top of the existing stacked bar → "table is broken"
2. Rebuilt as day-card grid → "use a line, not cards; make month work too"
3. Final: `components/dashboard/OverviewChart.tsx` — SVG bars (revenue actuals + indigo-striped predictions, labour bars below zero line, green margin polyline), period dropdown (7 weeks + 7 months), W/M toggle, calendar day-filter (click-to-toggle + shift-click-range), compare toggle (None/Prev/AI) with per-day whiskers, 4 KPI strip recomputing from visible days, floating tooltip with coloured-border sections. URL params sync `view/offset/cmp/days` for shareable links. Click-to-drill scaffolded for future `/dashboard/day/[date]`.

### Session 10 open threads
- `/dashboard/day/[date]` drill-down page (OverviewChart's `onDayClick` is a no-op today)
- Feature 2 — Conversational P&L with receipts (blocked on `pk_products` price history + Fortnox food-cost detail)
- Feature 3 — Cash runway MVP (unblocked — manual bank-balance entry + recurring costs + payroll forecast)
- Anomaly detection: ship a daily detector so weather-suppression can plug in

### Original UX redesign (deferred)
Full spec at `docs/ux-redesign-spec.md`, mockup at `docs/commandcenter-v2.html`. Recon preserved in memory. Do not start until Paul explicitly says so.

---

## Future — Blocked / Scale

### Blocked on external dependency
| Item | Blocker | When |
|------|---------|------|
| Fortnox OAuth | Developer account approval pending | When approved |
| POS adapter | Need to know which POS next customer uses | When known |
| Weekly digest email | ~~Resend domain not verified~~ | ✅ Resolved 2026-04-17 |

### Scale features (20+ customers)
| Item | Description |
|------|-------------|
| Staging environment | Test on preview branch before prod |
| TypeScript properly enabled | One session to remove ts-nocheck debt |
| Health monitoring with alerts | UptimeRobot + cron success logging |
| Subscription pause | Seasonal restaurant closures |
| Annual invoice option | Swedish B2B expects PDF invoice |

---


---

## AI Agents — ALL 6 BUILT ✅

| Agent | Schedule | Plan | Build effort | Status |
|-------|----------|------|-------------|--------|
| Anomaly detection | Nightly 05:30 UTC | All | 3 hrs | ✅ **COMPLETE** — updated thresholds and email alerts |
| Onboarding success | On first sync (inline) + daily 08:00 UTC (cron safety net) | All | 2 hrs | ✅ **COMPLETE** — inline path from sync engine + cron bugs fixed 2026-04-17 (provider col name, auth.admin.getUserById, plan col name, 48h safety window) |
| Monday briefing | Monday 06:00 UTC | Pro+ | 4 hrs | ✅ **COMPLETE** — Resend domain verified 2026-04-17, digest@ typo fixed |
| Forecast calibration | 1st of month 04:00 UTC | Pro+ | 4 hrs | ✅ **COMPLETE** — M003 tables live 2026-04-17, runs 04:00 UTC on 1st of month |
| Supplier price creep | 1st of month 05:00 UTC | Pro+ | 3 hrs | ✅ **SKELETON BUILT** — waiting for Fortnox OAuth |
| Scheduling optimisation | Monday 07:00 UTC | Group | 6 hrs | ✅ **COMPLETE** — M003 tables live 2026-04-17, runs Monday 07:00 UTC, uses Sonnet 4-6 |

**Total cost at 50 customers**: ~$5/month using Haiku 4.5 (was $15 with Sonnet — 67% saving)
**Model used**: All agents use `claude-haiku-4-5-20251001` except scheduling optimisation which uses `claude-sonnet-4-6`
**Rule**: Never hardcode model strings — always import from `lib/ai/models.ts`
**Total build effort**: 22 hours across all 6 agents

### SQL needed before building agents
```sql
-- Run in Supabase before starting agent builds
CREATE TABLE IF NOT EXISTS briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  content TEXT NOT NULL,
  key_metrics JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, week_start)
);
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "briefings_select_own" ON briefings
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

## Backlog — Build when there is customer demand

| Feature | Notes |
|---------|-------|
| Language toggle EN/SV | After first 10 paying customers |
| BankID auth | Swedish enterprise requirement |
| Visma integration | Alternative to Fortnox |
| Open Banking / Tink | Real-time bank data |
| Multi-currency | Groups with non-Swedish locations |
| Mobile app (React Native) | Post product-market fit |
| Competitor benchmarking | Anonymised industry avg when 10+ customers |

---

## Pages to Remove (Session 6)

| Page | Why remove |
|------|-----------|
| /beta | Half-built, not linked, will break |
| /changelog | Half-built, not linked, will break |
| /notebook | Replaced by /ai — duplicate confusing |
| /vat | No customer asked for it |
| /revenue-split | No customer asked for it |

## API Routes to Remove (Session 6)

| Route | Why remove |
|-------|-----------|
| /api/documents | No connected frontend |
| /api/pos-connections | No connected frontend |
| /api/supplier-mappings | No connected frontend |
| /api/chat | Duplicate of /api/ai |

---

## Pricing & Commercial Model

### Plans
| Plan | Price | AI queries/day | Businesses |
|------|-------|---------------|------------|
| Starter | 499 kr/mo/business | 20 | 1 |
| Pro | 799 kr/mo/business | 50 | Up to 5 |
| Group | 1,499 kr/mo/business | Unlimited | Unlimited |
| AI add-on | +299 kr/mo | +100 | Any |

### Annual billing (push to every customer)
- 2 months free = 10 months price for 12 months
- Starter annual: 4,990 kr upfront
- Pro annual: 7,990 kr upfront
- Group annual: 14,990 kr upfront

### Break-even
- 2 customers at 499 kr = covers all infrastructure costs
- 52 customers at 799 kr = full-time income equivalent (40,000 kr/mo)
- 50 customers target = ~75,700 kr/mo profit at 95% gross margin

---

## Database Migrations Needed (run these in Supabase before Session 6 builds)

```sql
-- Already run (do not re-run):
-- ALTER TABLE staff_logs ADD COLUMN IF NOT EXISTS ob_type TEXT;
-- ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS food_revenue INTEGER DEFAULT 0;
-- ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS drink_revenue INTEGER DEFAULT 0;

-- Needed for Session 6:
-- AI query tracking
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  UNIQUE(org_id, date)
);
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
```

---

*Last updated: Session 10 — 2026-04-20*
*Next action: `/dashboard/day/[date]` drill-down, then Feature 3 cash-runway MVP, then Feature 2 conversational P&L (blocked on Fortnox)*

