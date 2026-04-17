# ROADMAP.md — CommandCenter
> Version 7.0 | Updated: 2026-04-17 | Session 7 IN PROGRESS 🔄
> Read alongside CLAUDE.md and FIXES.md

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Complete — live in production, tested with real data |
| 🔄 | In progress |
| ⏳ | Blocked — waiting on external dependency |
| 📋 | Planned — session and priority confirmed |
| 💡 | Backlog — will build when relevant |

---

## What Is Live Right Now (Session 5 complete)

### Platform foundation ✅
- Multi-tenant architecture: org → businesses → integrations
- Auth (Supabase email/password), session cookies, route protection
- Sidebar with business switcher — all pages react to switch
- UX design system: `lib/constants/colors.ts`, `deptColor()`, uniform card styles
- GDPR: privacy policy, consent banner, data export API, deletion requests
- Onboarding: 4-step flow, sends setup request email to support
- Admin panel `/admin`: see all customers, connect APIs, trigger syncs
- Daily cron 06:00 UTC: syncs ALL connected integrations automatically

### Analytics pages ✅
- `/dashboard` — KPI cards, revenue chart, department breakdown
- `/staff` — hours, costs, OB supplement, late arrivals (reads from staff_logs DB)
- `/departments` — cost per department, colour-coded
- `/covers` — daily revenue detail (rename to /revenue pending)
- `/tracker` — monthly P&L, manual entry
- `/forecast` — predicted revenue vs actual
- `/budget` — cost targets
- `/invoices` — Fortnox documents
- `/alerts` — AI-detected anomalies
- `/ai` — Claude assistant with business context

### Data integrations ✅
- **Personalkollen adapter**: shifts, costs, OB types, food/drink split, covers
- **Sync engine**: per-integration, auto-detects business_id, upserts to DB
- **Master cron**: all businesses, all orgs, daily, zero config for new customers

### Database schema ✅
- All tables have org_id + business_id for multi-tenant isolation
- RLS policies on all tables
- Encrypted API key storage (AES-256-GCM)
- staff_logs columns: hours_worked, cost_actual, ob_supplement_kr, ob_type, is_late, late_minutes, costgroup_name, staff_name, staff_group, shift_date, real_start, real_stop
- revenue_logs columns: revenue, covers, food_revenue, drink_revenue, tip_revenue, dine_in_revenue, takeaway_revenue

---

## Session 6 — COMPLETED ✅

### Phase 1 — Must do (ALL COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| 1. Terms of service | ✅ **COMPLETE** | Live at `/terms` — Version 1.0 effective 11 April 2026 |
| 2. Admin password → env var | ✅ **COMPLETE** | Using `ADMIN_SECRET` env var in `.env.local`, checked via `/api/admin/auth` |
| 3. Signup confirmation email | ✅ **COMPLETE** | According to user confirmation |
| 4. Forecast empty state | ✅ **COMPLETE** | Loading state with "Loading forecasts..." message |
| 5. Sync status visible | ✅ **COMPLETE** | "Synced just now" / "Synced Xh ago" in sidebar with green indicator |
| 6. Onboarding completion state | ✅ **COMPLETE** | `setupPending` state in dashboard with "Setting up your data..." banner |
| 7. Wire Stripe billing | ✅ **COMPLETE** | Checkout flow in `/upgrade` page calling `/api/stripe/checkout` |

### Phase 4 — Clean up (ALL COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| Delete beta, changelog, notebook pages | ✅ **COMPLETE** | All directories removed: `/beta`, `/changelog`, `/notebook` |
| Delete VAT, revenue-split pages | ✅ **COMPLETE** | Directories removed: `/vat`, `/revenue-split` |
| Delete orphaned API routes | ✅ **COMPLETE** | Routes removed: `/documents`, `/pos-connections`, `/supplier-mappings`, `/chat` |
| Fix or disable weekly digest cron | ✅ **COMPLETE** | Updated to use POST method and Bearer token authorization |

### AI cost control (PARTIALLY COMPLETED)
| Item | Status | Notes |
|------|--------|-------|
| 25. Enforce AI query limits at API level | ✅ **COMPLETE** | Implemented in `/api/ask/route.ts` with daily counter and 429 response |
| 26. AI add-on upsell (+299 kr/mo) | ⏳ **PENDING** | Limit enforcement triggers `upgrade: true` flag but UI upsell not built |

