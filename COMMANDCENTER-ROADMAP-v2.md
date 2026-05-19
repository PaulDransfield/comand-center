# CommandCenter → Nory: revised roadmap (v2)

**Last updated:** 19 May 2026
**Supersedes:** the previous COMMANDCENTER-ROADMAP.md (Phase 0–7 plan)
**Reads alongside:** THE-NORDIC-PLAN.md (product/tech master), ROADMAP.md (tactical, session-by-session), ADD-SECOND-BUSINESS-PLAN.md, LIVE-BANK-FEEDS-PLAN.md, CLAUDE.md (rules)

This document is the **go-to-market and positioning layer** that bolts onto the Nordic Plan. The Nordic Plan answers *what we build*. This answers *how we sell it, how we look to operators, and what infrastructure outside the product itself we need to win the region*.

---

## 0. Reconciling the previous roadmap

For honesty and continuity. Where the first roadmap was wrong:

| Previous recommendation | Actual position | Corrected stance |
|---|---|---|
| Build Inventory v1 (Phase 3, 16 weeks) | Nordic Plan §9.3: "Don't build payroll or inventory; integrate." | **Drop inventory build.** Position the Fortnox-derived COGS view as our intelligence layer; let operators keep their existing stock tools. |
| Build Workforce v2 / löneunderlag flow (Phase 4) | Nordic Plan: same — don't build payroll, integrate. | **Drop the payroll build.** Pull approved-shifts → Fortnox export is fine as a thin helper; full payroll is out. |
| Pricing 1 995 / 4 995 / 9 995 SEK + Founding 995 SEK | Reconciled 2026-05-19 | **Confirmed at 1 995 / 4 995 / 9 995 SEK per business.** No founding tier — case-study customers get the standard rate and a quarterly review relationship in exchange for logo + numbers rights. |
| "Phase 0 unblockers" (register AB, sign Fortnox) | Already past this — Vero OAuth live, 12-month backfill working, 6 agents shipped | **Skip phase 0.** |
| Frame as "Swedish answer to Nory" | Nordic Plan is SE → NO → DK → FI | **Frame as Nordic-native** throughout. Sweden is the launchpad, not the ceiling. |
| Build a benchmark tool in Phase 6 | Implicit — you don't have one yet, and it's a high-value lead-gen asset | **Keep this**, but explicitly link it to your real anonymised customer data once n≥10. |
| Three-tier landing pages | You don't have these yet | **Keep this.** |
| 4-milestone implementation methodology | You have an informal version | **Codify and publish it.** |
| Phase 1 = marketing infrastructure | Still right | **Keep this** — it's the biggest unaddressed gap. |

Net: about 60% of the previous roadmap holds. The product build phases were wrong because I didn't know you'd already decided against them. The marketing/GTM phases are still the right gap to fill.

---

## 1. What the Nordic Plan already gives us

The Nordic Plan is doing the heavy lifting on product strategy. Briefly, so the rest of this document doesn't repeat it:

**Q3 2026** — 12-week sprint covers hourly POS ingestion + meal-period forecasting, attribution-first UX (`/dashboard/why-today`, `/dashboard/why-yesterday`, target bands), Stockholm events ingestion, customer 3–5 onboarding sprint + booking integration.

**Q4 2026** — Sweden saturation (10–15 paying), Norway expansion (Tripletex integration, NO holidays module, first Oslo customer), cash-side intelligence enhancements.

**Q1–Q2 2027** — Denmark + Finland, multi-business GBM model, v1.6 subset-substitution forecaster.

**The non-build list** is firm: no real-time pipeline, no POS integration sprawl, no replacement-of-Fortnox, no enterprise sales, no foundation-model prediction, no LLM-as-numerical-predictor, no English-first UI, no chasing Nory's 95% headline number, no premature multi-currency, no pre-PMF VC.

That plan is sound. This document doesn't argue with it. What it adds is everything sitting *outside* the engineering surface.

---

## 2. The full Nory inventory (carry-forward from v1)

Kept here verbatim so future-Paul has a single document to reference. Source: nory.ai pages read 2026-05-19.

### 2.1 Their four product modules

**Business Intelligence** — 5–15min POS refresh, hourly forecast per venue 90–95% accuracy, COGS/labour/waste tracking, real-time P&L, budget vs actual, customisable dashboards, role-based access, multi-user multi-location, Flash P&L summaries, predictive analytics.

