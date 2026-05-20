# Roadmap refinement — what the Nory video changes

**Date:** 20 May 2026
**Source:** "See Nory in action" product tour (5min 37s), frame-by-frame analysis
**Refines:** COMMANDCENTER-ROADMAP-v2.md
**Status:** read alongside v2, not a replacement

The video is the scripted product tour at `nory.ai/tour/product`. I pulled 42 frames and read the screens directly. Most of it confirms what we already mapped. But it surfaced **five things the marketing site didn't show**, and it forces **one strategic reconsideration** I want to put in front of you rather than bury.

---

## 1. The video's actual narrative arc

So we're working from what they show, not what they say they do. The tour, in order:

1. **Cold open** — "the AI-powered restaurant management platform" — phone mockups cycling through inventory, payroll.
2. **BI overview** — "stop guessing and start knowing" — dashboard with sales chart + product table, "key figures at a glance, drill into details."
3. **Forecasting** — "forecasts hour by hour, day by day" + "prevent slowdowns before they happen and make smarter calls." Hourly granularity shown explicitly.
4. **Chapter card: "Business Intelligence: Cost Control & Waste Insights"**
5. **Cost transparency** — "total transparency to your costs", "see where to focus for the biggest impact", "movements from sales to deliveries and waste", "then train your team to cut costs fast."
6. **Flash P&L** — "Instant P&L shows you the impact [of] decisions on your bottom line." A live P&L screen with side-by-side period columns.
7. **Customer Reviews** — "Spot operational issues before they spread and reply to [them]" + "Happier staff, better service." Star-rating trend, ratings distribution table, **live AI-generated reply** in brand voice.
8. **Chapter card: "Workforce Management: Scheduling & Team Management"**
9. **Scheduling** — "Our AI analyses staffing patterns and demand alongside [labour]" + "shifts that balance staffing demand for every shift."
10. **Staff mobile app** — "keep everyone in the loop with shifts and time off", "Less admin, more engagement, a team that's always in sync." Shows a **claim-shift-request approval** with **cost-of-labour impact estimated inline (+£116.13)**.
11. **Inventory (mobile + desktop)** — "order exactly what you need", "track supplier prices, manage credit notes and scan invoices", "better margins, more time for customers", "consistency is key to scaling your brand", "transfers between locations with ease." Shows a **418-item inventory master** with categories/suppliers/order-units/VAT, and a **mobile stock-count flow** with unit conversions.

The structure confirms our four-module read. But the *depth* of three modules is greater than the marketing site implied.

---

## 2. Five things we under-weighted

### 2.1 Hourly forecasting is front-and-centre, not a footnote

The video spends real time on "hour by hour" forecasting and "prevent slowdowns before they happen." This isn't a daily forecast with hourly nice-to-have — hourly is the headline. Your Nordic Plan Q3 sprint already has "hourly POS ingestion + meal-period forecasting," so **we're aligned** — but the video confirms hourly is table-stakes for credibility, not a v2 feature. Keep it in the Q3 sprint, don't let it slip.

**Refinement:** none to the plan. Confirmation that the Q3 hourly work is correctly prioritised. If anything, it should be demo-ready *before* the marketing site claims forecasting at all, because an operator who's seen Nory's hourly view will ask for it in the first demo.

### 2.2 "Flash P&L" is a named, specific artifact — and we have the pieces

The video shows a **Flash P&L**: an instant, period-over-period P&L with side-by-side columns, framed as "see the impact of decisions on your bottom line." We have P&L extraction, BAS classification, and the Business Performance page already in flight. **We're closer to this than to anything else in the video.**

**Refinement:** rename and reframe our Business Performance page concept to lead with the "Flash P&L" idea — an instant, current-period P&L that updates as Fortnox data flows, with period-over-period columns. This is a Phase 2 (product polish) item we already have most of. Make sure the period-over-period side-by-side column layout is in the PERFORMANCE-PROMPT.md spec. It's a small framing change that lands a Nory-parity feature with work we've largely done.

