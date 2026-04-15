# PROJECT_MANIFEST.md — CommandCenter
> Version 6.0 | Updated: 2026-04-11 | Session 6

---

## 1. What CommandCenter Is

**CommandCenter** is a multi-tenant SaaS platform for Swedish restaurant groups. Restaurant owners connect their staff system, accounting software, and POS system to get a unified intelligence dashboard across all their locations — with AI that explains what the numbers mean.

**The problem it solves**: Restaurant groups run Personalkollen for staff, Fortnox for accounting, and a POS for revenue. Three tabs, no single picture, no AI analysis. CommandCenter is that single picture.

**The value proposition**: One dashboard instead of four tabs. AI that answers "why was food cost high last month?" — for less than what Fortnox costs alone.

---

## 2. Current State (Session 5 complete)

**Status**: Live in production at https://comandcenter.se

### What works today
- Full multi-tenant architecture (org → businesses → integrations)
- 14 pages: dashboard, staff, departments, covers, tracker, forecast, budget, invoices, alerts, AI, settings, integrations, onboarding, admin
- Personalkollen sync: shifts, costs, OB supplement, department breakdown
- Daily cron syncing all connected businesses automatically at 06:00 UTC
- Admin panel for support: connect new customers, trigger syncs, see status
- UX design system: consistent colours, department colour coding, uniform cards
- GDPR: privacy policy, consent, data export, deletion request flow
- Business switching: all pages react when sidebar business is changed

### What does not work yet
- Stripe billing not wired (UI exists)
- Fortnox OAuth (waiting developer approval)
- POS adapter (waiting to know which system next customer uses)
- Email sending (Resend domain not verified)
- No public landing page
- No terms of service
- AI query limits not enforced at API level

### Test businesses (not paying customers)
Two businesses connected for development and testing only. All issues found with them are bugs fixed before paying customers join.

---

## 3. Target Market

**Primary**: Swedish restaurant groups with 2–10 locations
**Secondary**: Single-location restaurants wanting better financial visibility
**Geography**: Sweden (Phase 1 only)
**Language**: English UI (Swedish data is understood and displayed)

### What customers use before CommandCenter
- Personalkollen (staff/scheduling)
- Fortnox (accounting/invoicing)
- Ancon / Swess / Trivec (POS)
- Excel spreadsheets for consolidation
- CommandCenter replaces the spreadsheets and adds AI

---

## 4. Technology Stack

| Layer | Technology | Cost |
|-------|-----------|------|
| Frontend | Next.js 14 App Router + React | Included in Vercel |
| Hosting | Vercel Pro (EU region) | $20/mo |
| Database | Supabase Pro (Frankfurt) | $25/mo |
| Auth | Supabase Auth (email/password) | Included |
| AI | Anthropic Claude Sonnet 4.6 | ~$1–10/customer/mo |
| Email | Resend Pro | $20/mo |
| Payments | Stripe | 1.5% + 2.70 kr/transaction |
| Error monitoring | Sentry Free | $0 |
| Uptime monitoring | UptimeRobot Free | $0 |
| **Total fixed** | | **~$65/mo (~700 kr)** |

---

## 5. Data Model

### Tenant hierarchy
```
organisations (one per restaurant group)
  └── businesses (one per restaurant location)
        ├── integrations (one per connected system)
        ├── staff_logs (synced from Personalkollen)
        ├── revenue_logs (synced from Personalkollen or POS)
        ├── tracker_data (monthly P&L — manual or synced)
        ├── forecasts
        ├── budgets
        └── anomaly_alerts
  └── organisation_members (users with roles)
```

### Key tables
| Table | What it stores | Filtered by |
|-------|---------------|-------------|
| staff_logs | Every shift synced from staff system | org_id + business_id |
| revenue_logs | Daily revenue, covers, food/drink split | org_id + business_id |
| tracker_data | Monthly P&L entries | org_id + business_id |
| integrations | Encrypted API keys, sync status | org_id + business_id |
| businesses | Restaurant locations, targets | org_id |
| organisations | Tenant, plan, Stripe IDs | id |

---

## 6. Integration Adapters

### Personalkollen (complete ✅)
- Endpoint: `https://personalkollen.se/api/`
- Auth: API key (Token header)
- Data pulled: logged-times, work-periods, staffs, sales, sale-forecasts
- Fields captured: hours, cost, OB types, late arrivals, department, food/drink revenue split, guest count
- Sync: daily 06:00 UTC via master cron