**Inventory** — AI-predictive ordering with order guides, real-time GP & waste, delivery + invoicing one-click flow, photo invoice scanning (deliberately not barcode), menu engineering with GP% targets at menu/dish level, recipes/portion control/costing, Central Production Unit management, supplier price-change alerts, demand-based reorder with red/green stock status, inter-location variance, stock counts, multi-location dashboard.

**Workforce** — AI scheduling matching capability/availability/contract to forecast and budget, drag-and-drop popular shifts, real-time labour vs budget (Digbeth case: 0.38% variance), onboarding <2 min/team-member, HR ops (reviews, feedback, entitlements), engagement insights, time-and-attendance, staff mobile app (schedules/swap/time-off/claim shifts/pay/details), push reminders, manager↔team chat, compliance (breaks/rest/max-shifts/contract limits/holiday accrual), tips management with UK Allocation of Tips compliance.

**Payroll** — Gross-to-Net, HMRC/Revenue tax submissions, pensions, payslips, hourly/salaried/variable-hour support, multi-site consolidation, audit reports, payroll approval off approved shifts, 24/7 in-app chat.

### 2.2 Adjacent products

**Customer Reviews** (newer) — aggregates Google/Deliveroo/TripAdvisor/JustEat/OpenTable/Yelp, AI sentiment+operations correlation ("slow Fridays = understaffed 18:00–21:00 Fridays"), specific operational recommendations, AI-generated auto-replies in brand tone, cross-location benchmarking.

**Nory Capital** (YouLend white-label) — £1k–£2m loans, 85% acceptance, 24h approval, 1–5 day funding, fixed-monthly or %-of-card-sales repayment, from ~5% interest, 5-min embedded application.

### 2.3 Marketing & growth infrastructure

ROI Calculator, Benchmark tool (operator inputs GP/labour%/Google Reviews → "You vs industry" report with restaurant-type segmentation), 14+ visible customer logos with G2 4.8 rating, segment-specific solution pages (Independent/Franchise/Multi-location/Enterprise), case studies (15+), blog, "What's Cooking?" podcast, content library, product tour video, "Book a chat" CTA everywhere.

### 2.4 Service & implementation

**4-milestone playbook**: kick-off (gather info, KPIs) → M1 POS+forecasting → M2 time/attendance+scheduling → M3 supply chain → M4 stock counts+COGS. Customer-side roles defined: Point of Contact, Task Manager, "Nory Champion" (internal advocate). No implementation fees claimed. Onboarding portal, 24/7 chat for payroll, dedicated Customer Success Manager.

### 2.5 Integrations

POS: Toast, Lightspeed, Vita Mojo, Square, SumUp, Tevalis, Clover, Zonal, Revel, Par Pixel Point, Oracle Micros, MyOrderBox, Epos Now, Innova POS, Captiva POS. **All UK/Ireland/US-centric** — no Caspeco, no Personalkollen, no Onslip. Confirms the Nordic gap.

### 2.6 Headline claims

10–25% labour cost reduction · up to 50% waste reduction · 100+ hours/month admin saved · 90–97% forecast accuracy · 1–4pp GP improvement · payroll 2 days → 1 hour.

---

## 3. What to copy from Nory, what to skip, what to do differently

Updated with the Nordic Plan in hand.

### 3.1 Copy from Nory

- **The four-module mental model.** Operators understand "BI / Inventory / Workforce / Payroll" because Nory and others trained them. Even though we *don't build* inventory or payroll, the **marketing taxonomy** should still reference them — but reframed as integration surfaces, not products we own.
- **Agentic AI framing.** You have 6 agents. Name them, illustrate them, give each one a one-liner. Nory's "crew that never clocks off" is doing real work in their funnel.
- **Results-led marketing.** Every public page leads with measurable outcomes. Labour% reduction, hours saved, margin improvement.
- **Benchmark tool.** High-value, low-cost-to-build, compounds with every submission. Nordic-native (kommun, restaurant type, segment) is the differentiator.
- **4-milestone implementation playbook.** Reduces perceived buyer risk. Codify yours from the informal version that's already working with Vero/Rosali.
- **Segment-specific landing pages** (Solo / Group / Chain). Even when Chain is aspirational, signalling "we know your segment" closes group-level deals.
- **"Nory Champion" role internally at the customer.** This works in Sweden too — the GM or admin manager who becomes the system's advocate. Define the role in your onboarding doc.
- **No-implementation-fee positioning.** Removes a buyer objection. We're effectively already doing this.

