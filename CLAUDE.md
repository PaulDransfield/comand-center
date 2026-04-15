# CLAUDE.md — Working Guidelines
> Last updated: 2026-04-11 | Session 6

---

## 1. Role Definition

**You are**: Paul Dransfield — business owner, product visionary, decision-maker.
**Claude is**: Technical co-founder and lead developer.
**Dynamic**: You set direction. Claude builds and explains. Always confirms before major changes.

---

## 2. Session Protocol (every session, in order)

1. Read `ROADMAP.md` and this file before writing a single line of code
2. Ask clarifying questions if requirements are not clear
3. State the plan — what will be built, why, what you will see — get confirmation
4. Write code with plain-English comments explaining why
5. Explain how to test — specific steps to verify it works
6. Provide SQL for any DB changes, formatted for Supabase SQL Editor
7. Update this file at the end of every session

---

## 3. Project Identity

**Product**: CommandCenter — restaurant group business intelligence SaaS
**Live URL**: https://comandcenter.se
**Stack**: Next.js 14 + Supabase (Frankfurt) + Vercel (EU) + Anthropic Claude API + Stripe + Resend
**Local dev**: C:\Users\pauld\Desktop\comand-center\
**Supabase project**: https://llzmixkrysduztsvmfzi.supabase.co
**Vercel org**: paul-7076s-projects/comand-center

### Key IDs
| Item | Value |
|------|-------|
| Org ID (test org) | e917d4b8-635e-4be6-8af0-afc48c3c7450 |
| Test business 1 (Vero) | 0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99 |
| Test business 2 (Rosali) | 97187ef3-b816-4c41-9230-7551430784a7 |
| Integration 1 | 2475e1ef-a4d9-4442-ab50-bffe4e831258 |
| Integration 2 | 1c3278cc-7446-4fcd-9078-e380c73e52fb |

---

## 4. Architecture — What Is Actually Built

```
Customer browser
      │
      ▼
Vercel (EU) — Next.js 14 App Router
  ├── /dashboard, /staff, /departments, /covers, /tracker
  ├── /forecast, /budget, /invoices, /alerts
  ├── /ai (Claude-powered assistant)
  ├── /settings, /integrations, /onboarding, /privacy, /upgrade
  ├── /admin (support panel — server-side password protected)
  └── /api/* (data routes, sync engine, cron jobs)
      │
      ▼
Supabase PostgreSQL (Frankfurt)
  ├── staff_logs       — shifts, costs, OB supplement, late minutes
  ├── revenue_logs     — daily revenue, covers, food/drink split
  ├── tracker_data     — monthly P&L entries (manual + synced)
  ├── businesses       — multi-tenant, per org
  ├── integrations     — API keys encrypted (AES-256-GCM)
  ├── organisations    — top-level tenant
  ├── organisation_members
  ├── forecasts, budgets, covers, anomaly_alerts
  └── deletion_requests — GDPR deletion queue
      │
      ▼
External APIs (all via sync engine — never called live from pages)
  ├── Personalkollen — staff shifts, costs, sales
  ├── Fortnox        — P&L, invoices (OAuth2 — PENDING approval)
  ├── POS systems    — Ancon, Swess, Trivec (PENDING customer info)
  └── Anthropic      — Claude Sonnet 4.6 (central key, never client-side)
```

---

## 5. Permanent Build Rules (never break these)

### Architecture rules
1. Every page filters by `org_id` AND `business_id`. Never hardcode business names or IDs.
2. Staff API reads from `staff_logs` DB only. Never call external APIs live from page routes.
3. API keys stored encrypted. Use `encrypt()` on save, `decrypt()` on use. Never log raw keys.
4. Every new integration automatically included in daily 06:00 UTC cron — no config needed.
5. Admin panel password checked server-side via `ADMIN_PASSWORD` env var. Never in client source.
6. No code changes when a new customer joins. If code must change to onboard, it is a bug.

### UX rules — HIGH PRIORITY
7. **Uniform UX across all businesses.** Always import from `lib/constants/colors.ts`. Never define colours inline.
8. Use `deptColor(name)` for all department colours — handles all businesses automatically.
9. All KPI cards: `borderRadius: 12`, white background, `0.5px solid #e5e7eb`. No exceptions.
10. All pages must listen for `window.addEventListener('storage', sync)` for business switching.

### Code quality rules
11. `'use client'` MUST be line 1. `// @ts-nocheck` line 2. No exceptions.
12. Use `try/catch` for all Supabase queries. Never chain `.catch()`.
13. `useState([])` → `useState<any[]>([])`. `useState(null)` → `useState<any>(null)`.
14. CSS string values need `as const`: `textAlign: 'center' as const`.

### Business rules
15. AI query limits enforced per plan tier at the API level. Heavy users shown upgrade prompt.
16. When adding a new customer's departments, add once to `lib/constants/colors.ts` — all pages update automatically.
17. Business delete permanently removes all related data across all tables.

---

## 6. Cost & Pricing Model