### 2.3 The Customer Reviews module is more built-out than I assumed — but the AI-reply angle is the actual insight

I previously said "skip Customer Reviews until 30+ customers ask." The video changes my read slightly. Not because we should build it now — the priority call stands — but because the *specific feature* that matters is narrower and cheaper than full review aggregation: **AI-generated, brand-voice replies to reviews, with operational correlation.** The aggregation (pulling from Google/TripAdvisor/etc.) is the expensive, low-moat part. The AI-reply-in-your-voice is the cheap, demoable part.

**Refinement:** keep Customer Reviews deferred (Phase D+ / post-30-customers), but when it lands, **build the AI-reply feature first, aggregation second** — the reverse of how Nory probably built it. For a Swedish operator, replying to Google reviews in good Swedish, in their brand voice, correlated to "you were understaffed that Friday" (which we'd know from Personalkollen) is the wedge. The aggregation plumbing can come later or lean on a third-party review-aggregation API. Note this in the deferred-features doc so we don't build it backwards.

### 2.4 The staff mobile app shows labour-cost impact at the moment of approval — this is a genuinely good idea worth stealing conceptually

The claim-shift screen shows **"COL difference (estimated) +£116.13"** to the manager *at the moment they approve a shift swap*. The cost consequence of a staffing decision is surfaced at decision time, not in a month-end report. This is the single best UX idea in the whole video.

We decided (correctly, per Nordic Plan §9.3 and the Personalkollen-owns-the-app reality) **not to build a staff mobile app.** That call stands. But the *principle* — show the labour-% / kronor impact of a scheduling decision at the moment the decision is made — belongs in our AI Scheduling "before and after" view, which we're already building.

**Refinement:** in SCHEDULE-AI-PROMPT.md, make sure every proposed shift change shows its labour-% and kronor delta inline, at the point of the change — not just in an aggregate "you'll save 47k" strip. When the operator hovers/taps a specific shift the AI wants to cut, show "−1 200 kr · −0,8 pp labour" right there. This is the Nory COL-difference idea applied to our manager-facing (not staff-facing) scheduling tool. Cheap to add, big perceived-intelligence payoff.

### 2.5 Inventory is deeper than "v1 narrow" — which sharpens, not changes, the decision to skip it

The video shows a **418-item inventory master** with a 25-category taxonomy, per-item supplier/order-unit/VAT-rate, a mobile stock-count flow with unit conversions (kilogram / pack-5kg / case-2x5kg), credit-note management, invoice scanning, and inter-location transfers. This is years of product. It is *not* something we can "narrow v1" our way into credibly in 16 weeks.

This **confirms and strengthens** the Nordic Plan §9.3 decision: don't build inventory. My earlier v1 roadmap (the one I corrected) wanted a 16-week Inventory v1. Having now seen the real depth, even that corrected stance ("don't build it") deserves reinforcing — a narrow inventory v1 would look like a toy next to this, and would invite exactly the comparison we lose.

**Refinement:** none to the plan — but add explicit copy to the never-do list: "Inventory stock-management is a multi-year product surface (Nory shows 418-item masters, unit-conversion stock counts, credit notes, transfers). We do not enter it. We consume Fortnox-booked COGS for the intelligence layer and let operators keep their stock tools." This stops a future you from being tempted by a narrow v1 after a customer asks.

---

## 3. The one strategic reconsideration

This is the part I want to flag rather than soft-pedal.

**The video is overwhelmingly an operations product. Ours is overwhelmingly an intelligence product. These are different things, and the video makes the gap visible in a way the marketing site didn't.**

Nory's tour spends maybe 70% of its runtime on *doing the work*: counting stock on your phone, approving shift swaps, scanning invoices, replying to reviews, building rosters. The intelligence (forecasting, P&L, cost insights) is woven in, but the spine of the product is **operational workflow** — it's where the restaurant's day-to-day actually happens, which is why it's sticky and hard to rip out.

Our product is the inverse. We read the data their operational tools produce (Fortnox, Personalkollen, POS) and turn it into intelligence — Monday Memo, forecasts, anomaly detection, the "why this week's numbers" explanations. We deliberately don't own the operational workflow. That's the Nordic Plan thesis and I think it's right *for a sole founder in an 18-month window*.

But here's the honest tension: **an intelligence layer is easier to displace than an operational layer.** If an operator does their stock counts, rosters, and review replies in Nory, ripping Nory out is painful. If an operator reads insights in CommandCenter but does the actual work elsewhere, switching away from us is just… closing a tab. Our stickiness has to come from somewhere other than workflow lock-in.

I see three honest answers, and I think we should pick deliberately rather than drift:

**(a) Stickiness through the Fortnox/BAS depth + the revisor relationship.** The moat isn't workflow, it's accounting fluency no generic tool will match, plus the revisor who recommends us. This is the current plan. It's defensible but it's a *trust* moat, not a *switching-cost* moat.

**(b) Own one small operational loop.** Pick the single highest-value operational action and own it end-to-end so there's real switching cost. The best candidate from the video: **approving the AI's weekly roster and pushing it back to Personalkollen.** If the operator's actual roster-building happens in our before/after view and writes back to Personalkollen, we've got a workflow hook — without building a scheduling product from scratch. This is the most strategic version of the SCHEDULE-AI work already planned.

**(c) Accept that we're an intelligence layer and compete on insight quality + price, not lock-in.** Plenty of good businesses are "the dashboard everyone checks." It's a real position. But it caps the moat and makes the "find a commercial co-founder / strategic acquirer" path more important, because the long-term defensibility is thinner.

**My read:** lean (a) as the public story, invest quietly in (b) as the real switching-cost play, and be honest with yourself that (c) is the gravity the product drifts toward if (b) doesn't get built. The roster write-back to Personalkollen is the highest-leverage single thing for turning an intelligence product into a slightly-sticky one. I'd elevate it from "part of the scheduling feature" to "the strategic centrepiece of the operational story."

This doesn't change the phased plan. It changes *which* item in the plan you treat as load-bearing.

---

## 4. Concrete changes to the v2 roadmap

Small, specific edits:

1. **Phase 2 (product polish):** rename the Business Performance concept to lead with **"Flash P&L"** — instant current-period P&L, period-over-period columns. Update PERFORMANCE-PROMPT.md with the side-by-side column layout.
2. **Phase 2, SCHEDULE-AI-PROMPT.md:** every proposed shift change shows its **kronor + labour-% delta inline at the point of change**, mirroring Nory's "COL difference (estimated)" idea — but manager-facing. And elevate **roster write-back to Personalkollen** to the strategic centrepiece (see §3b).
3. **Phase A (marketing):** confirmed — lead with cash intelligence + Flash P&L + the "why this week's numbers" explainer. Do **not** show inventory/payroll/stock-count UI; do **not** imply operational workflow we don't own. Hourly forecasting can be shown only once the Q3 sprint makes it real.
4. **Deferred-features doc:** Customer Reviews — when built, **AI-reply-in-brand-voice first, aggregation second.** Note the reversal explicitly.
5. **Never-do list:** add the inventory-is-a-multi-year-surface note from §2.5.
6. **Strategy doc:** add §3 as a standing question — "intelligence layer vs operational layer, and where switching cost comes from." Revisit at the 15-customer mark.

---

## 5. What the video did NOT change

To be clear about the boundaries of this refinement:

- The **phasing and sequencing** of v2 stands.
- The **pricing** (499/799/1499, founding 995) stands.
- The **don't-build-inventory / don't-build-payroll** calls stand — reinforced.
- The **Nordic expansion sequence** (SE → NO → DK → FI) stands.
- The **marketing-infrastructure-first** priority stands.
- The **hourly forecasting in Q3** stands — confirmed as table-stakes.

The video was confirmation more than course-correction. The one thing worth genuinely sitting with is §3 — the intelligence-vs-operations tension and where our switching cost actually comes from. Everything else is small, specific tightening.

---

*Frame analysis available in /home/claude/frames if you want to see any specific Nory screen pulled out and read in detail.*