### 3.2 Skip indefinitely

- **Customer Reviews aggregation as a separate product.** Nice-to-have, defer until 30+ customers ask.
- **Nory Capital / lending.** Not for years. Adds zero product value, partnering with a Nordic equivalent (Froda, Mondu, Treyd) is a Series B-onwards distraction.
- **Per-seat pricing.** Anti-pattern for the segment.
- **Freemium.** Anti-pattern; operators want trusted, not free.
- **Full HR feature stack** (performance reviews, engagement surveys, recruitment). Hailey HR / Lessor / Hogia / Visma own this in the Nordics. Integrate at most.
- **Tips management as a product.** Different regulatory framing in Sweden; lower priority.
- **A native staff mobile app.** Personalkollen owns that real estate in Sweden. Build a thin "view your Monday Memo on mobile" web view instead.
- **The podcast.** Massive lift, no advantage.
- **Content Library as a separate destination.** Until the blog has 20+ posts, just have a blog.

### 3.3 Do differently

- **Lead with Swedish accounting depth.** Fortnox/BAS classification is the moat. Every public page reinforces it.
- **Labour% first, kronor second.** Swedish operators read percentage before currency. Every metric pair leads with %.
- **Calm copy, not transformation copy.** Swedish operators are sceptical of hype. "Profitability's secret ingredient" doesn't translate — `Marginaler, inte mirakel` does.
- **Founder-as-operator credibility everywhere.** "Paul ran Vero and Rosali before building this" is your strongest sales line. Use it on the about page, on every blog post, on every demo intro.
- **Show how we sit on top of the existing stack.** Operators in Örebro know Caspeco, Personalkollen, Fortnox. Don't replace — augment.
- **Pricing as a moat.** 1 995 / 4 995 / 9 995 SEK is materially cheaper than Nory's enterprise pricing while still positioning as professional restaurant intelligence (not a budget tool). For a 3-location group on Group tier (~5 k SEK/month) the math is "fraction of Nory's annual cost, deeper into the Swedish stack." Avoid pricing below 1 000 SEK/month — sceptical Nordic operators read sub-1 000 as "hobby software".
- **Cash-side intelligence as the second pillar.** Nory doesn't have it. The Fortnox-booked cash position + 30-day projection + (eventually) live bank feeds is uniquely ours. Promote it.

---

## 4. The actual roadmap — GTM and infrastructure, sequenced

This is what slots alongside the Nordic Plan's product sprints. Phases here are dated to coordinate with theirs.

### Phase A — Marketing foundation (May–June 2026, 4–6 weeks)

This is what bridges "we have a great product behind the login wall" to "operators are booking demos." Currently the bridge does not exist.

**A.1 — Public landing page at comandcenter.se**
- Use the mockup already designed in the previous session.
- Swedish-first with EN toggle. No DK/NO localisation yet — that lands in Phase C/D.
- Hero: `Marginaler, inte mirakel` or similar calm headline. KPI card mockup, three results, six AI agents, modules, primary CTA "Boka demo".
- One real screenshot of Vero's dashboard (anonymised) showing the 30-day cash projection — the differentiation Nory doesn't have.

**A.2 — Module sub-pages (×4)**
- `/produkt/affärsresultat` — BI module page. Largely matches existing built feature set.
- `/produkt/prognos` — forecasting / Monday Memo / scheduling AI page.
- `/produkt/kassa` — cash position + 30-day projection. **This is our unique differentiator vs Nory; treat it as the headline page.**
- `/produkt/ai-agenter` — the six named agents page.
- Each page: hero, three "why operators love this", screenshots, FAQ section, CTA.

**A.3 — Customer-segment pages (×3)**
- `/lösningar/självständiga` (Solo, 1 location)
- `/lösningar/grupp` (Group, 2–5 locations)
- `/lösningar/kedja` (Chain, 6+, aspirational)

**A.4 — Case studies (×2 minimum)**
- Vero Italiano + Rosali Deli.
- Real numbers, real quote, one page each.
- Negotiate logo + numbers usage with both owners as part of moving them from "paying candidate" to paying.
- Specifically extract: forecast accuracy improvement vs operator's prior method, hours saved per week, any GP or labour movement vs pre-CommandCenter baseline.