### Fortnox (pending ⏳)
- Waiting: developer account approval at developer.fortnox.se
- Auth type: OAuth2
- Data: P&L, invoices, supplier costs

### POS systems (pending ⏳)
- Ancon, Swess, Trivec: API key
- Needed when: next customer uses a POS not connected to Personalkollen

---

## 7. AI Architecture

- **Model**: Claude Sonnet 4.6 (Anthropic API, central key, never client-side)
- **Context**: Business data from DB injected per query (staff costs, revenue, tracker data)
- **Rate limiting**: Per plan tier (20/50/unlimited queries per day) — TO BE ENFORCED at API level
- **Cost**: ~$3/$15 per 1M input/output tokens
- **Fallback**: Route simple queries to Haiku 4.5 ($1/$5) to reduce costs 70%

### AI query limits per plan
| Plan | Queries/day | Our cost at limit | Margin |
|------|------------|------------------|--------|
| Starter (499 kr) | 20 | ~10 kr | Excellent |
| Pro (799 kr) | 50 | ~26 kr | Excellent |
| Group (1,499 kr) | Unlimited | ~54–162 kr | Strong |
| AI add-on (+299 kr) | +100/day | ~52 kr | 82% margin |

Heavy AI users are an upsell opportunity — not a cost risk.

---

## 8. Security

- **Multi-tenant isolation**: PostgreSQL RLS on every table — bugs cannot leak one tenant's data to another
- **API key encryption**: AES-256-GCM, key in environment variable, never in database
- **Admin panel**: Password via server-side env var check — never in client source
- **Session auth**: Supabase JWT cookies, middleware validates on every request
- **GDPR**: Data export API, deletion request flow, privacy policy, consent logging

---

## 9. File Structure

```
comand-center/                    ← Next.js project root
├── app/
│   ├── (auth)/login/             ← Login, signup
│   ├── dashboard/                ← Main KPI dashboard
│   ├── staff/                    ← Hours, costs, OB, punctuality
│   ├── departments/              ← Cost by department
│   ├── covers/                   ← Daily revenue (rename to /revenue pending)
│   ├── tracker/                  ← Monthly P&L
│   ├── forecast/                 ← Revenue predictions
│   ├── budget/                   ← Cost targets
│   ├── invoices/                 ← Fortnox documents
│   ├── alerts/                   ← AI anomaly alerts
│   ├── ai/                       ← Claude assistant
│   ├── settings/                 ← Org, GDPR, businesses
│   ├── integrations/             ← Connect systems
│   ├── onboarding/               ← 4-step new customer flow
│   ├── upgrade/                  ← Pricing, Stripe
│   ├── privacy/                  ← Privacy policy (GDPR)
│   ├── admin/                    ← Support panel
│   └── api/
│       ├── admin/                ← Admin APIs (orgs, connect, sync, test)
│       ├── staff/                ← Reads from staff_logs
│       ├── sync/                 ← Sync engine trigger
│       ├── ai/ (or chat/)        ← Claude API proxy
│       └── cron/master-sync/     ← Daily all-business sync
├── components/
│   ├── AppShell.tsx              ← Sidebar + business switcher
│   └── MobileNav.tsx
├── lib/
│   ├── constants/colors.ts       ← ALL colours — single source of truth
│   ├── pos/personalkollen.ts     ← Personalkollen API adapter
│   ├── sync/engine.ts            ← Universal sync engine
│   ├── integrations/encryption.ts
│   └── supabase/                 ← client.ts + server.ts
├── CLAUDE.md                     ← Working guidelines (this repo's north star)
├── ROADMAP.md                    ← Phased plan with real status
├── PROJECT_MANIFEST.md           ← This file
├── FIXES.md                      ← 63+ documented build fixes
└── MIGRATIONS.md                 ← DB schema change log (TO CREATE)
```

---

## 10. Competitive Position

| Competitor | Price | What they do | Our advantage |
|-----------|-------|-------------|---------------|
| Quinyx | 300–600 kr/employee/mo | Scheduling only | We consolidate all data + add AI |
| Fortnox | 300–800 kr/mo | Accounting only | We show it in context of operations |
| Trivec/Ancon | 500–1,500 kr/mo | POS only | We aggregate across systems |
| Generic BI | 500–2,000 kr/user/mo | Dashboards, no context | Swedish restaurant-specific |
| **CommandCenter** | **499–1,499 kr/mo** | **All of the above unified + AI** | **Cheaper than any single competitor** |

---

*Updated: 2026-04-11 — Session 6 start*
