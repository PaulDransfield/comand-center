# CommandCenter — State of the Project

**Date:** 2026-04-23
**Owner / sole developer:** Paul Dransfield
**Live at:** https://www.comandcenter.se
**Purpose of this doc:** give a complete picture of the project — product, technical maturity, commercial state, market, and funding decision — for honest external review (Claude.ai, advisors, potential investors).

---

## 1. Executive summary

**CommandCenter** is a Swedish-market business-intelligence SaaS for restaurant groups. It pulls data from the operator's existing tools (Personalkollen for staff + POS, Fortnox for accounting, Stripe for payments, POS integrations like Onslip), aggregates it into a unified view, and layers AI agents that generate actionable weekly/monthly insights — labour-cost cuts, food-cost anomalies, cash-flow projections, budget variance, scheduling optimisation.

**Current state:** technically mature MVP+ in production with one live customer (the founder's own restaurant group — Vero Italiano + Rosali Deli). ~12 months of continuous shipping. Zero external paying customers yet. Legal entity (ComandCenter AB) not yet registered — blocks sub-processor DPAs and Fortnox developer-program access.

**Core question this doc addresses:** does this need VC funding, or is it a bootstrap?

**Short answer:** bootstrap is viable and probably preferable. The technical moat is real but the Swedish-restaurant addressable market caps VC-return math. Raising only makes sense if the plan is rapid Nordic/European expansion, which would require a co-founder on the commercial side.

---

## 2. What the product does

### Value proposition in one sentence

> "One screen that tells a Swedish restaurant owner what's working, what's bleeding money, and what to change next week — built on top of the tools they already use."

### User journey

1. Owner signs up, enters business details + legal entity.
2. Connects **Personalkollen** (staff scheduling + POS sales — the dominant Swedish staff tool, paid by ~10k restaurants).
3. Uploads monthly/annual **Fortnox Resultatrapport** PDFs (Swedish P&L from the dominant SME bookkeeping software). AI extractor reads them, classifies every BAS account, populates a full P&L.
4. Optional: connects **Fortnox OAuth** for supplier invoices (blocked pending Fortnox dev-program approval — needs a legal entity).
5. Nightly syncs keep everything current. AI agents run on schedules.
6. Monday 07:00 Stockholm — owner gets a personalised, numbers-specific Monday Memo email with 3 concrete actions and SEK-quantified impact for each.
7. Through the week: dashboard shows live dashboards, trends, anomalies, "Ask AI" button for free-form questions with the full business context.

### Key pages in the app

- **Overview** — weekly KPI dashboard, AI-suggested next-week action
- **Group** — multi-restaurant rollup for operators with 2+ locations
- **P&L Tracker** — 12-month profit-and-loss with drill-down
- **Budget vs Actual** — AI-generated annual budget, tracked monthly
- **Performance** (new, shipped 2026-04-23) — waterfall + donut + trend sparklines across Revenue / Food / Alcohol / Labour / Overheads / Margin, period picker (W/M/Q/YTD), compare mode
- **Forecast** — full-year projection with calibration
- **Overheads** — Fortnox line-item detail, cost-creep detection
- **Revenue** — daily revenue detail with food/drink/takeaway split
- **Staff** — labour %, overtime, OB supplements, late arrivals
- **Scheduling** — AI-suggested next-week schedule (cut-only, asymmetric rule)
- **Departments** — per-department P&L for multi-concept operators
- **Invoices** — Fortnox supplier invoice tracking
- **Alerts** — anomaly feed
- **Admin** — operator-facing customer management (me as super-admin)

### AI agents (6 shipped + 3 supporting)

| Agent | Trigger | Plan gate | Model | Status |
|---|---|---|---|---|
| Anomaly detection | Nightly 05:30 UTC | All | Haiku 4.5 | ✅ live, sends email alerts |
| Onboarding success | On first sync | All | Haiku 4.5 | ✅ live |
| Monday Briefing | Mon 06:00 UTC | Pro+ | Haiku 4.5 | ✅ live |
| Forecast calibration | 1st of month | Pro+ | Haiku 4.5 | ✅ live, pure arithmetic |
| Supplier price creep | 1st of month | Pro+ | Haiku 4.5 | ✅ shipped, waiting for Fortnox OAuth |
| Scheduling optimisation | Weekly Mon 07 UTC | Group | Sonnet 4.6 | ✅ live |
| Cost intelligence | On Fortnox upload | All | Haiku 4.5 | ✅ live |
| AI accuracy reconciler | Daily 07:00 UTC | — | no AI | ✅ closes the feedback loop |
| Customer health scoring | Weekly | admin-only | no AI | ✅ live |

All AI surfaces share a single `lib/ai/rules.ts` (domain rules + benchmarks + voice), `lib/ai/scope.ts` (business-wide vs department-level attribution), `lib/ai/outcomes.ts` (feedback loop), and use Anthropic tool-use for structured outputs. Prompt caching on `/api/ask` cuts input-token cost ~80%. At 50 customers, total AI spend ~$15/month on Haiku 4.5 (vs. ~$45/mo if using Sonnet everywhere).

---

## 3. Technical state

### Stack

- **Frontend + backend:** Next.js 14 App Router on Vercel Pro (Fluid Compute, EU region `fra1`)
- **Database:** Supabase Pro (Postgres, Frankfurt, PITR, daily backups, 8 GB, RLS enforced on every tenant table)
- **AI:** Anthropic Claude (Sonnet 4.6 for analysis, Haiku 4.5 for agents; via direct API)
- **Payments:** Stripe with `stripe_processed_events` idempotency
- **Email:** Resend (transactional) + Gmail Workspace on `comandcenter.se` (11 aliases, SPF/DKIM/DMARC all verified)
- **Monitoring:** Sentry with custom PII scrubbing (emails + Swedish phone numbers redacted before leaving our boundary)
- **Analytics:** PostHog (EU-hosted), ePrivacy-compliant consent banner gates initialisation
- **Weather:** Open-Meteo (free API) for footfall correlation

### Data pipeline

```
Personalkollen API ──┐
Fortnox OAuth (pending)┤
Fortnox PDF upload ──┼──→ sync engine ──→ revenue_logs
Onslip (POS) ─────────┤                   staff_logs
                      │                   tracker_data, tracker_line_items
                      └──→ aggregator ──→ daily_metrics, monthly_metrics
                                      └─→ AI agents ──→ alerts, briefings,
                                                         ai_forecast_outcomes,
                                                         scheduling_recommendations
```

Job queue built on Postgres (`extraction_jobs` table) with `FOR UPDATE SKIP LOCKED` atomic claim + pg_cron firing the worker every 20 seconds + stale-job release every 60 seconds.

### What's been built — high-impact architecture decisions

- **Fortnox extraction** uses Sonnet 4.6 + extended thinking (5000 token budget) + tool use (`submit_extraction` with JSON schema) + prompt caching. Account-number-primary classification using Swedish BAS chart-of-accounts ranges (3000s=revenue, 4000s=food/cogs, 5000-6999=overheads, 7000s=staff, 8900s=depreciation). Validation layer catches scale-misreads, sign errors, and rollup-vs-line-sum mismatches server-side before the data lands.
- **AI feedback loop** — every budget prediction captured in `ai_forecast_outcomes` with the model's reasoning context. Nightly reconciler fills in actuals from `monthly_metrics` once each month closes. Next generation of the budget prompt cites the model's own accuracy track record ("you've been systematically over-predicting Q3 by 8% for two years — adjust").
- **Tenant isolation** — RLS policies on every data table, `current_user_org_ids()` array-returning function for multi-org users, `requireAdmin()` + `checkAdminSecret()` on 35 admin routes, zero known cross-tenant leaks.
- **Self-healing sync** — `/api/sync/today` fires on every page mount (10-min server throttle) for the selected business. Engine resets `status='connected'` on every successful sync so a one-off failure can't permanently strand an integration. Master-sync nightly + 3×/day catchup covers crons; BackgroundSync covers the active-user case.
- **Documented incidents** — FIXES.md has 11 entries, each with symptom, root cause, fix commit, and preventive rule. No silent regressions allowed.

### Technical debt / known limits

- **Single-developer codebase.** ~100k+ LOC, no other human has touched it. Bus factor = 1.
- **No automated tests.** Rely on TypeScript strict mode + manual verification per shipped feature + comprehensive error reporting to Sentry. Works at this scale; won't at 50+ customers.
- **Fortnox supplier invoice sync blocked** pending Fortnox developer-program approval (requires legal entity = ComandCenter AB registration).
- **No cohort analytics yet** — industry-benchmark percentiles get computed but aren't a differentiated feature customers see.
- **Mobile:** responsive web only. Native mobile (Capacitor) scoped and planned, not started.

---

## 4. Commercial state (honest version)

- **Paying customers:** 0 external.
- **Operator trial:** 1 (the founder — Vero Italiano + Rosali Deli, both inside one org).
- **Revenue:** SEK 0.
- **Stripe setup:** working, subscription products defined (Trial / Pro / Group), billing pipeline tested. Never processed a customer payment.
- **Sales & marketing activity:** none. No landing page optimisation, no outbound, no Google Ads, no LinkedIn, no content marketing. comandcenter.se is a functional login page.
- **Legal entity:** not yet registered. Trading as Paul Dransfield personally. Blocks: Apple Developer (organisation account), Google Play (organisation), Fortnox developer program (requires corporate), Anthropic Zero-Data-Retention agreement, formal DPAs with Supabase/Vercel/Stripe/Resend/Anthropic.
- **Compliance:** LEGAL-OBLIGATIONS.md drafted, GDPR Art. 17 erasure pipeline shipped (hard-delete with 3 legally-retained tables for bokföringslagen / audit). No lawyer review yet.
- **Pricing:** Trial (free), Pro (Swedish-single-restaurant tier), Group (multi-restaurant tier with additional AI agents). Specific SEK prices defined but not stress-tested against market.

**Honest read:** product is production-ready; business is pre-launch.

---

## 5. Market

### Sweden-specific opportunity

- **~30,000 registered restaurants** in Sweden (Statistics Sweden).
- **~10,000 use Personalkollen** for staff scheduling (dominant platform for mid-to-large operators; commanding share of table-service / restaurant chains).
- **~70,000 use Fortnox** across SME segments; probably ~8,000 are restaurants (rough).
- **Realistic serviceable addressable market (SAM):** restaurant operators with 2+ locations or 5M+ SEK annual revenue AND using both Personalkollen + Fortnox — estimated **2,000–4,000 operators**.

If pricing averages SEK 1,500/month per restaurant, Swedish SAM revenue ceiling is:
- 2,000 operators × 1,500 × 12 = SEK 36M ARR
- 4,000 operators × 1,500 × 12 = SEK 72M ARR

That's roughly **EUR 3–6M ARR** at Swedish saturation. Real-world capture rate at equilibrium might be 20–30% of SAM, so **EUR 0.8–2M ARR** is the realistic Swedish ceiling for a mid-decade scenario.

### Nordic expansion

- **Norway / Denmark / Finland:** each ~15k–30k restaurants; different accounting software (Fiken/Tripletex in Norway, e-conomic/Dinero in Denmark, Procountor in Finland); similar staff-scheduling landscape.
- **Expansion cost:** each country needs a new bookkeeping-extractor pipeline, local-language AI prompts, a reseller/partner strategy. Substantial integration work per country.
- **Combined Nordic ceiling** with good execution: **EUR 4–10M ARR** over 5–7 years.

### Competitive landscape

- **Onslip, Zetadisplay, Zettle** — POS-first; don't do the P&L layer or AI insights.
- **Personalkollen itself** — has its own dashboards, but stops at staff scheduling + POS data; doesn't pull Fortnox, doesn't model full P&L, no AI agents generating prose.
- **Fortnox itself** — bookkeeping-first; its "Analys" add-on is generic and not restaurant-specific.
- **International BI tools** (e.g. Holistic, Polymer, generic BI) — don't understand Swedish BAS accounts, Swedish VAT (12% food / 25% alcohol), OB supplements, Swedish bookkeeping law. Replacement cost is high even for sophisticated operators.
- **In-house Excel** — how most operators actually work today. That's the real competitor.

**Defensible moat:** deep Swedish specificity. BAS chart of accounts, OB supplement math, VAT splits, bokföringslagen retention, Fortnox P&L extractor. A foreign entrant would need 6–12 months of focused work just to match the data layer.

---

## 6. Unit economics (estimated)

**Per-customer monthly cost at 50 customers:**
- Vercel Pro (flat) + Supabase Pro (flat): ~$45/mo total → ~$0.90/customer
- Anthropic API: ~$0.30/customer (Haiku-dominant)
- Resend: $0.02/customer
- Open-Meteo, PostHog, Sentry: free tiers
- **Total variable:** ~$1.25/customer/month

At **SEK 1,500/month ARPU** and **$1.25/customer cost**, gross margin is ~99%. CAC is the unknown. If CAC is SEK 5,000 per customer, payback = 4 months, which is healthy for B2B SaaS.

**Pricing headroom:** SEK 1,500/mo is conservative. A restaurant doing SEK 8M annual revenue has labour cost of SEK 3M; 1pp labour-% optimisation = SEK 80k/year saved. Even SEK 3,000/mo (SEK 36k/year) is a 2× ROI at single-digit labour savings. The pricing could plausibly be 2× higher with the right sales motion.

---

## 7. Roadmap — what's left

### Pre-launch gating (next 4–8 weeks)

1. **Register ComandCenter AB.** Unblocks everything downstream. 2–4 week Bolagsverket turnaround.
2. **Lawyer review of LEGAL-OBLIGATIONS.md + DPAs** with Supabase / Vercel / Stripe / Resend / Anthropic. Swedish GDPR compliance spot-check.
3. **Landing page** at comandcenter.se — value prop, screenshots, pricing, self-service signup. Currently a login page.
4. **3 pilot customers** outside the founder's own group. Free for 6 months in exchange for weekly feedback + testimonial.
5. **Fortnox developer-program application** — enables supplier-invoice OAuth sync.
6. **Automated tests** — at least happy-path coverage on the critical pipelines (sync, aggregation, AI extraction, billing webhooks) before bringing in real customers.

### Post-launch features (3–6 months)

- Mobile app (Capacitor wrapping the web app; scoped).
- Native push notifications for critical anomalies.
- Benchmark cohort view (with opt-in anonymised sharing — the AI already computes it).
- Multi-user access per organisation (currently single-owner per org).
- White-label partnership with an accounting firm or Personalkollen reseller.

### Longer-term (6–18 months)

- Nordic expansion pilot: one Norwegian customer, verify the accounting extractor can be re-pointed at Fiken or Tripletex.
- Supplier/wholesale integrations (Menigo, Martin Olsson) — enables real unit-level COGS attribution rather than P&L-level.
- AI-driven recipe / menu pricing assistant.

---

## 8. Team

- **Paul Dransfield** — sole founder, product, engineering, operations. Swedish restaurant-operator background (Vero Italiano / Rosali Deli). Non-technical originally; pair-programming with Claude (Sonnet 4.6 and Opus 4.7) has gotten the entire codebase to production.

No other team members. No advisors yet. No board.

**Bus factor = 1.** This is the single biggest commercial risk.

---

## 9. The funding decision

### What bootstrap looks like

- Register the AB. Get 3 pilots on paid tier after Month 3. Reinvest every kr back into the product.
- At SEK 1,500/month ARPU, 50 customers = SEK 75,000/month = SEK 900k/year — comfortably covers infra + legal/accounting + gives Paul a part-time salary.
- 100 customers ≈ SEK 1.8M ARR, supports one full-time founder + a part-time sales/CS hire.
- Takes ~18–30 months to reach 100 customers with organic + referral + content marketing.

**Outcome:** a profitable niche SaaS doing EUR 1–2M ARR in 5 years, fully owned by Paul. Sold to a Nordic accounting-software roll-up or PE for 5–8× ARR → EUR 5–15M exit. Good result for a solo founder.

### What raising looks like

Pre-seed SEK 3M (~EUR 270k) at SEK 15–25M pre-money:
- 12–18 month runway
- One product-marketing / commercial co-founder hire
- Nordic expansion groundwork (Norway pipeline)
- Spend on paid acquisition to short-circuit the organic ramp

**Outcome if it works:** EUR 3–5M ARR in 3 years → Series A candidate → EUR 20–40M exit window.

**Outcome if it doesn't:** runway runs out, investors push for a pivot or fire sale, founder dilution without a real exit.

### Does it NEED funding?

**Probably not.** Here's why:

- Infra cost is essentially $0 at current scale; no pressure to raise for runway
- The product works; the blocker is GTM, and GTM in a 30k-restaurant market is about phone calls and content, not engineering
- A solo technical founder who already understands the customer problem and has the MVP working is in the strongest bootstrap position — raising now dilutes upside for problems money doesn't solve
- The Swedish-market ceiling caps VC-return math. VCs want EUR 50M+ exit potential; a Sweden-only play peaks at EUR 10–15M
- Once you're at 50 paying customers growing 5–10%/month, raising becomes much easier and on better terms

**Funding DOES make sense if:**

1. You explicitly plan Nordic-or-bust (4-country simultaneous rollout needs capital)
2. You find a killer commercial co-founder who only joins if there's salary/equity funded to go (this is the most common legitimate reason)
3. A strategic investor (Personalkollen, Fortnox, Visma) offers non-dilutive-feeling terms in exchange for channel access

### Recommendation

**Register the AB. Get to 10 paying customers organically. Then decide.** At 10 customers you'll know whether:
- The sales motion is repeatable (→ raise to accelerate)
- The churn is acceptable (→ raise or bootstrap, both work)
- The pricing holds (→ you have an actual business, fundable either way)

Without 10 customers, a pitch to VCs relies entirely on storytelling and the founder's background — Swedish-market solo-founder pre-revenue is a **hard raise** at reasonable terms.

---

## 10. What I'd tell a friend asking for advice

The product is real. The tech is honest. The market is too small for VCs but big enough for a great lifestyle business or a mid-8-figure trade sale in 5 years.

The gap between "working MVP used by founder" and "revenue-generating SaaS" is 90% commercial, 10% technical. The technical work you've been doing this year is already MORE than needed. Stop shipping new features for a few weeks. Register the company. Build a landing page. Call 20 Swedish restaurant operators you know. Sign the first 3.

If that works — bootstrap or raise, either is legitimate. If that doesn't work — no amount of VC money fixes a product customers don't want, and you save yourself the dilution pain of raising on a thesis.

The single best use of the next 30 days is not code. It's customer calls.