---

## Session 7 — IN PROGRESS 🔄

| Item | Description | Status |
|------|-------------|--------|
| 8. Public landing page | Marketing page at comandcenter.se | ✅ **COMPLETE** — live at `/`, logged-in users redirect to `/dashboard` |
| 9. Sentry error monitoring | Know about issues before customers do | ✅ **COMPLETE** |
| 10. Fix sync timeout | Chunked backfill — one month per call | ✅ **COMPLETE** |
| 11. Contextual AI on every page | "Ask AI" button on staff, tracker, dashboard | ✅ **COMPLETE** |
| 12. Rename /covers → /revenue | "Covers" is wrong term for this page | ✅ **COMPLETE** |
| 13. Mobile dashboard, staff, tracker | KPI cards must stack on phones | 📋 Next |
| 14. Schema migrations log | MIGRATIONS.md — record every SQL change (file created) | ✅ **COMPLETE** |

### Session 7 — Inzii POS Integration

| Item | Status | Notes |
|------|--------|-------|
| Inzii POS adapter (`lib/pos/inzii.ts`) | ✅ Built | Tries 8 endpoint patterns against api.swess.se |
| Multi-department DB schema (M005) | ✅ Complete | `department` column + partial unique indexes |
| Admin panel — add dept modal | ✅ Built | InziiDeptModal in `/admin` page |
| Sync engine — Inzii provider | ✅ Built | Stores as `inzii_bella`, `inzii_brus` etc. in revenue_logs |
| Admin panel — show depts | ✅ **NOT A BUG** | Diagnose-inzii endpoint confirmed all 6 depts correctly attached to Vero Italiano — see FIXES.md |
| Inzii API endpoint | ⏳ Unknown | api.swess.se responds but correct path not confirmed |

**Resolved 2026-04-17:** The "0 departments" report was a misread — all 6 Inzii depts are correctly attached to Vero Italiano (Rosali Deli is a separate business with only PK). Expanding Vero's card in the admin panel shows all 6 as expected. Built `/api/admin/diagnose-inzii?org_id=…` for future investigations of this kind.

---

## Session 8+ — Blocked / Scale

### Blocked on external dependency
| Item | Blocker | When |
|------|---------|------|
| Fortnox OAuth | Developer account approval pending | When approved |
| POS adapter | Need to know which POS next customer uses | When known |
| Weekly digest email | ~~Resend domain not verified~~ | ✅ Resolved 2026-04-17 |

### Scale features (20+ customers)
| Item | Description |
|------|-------------|
| Staging environment | Test on preview branch before prod |
| TypeScript properly enabled | One session to remove ts-nocheck debt |
| Health monitoring with alerts | UptimeRobot + cron success logging |
| Subscription pause | Seasonal restaurant closures |
| Annual invoice option | Swedish B2B expects PDF invoice |

---


---

## AI Agents — ALL 6 BUILT ✅

| Agent | Schedule | Plan | Build effort | Status |
|-------|----------|------|-------------|--------|
| Anomaly detection | Nightly 05:30 UTC | All | 3 hrs | ✅ **COMPLETE** — updated thresholds and email alerts |
| Onboarding success | On first sync (inline) + daily 08:00 UTC (cron safety net) | All | 2 hrs | ✅ **COMPLETE** — inline path from sync engine + cron bugs fixed 2026-04-17 (provider col name, auth.admin.getUserById, plan col name, 48h safety window) |
| Monday briefing | Monday 06:00 UTC | Pro+ | 4 hrs | ✅ **COMPLETE** — Resend domain verified 2026-04-17, digest@ typo fixed |
| Forecast calibration | 1st of month 04:00 UTC | Pro+ | 4 hrs | ✅ **COMPLETE** — M003 tables live 2026-04-17, runs 04:00 UTC on 1st of month |
| Supplier price creep | 1st of month 05:00 UTC | Pro+ | 3 hrs | ✅ **SKELETON BUILT** — waiting for Fortnox OAuth |
| Scheduling optimisation | Monday 07:00 UTC | Group | 6 hrs | ✅ **COMPLETE** — M003 tables live 2026-04-17, runs Monday 07:00 UTC, uses Sonnet 4-6 |

