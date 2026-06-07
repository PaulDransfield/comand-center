# CommandCenter — Market-Ready Roadmap

> Target: walk into the registered-business launch with the bolts tight and
> the differentiators sharp. Two streams running in parallel:
> **Stream A** — things I can ship autonomously (engineering judgement,
> no external signups required).
> **Stream B** — things that need you (signups, business decisions, manual
> inputs, legal). I'll prep the engineering scaffold where I can so the
> moment you unblock me, the wiring is already there.
>
> Pick the order; I'll execute. Each item carries an effort estimate
> (S = ≤1 day, M = 2-4 days, L = a week, XL = multi-week).

---

## Stream A — autonomous engineering work

### Phase A.1 — Tighten the bolts (no new product surface)

The boring but high-value work. Ship before any flashy feature.

| # | Item | Why | Size |
|---|------|-----|------|
| A1.1 | **Performance pass on cost engine** — profile recipe-cost query on 500+ recipe businesses, add covering indexes where `.in()` batches show up hot, verify N+1 absence. | Single biggest read path; slow load = bad first impression at scale. | M |
| A1.2 | **Honest-incomplete sweep** — audit every numeric surface (dashboard tiles, recipe GP%, forecast cards) and confirm null/missing renders as a coral badge, not "0.00 SEK / 0.0%". | Cited as core principle in docs; needs to be literally true everywhere. | M |
| A1.3 | **Loading-state pass** — every page with async data needs a skeleton, not a flash-of-empty. Particularly `/dashboard`, `/inventory/items`, `/financials/performance`. | First impression. New customer opens dashboard, sees skeleton = trustworthy; sees empty = "is this broken?" | S |
| A1.4 | **Error boundary on every top-level route** — currently a single bad component blanks the page. Wrap each app route in an error boundary that renders "Something went wrong" + a way to report it. | Resilience. One bug shouldn't take down the whole experience. | S |
| A1.5 | **Backfill queue health surface** — admin-only `/admin/backfill-health` showing per-customer backfill state, last cron run, queue depth, age of oldest pending. Email digest if any business stuck >24h. | We're flying blind on backfill drain across customers. Will matter as soon as #2 onboards. | M |
| A1.6 | **Cron observability** — wrap every cron in a structured-log envelope (start, end, duration, items processed, errors) + a single `/admin/cron-health` page reading the latest run per cron. | Today we read Vercel logs one at a time. Won't scale past ~5 customers. | M |
| A1.7 | **Empty-state pass** — every list/grid needs a designed empty state with a "do X to populate" call-to-action. /recipes, /items, /orders, /prep, /scheduling, /reviews. | Onboarding feel. Empty grids look broken even when the system is healthy. | S |
| A1.8 | **Mobile sweep — final** — Phase 6 was "remaining mobile sweep" but a fresh audit on phone after recent feature additions. Particularly /financials/performance and /overheads which were built desktop-first. | "Enter market strong" includes phone reviewing on the train. | M |
| A1.9 | **Data quality score per business** — single 0-100 score on `/dashboard` showing % of months with closed P&L, % of products with cost, % of recipes with priced ingredients, % of supplier lines matched. Owner click → drilldown by metric. | Owners need to know whether to trust the numbers BEFORE acting. Builds trust + drives matcher review behaviour. | M |
| A1.10 | **Audit trail for owner-facing values** — when a number on dashboard changes, owner can hover/click to see "last updated 2h ago, source: Fortnox sync 06:00 UTC, raw value: 47213". | Trust. Especially around staff_cost where source switches between PK and Fortnox. | M |

**Total Phase A.1 ≈ 2-3 weeks of autonomous work.**

---

### Phase A.2 — High-impact features I can ship solo

These are the differentiators from the previous review I can build without
owner inputs.

