# SAAS_MANIFEST.md — CommandCenter Commercial Specification
> Version 6.0 | Updated: 2026-04-11 | Session 6

---

## 1. Business Summary

**Product**: CommandCenter — restaurant group business intelligence SaaS
**Owner**: Paul Dransfield (paul@laweka.com) — Dransfield Invest AB
**Live**: https://comandcenter.se
**Stage**: Platform live, 0 paying customers, ready for first sale
**Target**: 50 paying customers within 12 months

---

## 2. Pricing

### Plans (per business per month)

| Plan | Monthly | Annual (2 free) | AI queries/day | Businesses |
|------|---------|-----------------|---------------|------------|
| Starter | 499 kr | 4,990 kr/yr | 20 | 1 |
| Pro | 799 kr | 7,990 kr/yr | 50 | Up to 5 |
| Group | 1,499 kr | 14,990 kr/yr | Unlimited | Unlimited |

### Add-ons

| Add-on | Price | What it provides |
|--------|-------|-----------------|
| AI booster | +299 kr/mo | +100 AI queries/day — for heavy users |

### Billing rules
- Annual billing = 10 months price for 12 months (push this on every sale)
- All prices in SEK including VAT (25% Swedish VAT)
- Stripe handles payment processing: 1.5% + ~2.70 kr per transaction (EU cards)
- Stripe webhook activates plan on successful payment

---

## 3. Cost Model

### Fixed monthly costs (same at 0 or 100 customers)
| Item | SEK/mo |
|------|--------|
| Supabase Pro | ~270 kr |
| Vercel Pro | ~215 kr |
| Resend Pro | ~215 kr |
| Sentry / UptimeRobot | 0 kr |
| **Total fixed** | **~700 kr** |

### Variable costs per customer
| Cost driver | At plan limit | SEK/mo |
|------------|--------------|--------|
| Starter AI (20 q/day) | 600 queries/mo | ~10 kr |
| Pro AI (50 q/day) | 1,500 queries/mo | ~26 kr |
| Group AI (unlimited) | ~6,000 q/mo est. | ~104 kr |
| Stripe per transaction | 1 charge/mo | ~12–22 kr |

### Unit economics at scale
| Customers | Revenue | Costs | Profit | Margin |
|-----------|---------|-------|--------|--------|
| 1 | 799 kr | ~760 kr | 39 kr | 5% |
| 10 | 7,990 kr | ~1,250 kr | 6,740 kr | 84% |
| 20 | 15,980 kr | ~1,800 kr | 14,180 kr | 89% |
| 50 | 39,950 kr | ~4,200 kr | 35,750 kr | 89% |
| 100 | 79,900 kr | ~7,900 kr | 72,000 kr | 90% |

### AI as profit driver (not risk)
AI query limits prevent cost overruns. When a customer hits their daily limit:
1. They see a clear "upgrade" prompt
2. They buy the AI add-on (+299 kr/mo)
3. The add-on costs us ~52 kr to serve — 82% margin on the upsell

Unlimited AI (Group plan) still delivers 93% margin even at maximum realistic usage.

---

## 4. Customer Onboarding Process

**Time from signup to live data: target 30 minutes**

```
Customer signs up at comandcenter.se
  → Completes 4-step onboarding (name, city, systems they use)
  → Email sent to paul@laweka.com with their system choices
  → Customer sees "setting up..." state on dashboard

Support goes to /admin
  → Sees customer flagged as "setup requested"
  → Opens connection wizard
  → Pastes customer's API key → system tests it → shows workplace + date range
  → Clicks "Connect & Import" → data backfills automatically
  → Customer dashboard goes live

Daily cron takes over
  → 06:00 UTC every morning
  → Syncs all connected businesses automatically
  → No further action needed from support
```

**Admin panel**: https://comandcenter.se/admin (password: server-side env var)

---

## 5. Customer Support Model

**Phase 1 (0–20 customers)**: Paul handles all support directly
- Email: paul@laweka.com
- Response target: same business day
- Onboarding: Paul connects all new customers via /admin panel

**Phase 2 (20–50 customers)**: Potentially 1 support hire
- Admin panel designed to be used by non-technical support staff
- Connection wizard requires only: select customer → paste API key → click connect
- All syncing is automatic

---

## 6. Legal & Compliance

| Requirement | Status |
|------------|--------|
| Privacy policy | ✅ Live at /privacy — Dransfield Invest AB, full GDPR |
| Terms of service | ❌ Not built — MUST BUILD before charging customers |
| GDPR data export | ✅ Built — /api/gdpr GET |
| GDPR deletion | ✅ Built — deletion_requests table, 30-day process |
| Consent logging | ✅ Built — ConsentBanner component, stored in DB |
| Data location | ✅ Supabase Frankfurt (EU), Vercel EU |
| Sub-processors disclosed | ✅ In privacy policy: Supabase, Vercel, Anthropic, Stripe |
| Swedish company registration | ✅ Dransfield Invest AB |

**Blocking issue**: Cannot legally charge customers without terms of service. Build in Session 6.

---

## 7. Revenue Milestones

| Milestone | Customers needed | At 799 kr/business |
|-----------|-----------------|-------------------|
| Cover infrastructure costs | 2 | ~1,600 kr/mo |
| 10,000 kr/mo profit | 14 | ~11,186 kr/mo |
| Part-time income (20k/mo) | 27 | ~21,573 kr/mo |
| Full-time income (40k/mo) | 52 | ~41,548 kr/mo |
| Two salaries (80k/mo) | 103 | ~82,297 kr/mo |

---

## 8. Competitive Positioning

### The pitch (one sentence)
"One dashboard for all your restaurant group's financial data — from Personalkollen, Fortnox, and your POS — with AI that explains what the numbers mean. For less than you pay for Fortnox alone."

### Why we win
- **Price**: 499–799 kr vs 500–2,000 kr for comparable tools
- **Consolidation**: Connects systems that don't talk to each other
- **AI**: Not just dashboards — AI explains anomalies, forecasts, and trends
- **Swedish context**: Understands OB supplements, VAT, Swedish accounting codes
- **Multi-location**: Built for groups, not single restaurants

### Why we lose (honest)
- Not proven yet — 0 paying customers
- Fortnox integration blocked (pending approval)
- No mobile app
- Small team (effectively 1 person)

---

## 9. Key Metrics to Track (from Day 1)

| Metric | Target | Why |
|--------|--------|-----|
| Monthly Recurring Revenue (MRR) | Growing | Primary success metric |
| Customer count | 50 in 12 months | Scale target |
| Gross margin | >90% | Validates cost model |
| Churn rate | <5%/mo | Retention = revenue |
| AI queries per customer/day | Track by plan | Spot heavy users for upsell |
| Time to live (signup → data visible) | <30 min | Onboarding quality |
| Annual vs monthly ratio | >50% annual | Reduces churn risk |

---

## 10. What We Build Next (Priority order for first paying customer)

1. **Terms of service** — legal blocker
2. **Admin password → env var** — security blocker
3. **Signup confirmation email** — trust
4. **Forecast empty state** — UX
5. **Sync status visible** — trust
6. **Onboarding completion state** — UX
7. **Stripe billing wired** — revenue enabler
8. **AI query limits enforced** — cost protection
9. **AI add-on upsell** — profit driver

---

*Updated: 2026-04-11 — full rewrite from prototype docs to live platform reality*