**Total cost at 50 customers**: ~$5/month using Haiku 4.5 (was $15 with Sonnet — 67% saving)
**Model used**: All agents use `claude-haiku-4-5-20251001` except scheduling optimisation which uses `claude-sonnet-4-6`
**Rule**: Never hardcode model strings — always import from `lib/ai/models.ts`
**Total build effort**: 22 hours across all 6 agents

### SQL needed before building agents
```sql
-- Run in Supabase before starting agent builds
CREATE TABLE IF NOT EXISTS briefings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  content TEXT NOT NULL,
  key_metrics JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(business_id, week_start)
);
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "briefings_select_own" ON briefings
  FOR SELECT USING (org_id IN (
    SELECT org_id FROM organisation_members WHERE user_id = auth.uid()
  ));

CREATE TABLE IF NOT EXISTS forecast_calibration (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  calibrated_at TIMESTAMPTZ DEFAULT now(),
  accuracy_pct NUMERIC,
  bias_factor NUMERIC DEFAULT 1.0,
  dow_factors JSONB,
  UNIQUE(business_id)
);
ALTER TABLE forecast_calibration ENABLE ROW LEVEL SECURITY;

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS onboarding_email_sent BOOLEAN DEFAULT false;
```

## Backlog — Build when there is customer demand

| Feature | Notes |
|---------|-------|
| Language toggle EN/SV | After first 10 paying customers |
| BankID auth | Swedish enterprise requirement |
| Visma integration | Alternative to Fortnox |
| Open Banking / Tink | Real-time bank data |
| Multi-currency | Groups with non-Swedish locations |
| Mobile app (React Native) | Post product-market fit |
| Competitor benchmarking | Anonymised industry avg when 10+ customers |

---

## Pages to Remove (Session 6)

| Page | Why remove |
|------|-----------|
| /beta | Half-built, not linked, will break |
| /changelog | Half-built, not linked, will break |
| /notebook | Replaced by /ai — duplicate confusing |
| /vat | No customer asked for it |
| /revenue-split | No customer asked for it |

## API Routes to Remove (Session 6)

| Route | Why remove |
|-------|-----------|
| /api/documents | No connected frontend |
| /api/pos-connections | No connected frontend |
| /api/supplier-mappings | No connected frontend |
| /api/chat | Duplicate of /api/ai |

---

## Pricing & Commercial Model

### Plans
| Plan | Price | AI queries/day | Businesses |
|------|-------|---------------|------------|
| Starter | 499 kr/mo/business | 20 | 1 |
| Pro | 799 kr/mo/business | 50 | Up to 5 |
| Group | 1,499 kr/mo/business | Unlimited | Unlimited |
| AI add-on | +299 kr/mo | +100 | Any |

### Annual billing (push to every customer)
- 2 months free = 10 months price for 12 months
- Starter annual: 4,990 kr upfront
- Pro annual: 7,990 kr upfront
- Group annual: 14,990 kr upfront

### Break-even
- 2 customers at 499 kr = covers all infrastructure costs
- 52 customers at 799 kr = full-time income equivalent (40,000 kr/mo)
- 50 customers target = ~75,700 kr/mo profit at 95% gross margin

---

## Database Migrations Needed (run these in Supabase before Session 6 builds)

```sql
-- Already run (do not re-run):
-- ALTER TABLE staff_logs ADD COLUMN IF NOT EXISTS ob_type TEXT;
-- ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS food_revenue INTEGER DEFAULT 0;
-- ALTER TABLE revenue_logs ADD COLUMN IF NOT EXISTS drink_revenue INTEGER DEFAULT 0;

-- Needed for Session 6:
-- AI query tracking
CREATE TABLE IF NOT EXISTS ai_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organisations(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  query_count INTEGER DEFAULT 0,
  UNIQUE(org_id, date)
);
ALTER TABLE ai_usage_daily ENABLE ROW LEVEL SECURITY;
```

---

*Last updated: Session 6 — 2026-04-15*
*Next action: Session 7 items 8-14*