| # | Item | Why | Size |
|---|------|-----|------|
| A2.1 | **Waste log v1 — phase 0 schema + UI** — new `waste_log` table (recipe_id, qty_wasted, reason, recorded_at, user, prep_session_id). Form on prep complete step: "anything go in the bin? log it here". Reports surface on `/inventory/recipes` per dish (waste vs cost). | Biggest gap from the architecture review. Restaurants lose 5-15% to waste invisibly. | L |
| A2.2 | **Cash position from Fortnox 1xxx accounts** — read 1xxx asset account balances (already in voucher data) + outstanding supplier_invoice_lines unpaid + open customer invoices. New page `/financials/cash` showing current cash, 30-day projection, alerts when projection dips below payroll-floor. No PSD2 needed. | Owners' #1 anxiety addressed without any external integration. | L |
| A2.3 | **Channel-mix economics surface** — settings page where owner sets commission % per channel (Wolt 30%, Foodora 25%, etc). New panel on `/financials/performance` showing per-channel net margin (gross - commission - packaging cost estimate). | Wolt/Foodora often invisibly destroying margin; this surfaces it. One-time settings input from owner = "S"; engineering = M. | M |
| A2.4 | **Within-service granularity** — bucket revenue_logs by meal period (lunch 11-15, dinner 17-22, late 22+) using existing timestamps. New `/financials/service-detail` page comparing services across last 4 weeks. | Labour decisions happen at meal-period level, not daily. | M |
| A2.5 | **Weather signal wired through SMHI** — free Swedish weather API, businesses already have country=SE. 7-day forecast attached to /scheduling/grid + /dashboard attention panel ("rain forecast Thursday — review terrace covers"). | Cheapest unlocked signal. SMHI is free, no signup. | M |
| A2.6 | **Multi-location org rollup** — new `/financials/group` page (when org has ≥2 businesses) showing combined revenue, food cost %, labour %, side-by-side per-business panels, group-level trends. | When you have 4 Chicce locations, you need the org view. Architectural now > scrambling later. | M |
| A2.7 | **Confidence intervals on forecasts** — modify the three-layer stack to emit `[low, point, high]` not just a point. Render as "47k SEK ±12%" with hover detail. | Owners read a point estimate as gospel. Banded estimate teaches calibration. | M |
| A2.8 | **AI reasoning trail surface** — every AI recommendation gets a "why?" expand showing the inputs (last 12 weeks of data + holiday list + weather) and the model's stated reasoning. Stored in `ai_request_log`. | Trust + accountability. Owner who understands the recommendation will act on it; owner who doesn't, won't. | M |
| A2.9 | **Forecast accuracy badge per business** — show on `/forecast` a "last 6 months: 87% accurate" badge derived from `ai_forecast_outcomes`. Click → MAPE breakdown by layer (deterministic vs LLM-adjusted). | Owners can see the system grading itself = trust signal. | S |
| A2.10 | **A/B shadow-mode framework for AI prompts** — when I change a forecast prompt, run both versions in parallel for 4 weeks, write both to `ai_forecast_outcomes` with a label. Pick the winner by MAPE. | Right now every prompt tweak is a guess. Shadow mode = data-driven. | M |
| A2.11 | **Anomaly through the layered stack** — refactor anomaly detection to use the same L0/L1 baseline as forecasts (claim from architecture doc currently aspirational). Statistical band derived from same baseline = consistent with forecast. | Matches what I claimed in the docs; removes one "oversold" item. | M |
| A2.12 | **Onboarding tour** — first-login walkthrough overlay pointing at /inventory/review, /tracker, /forecast, /ai. Skippable, dismissible permanently. | New customers land on /dashboard and don't know where to go first. | M |

**Total Phase A.2 ≈ 4-6 weeks of autonomous work.**

---

### Phase A.3 — Pre-launch hardening (must-do before opening to public)

| # | Item | Why | Size |
|---|------|-----|------|
| A3.1 | **Load test** — simulate 50 concurrent businesses syncing + 200 concurrent dashboard loads. Measure p95 response times. Fix the worst 3 offenders. | Will we survive a soft-launch wave? Right now: unknown. | M |
| A3.2 | **RLS audit** — sweep every table, confirm `current_user_org_ids()`-based RLS is in place. The audit doc exists from earlier; rerun on current schema. | One missing policy = cross-tenant leak. | M |
| A3.3 | **Stripe webhook reliability check** — two-phase claim pattern exists (M103); add monitoring that alerts if claim_stripe_event returns 'duplicate' or 'concurrent' more than N times in an hour. | Billing correctness = revenue. | S |
| A3.4 | **AI cost dashboard** — admin surface showing daily/monthly spend per org, per agent, per surface. Alert at 70% of MAX_DAILY_GLOBAL_USD. | Don't get blindsided by a customer running away with the bill. | M |
| A3.5 | **Onboarding-flow smoke test** — automated test that walks signup → email verify → onboarding wizard → first sync → dashboard render. Runs on every PR. | Must not break the new-customer path. | M |
| A3.6 | **Sub-processor list + privacy.md refresh** — update /privacy with current sub-processor list (Anthropic, Supabase, Vercel, Resend, Fortnox, PK, Google, SMHI when wired). Already drafted in LEGAL-OBLIGATIONS.md; sync to user-facing page. | GDPR + trust marker for prospects evaluating us. | S |
| A3.7 | **Status page** — public `/status` showing latest cron run status per pillar (Fortnox sync, PK sync, FX, extractor, matcher). Reads ai_request_log + integrations.last_sync_at. | "Is the data fresh?" is asked by every prospect. | M |
| A3.8 | **Backup + restore drill** — document the procedure to restore from Supabase Pro daily backup. Test once on a throwaway database. | Catastrophic recovery; required before paid customers. | M |

**Total Phase A.3 ≈ 2-3 weeks autonomous.**

---

## Stream B — needs you to unblock

For each, I'll list what YOU need to do, and the engineering scaffold I can
build in parallel so the moment you unblock me, the wiring is already there.

### B.1 — Company formation (highest priority)

**You need to:** Register the legal entity. Notes from memory:
- Blocks all sub-processor DPAs (Anthropic ZDR, Fortnox dev program access)
- Blocks Stripe Atlas-style options
- Blocks PSD2 cert process

**I can prep:** Nothing engineering-blocked by this directly, but I can draft
the sub-processor request emails for you to send the day after registration
(Anthropic ZDR, Fortnox dev programme, SMHI commercial use confirmation).

