# ROADMAP.md — CommandCenter
> Version 6.0 | Updated: 2026-04-11 | Session 6
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

## Session 6 — Priority order

### Must do (Phase 1 of improvement plan)
| Item | Description | Est. |
|------|-------------|------|
| 1. Terms of service | Legal requirement before charging anyone | 30 min |
| 2. Admin password → env var | Currently hardcoded in source — security risk | 1 hr |
| 3. Signup confirmation email | Customer gets nothing after onboarding | 2 hrs |
| 4. Forecast empty state | Blank page when no data — looks broken | 30 min |
| 5. Sync status visible | "Last synced: today 06:14" in sidebar | 1 hr |
| 6. Onboarding completion state | "Setting up your data..." on dashboard | 1 hr |
| 7. Wire Stripe billing | Checkout → webhook → plan activation | 4 hrs |

### Clean up (Phase 4)
| Item | Description | Est. |
|------|-------------|------|
| Delete beta, changelog, notebook pages | Half-built, not linked, drift and break | 15 min |
| Delete VAT, revenue-split pages | No customer has asked for them | 15 min |
| Delete orphaned API routes | /documents, /pos-connections, /supplier-mappings, /chat | 15 min |
| Fix or disable weekly digest cron | Failing silently every Monday | 30 min |

### AI cost control
| Item | Description | Est. |
|------|-------------|------|
| 25. Enforce AI query limits at API level | Daily counter per org, block at plan limit | 2 hrs |
| 26. AI add-on upsell (+299 kr/mo) | Heavy users upgrade — 82% margin on upsell | 3 hrs |

---

## Session 7 — Planned

| Item | Description | Est. |
|------|-------------|------|
| 8. Public landing page | No marketing page exists — just a login screen | 4 hrs |
| 9. Sentry error monitoring | Know about issues before customers do | 2 hrs |
| 10. Fix sync timeout | Chunked backfill — one month per call | 3 hrs |
| 11. Contextual AI on every page | "Ask AI" button on staff, tracker, dashboard | 3 hrs |
| 12. Rename /covers → /revenue | "Covers" is wrong term for this page | 30 min |
| 13. Mobile dashboard, staff, tracker | KPI cards must stack on phones | 3 hrs |
| 14. Schema migrations log | MIGRATIONS.md — record every SQL change | 2 hrs |

---

## Session 8+ — Blocked / Scale

### Blocked on external dependency
| Item | Blocker | When |
|------|---------|------|
| Fortnox OAuth | Developer account approval pending | When approved |
| POS adapter | Need to know which POS next customer uses | When known |
| Weekly digest email | Resend domain not verified | When verified |

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

## AI Agents — full spec in claude_code_agents_prompt.md

| Agent | Schedule | Plan | Build effort | Status |
|-------|----------|------|-------------|--------|
| Anomaly detection | Nightly 06:00 | All | 3 hrs | Skeleton exists — complete it |
| Onboarding success | On first sync | All | 2 hrs | Build in Session 7 |
| Monday briefing | Monday 07:00 | Pro+ | 4 hrs | Build in Session 7 (needs Resend) |
| Forecast calibration | 1st of month | Pro+ | 4 hrs | Build in Session 8 |
| Supplier price creep | 1st of month | Pro+ | 3 hrs | Build after Fortnox connected |
| Scheduling optimisation | Weekly | Group | 6 hrs | Build after 6 months live data |

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

*Last updated: Session 6 start — 2026-04-11*
*Next action: Items 1–7 + Phase 4 cleanup + items 25–26*
