# AI Roadmap — "Promising → Revolutionary"
> Started: 2026-04-19
> Owner: Paul Dransfield
> Goal: 3 AI features that genuinely move the needle for a restaurant owner, not just more charts.

---

## The three bets

### 1. Weekly AI Manager
**Opinionated memo, not a digest.** Monday email with 3 numbered actions, each with SEK impact, citing specific rows.

**Status:** 🔄 In progress (MVP this session)

| Component | Status |
|-----------|--------|
| Context packer (4 weeks daily_metrics + dept + alerts + budget) | 🔄 |
| Claude prompt with strict constraints (<200 words, 3 actions, SEK cited) | 🔄 |
| Swap template HTML for AI narrative in weekly-digest | 🔄 |
| Feedback loop — "was this useful?" thumbs | ⏳ |
| Schedule comparison page (replaces PK write-back idea) | 🔄 |
| PK schedule vs AI-suggested — side-by-side tabs | 🔄 |

**Blockers:** none critical. Prior-year comparisons limited to 5 months until more data accumulates.

---

### 2. Conversational P&L with receipts
**Q&A over business data with cited evidence.** "Why was March GP down 2 pts?" → "Carne price rose from 145→165 kr on March 12, carne is 22% of food sales. Revert to 149 kr recovers 1.4 pts."

**Status:** ⏳ Blocked on product price history + Fortnox

| Component | Status |
|-----------|--------|
| `pk_products` + `pk_product_prices` schema (track price changes over time) | ⏳ Pending |
| Sync update to populate price history from sales[].items[] | ⏳ |
| Tool-use prompt (Claude calls `get_product_price_history`, etc.) | ⏳ |
| Q&A UI with "Show receipt" citations | ⏳ |
| Fortnox integration for food cost detail | ❌ Blocked on dev program approval |

**Estimate:** 1.5–2 weeks for revenue-side (no food cost detail). Full version waiting on Fortnox.

---

### 3. Cash runway + decision engine
**"At current pace you clear payroll May 28 with 47k buffer. Here are 2 decisions to stay out of red."**

**Status:** ⏳ Not started — MVP unblocked, full version blocked on bank integration

| Component | Status |
|-----------|--------|
| Manual bank-balance entry in Settings (MVP path) | ⏳ |
| Recurring-costs model (rent, utilities, insurance) | ⏳ |
| Payroll forecast from scheduled shifts | ⏳ |
| Cash flow projection math | ⏳ |
| Claude interpretation with decision recommendations | ⏳ |
| **Tink / Open Banking auto bank balance** | ❌ 2–3 weeks, PSD2+BankID compliance |
| Fortnox A/P for accurate cost timing | ❌ Blocked on dev program |

**Estimate:** 1 week MVP (manual). 4–6 weeks full.

---

### 4. Weather-aware intelligence
**Footfall swings hard on Swedish weather.** Rain on Fri night = fewer walk-ins. Heat wave = drinks-heavy mix. Injecting weather forecast into every AI feature makes each one measurably smarter.

**Status:** 🔄 MVP in progress (this session)

| Component | Status |
|-----------|--------|
| Open-Meteo fetcher — free, no API key (SMHI direct was 404 2026-04-19) | ✅ |
| City → lat/lon lookup for 16 Swedish towns (no schema migration yet) | ✅ |
| Daily weather summary (temp min/max, precip, wind, WMO code + label) | ✅ |
| Weather injected into `buildWeeklyContext` — AI memo references upcoming weather | ✅ |
| Weather-adjusted scheduling suggestion (weather_multiplier on rev-per-hour target) | ⏳ |
| Dashboard 7-day forecast strip | ⏳ |
| Revenue/weather regression (after 3 months of correlated data) | ⏳ |
| False-positive suppression in anomaly detection ("rainy Thursday, matches pattern") | ⏳ |

**MVP effort:** 1 day (just fetcher + context injection). **Full version:** 3–4 days.
**Compound value:** after 3 months, we have `(day, revenue, weather)` tuples. Claude can answer "why was March 14 slow?" with "3°C with rain — your rainy sub-10°C Saturdays average 42k, you did 38k, above that segment's mean." No POS/accounting vendor can give that answer.

---

## Shared infrastructure (compounding value)

- Prompt-versioning + A/B test harness — 3 days
- Thumbs-up/down feedback capture per AI output — 2 days
- Evaluation harness: 30–50 curated Q&A regression tests — 1 week

These get built opportunistically as each feature needs them.

---

## External blockers to track

| Blocker | What it unblocks | Status |
|---------|-----------------|--------|
| Dransfield Invest AB registration | Anthropic ZDR+DPA, Stripe, Fortnox dev approval | ⏳ Not yet filed |
| Fortnox developer program | Food cost analysis, A/P timing, supplier insights | ⏳ Awaiting approval |
| PK API write scope | One-click "Accept" for AI schedule (dropped in favour of side-by-side page) | ❌ Dropped; not pursuing |
| Tink contract | Auto bank-balance for cash runway | 💡 Evaluate after MVP proves out |

---

## Sequencing

| Week | Focus | Outcome |
|------|-------|---------|
| **Week 1 (now)** | Feature 1 MVP: narrative memo + schedule compare page | Paul judges quality on his own Monday email for 4 weeks |
| Week 2–3 | Prompt tooling + eval harness | Guardrails before expanding to conversational P&L |
| Week 4–6 | Feature 2 revenue-side | Q&A over clean data, cite receipts |
| Week 7 | Feature 3 MVP (manual bank) | Cash runway narrative, unblock-adjacent features |
| Month 3+ | Fortnox + Tink integrations as approvals land | Full version of all three |

---

## The go/no-go test

After 4 Monday memos (mid-May), ask: *"Would I forward this to another restaurant owner as an example of why they should buy?"*

Yes → Features 2 & 3 worth the investment.
No → Harden Feature 1 until it passes before expanding.
