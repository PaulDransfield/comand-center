# The Nordic Plan
> Being the Nory of Scandinavia — the Nordic restaurant intelligence platform native to Fortnox, Personalkollen, and the regional signals incumbents will never prioritize.
>
> Drafted 2026-05-19. Living document. Update at each phase gate.

---

## 1. The mission

CommandCenter becomes the default restaurant operating intelligence platform for the Nordics — Sweden first, Norway + Denmark within 12 months, Finland within 18.

We're not trying to be Nory. We're trying to be **the Nordic answer to Nory** — a regionally-native intelligence layer that hits 80% of Nory's accuracy at 30% of Nory's price, with deeper integration into the accounting + scheduling systems Nordic operators actually use.

**Strategic positioning:** "Restaurant intelligence built in Stockholm, for Nordic operators." Defensible because:

- Native Fortnox / Personalkollen (Sweden), Tripletex (Norway), e-conomic (Denmark), Fennoa (Finland) integrations Nory will never prioritize
- Klämdag, kommun-resolved school holidays, salary cycle around the 25th, Valborg/Midsommar lifts — Nordic signals encoded in the model
- Owner-operator pricing — Solo 1,995 SEK / Group 4,995 / Chain 9,995 — accessible to the 1-10-location SMBs who are 80% of the market
- Founder-as-operator credibility — Paul ran Vero and Rosali before building this. Every sales conversation carries operator weight Nory loses in Nordic markets

---

## 2. Where we are now (2026-05-19)

**Shipped — production foundation:**

- v1.5 deterministic daily forecaster (`lib/forecast/daily.ts`) — 9-signal multiplicative model
- v1.1 LLM enrichment layer (Haiku 4.5, prompt-cached) — low-confidence skip just shipped
- Piece 5 monthly forecaster (yoy-anchored / daily-aggregate / weekday-extrapolation paths)
- Audit ledger (M059) + reconciler — every prediction graded
- Phase 0 measurement dashboard `/admin/v2/forecasting` — MAPE / bias / confidence calibration / horizon distribution
- Personalkollen sync (daily aggregate), Fortnox OAuth + 12-month backfill + drilldown
- Open-Meteo weather + bucket lift
- Swedish public holidays + klämdag + kommun-aware school holidays
- Opening days (closed-day short-circuit)
- Zero-baseline fallback (Rosali Apr 20-26 case)
- Cold-start holiday-period exclusion (Dec 20-Jan 6)
- Cash position tile + 30-day cash-flow projection
- Two paying-candidate businesses: Vero Italiano + Rosali Deli

**Where we genuinely stand:**

| Metric | Vero | Rosali | Nory's claimed |
|---|---|---|---|
| MAPE — h=1 medium confidence | 39% | 26% | < 10% |
| MAPE — h=7 (legacy fallback) | 29% | 15% | < 10% |
| Bias | varies | -10% | not disclosed |
| Hourly granularity | no | no | yes |
| Booking data | no | no | yes |
| Local events | no | no | yes |

We're behind on absolute accuracy. We're competitive on h=7 legacy MAPE. We have the data plumbing for Nordic-native signals Nory doesn't.

---

## 3. Where Nory is — and where the Nordic gap is

**Nory:** UK/Ireland-founded ($62.6m total funding through Series B Sept 2025), expanding US (March 2026), 1000+ restaurants across US/Europe/Middle East. Customers include Jamie Oliver Group, Black Sheep Coffee, Dave's Hot Chicken. They integrate with Toast, SumUp, Vita Mojo, Square, and dozens of other POS systems. Their architecture: real-time POS ingestion → per-venue tree-based ML (likely XGBoost/LightGBM) → LLM explanation layer. Founder Conor Sheridan came from quantitative finance.

**Restaurant365 / MarginEdge:** US-focused, accounting-first, much larger. Not pursuing Nordics actively.

**The Nordic-native gap:**

| Country | Restaurants (est.) | Dominant accounting | Dominant POS / scheduling | Nory presence |
|---|---|---|---|---|
| Sweden | ~30,000 | Fortnox, Visma | Personalkollen, Caspeco, Onslip | Minimal |
| Norway | ~12,000 | Tripletex, Visma, Fiken | Lightspeed, SumUp, Onslip | Minimal |
| Denmark | ~15,000 | e-conomic, Dinero, Billy | Lightspeed, OrderYOYO | Minimal |
| Finland | ~10,000 | Fennoa, Procountor | Onslip, Kassa-O | Minimal |