**A.5 — ROI Calculator at /roi**
- Inputs: number of locations, weekly omsättning, current labour%, current admin hours/month.
- Outputs: estimated kr saved per month, payback period, comparable customers' results.
- Simple form, no auth, generates branded PDF on submit, email-gated.

**A.6 — Booking flow**
- Cal.com or Calendly under `/boka-demo`.
- Three qualifying questions: locations count, POS in use (must be PK-compatible to qualify for fast onboarding), accounting (must be Fortnox to qualify).
- Out-of-fit cases route to a "we'll get back to you when we support X" wait-list, not a hard rejection.

**A.7 — Three launch blog posts**
- "Varför svenska restauranger behöver ett annat operativsystem"
- "Att läsa Fortnox som en revisor: hur BAS-klassificering faktiskt fungerar"
- "30–35% personalkostnad: branschens dolda måttstock"

**A.8 — Logo strip with placeholder slots**
- Vero + Rosali real, plus 6–8 silhouettes labelled "kommer snart". Signals momentum without lying.

**A.9 — Trust elements**
- One-page security/data summary (Supabase EU hosting, GDPR, encryption, retention).
- "Powered by Anthropic" badge if appropriate.
- Founder bio with photo on `/om-oss`.

**Exit criterion (Phase A):** comandcenter.se is live, 8+ demo bookings/month, two case studies public, ROI calculator generating leads.

### Phase B — Product polish + onboarding flow (June–July 2026, parallel to Nordic Plan weeks 1–3)

These are the GTM-adjacent product changes that aren't in the Nordic Plan but matter for converting demos to paying.

**B.1 — Codify the 4-milestone implementation playbook**
- Match Nory's structure: kick-off → M1 POS+forecast live → M2 scheduling live → M3 Fortnox+drilldown live → M4 full monthly close cycle. Adapt to our actual flow.
- Publish at `/implementering` as a sales asset.
- Internal version with checklists, customer-supplied data forms, milestone email templates.
- Define the "CommandCenter Champion" role (customer-side internal advocate).

**B.2 — Onboarding wizard inside the app**
- The ADD-SECOND-BUSINESS-PLAN flow is the right architecture for this — reuse it for first-business onboarding too.
- Step 1: Connect Fortnox + POS + Personalkollen. Step 2: Confirm period mapping + BAS chart. Step 3: Generate first Monday Memo + first forecast. Step 4: Walk through a recent week.
- Sales asset as much as product feature.

**B.3 — Demo data mode**
- A toggle that loads anonymised data from a fictional Stockholm restaurant. So demos don't require real-customer data exposure.
- Halves demo cycle time.

**B.4 — Public-facing onboarding methodology page**
- Mirror Nory's "How we manage change" page.
- Reduces buyer risk perception. Three customer roles defined (Point of Contact, Champion, Task Manager).

**B.5 — Role-based access**
- Owner / Manager / Revisor (accountant) — three roles, three permission sets.
- The Revisor role is unique to us — Nordic operators have an external accountant relationship that UK ops do not. A read-only role for the customer's revisor with month-end close artifacts is a differentiator.

**B.6 — Audit trail per AI agent**
- Every agent action logged with timestamp, input, output. Visible in admin and exportable.
- Customers (and their revisor) will ask. Required for moving from beta-candidate to paying.

**Exit criterion (Phase B):** can complete a full demo to a 3-location group without showing rough edges; first paying customer signs.

### Phase C — Pricing, sales motion, contracts (June–August 2026, parallel)

Not a build phase, but it has to be sequenced because moving from "paying candidate" to "paying customer" is the next gate.

**C.1 — Publish pricing publicly at /priser**
- Solo 1 995 / Group 4 995 / Chain 9 995 SEK per business per month.
- Annual billing: 2 months free (push to every conversation).
- Case-study customers get the standard rate and a quarterly customer-success review in exchange for logo + numbers usage rights — no special discount. No founding-tier price lock. Discount-first positioning attracts the wrong customers (price-shoppers, not committed operators).

**C.2 — Sales collateral**
- Three-slide pitch deck PDF (problem / solution / proof) in Swedish.
- One-page "Why CommandCenter" PDF.
- Branded ROI calculator output template.