### Monthly infrastructure costs
| Service | Cost | Notes |
|---------|------|-------|
| Supabase Pro | $25/mo | Required for production — free tier pauses |
| Vercel Pro | $20/mo | Required for commercial use |
| Resend Pro | $20/mo | 50k emails included |
| Sentry | $0 | Free tier sufficient |
| UptimeRobot | $0 | Free tier sufficient |
| **Total fixed** | **~$65 (~700 kr)** | Same regardless of customer count |

### Variable costs per customer
| Cost driver | Rate | Est. per customer/mo |
|------------|------|----------------------|
| Claude Sonnet 4.6 (20 q/day) | $3/$15 per 1M tokens | ~10 kr |
| Claude Sonnet 4.6 (50 q/day) | $3/$15 per 1M tokens | ~26 kr |
| Stripe fees | 1.5% + 2.70 kr/transaction | ~12–22 kr |

### Pricing tiers
| Plan | Price | AI queries | Businesses |
|------|-------|-----------|------------|
| Starter | 499 kr/mo/business | 20/day | 1 |
| Pro | 799 kr/mo/business | 50/day | Up to 5 |
| Group | 1,499 kr/mo/business | Unlimited | Unlimited |
| AI add-on | +299 kr/mo | +100/day | Any plan |

**Annual billing**: 2 months free (10 months price for 12 months). Push annual on every customer.

### AI cost model — risk to profit
Heavy AI users (50+ q/day) hit plan limits and are prompted to upgrade or buy the AI add-on.
The add-on (+299 kr/mo) costs ~52 kr in Claude API — 82% margin. Heavy users become most profitable customers.
Fallback: route simple queries to Haiku 4.5 ($1/$5 per 1M tokens) to cut AI costs 70%.

---

## 7. Sync Commands (manual triggers)

```bash
# Master sync (all businesses — runs automatically at 06:00 UTC)
https://comandcenter.se/api/cron/master-sync?secret=commandcenter123

# Manual single-integration sync
https://comandcenter.se/api/sync?secret=commandcenter123&provider=personalkollen&org_id=ORG_ID&integration_id=INTEGRATION_ID&from=2024-01-01
```

---

## 8. Current Blockers

| Blocker | Status | Action needed |
|---------|--------|---------------|
| Fortnox OAuth | Waiting developer account approval | Chase developer portal |
| Rosali POS revenue | No POS connected | Ask customer which POS they use |
| Resend domain verification | DNS pending | Verify in Resend dashboard |
| Stripe billing wiring | UI exists, payment flow not built | Session 6 priority |
| Admin password | Hardcoded in source — security risk | Move to ADMIN_PASSWORD env var |

---

## 9. Test Businesses

The two businesses in the system are for building and testing only — not paying customers. Every issue we find with them is a bug we fix so paying customers never see it.

- **Test business 1**: Logs sales in staff system. Full staff + revenue data available.
- **Test business 2**: Does NOT log sales in staff system. Staff data only. Revenue needs POS.

In code, diagrams, and docs, use generic terms: "restaurant", "location", "test business". Never use their real names in customer-facing UI.

---

## 10. Communication Style

Plain language first. No jargon without immediate explanation.

When showing options:
> **Option A** — what it does · pros · cons · best if you want X
> **Recommendation**: A, because [plain reason tied to your situation]

After completing a task:
```
Done — what we built / what to test / what comes next
```

---

*Read at the start of every session. Companion files: ROADMAP.md · FIXES.md · MIGRATIONS.md*

---

## 11. AI Model Routing — always follow this

Never hardcode model strings. Always import from `lib/ai/models.ts`.

```typescript
// lib/ai/models.ts
export const AI_MODELS = {
  AGENT:     'claude-haiku-4-5-20251001', // Background agents — 70% cheaper
  ANALYSIS:  'claude-sonnet-4-6',          // Complex multi-step reasoning
  ASSISTANT: 'claude-sonnet-4-6',          // Interactive AI assistant
} as const

export const MAX_TOKENS = {
  AGENT_EXPLANATION: 150,
  AGENT_SUMMARY:     300,
  AGENT_RECOMMENDATION: 400,
  ASSISTANT: 2000,
} as const
```

| Use case | Model | Max tokens |
|----------|-------|-----------|
| Anomaly explanation (1 sentence) | Haiku 4.5 | 150 |
| Monday briefing (1 paragraph) | Haiku 4.5 | 300 |
| Onboarding welcome email | Haiku 4.5 | 300 |
| Supplier / scheduling alerts | Haiku 4.5 | 400 |
| Scheduling optimisation (complex) | Sonnet 4.6 | 600 |
| Interactive AI assistant | Sonnet 4.6 | 2000 |

**Cost comparison** (per 1,000 agent calls, avg 500 input + 150 output tokens):
- Haiku 4.5: ~$1.25 total
- Sonnet 4.6: ~$3.75 total
- Saving: 67% per agent run

At 50 customers, all agents running: ~$15/month with Haiku vs ~$45/month with Sonnet.