**No Nordic-native incumbent.** Restaurant intelligence in the Nordics today = either spreadsheets, or Nory at enterprise pricing nobody can afford, or nothing.

This is the window. The Nordic market for restaurant intelligence is structurally underserved. Once Nory finishes US expansion (probably 2027), they'll look north. We have 18-24 months to own the region before that.

---

## 4. Our wedge

What we have that Nory doesn't, in priority order:

1. **Native Fortnox integration** — OAuth, 12-month backfill, drilldown to source invoices. Nory builds for QuickBooks/Xero. They will never prioritize Fortnox.
2. **Native Personalkollen integration** — PK dominates Swedish hospitality scheduling. Nory will never integrate.
3. **Swedish-specific predictive signals** — klämdag, kommun-resolved Sportlov / Höstlov / Jullov, salary cycle around the 25th, Valborg/Midsommar lifts. These are baked into our model. Nory would need to rebuild them per market.
4. **Owner-operator pricing** — accessible to the 1-5-location restaurants that make up 80% of Nordic hospitality. Nory's pricing targets enterprise.
5. **Founder credibility** — Paul operates Vero + Rosali. Every sales conversation in the Nordic market carries "another operator built this for himself" weight.
6. **Swedish UI + customer support** — Nory is English-first. Nordic operators prefer their own language.

What Nory has that we don't (yet):

1. Hourly POS granularity
2. Booking data ingestion
3. Local events with leading/lagging impact curves
4. Real-time data pipeline
5. Per-venue ML model
6. Attribution-first UX (prediction + explanation + recommendation)
7. $62m war chest

**Strategic choice:** copy items 1-3, 6 from above. Skip items 4-5, 7. Compete on price, integrations, and Nordic fit.

---

## 5. The 12-week sprint (Q3 2026)

This is the build that closes the Nory feature gap on the Swedish market. Everything is additive to current v1.5 architecture — no rebuilds.

### Weeks 1-3: Hourly POS ingestion + meal-period forecasting

**Why first:** the single highest-leverage change. Nory's "95% accuracy" is downstream of hourly granularity. PK exposes hourly via `salesByHour`; we currently aggregate to daily. Code change, not a model change.

**Deliverables:**
- `hourly_metrics` table (date, hour, business_id, revenue, covers, hours_worked)
- PK sync extended to pull hourly
- `lib/forecast/hourly.ts` — per-hour forecaster sharing v1.5's signal stack
- Meal-period rollups: lunch (11-14), dinner (17-22), late (22-02)
- Scheduling AI cuts re-anchored on meal periods, not daily totals

**Success criterion:** hourly MAPE on resolved rows ≤ 25% on mature businesses; meal-period MAPE ≤ 20%.

### Weeks 4-5: Attribution-first UX

**Why second:** customer-perceived accuracy is a product UX problem, not a model problem. Nory's "95%" feels like 95% because every prediction comes with an explanation. We already have `inputs_snapshot` decomposing predictions; we just need the customer-facing view.

**Deliverables:**
- `/dashboard/why-today` — forward decomposition. "67k expected: weekday baseline 58k + 9% sunny weather + 4% payday – 2% post-holiday."
- `/dashboard/why-yesterday` — variance attribution. "Tuesday actual 78k vs predicted 67k. Unexplained residual: 8k. Likely driver: weather was warmer than forecast."
- Target-band rendering — every prediction shown as P25/P50/P75 range, not point estimate
- Per-week scorecard — "this week your team hit target 4/7 days"

**Success criterion:** weekly memo thumbs-up rate ≥ 70%.

### Weeks 6-8: Local events with PredictHQ-style impact curves

**Why third:** published research shows events deliver 5-6pp MAPE improvement at restaurant scale (Favor case study); 35% accuracy lift in Lineup.ai's case. Stockholm sources are free.

**Deliverables:**
- `events` table — source, start/end, venue, lat/lng, expected_attendance, category
- `business_event_impact` — per-business calibration of pre-window/post-window lifts by event category
- Ingest from Stockholm Stad open events API, ticketmaster.se, biljett.se, eventim
- Daily 04:00 UTC cron for next 30 days
- Leading curve (days_until_event factor) + lagging curve (days_since_event factor)
- New signal added to v1.5 inputs_snapshot