**C.3 — Cold outreach playbook**
- Target list: Personalkollen customer list (publicly searchable for restaurants), Fortnox restaurant-classified customers, Örebro/Stockholm hospitality groups, founders-network introductions.
- 100 targets, weekly cadence, founder-led.

**C.4 — Standard contracts**
- Subscription agreement template (SE+EN), GDPR DPA template, security one-pager — all ready before the first paying conversation that asks.

**C.5 — Partnership conversations (warm, no urgency)**
- Personalkollen — they own the Swedish scheduling layer; partnership before competition.
- Fortnox — accounting layer; same logic.
- Caspeco — alternative scheduling/POS; coverage move.
- Novax (Personalkollen's owner) — strategic-investor precedent given their portfolio.

**Exit criterion (Phase C):** 5+ paying customers, MRR > SEK 10 000 (= 5 customers averaging ~2 000 SEK/month across Solo + Group mix).

### Phase D — Differentiation moat (Q4 2026, after Nordic Plan weeks 1–12 complete)

The features that make us specifically uncloneable. These overlap with the Nordic Plan's Q4 work but emphasise GTM-visible differentiators.

**D.1 — Public benchmark tool at /benchmark**
- Same shape as nory.ai/benchmark but Swedish-locale, restaurant-type segmented, kommun-aware where data permits.
- Inputs: labour%, GP%, omsättning, restaurant type, kommun.
- Output: "you're top-quartile in your segment / you're bleeding 2.4 pp below industry."
- Eligibility: only when n≥10 paying customers (else credibility breaks).
- Lead capture is the real point. Even at n=10, every submission grows the database.

**D.2 — Revisor view**
- A read-only role for the customer's accountant/revisor.
- Month-end artifacts: trial balance reconciliation, BAS-classified P&L, variance commentary, AI-generated month-end memo, all exportable as PDF.
- **This is unique to us.** Nory doesn't have it because UK operators don't have the same revisor relationship.
- Sales hook: when a Swedish restaurant group's revisor recommends us, we win the deal.

**D.3 — Skatteverket / SCB sanity checks**
- Periodic moms-rapport sanity check ("your VAT looks consistent with your sales").
- Branschens nyckeltal benchmark sanity check.
- Not formal filing, just AI-flagged anomalies.

**D.4 — AI agent governance**
- Per-agent enable/disable, model selection (Haiku vs Sonnet for power users), escalation thresholds.
- Important for any customer who wants to dial up/down AI autonomy.

**D.5 — Public read-only API**
- For larger groups who want to pipe data into Looker / Power BI.
- Doesn't have to be feature-rich; just credible.
- Becomes a sales asset on the Chain-tier page.

**D.6 — Customer success / quarterly review process**
- Every paying customer gets a quarterly review meeting with documented outcomes (labour% movement, hours saved, forecast accuracy improvement). 
- Outputs become future case studies on a rolling basis.

**Exit criterion (Phase D):** at least one deal closed *because of* a specific differentiator above. At least 12 paying customers total.

### Phase E — Norway entry (Q4 2026 → Q1 2027, mirrors Nordic Plan Q4)

GTM layer for the Nordic Plan's Norway expansion sprint.

**E.1 — Norwegian-locale landing page**
- `no.commandcenter.com` or `/no` route.
- Norwegian copy, Tripletex/Fiken integration mentions, NO klämdag/inneklemt-dag references.

**E.2 — First Oslo customer**
- Founder-led outreach via SaaS-Nordic / hospitality groups in Oslo.
- Target: one paying customer by end of Q1 2027.

**E.3 — Norwegian case study**
- Required before second NO customer outreach to convert at scale.

**Exit criterion (Phase E):** first NO paying customer signed.

### Phase F — Cash-side intelligence as headline (parallel from Q4 2026)

The Nordic Plan mentions live bank feeds as parked until 15 customers. But the **marketing of cash intelligence** doesn't need to wait — we already have the Fortnox-booked cash position and 30-day projection.

**F.1 — Cash-intelligence is the lead message**
- Reposition `/produkt/kassa` as the headline product page (above Affärsresultat).
- "See your cash 30 days ahead. Nobody else in Sweden does this."

**F.2 — Live bank feeds (post-15-customer trigger)**
- Per LIVE-BANK-FEEDS-PLAN.md, Nordigen integration.
- ETA Q2 2027 by current customer-count trajectory.

**Exit criterion (Phase F):** cash-flow story drives 30%+ of inbound demo bookings.

### Phase G — Denmark + Finland (Q2 2027, mirrors Nordic Plan)

Same shape as Phase E, repeated. By this point the playbook should be repeatable.

---

## 5. Specific Nory pages → our equivalent

Updated for the corrected product scope.

| Nory page | Our equivalent | Phase | Notes |
|-----------|----------------|-------|-------|
| Homepage | comandcenter.se | A.1 | Lead with calm Nordic operator tone |
| Agentic AI | /produkt/ai-agenter | A.2 | Lean into the 6 named agents |
| Business Intelligence | /produkt/affärsresultat | A.2 | Map to existing built features |
| Inventory | (no module) | — | **Don't build. Reference Fortnox-integrated COGS view only.** |
| Workforce | /produkt/prognos | A.2 | Reframed as forecasting + scheduling AI, not full workforce mgmt |
| Payroll | (no module) | — | **Don't build. Reference löneunderlag-to-Fortnox export only.** |
| Customer Reviews | (skipped) | — | Future addition only when 30+ customers ask |
| Capital | (skipped) | — | Not for years |
| Integrations | /integrationer | A.2 | Fortnox + Personalkollen + Caspeco + Onslip + Tripletex (NO) |
| How we manage change | /implementering | B.1 | 4-milestone playbook published |
| Independent brands | /lösningar/självständiga | A.3 | Solo tier |
| Multi-location | /lösningar/grupp | A.3 | Group tier |
| Enterprise groups | /lösningar/kedja | A.3 | Chain tier, aspirational |
| About | /om-oss | A.1 | Paul's bio, founder-as-operator credibility |
| Success Stories | /kundberättelser | A.4 | Vero + Rosali first |
| Blog | /blog | A.7 | Three launch posts minimum |
| Podcast | (skipped) | — | No advantage |
| Benchmark | /benchmark | D.1 | Trigger at n≥10 customers |
| ROI Calculator | /roi | A.5 | Easy build, high-value |
| Content Library | (skipped) | — | Until blog has 20+ posts |
| Product tour | /demo (video) | B.3 | 2-minute screencast against demo data mode |
| **(new for us)** Cash intelligence | /produkt/kassa | A.2 + F.1 | Our differentiator vs Nory |
| **(new for us)** Revisor view | /revisor | D.2 | Unique to Nordic market |

---

## 6. The "never do" list — updated

Carry-forward + additions:

1. Per-seat pricing.
2. Freemium.
3. A staff-facing native mobile app.
4. Full POS replacement.
5. Full HR-tech stack.
6. Lending/capital partnerships in the first 18 months.
7. VC fundraise before SEK 1M ARR.
8. Geographic expansion before 15 Swedish customers.
9. Generic AI features that dilute the accounting-depth positioning.
10. Public Nory comparison or "Scandinavian Nory" framing as the *external* tagline. (Internal reference frame is fine.)
11. **(new)** Inventory module. (Nordic Plan §9.3.)
12. **(new)** Payroll module beyond löneunderlag-to-Fortnox export. (Nordic Plan §9.3.)
13. **(new)** Real-time data pipeline. (Nordic Plan §9.1.)
14. **(new)** Foundation models for prediction. (Nordic Plan §9.5.)
15. **(new)** English-first UI. (Nordic Plan §9.7.)
16. **(new)** Chasing Nory's 95% headline accuracy. (Nordic Plan §9.8 — credible 15–20% MAPE with attribution is the actual product.)

---

## 7. Success metrics — reconciled with Nordic Plan §8

Combining their product metrics with GTM metrics.

| Metric | Q3 2026 | Q4 2026 | Q1 2027 | Q2 2027 |
|---|---|---|---|---|
| **Product (from Nordic Plan)** | | | | |
| Paying customers | 2 | 5–10 | 15–20 | 30–50 |
| Markets live | SE | SE | SE + NO | SE + NO + DK + FI |
| Daily MAPE (mature, h=1) | 25% | 20% | 17% | 15% |
| Hourly MAPE (mature) | n/a | 25% | 22% | 20% |
| Annual recurring revenue | ~50k SEK | ~250k SEK | ~750k SEK | ~2M SEK |
| **GTM (new in this doc)** | | | | |
| comandcenter.se live | ✅ | ✅ | ✅ | ✅ |
| Public case studies | 2 | 4 | 8 | 15 |
| Monthly demo bookings | 8 | 15 | 25 | 40 |
| Demo → trial conversion | 30% | 40% | 50% | 55% |
| Trial → paid conversion | 50% | 60% | 65% | 70% |
| Benchmark tool launched | — | ✅ (at n≥10) | ✅ | ✅ |
| Revisor view shipped | — | ✅ | ✅ | ✅ |
| First NO customer | — | — | ✅ | — |
| First DK / FI customer | — | — | — | ✅ |

---

## 8. The honest constraints

**Bandwidth.** Sole technical founder with two paying-candidate customers, six agents shipped, and a 12-week Nordic Plan sprint already mapped. Adding the marketing infrastructure of Phase A on top is realistically 4–6 weeks of work for one person. Phase B onboarding/playbook codification adds another 2–3 weeks. The phases are sequenceable but not all parallelisable.

**Forecasting accuracy gap.** Vero h=1 MAPE is 39% medium-confidence; Nory claims <10%. The Nordic Plan's Q3 sprint closes some of this gap but not all. **The GTM layer has to be honest about this.** The pitch isn't "more accurate than Nory" — it's "credible accuracy with attribution that makes the variance explainable, plus deeper integration into the stack you actually use." If marketing copy overpromises accuracy, the first demo where the forecast misses by 25% kills the deal.

**The case-study extraction risk.** Vero and Rosali need to be willing to share numbers publicly. If they refuse, Phase A.4 stalls. Mitigate: bring this up explicitly in the next conversation with each owner, frame as part of the customer-success quarterly review relationship in exchange for logo + numbers rights on the public site.

**Nory in Sweden.** The Nordic Plan's 18-24-month window is realistic but not infinite. Once Nory completes US expansion (probably 2027), they look at the Nordics. The defence: be deeper into Fortnox/BAS than they'll bother going, build the revisor relationship they don't have, price below what they can match.

**The forecasting-as-headline problem.** If we lead marketing with forecasting (where we're behind Nory) we lose. If we lead with cash intelligence + Fortnox depth + the Nordic operator story (where Nory doesn't compete), we win. **Lead with what's uniquely ours.**

---

## 9. The "this week" action list — corrected

The previous roadmap had a "this week" list that included tasks already done. The corrected version:

1. **Decide on case study extraction.** Schedule a 30-minute conversation with each of Vero and Rosali owners about case-study rights and quarterly review participation. Standard rate; the deal is logo + numbers in exchange for a public success story and a quarterly review touchpoint.
2. **Write LANDING-PROMPT.md.** Same format as PERFORMANCE-PROMPT.md, using the comandcenter.se mockup from the previous session as reference. Hand to Claude Code.
3. **Draft three launch blog post outlines.** Per Phase A.7.
4. **Buy comandcenter.se if not owned** and point a Vercel project at it ready for the landing-page deploy.
5. **Open Cal.com or Calendly** for `/boka-demo`. Set up three qualifying questions.
6. **Codify the 4-milestone implementation playbook.** One internal doc, version 0.1, captures what worked for Vero/Rosali. Publish externally as Phase B.1 deliverable in 4 weeks. *Shipped as `IMPLEMENTATION-PLAYBOOK.md` on 2026-05-19.*

---

## 10. What this document does and doesn't replace

**Replaces:** the previous COMMANDCENTER-ROADMAP.md (v1). That document had product-build recommendations that contradict the Nordic Plan's explicit choices.

**Does not replace:**
- THE-NORDIC-PLAN.md — product/tech master, the source of truth on what to build.
- ROADMAP.md — tactical session log; the working journal.
- ADD-SECOND-BUSINESS-PLAN.md — feature plan in flight.
- LIVE-BANK-FEEDS-PLAN.md — parked feature plan.
- CLAUDE.md — engineering rules.

**Sits alongside the Nordic Plan** as the marketing / positioning / GTM / non-engineering-infrastructure layer. The Nordic Plan answers "what to build." This answers "what to look like, how to sell, what to call ourselves, and which Nory features to leave deliberately on the table."

Revisit every 6 weeks. Some of this will be wrong. The question is which parts, and how soon.