### B.2 — POS-to-recipe mapping (unlocks menu engineering + demand forecast)

**You need to:** Either (a) get one customer (Chicce or Vero) to map their POS
menu items to recipes through the existing `/admin/onboard/recipes-draft`
flow, OR (b) decide which connector we target first (Onslip / Ancon / Swess)
for an auto-mapper.

**I can prep:**
- Build the menu-engineering matrix UI now with a "manual sales mix input"
  field. When real POS data lands, swap the input source — UI doesn't change.
- Build a per-product daily-demand storage table ready to receive POS sales
  events.
- Doc: `POS-RECIPE-MAPPING-PLAN.md` already exists; I'll extend.

### B.3 — Booking provider integration (unlocks reservation/customer signal)

**You need to:** Decide which provider to target first — SuperbExperience,
OpenTable, ResDiary, or Caspeco. Doc `BOOKING-API-COVERS-PLAN.md` lists
them. Probably whichever YOU or Vero/Chicce already use.

**I can prep:**
- Schema for `reservations` table (party_size, source, recipe_pre_orders,
  cancel_history).
- UI shell on `/scheduling/grid` for reservation-driven cover counts.
- Booking provider abstraction layer (so swapping provider = one adapter).

### B.4 — Live bank feeds (cash forecast extension)

**You need to:** Decide whether to pursue PSD2 cert (significant compliance
cost, ~6-12 months) OR partner with an aggregator (Tink / Plaid EU /
Nordigen). Doc `LIVE-BANK-FEEDS-PLAN.md` exists. Memory says "parked until
15-25 paying customers" — confirm that's still the threshold.

**I can prep:** Cash position from Fortnox 1xxx (Phase A2.2) gets you 80%
of the value without bank feeds. PSD2 is a Phase 2 enhancement.

### B.5 — Marketing / launch site

**You need to:** Decide the brand voice (founding tier is removed — what's
the new positioning?), final pricing tiers (current: Solo 1995 / Group 4995
/ Chain 9995 — confirm at launch), the public homepage copy.

**I can prep:** Cleanup of marketing pages, /pricing surface, /security and
/privacy pages. Founding-tier residual references swept.

### B.6 — First three reference customers

**You need to:** Confirm Vero + Chicce + 1 more as launch case studies.
Permission to mention them publicly. Permission to use their data for
"see how X grew margin by Y%" content.

**I can prep:** A `/case-studies` page template that pulls live numbers
from a designated reference business (with their permission flag set).

### B.7 — Pricing tier configuration in Stripe

**You need to:** Confirm pricing, create the products in Stripe, share
the price IDs.

**I can prep:** All the pricing-gate code already exists; just needs the
right product IDs in env config.

### B.8 — Customer support flow

**You need to:** Decide where support lands. hello@/support@ mailbox exists.
Need a triage process — who reads it, response SLA, escalation. Or a tool
(Intercom / Plain.com / just Gmail with labels).

**I can prep:** In-app "report issue" button on every error boundary that
emails support@ with auto-attached context (user, org, route, error).

---

## Suggested ordering

If you're asking "where to point me next," here's my recommendation in priority
order, factoring in market readiness vs autonomy:

1. **Phase A.1 (1-2 weeks)** — boring hardening. Ship before any feature.
   Specifically A1.5 (backfill health), A1.6 (cron observability), A1.9
   (data quality score), and A1.10 (audit trail).
2. **Phase A.3 (parallel where it makes sense)** — A3.2 (RLS audit) and
   A3.5 (onboarding smoke test) are blocking-level for a public launch.
   Do these alongside A.1.
3. **Phase A.2 high-impact features** — pick 2-3 of A2.1 (waste), A2.2
   (cash), A2.5 (weather), A2.7 (confidence). All four would be nice;
   waste + cash are the biggest differentiators.
4. **Stream B unblocks** — once company is formed, send sub-processor
   request emails. Decide booking provider. Confirm reference customers.
5. **Phase A.2 second wave** — menu engineering, multi-location rollup,
   AI reasoning trail. These benefit from B.2 (POS mapping) being
   unblocked but don't require it.
6. **Phase A.3 remaining** — load test, status page, AI cost dashboard
   in the final week before opening.

---

## What I won't do without explicit ask

To stay aligned with what you want:
- No feature flag experimentation without a clear hypothesis
- No backwards-compatibility shims for hypothetical migrations
- No new abstractions for hypothetical future tenants
- No emojis anywhere (per standing rule)
- No mid-task check-ins (auto mode — keep going until done or genuinely blocked)
- No destructive git operations without confirmation
- No automated retraining of matcher rules from owner corrections (signals
  only; humans update rules)
- No sub-daily crons added without you knowing (Vercel Pro plan can; just
  worth flagging to keep cost visible)

---

## Tracking

Each Phase A item will become a task when started, not now. The doc IS the
roadmap; tasks track in-flight work. You pick the order, I execute.

When you say "start A1.5" or "start the bolts pass" I'll create the task,
flip it to in_progress, ship it, mark complete.