**Success criterion:** event-day MAPE ≤ 25% on businesses within 2km of a major venue.

### Weeks 9-12: Customer 3-5 onboarding sprint + booking integration

**Why fourth:** each new customer expands the integration footprint and stress-tests cold-start handling. If the next customer uses Bordsbokning, Caspeco, or another booking system, integration jumps forward.

**Deliverables:**
- `ADD-SECOND-BUSINESS-PLAN.md` flow shipped (plan-limit check, append-mode onboarding wizard)
- Bordsbokning or Caspeco booking API integration (whichever customer 3+ uses)
- `bookings` table — forward reservation counts + party-size distribution by date
- New signal in inputs_snapshot: 7-day-forward booking count
- Cold-start handling tested with real customer onboarding

**Success criterion:** customers 3-5 onboarded; one booking integration shipped.

---

## 6. The 6-month roadmap (Q4 2026)

**Sweden saturation + Norway expansion.**

### Sweden customer growth target: 10-15 paying

- Hourly + attribution UX as the lead sales pitch
- Founder-led sales — Paul opens 5 owner conversations / month through industry network
- Founding-tier price lock (995 SEK / month / 24 months) to incentivize early adopters as case studies
- One quarterly customer-success review per customer; document labour-cost-reduction outcomes

### Norway expansion (3-month sprint, weeks 13-24)

- Add `lib/holidays/norway.ts` (17 NO holidays + observed shifts, mirrors `sweden.ts`)
- Norwegian klämdag equivalent — "inneklemt dag" — same algorithm
- Tripletex accounting integration (largest NO accounting platform)
- Norwegian school holiday data per fylke
- NO locale + UI translation
- First Norwegian customer onboarded — target Oslo restaurant group

### Cash-side intelligence (parallel)

- Per-business GBM model once Vero crosses 365 days (~Nov 2026)
- Live bank feeds (LIVE-BANK-FEEDS-PLAN.md — currently parked) when customer count ≥ 15
- Cash-flow attribution: "your cash is 200k below projection because: late receivables 80k, faster-than-expected supplier payments 120k"

**Success criteria by end of Q4 2026:**
- 15+ paying customers across Sweden + Norway
- Hourly MAPE ≤ 20% on mature businesses (Vero + Rosali both past 6-month mark)
- One published customer-success case study showing measurable labour cost reduction

---

## 7. The 12-month vision (Q2 2027)

**Denmark + Finland + multi-business ML.**

### Denmark expansion

- `lib/holidays/denmark.ts`
- e-conomic accounting integration
- Lightspeed POS integration (cross-Nordic, also relevant for Norway)
- Danish booking system integration (DinnerBooking)
- First DK customer

### Finland expansion

- `lib/holidays/finland.ts`
- Fennoa or Procountor accounting integration
- Onslip POS integration (Swedish-owned, dominant in FI hospitality)

### Multi-business GBM (the model upgrade)

- Per-business LightGBM model alongside rule-based forecaster
- Eligibility gate: ≥ 365 days history
- Ensemble: rolling-MAPE-weighted blend of rule-based + GBM
- Cross-business pooled training in same city — improves cold-start on new customers in already-served markets

### Architecture: v1.6 subset-substitution forecaster (already skeletoned in `lib/forecast/daily-v2.ts`)

- Replace v1.5's multiplicative chain with subset-substitution per-tier
- Validation: ≥ 3pp better than v1.5 on rolling 28-day MAPE for 4 weeks → cutover
- Shadow-mode capture during the transition

**Success criteria by end of Q2 2027:**
- 30-50 paying customers across Sweden + Norway + Denmark + Finland
- Daily MAPE ≤ 15% on mature businesses
- Hourly MAPE ≤ 20%
- LightGBM ensemble live on ≥ 5 businesses with > 365 days history
- One labour-cost-reduction case study per market

---

## 8. Success metrics

Tracked monthly on `/admin/v2/forecasting`:

