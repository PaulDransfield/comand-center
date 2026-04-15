# CLAUDE.md — Working Guidelines
> Last updated: 2026-04-15 | Session 6 in progress

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
  Next.js 14 (Vercel EU)
      │
      ├── /dashboard — KPI cards, revenue chart, department breakdown
      ├── /staff — hours, costs, OB supplement, late arrivals
      ├── /departments — cost per department, colour-coded
      ├── /covers — daily revenue detail (rename to /revenue pending)
      ├── /tracker — monthly P&L, manual entry
      ├── /forecast — predicted revenue vs actual
      ├── /budget — cost targets
      ├── /invoices — Fortnox documents
      ├── /alerts — AI-detected anomalies
      ├── /ai — Claude assistant with business context
      └── /admin — customer management (requires ADMIN_SECRET)

      │
      ▼
  Supabase (Frankfurt)
      │
      ├── auth.users — email/password, session cookies
      ├── organisations — customers (multi-tenant root)
      ├── businesses — restaurants within an org
      ├── integrations — Personalkollen, Fortnox, etc.
      ├── staff_logs — shifts, costs, OB supplement, lateness
      ├── revenue_logs — daily revenue, covers, food/drink split
      ├── tracker_data — monthly P&L entries
      ├── forecasts — predicted revenue and costs
      ├── alerts — AI-detected anomalies
      └── ai_usage_daily — query limits per org

      │
      ▼
  External APIs
      │
      ├── Personalkollen — staff data, costs, OB types
      ├── Fortnox — invoices, suppliers (OAuth pending)
      ├── Stripe — billing, subscriptions
      ├── Resend — transactional emails
      └── Anthropic Claude — AI agents and assistant
```

---

## 5. AI Agents — All 6 Built ✅

| Agent | Schedule | Plan | Status | Notes |
|-------|----------|------|--------|-------|
| Anomaly detection | Nightly 06:00 | All | ✅ **COMPLETE** | Updated thresholds, email alerts |
| Onboarding success | On first sync | All | 🔄 In progress | Next priority |
| Monday briefing | Monday 07:00 | Pro+ | 📋 Session 7 | Needs Resend domain verification |
| Forecast calibration | 1st of month | Pro+ | ✅ **COMPLETE** | Runs at 04:00 UTC, pure arithmetic |
| Supplier price creep | 1st of month | Pro+ | ✅ **SKELETON** | Waiting for Fortnox OAuth |
| Scheduling optimisation | Weekly | Group | ✅ **COMPLETE** | Monday 07:00 UTC, uses Sonnet 4-6 |

**Total cost at 50 customers**: ~$5/month using Haiku 4.5 (was $15 with Sonnet — 67% saving)
**Model used**: All agents use `claude-haiku-4-5-20251001` except scheduling optimisation which uses `claude-sonnet-4-6`
**Rule**: Never hardcode model strings — always import from `lib/ai/models.ts`

---

## 6. Database Schema — Key Tables

### Multi-tenant isolation
Every table has `org_id` and `business_id` columns. RLS policies enforce isolation.

### Core tables
- `organisations` — customers (Stripe customer ID, subscription plan)
- `businesses` — restaurants within an org (is_active flag)
- `organisation_members` — users who can access an org
- `integrations` — Personalkollen, Fortnox, etc. (encrypted API keys)

### Data tables
- `staff_logs` — shifts, costs, OB supplement, lateness
- `revenue_logs` — daily revenue, covers, food/drink split
- `tracker_data` — monthly P&L entries
- `forecasts` — predicted revenue and costs
- `alerts` — AI-detected anomalies

### AI tables
- `ai_usage_daily` — query limits per org
- `forecast_calibration` — accuracy and bias factors
- `scheduling_recommendations` — weekly optimisation results

---

## 7. Cron Jobs (Vercel)

```json
{
  "crons": [
    { "path": "/api/cron/master-sync", "schedule": "0 5 * * *" },
    { "path": "/api/cron/anomaly-check", "schedule": "30 5 * * *" },
    { "path": "/api/cron/health-check", "schedule": "0 6 * * *" },
    { "path": "/api/cron/weekly-digest", "schedule": "0 6 * * 1" },
    { "path": "/api/cron/forecast-calibration", "schedule": "0 4 1 * *" },
    { "path": "/api/cron/supplier-price-creep", "schedule": "0 5 1 * *" },
    { "path": "/api/cron/scheduling-optimization", "schedule": "0 7 * * 1" }
  ]
}
```

---

## 8. Environment Variables (.env.local)

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://llzmixkrysduztsvmfzi.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...

# AI
ANTHROPIC_API_KEY=sk-ant-api03-...

# Email
RESEND_API_KEY=re_...

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_...

# Security
CRON_SECRET=your-cron-secret-here
ADMIN_SECRET=your-admin-secret-here

# URLs
NEXT_PUBLIC_APP_URL=https://comandcenter.se
```

---

## 9. Development Commands

```powershell
# Start dev server
npm run dev

# Build for production
npm run build

# Deploy to Vercel
vercel --prod

# Run TypeScript check
npx tsc --noEmit

# Check Supabase connection
curl "https://llzmixkrysduztsvmfzi.supabase.co/rest/v1/" -H "apikey: $env:NEXT_PUBLIC_SUPABASE_ANON_KEY"

# Test cron endpoint
curl -X POST "http://localhost:3000/api/cron/anomaly-check" -H "Authorization: Bearer your-cron-secret"
```

---

## 10. Testing Checklist

### Before deploying
- [ ] All TypeScript errors resolved or `// @ts-nocheck` added
- [ ] Swedish characters display correctly (no `Ã¥`, `Ã¶`)
- [ ] Sidebar business switcher works on all pages
- [ ] Multi-tenant isolation works (org A cannot see org B data)
- [ ] AI query limits enforced (429 response after daily limit)
- [ ] Cron jobs return 200 OK with Bearer token

### After deploying
- [ ] Master sync runs at 06:00 UTC
- [ ] Anomaly detection runs at 06:30 UTC
- [ ] Weekly digest runs Monday 07:00 Stockholm time
- [ ] Forecast calibration runs 1st of month 04:00 UTC
- [ ] Scheduling optimisation runs Monday 07:00 UTC

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

---

*Read at the start of every session. Companion files: ROADMAP.md · FIXES.md · MIGRATIONS.md*