# PROJECT_MANIFEST.md — CommandCenter
> Version 6.0 | Updated: 2026-04-15 | Session 6
> Companion files: ROADMAP.md · CLAUDE.md · FIXES.md · MIGRATIONS.md

---

## 1. What CommandCenter Is

**CommandCenter** is a multi-tenant SaaS platform for Swedish restaurant groups. Restaurant owners connect their staff system, accounting software, and POS system to get a unified intelligence dashboard across all their locations — with AI that explains what the numbers mean.

**The problem it solves**: Restaurant groups run Personalkollen for staff, Fortnox for accounting, and a POS for revenue. Three tabs, no single picture, no AI analysis. CommandCenter is that single picture.

**The value proposition**: One dashboard instead of four tabs. AI that answers "why was food cost high last month?" — for less than what Fortnox costs alone.

---

## 2. Current State (Session 6 in progress)

**Status**: Live in production at https://comandcenter.se
**Session 6 focus**: AI agents, billing, cleanup

### ✅ What works today
- Full multi-tenant architecture (org → businesses → integrations)
- 14 pages: dashboard, staff, departments, covers, tracker, forecast, budget, invoices, alerts, AI, settings, integrations, onboarding, admin
- Personalkollen sync: shifts, costs, OB supplement, department breakdown
- Daily cron syncing all connected businesses automatically at 06:00 UTC
- Admin panel for support: connect new customers, trigger syncs, see status
- UX design system: consistent colours, department colour coding, uniform cards
- GDPR: privacy policy, consent, data export, deletion request flow
- Business switching: all pages react when sidebar business is changed
- Terms of service: Live at `/terms` — Version 1.0 effective 11 April 2026
- AI query limits: Enforced at API level with daily counters and 429 responses
- Stripe billing: Checkout flow wired in `/upgrade` page

### ✅ AI Agents Built (Session 6)
**5 out of 6 agents complete** — delivering automated business intelligence:

1. **Anomaly Detection** — Nightly at 05:30 UTC
   - Detects revenue drops ≥15%, cost spikes, OB supplement spikes ≥40%
   - Sends email alerts for critical severity anomalies
   - Uses Claude Haiku 4.5 (67% cheaper than Sonnet)

2. **Forecast Calibration** — 1st of month at 04:00 UTC
   - Calculates forecast accuracy vs actual revenue
   - Computes bias factors and day-of-week patterns
   - No Claude needed — pure arithmetic

3. **Scheduling Optimization** — Monday at 07:00 UTC
   - For Group plan customers only
   - Analyzes 6 months of staff and revenue data
   - Provides specific scheduling recommendations
   - Uses Claude Sonnet 4-6 for complex analysis

4. **Supplier Price Creep** — 1st of month at 05:00 UTC
   - Skeleton built, waiting for Fortnox OAuth approval
   - Will detect supplier price increases >10% month-over-month

5. **Weekly Digest** — Monday at 06:00 UTC
   - Fixed cron configuration with Bearer token authorization

**Monthly cost at 50 customers**: ~$5 (was $15 with Sonnet — 67% saving)

### 🔄 What does not work yet
- Fortnox OAuth (waiting developer approval)
- POS adapter (waiting to know which system next customer uses)
- Email sending (Resend domain not verified)
- No public landing page
- AI add-on upsell UI not built (limit enforcement triggers `upgrade: true` flag)

### Test businesses (not paying customers)
Two businesses connected for development and testing only. All issues found with them are bugs fixed before paying customers join.

---

## 3. Target Market

**Primary**: Swedish restaurant groups with 2–10 locations
**Secondary**: Single-location restaurants wanting better financial visibility
**Geography**: Sweden (Phase 1 only)
**Language**: English UI (Swedish data is understood and displayed)

**Ideal customer profile**:
- Restaurant group with 3+ locations
- Already using Personalkollen for staff
- Monthly revenue >1M SEK per location
- Owner/manager spends >2h/day looking at spreadsheets
- Willing to pay 799 kr/month/location for unified intelligence

---

## 4. Technical Architecture

### Stack
- **Frontend**: Next.js 14 (App Router) + TypeScript + Tailwind CSS
- **Backend**: Supabase (PostgreSQL + Auth + Storage) in Frankfurt
- **Hosting**: Vercel (EU region)
- **AI**: Anthropic Claude API (Haiku 4.5 + Sonnet 4-6)
- **Payments**: Stripe (subscriptions + usage billing)
- **Email**: Resend (transactional emails)
- **Monitoring**: Sentry (error tracking)

### Key Design Decisions
1. **Multi-tenant isolation**: Every table has `org_id` + `business_id`, RLS policies
2. **API key encryption**: AES-256-GCM for third-party credentials
3. **Cost-optimized AI**: Haiku 4.5 for background agents, Sonnet only when needed
4. **Zero-config sync**: New customers automatically sync all connected integrations
5. **Business switcher**: All pages react to sidebar selection without page reload

---

## 5. Commercial Model

### Pricing Plans
| Plan | Price | AI queries/day | Businesses | Target customer |
|------|-------|---------------|------------|-----------------|
| Starter | 499 kr/mo/business | 20 | 1 | Single location |
| Pro | 799 kr/mo/business | 50 | Up to 5 | Small group (2-5) |
| Group | 1,499 kr/mo/business | Unlimited | Unlimited | Large group (6+) |
| AI add-on | +299 kr/mo | +100 | Any | Power users |