| Metric | Q3 2026 | Q4 2026 | Q1 2027 | Q2 2027 |
|---|---|---|---|---|
| Paying customers | 2 | 5-10 | 15-20 | 30-50 |
| Markets | SE | SE | SE + NO | SE + NO + DK + FI |
| Daily MAPE (mature, h=1) | 25% | 20% | 17% | 15% |
| Daily MAPE (mature, h=7) | 28% | 22% | 19% | 17% |
| Hourly MAPE (mature) | n/a (not built) | 25% | 22% | 20% |
| Bias (rolling 28d) | varies | ±10% | ±7% | ±5% |
| Customer-perceived useful (thumbs) | n/a | 65% | 70% | 75% |
| Labour cost reduction (per customer, vs pre-CommandCenter) | n/a | -1pp | -3pp | -5pp |
| Annual recurring revenue | ~50k SEK | ~250k SEK | ~750k SEK | ~2M SEK |

---

## 9. Things we will deliberately NOT do

These look tempting and we will say no to them, in order to stay focused.

1. **Build a real-time pipeline.** Nory has $62m. We don't. Daily batch hits 80% of the value at 5% of the cost.
2. **Compete on POS integration count.** Nory integrates with 30+ POS. We commit to 4-5 (PK, Caspeco, Onslip in Sweden; Lightspeed, OrderYOYO in DK; Onslip, KasseO in FI; etc.) — the dominant Nordic ones, deep, not the long tail.
3. **Try to replace Fortnox / Tripletex / e-conomic.** We are the intelligence layer. Accounting is a different product. Don't build payroll or inventory; integrate.
4. **Enterprise sales.** Single-operator and small-group is our segment. We don't pitch Norwegian Hospitality Group or McDonald's franchisees.
5. **Foundation models for prediction.** Chronos/TimesFM/Moirai don't know restaurant signals. LightGBM with our feature engineering beats them at this data scale.
6. **LLM as numerical predictor.** Per the Piece 4 data — LLM is enrichment, not load-bearing. Use it for attribution + explanation, not for the prediction itself.
7. **English-first UI.** Nordic operators want their own language. Native SE / NO / DK / FI translations, native customer support hours.
8. **Chase Nory's 95% accuracy.** Marketing number. We aim for credible 15-20% MAPE on mature businesses with attribution that makes the variance explainable. That's the actual product.
9. **Multi-currency, multi-tenant chain features prematurely.** Optimize for 1-5 location groups first. Chain features when a chain customer signs.
10. **VC funding before product-market fit.** Pre-PMF VC = pressure to grow before the model works. Bootstrap to 30-50 customers; raise only if expansion velocity needs it.

---

## 10. Decisions to make before next session

1. **Phase A start week:** Hourly POS ingestion (3-week sprint). Confirm green light.
2. **Founding-tier offer:** how many 995 SEK 24-month spots to offer, in what window. Currently set at 10 in the pricing memory.
3. **Norway expansion ordering:** start NO holidays + Tripletex integration in parallel with SE customer growth, OR sequence (SE-saturation-then-NO)? My vote: parallel, since holiday module + accounting integration is < 4 weeks of work and lets us pitch NO restaurants from Q4.
4. **PredictHQ licensing decision:** ~$10-30k/year SMB tier for global event data vs ~2 weeks of build for Stockholm-only ingestion. Build-our-own for now; license at customer 20.
5. **GBM model deferral:** confirm we wait until any business crosses 365 days (Nov 2026 earliest for Vero) before any ML work.

---

## 11. The honest truth

We are 18 months behind Nory on product, with 0.3% of their funding. We will not catch up on accuracy.

What we CAN do: be the regionally-native option Nordic operators actually buy because nobody else speaks their language, integrates with their accountant, prices for their P&L, or knows what a klämdag is.

The Nordic restaurant intelligence market is structurally underserved. The window is real but it's not permanent — once Nory finishes its US expansion, they'll look at the Nordics, and they'll either build for us or acquire us. Both outcomes are wins. But the path requires being the obvious answer in the region when that decision arrives.

Be the Nory of Scandinavia. Not by being Nory. By being the operator the Nordics didn't know they were waiting for.

---

*Companion docs: ROADMAP.md (tactical) · CLAUDE.md (rules) · ADD-SECOND-BUSINESS-PLAN.md · LIVE-BANK-FEEDS-PLAN.md*