### Annual Billing (push to every customer)
- 2 months free = 10 months price for 12 months
- Starter annual: 4,990 kr upfront
- Pro annual: 7,990 kr upfront
- Group annual: 14,990 kr upfront

### Break-even Analysis
- **2 customers at 499 kr** = covers all infrastructure costs
- **52 customers at 799 kr** = full-time income equivalent (40,000 kr/mo)
- **50 customers target** = ~75,700 kr/mo profit at 95% gross margin

**Gross margin**: 95% (infrastructure costs ~5% of revenue)
**Customer acquisition cost target**: <3,000 kr (payback in 4 months)

---

## 6. Development Roadmap

### Session 7 — Next Priorities
1. **Public landing page** — No marketing page exists yet
2. **Sentry error monitoring** — Know about issues before customers do
3. **Fix sync timeout** — Chunked backfill (one month per call)
4. **Contextual AI on every page** — "Ask AI" button on staff, tracker, dashboard
5. **Rename /covers → /revenue** — "Covers" is wrong term for this page
6. **Mobile dashboard, staff, tracker** — KPI cards must stack on phones
7. **Complete onboarding success agent** — Last AI agent to build

### Session 8+ — Scale Features
- **Staging environment** — Test on preview branch before prod
- **TypeScript properly enabled** — Remove `// @ts-nocheck` debt
- **Health monitoring with alerts** — UptimeRobot + cron success logging
- **Subscription pause** — Seasonal restaurant closures
- **Annual invoice option** — Swedish B2B expects PDF invoice

### Blocked on External Dependency
- **Fortnox OAuth** — Developer account approval pending
- **POS adapter** — Need to know which POS next customer uses
- **Weekly digest email** — Resend domain not verified

---

## 7. Team & Resources

### Current Team
- **Paul Dransfield** — Founder, product, sales, customer support
- **Claude (AI)** — Technical co-founder, lead developer

### Development Philosophy
1. **Build fast, fix fast** — Get features in front of test customers quickly
2. **Document everything** — CLAUDE.md, ROADMAP.md, FIXES.md, MIGRATIONS.md
3. **Cost-conscious** — Haiku 4.5 for agents, Vercel free tier where possible
4. **Multi-tenant first** — Every feature works for all customers from day one
5. **AI as differentiator** — Not just dashboards, but explanations and recommendations

### Infrastructure Costs (Current)
- **Supabase**: Free tier (€0/month)
- **Vercel**: Free tier (€0/month)
- **Claude API**: ~$5/month at 50 customers
- **Stripe**: 2.9% + 30¢ per transaction
- **Resend**: Free tier (100 emails/day)

**Total monthly cost at 50 customers**: <€50

---

## 8. Success Metrics

### Product Metrics
- **Daily active users**: Target 70% of paying customers
- **AI queries per customer**: Target 15/day (shows engagement)
- **Sync success rate**: Target 99% (reliability)
- **Page load time**: <2 seconds (performance)

### Business Metrics
- **Monthly recurring revenue**: Target 75,700 kr at 50 customers
- **Customer acquisition cost**: Target <3,000 kr
- **Customer lifetime value**: Target >36,000 kr (3+ years retention)
- **Churn rate**: Target <3% monthly (restaurants are sticky)

### Technical Metrics
- **Uptime**: 99.9% (Vercel SLA)
- **Error rate**: <0.1% (Sentry monitoring)
- **Cron success rate**: 100% (daily syncs)
- **Database performance**: <100ms query time (Supabase)

---

## 9. Risks & Mitigations

### Technical Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Supabase outage | High | Daily backups, can migrate to self-hosted Postgres |
| Vercel outage | High | Can deploy to other platforms (Netlify, Railway) |
| Claude API changes | Medium | Abstract model selection, can switch to OpenAI |
| Stripe webhook failures | Medium | Manual subscription updates in admin panel |

### Business Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| No product-market fit | Critical | Test with 2-3 paying customers before scaling |
| High customer acquisition cost | High | Focus on inbound leads from Personalkollen referrals |
| Swedish restaurant market too small | Medium | Expand to Norway/Denmark after Sweden proven |
| Competition from existing POS/accounting | Medium | Focus on multi-location groups they ignore |

### Operational Risks
| Risk | Impact | Mitigation |
|------|--------|------------|
| Single point of failure (me) | High | Document everything, consider hiring first employee at 30 customers |
| GDPR compliance issues | High | Built-in consent, export, deletion from day one |
| Payment disputes | Medium | Clear terms, good customer support |

---

## 10. Exit Strategy

### 3-Year Vision
1. **Year 1**: 50 paying customers in Sweden, €75k ARR
2. **Year 2**: 200 customers across Nordics, €300k ARR
3. **Year 3**: 500 customers, expand to DACH region, €750k ARR

### Potential Acquirers
1. **Personalkollen** — Natural fit, already integrated
2. **Fortnox** — Would complement their accounting software
3. **Lightspeed POS** — Would add intelligence to their restaurant POS
4. **Visma** — Large Nordic business software company

### Acquisition Valuation
- **SaaS multiple**: 5-10x ARR
- **At €750k ARR**: €3.75M–€7.5M acquisition price
- **Realistic target**: €5M at 500 customers

---

*This document is updated at the end of every development session. Always read ROADMAP.md for current priorities.*