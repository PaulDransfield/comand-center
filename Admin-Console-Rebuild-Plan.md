# CLAUDE CODE HANDOFF — Admin Console Rebuild
> Generated 2026-04-26 from a perf review + admin mockup of the same codebase snapshot.
> Companion to: `REVIEW.md`, `PERFORMANCE-REVIEW.md`, `CLAUDE-CODE-HANDOFF.md`, `Sprint1.5-Performance-Quick-Wins.md`.
> Reference design: the customer-detail mockup Paul showed you (see ADMIN-MOCKUP-NOTES.md if attached, else ask).

---

## ⚠️  Read this section before starting anything

**This is not a sprint with quick wins. This is a multi-week migration of the most-used internal tool in the system.**

The current admin (`app/admin/*`) is the one piece of the codebase that Paul personally uses every day to keep the business running. If it breaks, Paul cannot help his own customers, cannot diagnose sync issues, cannot impersonate to debug, cannot apply Fortnox uploads. **Breaking the admin is worse than breaking the dashboard** — customers can wait 5 minutes for a dashboard fix, but Paul going blind to his own system is a real outage.

So this build is governed by three rules that override anything else in this document:

1. **The old admin pages stay live until the new ones replace them feature-for-feature.** Routes are added side-by-side under `app/admin/v2/*`, never by editing existing `app/admin/*` files. Cut-over is the last step, not the first.
2. **Never delete an existing admin API route in this build.** New API routes go under `app/api/admin/v2/*`. Old ones are deprecated, not deleted, until at least 30 days after cut-over.
3. **Every PR is independently shippable.** If PR #4 of 12 is the one Paul lives on for two weeks because PR #5 has a bug, that's fine. The plan is structured so this works.

If you find yourself wanting to "just refactor this one thing in the existing admin to make the new one cleaner" — **stop**. Note it as a follow-up. Do not touch the existing files.

---

## Pre-flight — before writing any code

### 1. Read these files end-to-end:

- `CLAUDE.md` — current state, conventions, auto-push hook, §10b Supabase footguns
- `REVIEW.md` — architectural review (2026-04-26)
- `lib/admin/audit.ts` — the audit infrastructure already exists, you'll extend it
- `lib/admin/require-admin.ts` — the auth pattern every admin API route uses
- `lib/admin/check-secret.ts` — the timing-safe secret check
- `app/admin/customers/[orgId]/page.tsx` — the existing 1444-line god-page. **Read every line.** Take notes on every state variable, every fetch, every action. Your replacement must do everything this page does or you're regressing.

### 2. Inventory before you build

Create `ADMIN-INVENTORY.md` in the repo root. Don't commit it yet — it's your working notes. List:

- **Every existing admin page** (`app/admin/*/page.tsx`), one row per page: file path, what it does in 1 sentence, what API routes it calls, what state it manages, who uses it (Paul daily / Paul rarely / nobody-might-be-dead-code).
- **Every existing admin API route** (`app/api/admin/*/route.ts`), one row per route: file path, HTTP methods, what it does, what tables it reads/writes, whether it calls `recordAdminAction`, whether it uses `requireAdmin` or rolls its own auth.
- **Every action a user can perform from the existing admin** — explicitly enumerate them. Examples: "impersonate user," "force master sync," "extend trial," "edit Fortnox API key," "trigger weather backfill," "reaggregate metrics." This is your acceptance checklist — when the new admin is done, **every action on this list works in the new admin**.

This file is yours alone. Don't push it. But you'll reference it constantly.

### 3. Confirm with Paul before starting

Show Paul this exact message:

> "I've inventoried the existing admin: N pages, M API routes, K distinct actions. Building the new admin will take an estimated X PRs over Y weeks. The plan is non-destructive — old admin stays at /admin/*, new one ships at /admin/v2/*, cut-over is the final PR. I will not delete or edit any existing admin file until cut-over. Confirm to proceed?"

Replace N, M, K with your real counts from the inventory. Don't proceed without explicit approval. If Paul says "just rip it out and replace it," push back politely — explain rule #1 above and why incremental matters here.

---

## Hard constraints — do not violate

In addition to the global constraints (no sign-convention changes, no RLS disable, no destructive SQL, no widening `@ts-nocheck`):

- **Do not edit any file under `app/admin/` (except `app/admin/v2/`) until cut-over.** Read-only.
- **Do not edit any file under `app/api/admin/` (except `app/api/admin/v2/`) until cut-over.** Read-only.
- **Do not delete `lib/admin/audit.ts`, `lib/admin/check-secret.ts`, `lib/admin/require-admin.ts`, `lib/admin/totp.ts`, or `lib/admin/oauth-link.ts`** — extend, don't replace.
- **Do not store admin auth in localStorage.** The existing pattern (`sessionStorage.getItem('admin_auth')`) stays. localStorage persists across browser sessions — if an attacker has a few seconds at Paul's laptop, that's the exposure. sessionStorage clears on tab close. We can revisit later (proper SSR cookie auth) but that is its own project.
- **Every mutation goes through `recordAdminAction` from `lib/admin/audit.ts`.** Read-only routes don't need it. If you add a new action verb, add it to the `ADMIN_ACTIONS` const there.
- **Every dangerous action requires a typed reason field** (free-text) that gets saved into `admin_audit_log.payload.reason`. List of "dangerous" actions: impersonate, hard delete org, revoke all sessions, change plan, issue credit, force-apply Fortnox upload, manually edit tracker_data. The frontend pattern is a modal with a textarea labelled "Why?" and a confirm button that's disabled until the textarea has ≥10 chars.
- **Never break the ADMIN_SECRET → `requireAdmin` chain.** Every `app/api/admin/v2/*/route.ts` route must call `requireAdmin` first. No exceptions.

---

## What the new admin needs to do

Five top-level tabs (existing nav has 5; we keep the count):

1. **Overview** — landing page. "What needs my attention right now?" + business KPIs.
2. **Customers** — list view with filters and saved workflows. Click → customer detail.
3. **Agents** — AI agent operational view: queue, recent runs, kill switches.
4. **Health** — global system health: cron, RLS, migrations, Sentry, Anthropic spend, Stripe.
5. **Audit** — full audit log with filters by actor, action, target, time, impact.

Plus: a sixth tab **Tools** for global one-off operations (backfill weather, run M-verification queries, ad-hoc safe-SQL).

Plus: a customer detail view (`/admin/v2/customers/[orgId]`) that consolidates everything you can do *to one customer* into one screen with a right-rail action drawer. This is the big one — see PR breakdown below.

---

## The PR sequence

Twelve PRs. Each is independently shippable. **Stop after each PR for Paul to review and approve before starting the next.** Ship via the auto-push hook as usual; Paul will deploy/test on Vercel before greenlighting.

I'll give each PR: scope, files touched, acceptance criteria, FIXES.md section, and an explicit "what NOT to do in this PR."

### PR 1 — Foundation: shared admin layout, nav, types, hooks (~half day)

**Scope:** scaffolding only. No new functionality. Build the chassis the rest of the PRs hang off.

**Create:**
- `app/admin/v2/layout.tsx` — shared layout that mounts the new nav and reads `admin_auth` from sessionStorage (existing pattern). Bounces to `/admin/login` if absent. Wraps the page in a max-width container.
- `components/admin/v2/AdminNavV2.tsx` — the new nav with 6 tabs (Overview, Customers, Agents, Health, Audit, Tools). Same visual pattern as existing `AdminNav.tsx` but with the new tab list. Add a "v2" pill badge for the duration of the migration so Paul can tell at a glance which version he's in.
- `components/admin/v2/CommandPalette.tsx` — a stub. Empty modal triggered by ⌘K. Don't wire actual search yet; just prove the keybinding works. Real search is PR 11.
- `lib/admin/v2/types.ts` — shared types: `AdminGuardResult`, `OrgSummary`, `IntegrationSummary`, `HealthProbe`, etc. Pull these from reading the existing routes' shapes; don't invent.
- `lib/admin/v2/api-client.ts` — a thin wrapper around `fetch` that automatically adds the `x-admin-secret` header from sessionStorage and handles 401 → redirect-to-login. Replaces the boilerplate every existing admin page repeats.
- `lib/admin/v2/use-admin-data.ts` — a thin hook (`useAdminData(url)`) over the api-client that handles loading/error/data states. **Do NOT add SWR as a dep yet** — write a vanilla `useEffect`-based hook for now. SWR is its own decision.

**Routes (placeholders only):**
- `app/admin/v2/page.tsx` — redirects to `/admin/v2/overview`.
- `app/admin/v2/overview/page.tsx` — renders `<AdminNavV2 />` and "Coming in PR 2" placeholder.
- Same placeholders for `/customers`, `/agents`, `/health`, `/audit`, `/tools`.

**Do NOT in this PR:**
- Touch any existing `app/admin/*` file
- Add any new API route
- Implement command palette search
- Add any third-party deps

**Acceptance:**
- Visit `/admin/v2/overview` → nav renders, placeholder shows, ⌘K opens an empty modal that closes on Esc.
- `/admin/*` (existing) is completely untouched and works.
- `npx tsc --noEmit` clean.
- `npm run build` passes.

**`FIXES.md §0ab`:** "Scaffolded /admin/v2 surface with shared layout, nav, types, api-client, and command-palette stub. Old /admin/* untouched."

---

### PR 2 — Overview tab (~half day)

**Scope:** the new overview page. "What needs my attention right now?" + business KPIs.

**Two distinct sections:**

1. **Incidents strip** (top of page) — explicit list of "things that need Paul's attention." Each row links to the customer or system page where it's resolved. Categories:
   - Stuck integrations (any integration with `status='error'` or `last_sync_at < now() - 24h` for active orgs)
   - Expired or expiring-within-7d tokens (Fortnox, PK)
   - Customers whose data freshness has decayed (no daily_metrics row in the last 48h despite an active integration)
   - AI cost outliers (any org spending >5× their plan median in the last 24h)
   - Stripe webhook backlog (any `stripe_processed_events` row with `processed_at IS NULL` older than 5 min — once Sprint 1 Task 5's two-phase dedup lands)
   - Pending migrations (read `MIGRATIONS.md` header for "Pending" entries — TODO since this requires file read; if too complex, skip in this PR and add as follow-up)

2. **Business KPIs** (below) — the metrics-style strip the existing `/admin/overview` already shows. Recreate visually but **read from the same `/api/admin/overview` route** that exists today. Don't build a new API for this.

**Files:**
- Edit `app/admin/v2/overview/page.tsx` — full implementation.
- Create `app/api/admin/v2/incidents/route.ts` — new route that returns the incidents list. Use `requireAdmin`. Keep it read-only.
- Create `components/admin/v2/IncidentRow.tsx` — single-row component with severity badge + title + meta + jump link.
- Create `components/admin/v2/KpiStrip.tsx` — reusable stat-card grid; will be reused on customer detail.

**SQL needed:** none. `/api/admin/v2/incidents` queries existing tables (`integrations`, `organisations`, `daily_metrics`, `ai_usage_daily`).

**Do NOT in this PR:**
- Edit `app/admin/overview/page.tsx`
- Add a new `/api/admin/overview/route.ts` (use the existing one for KPIs)
- Add charts — keep it text/numeric

**Acceptance:**
- `/admin/v2/overview` shows incidents strip + KPI strip, both populated from real data.
- Each incident has a working link (customer link goes to `/admin/v2/customers/[orgId]` once that exists; until then, link to old `/admin/customers/[orgId]`).
- Empty incidents state shows "Nothing on fire ✓" or similar.

**`FIXES.md §0ac`:** "Built /admin/v2/overview with new incidents strip + reused KPI data."

---

### PR 3 — Customers list with filters (~half day)

**Scope:** the customers list with filter chips for saved workflows.

**The filter set** (each is a chip the admin can toggle on):
- "Needs attention" (intersection of: stuck integrations OR token expiring 7d OR data stale 48h)
- "Trial ending in 7d" (`plan='trial' AND trial_ends_at < now() + 7d`)
- "High AI usage" (`>50% of plan cap in last 24h`)
- "No login in 30d" (`last_login_at < now() - 30d`)
- "Active subscriptions" (`plan IN ('starter','pro','enterprise')`)

Multiple chips combine with AND. Free-text search box on top filters by org name + owner email.

**Sortable columns:** name, plan, MRR, last activity, health score, created date.

**Files:**
- `app/admin/v2/customers/page.tsx` — the list view.
- `app/api/admin/v2/customers/route.ts` — new route accepting `?filter=needs_attention&filter=trial_ending&search=foo&sort=mrr_desc`. Internally still uses the same tables as `/api/admin/customers` but with the filter logic computed in SQL, not Node.

**Why a new API route here, not reuse?** The existing `/api/admin/customers/route.ts` is 122 lines and returns a fixed shape. Filters and saved-workflow logic deserve their own route — and one of the explicit goals of v2 is to push aggregation into SQL. Don't change the old one; just don't use it from v2.

**Do NOT:**
- Edit `app/admin/customers/page.tsx`
- Try to make filter logic work cross-org via the existing route

**Acceptance:**
- `/admin/v2/customers` lists all orgs.
- Toggling "Needs attention" reduces the list to only orgs with stuck integrations or token issues.
- Free-text search works.
- Each row has a click-through to `/admin/v2/customers/[orgId]` (which is still placeholder until PR 4).

**`FIXES.md §0ad`:** "Built /admin/v2/customers with filter chips for saved support workflows."

---

### PR 4 — Customer detail: layout + first three sub-tabs (~1.5 days)

**This is the big one.** The customer detail view consolidates everything you can do to one customer.

**Scope of THIS PR only:**
- The page layout (main column + right rail).
- Header: org name, plan, business count, owner email, status pills.
- Sub-tab navigation (Snapshot, Integrations, Data, Billing, Users, Sync history, Audit, Danger zone).
- Implement only **Snapshot, Integrations, and Data** sub-tabs in this PR.
- Right rail: Quick actions (impersonate, force sync, reaggregate, memo preview, diagnose pk), Subscription (change plan, extend trial, issue credit), Health probes, Recent admin trail, Danger zone.
- Each right-rail action is a button that opens the appropriate modal — implement only **impersonate, force sync, reaggregate, memo preview** in this PR.

The other sub-tabs (Billing, Users, Sync history, Audit, Danger zone) and right-rail actions (extend trial, issue credit, change plan, danger zone) are PR 5.

**Files:**
- `app/admin/v2/customers/[orgId]/page.tsx` — main page.
- `app/admin/v2/customers/[orgId]/loading.tsx` — skeleton state.
- `components/admin/v2/CustomerHeader.tsx`
- `components/admin/v2/CustomerSubtabs.tsx`
- `components/admin/v2/CustomerSnapshot.tsx` (KPIs, recent uploads)
- `components/admin/v2/CustomerIntegrations.tsx`
- `components/admin/v2/CustomerData.tsx` (data freshness probes, aggregation status)
- `components/admin/v2/RightRail.tsx`
- `components/admin/v2/QuickActionButton.tsx` (with reason-modal wrapper)
- `components/admin/v2/ReasonModal.tsx` — the "Why?" modal for dangerous actions
- API routes `app/api/admin/v2/customers/[orgId]/snapshot|integrations|data/route.ts` — three new routes, each read-only, each returning just the shape its sub-tab needs (no megabyte payloads)

**Reuse for action endpoints:**
- Force sync → existing `/api/admin/sync-log`
- Impersonate → existing `/api/admin/customers/[orgId]/impersonate`
- Reaggregate → existing `/api/admin/reaggregate`
- Memo preview → existing `/api/admin/memo-preview`

**Critical: the impersonate flow in v2 must require a reason.** The existing route already returns a magic link; the v2 frontend should show a `ReasonModal` first, capture the reason, and **POST it as a `reason` field that the existing endpoint can ignore** (it'll be saved to audit log via `recordAdminAction` which is presumably already called there — verify). If the existing endpoint doesn't currently capture reason, leave the endpoint alone and call `recordAdminAction` from a new wrapper route `/api/admin/v2/customers/[orgId]/impersonate/route.ts` that proxies to the old one.

**Do NOT:**
- Edit `app/admin/customers/[orgId]/page.tsx` (the 1444-line god-page)
- Implement Billing, Users, Sync history, Audit, Danger zone sub-tabs (PR 5)
- Implement extend trial, issue credit, change plan modals (PR 5)
- Build the command palette search (PR 11)

**Acceptance:**
- `/admin/v2/customers/[orgId]` loads.
- All three implemented sub-tabs render real data for a real customer.
- All four implemented quick actions work AND write an `admin_audit_log` row with a reason.
- The original `/admin/customers/[orgId]` still works untouched.

**`FIXES.md §0ae`:** "Built /admin/v2/customers/[orgId] layout, header, right rail, Snapshot/Integrations/Data sub-tabs, and 4 quick actions. Old /admin/customers/[orgId] untouched."

---

### PR 5 — Customer detail: remaining sub-tabs + actions (~1 day)

**Scope:** finish customer detail.

- **Billing** sub-tab — Stripe customer ID, subscription status, recent invoices, refund/credit history, link to Stripe portal.
- **Users** sub-tab — list of users in `organisation_members` with role and last login.
- **Sync history** sub-tab — last 50 sync runs across all integrations for this org, paginated.
- **Audit** sub-tab — last 100 `admin_audit_log` rows scoped to this org.
- **Danger zone** sub-tab — hard delete org, revoke all sessions, force-flush all data. All three require the reason modal AND a typed-confirmation step ("Type the org name to confirm").
- **Right-rail actions completed:** extend trial, issue credit, change plan.

**Files:**
- `components/admin/v2/CustomerBilling.tsx`
- `components/admin/v2/CustomerUsers.tsx`
- `components/admin/v2/CustomerSyncHistory.tsx`
- `components/admin/v2/CustomerAudit.tsx`
- `components/admin/v2/CustomerDangerZone.tsx`
- `components/admin/v2/TypedConfirmModal.tsx` — extends `ReasonModal` with a typed-confirmation field
- New API routes for each sub-tab as needed
- A new wrapper route for change-plan, extend-trial, issue-credit if they don't already exist

**Reuse for hard delete:** existing `/api/admin/customers/[orgId]/delete/route.ts`.

**Critical: hard delete must call `recordAdminAction` with `payload.reason` BEFORE the delete runs.** If the audit insert fails the delete must not proceed. (Reverses the existing pattern where audit errors are non-fatal — for hard delete specifically, the audit IS the safety net.)

**Acceptance:**
- All sub-tabs render real data.
- All right-rail actions work.
- Hard delete requires typing the org name. If you start typing then close the modal, the action does NOT fire.

**`FIXES.md §0af`:** "Completed /admin/v2/customers/[orgId] with Billing/Users/Sync/Audit/Danger sub-tabs + extend trial / issue credit / change plan / hard delete actions. All dangerous actions require reason + typed confirmation."

---

### PR 6 — Agents tab (~half day)

**Scope:** AI agents operational view.

- List of all agent definitions (reuse existing `/api/admin/agents`).
- For each agent: enable/disable toggle, last-run status, runs in last 24h, success rate.
- "Currently running" panel: any agent runs in flight right now (poll every 5s).
- "Recent failures" panel: last 20 failed runs across all agents with error messages.
- Per-agent kill switch: a button that sets `agents.is_active = false` and writes audit row.

**Files:**
- `app/admin/v2/agents/page.tsx`
- `app/api/admin/v2/agents/route.ts` (extends what existing agents route does — adds the running/failed panels)

**Do NOT:**
- Edit existing `/api/admin/agents/route.ts`
- Add per-org agent management to this page (that's on the customer detail Audit/Snapshot)

**Acceptance:**
- `/admin/v2/agents` shows agents with their status.
- Toggling an agent off writes an audit log entry.
- Failed runs panel populates from the most recent failures.

**`FIXES.md §0ag`:** "Built /admin/v2/agents with operational views: running/failed panels, per-agent kill switch."

---

### PR 7 — Health tab (~half day)

**Scope:** global system health.

Sections:
- **Crons** — last run status for each Vercel cron (read from a new `cron_run_log` table — see SQL below; falls back to "no data" if not yet populated).
- **Migrations** — read `MIGRATIONS.md`. Show "Pending" count + names.
- **RLS policies** — list of tables with RLS enabled, count of policies per table. Detect anomalies (table with RLS enabled but 0 policies = full lockout).
- **Sentry error rate** — last 24h error count, p50, top error message. Pulled from Sentry API if `SENTRY_AUTH_TOKEN` is set; otherwise show "configure SENTRY_AUTH_TOKEN to enable."
- **Anthropic spend** — yesterday's total, day-before's total, % delta. Reuse `ai_request_log` (assumes M033's `ai_spend_24h_global_usd` RPC has shipped — if not, fall back to a SELECT SUM with index hint).
- **Stripe webhook health** — count of `stripe_processed_events` rows in last 24h, count of any with `processed_at IS NULL` older than 5min (post Sprint 1 Task 5).

**Files:**
- `app/admin/v2/health/page.tsx`
- `app/api/admin/v2/health/route.ts` — combines all the above into one response. May be slow (~500ms); add a 60s in-process cache.

**SQL (M035 if needed):**
```sql
-- Optional — only if you want cron run logging from this PR.
-- Otherwise crons section reads "no data — no logging configured yet."
CREATE TABLE IF NOT EXISTS cron_run_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name     TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT,
  error         TEXT,
  meta          JSONB
);
CREATE INDEX idx_cron_run_log_name_started ON cron_run_log (cron_name, started_at DESC);
```

If you ship the table, also add a tiny helper in `lib/cron/log.ts` that wraps a cron handler and records start/end. Don't yet wire it into existing crons — that's a follow-up.

**Acceptance:**
- `/admin/v2/health` renders all sections with real data (or "not configured" placeholders).
- Pending migrations count matches what's actually in MIGRATIONS.md.
- RLS section flags any anomaly tables.

**`FIXES.md §0ah`:** "Built /admin/v2/health with cron/migrations/RLS/Sentry/Anthropic/Stripe sections + optional cron_run_log table."

---

### PR 8 — Audit tab (~half day)

**Scope:** the audit log explorer.

- Default view: last 200 entries, newest first.
- Filters: by actor, by action verb, by org, by target type, by time range, by impact level.
- Each row: timestamp, actor, action, org name (if applicable), target, payload preview (expandable to full JSON).
- "Today" filter, "This week" filter, "My actions" filter (actor = current admin).
- Export button: download filtered set as CSV. Server-side, paginated.

**Files:**
- `app/admin/v2/audit/page.tsx`
- `app/api/admin/v2/audit/route.ts` — extends what `/api/admin/audit-log` does. Don't edit the old one.

**Pagination:** keyset pagination on `created_at`, not OFFSET. (OFFSET on a 100k-row audit table is a perf cliff.)

**Acceptance:**
- Audit page loads in <1s for 200 rows.
- All filters work.
- CSV export downloads correctly.

**`FIXES.md §0ai`:** "Built /admin/v2/audit with filters, keyset pagination, CSV export."

---

### PR 9 — Tools tab (~half day)

**Scope:** global one-off operations.

- Backfill weather for date range + business
- Trigger enhanced discovery for an org
- Run a specific migration verification query
- Test connection to all three external APIs (Fortnox, PK, Anthropic)
- **Safe SQL runner** — read-only, autocommit-off, statement-level timeout 5s. Pasted query runs against a service-role connection BUT the runner itself rejects any query containing `INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE` (case-insensitive). Output rendered as a table.

**Each tool is a card with: title, short description, input fields, run button.**

**Files:**
- `app/admin/v2/tools/page.tsx`
- `components/admin/v2/ToolCard.tsx`
- `app/api/admin/v2/tools/safe-sql/route.ts` — new, with the SELECT-only enforcement
- For other tools, reuse existing routes (`/api/admin/weather/backfill`, `/api/admin/trigger-enhanced-discovery`, `/api/admin/test-connection`)

**Critical for safe SQL:**
- Reject queries with the dangerous keywords list above.
- Wrap in `BEGIN; SET LOCAL statement_timeout = '5s'; SET LOCAL transaction_read_only = on; <query>; ROLLBACK;` — defence in depth even if the keyword check is bypassed.
- Cap result set at 1000 rows in the response.
- Log every executed query to `admin_audit_log` with action `safe_sql_run`.

**Acceptance:**
- Each tool runs and reports success/failure.
- Safe SQL runner rejects an INSERT statement.
- Safe SQL runner returns rows for a SELECT.
- Statement timeout works (try `SELECT pg_sleep(10)` — should error after 5s).

**`FIXES.md §0aj`:** "Built /admin/v2/tools with backfill weather, discovery trigger, connection tests, safe SQL runner. Read-only enforcement is double-layered (keyword check + read-only transaction)."

---

### PR 10 — Saved investigations / customer notes (~half day)

**Scope:** persist investigation context per customer.

A new section on the customer detail Snapshot tab: "Notes & investigations." Free-text markdown editor with auto-save, scoped to the org. When Paul spends 20 minutes diagnosing a customer issue, he can paste queries + findings + a TODO for next time.

**SQL (M036):**
```sql
CREATE TABLE IF NOT EXISTS admin_org_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  content     TEXT NOT NULL,
  pinned      BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_admin_org_notes_org_pinned ON admin_org_notes (org_id, pinned DESC, updated_at DESC);
ALTER TABLE admin_org_notes ENABLE ROW LEVEL SECURITY;
-- service-role only; no policy needed.
```

**Files:**
- `components/admin/v2/CustomerNotes.tsx` — markdown editor (use `react-textarea-autosize` if you want auto-resize; or just a styled textarea). No need for a fancy markdown renderer in this PR; render with line breaks preserved + simple bold/code parsing.
- `app/api/admin/v2/customers/[orgId]/notes/route.ts` — GET/POST.
- Update `CustomerSnapshot.tsx` from PR 4 to render the notes section.

**Do NOT:**
- Add a full markdown editor library (over-scoped)
- Allow notes on entities other than orgs

**Acceptance:**
- Adding a note saves and re-renders.
- Pinning a note moves it to the top.
- Notes persist across page reloads.

**`FIXES.md §0ak`:** "Added per-customer notes via M036. Surfaced on customer detail Snapshot tab."

---

### PR 11 — Command palette search (~half day)

**Scope:** the ⌘K modal goes from stub to functional.

- ⌘K opens modal with search input.
- Type any of: org name, owner email, business name, integration ID, upload ID, audit-log ID, error message snippet.
- Results group by type. Click → jump to the relevant page.
- Top 10 results across all categories. Server-side search, debounced 200ms.

**Files:**
- Update `components/admin/v2/CommandPalette.tsx`.
- New API route `app/api/admin/v2/search/route.ts`.

**Implementation note:** start with `ILIKE '%query%'` across the relevant tables. If perf is an issue at 50 customers, switch to Postgres `tsvector` later. Don't over-engineer.

**Do NOT:**
- Add a search index dep (Algolia, Meilisearch). Postgres is fine.
- Cache search results client-side. They go stale instantly.

**Acceptance:**
- ⌘K → type "vero" → result includes Vero org. Click → goes to `/admin/v2/customers/[orgId]`.
- ⌘K → type a partial email → result includes any user with that email.
- Closing the palette with Esc works.

**`FIXES.md §0al`:** "Wired command palette search across orgs/users/integrations/uploads/audit."

---

### PR 12 — Cut-over (~half day)

**Scope:** make `/admin` route to `/admin/v2`.

This is the only PR that edits old admin files.

- `app/admin/page.tsx` — change the `router.replace('/admin/overview')` to `router.replace('/admin/v2/overview')`.
- `app/admin/login/page.tsx` — change the post-login redirect destination to `/admin/v2/overview`.
- `components/admin/AdminNav.tsx` — leave the file but mark unused-export header so it's clear it's only there for the old pages (which still exist and still work).
- Add a banner on each old `/admin/*` page (NOT the v2 pages): "Looking for the new admin? You're on the old version. New admin →".
- Update `MIGRATIONS.md` header note explaining the v1/v2 coexistence.

**Do NOT in this PR:**
- Delete any old admin file
- Delete any old admin API route

**Acceptance:**
- Logging into `/admin` lands on `/admin/v2/overview`.
- Old admin URLs still load and show the "new admin" banner.
- All v2 functionality from PRs 2–11 works as expected.

**`FIXES.md §0am`:** "Cut over /admin to /admin/v2. Old /admin/* preserved with banner pointing to new location. No old files deleted; that happens in a separate cleanup PR ≥30 days from now."

---

## After cut-over: 30-day cleanup PR

**Don't include this in the build plan above.** It's a separate task ≥30 days after PR 12.

Once Paul has lived on /admin/v2 for 30 days with no critical regressions, do a cleanup PR that:
- Deletes everything under `app/admin/*` except `app/admin/login/`, `app/admin/page.tsx`, `app/admin/v2/`.
- Deletes everything under `app/api/admin/*` except v2 routes and the still-shared utilities (`auth/`, `2fa-setup/`).
- Renames `app/admin/v2/*` → `app/admin/*`. Updates all imports.
- Single commit, single PR. Easy to revert if anything was missed.

---

## Hard prohibitions across all PRs

- Do not create `localStorage` keys for admin auth.
- Do not skip `requireAdmin` on any new API route.
- Do not skip `recordAdminAction` on any new mutation.
- Do not call AI / Claude from the admin frontend (everything goes via the existing `/api/ask` flow).
- Do not introduce a new state-management library (Redux, Zustand, Jotai). React state + the small `use-admin-data` hook is enough.
- Do not introduce a UI component library (Material, Chakra, Mantine). Keep it CSS-in-JS like the rest of the codebase.
- Do not add Tailwind. Codebase doesn't use it.

## What success looks like

After PR 12:
- Paul logs into `/admin` and lands on the new console.
- Every action he could perform on the old admin works on the new one (validated against the inventory created in pre-flight step 2).
- Every dangerous action requires a reason. Every action writes audit. Audit is searchable.
- ⌘K finds anything across the system.
- The right rail on customer detail is the single tool surface for "do something to this customer."
- Old admin still works for emergencies but is clearly flagged as legacy.

After 30-day cleanup:
- `app/admin/*` is the new admin only. Old code gone.
- One nav, one customer detail page, no diagnostic bolt-on pages. The 1444-line god-page is replaced by a structured tree of focused components.

---

## When stuck

- Action exists in old admin but you can't figure out which API route → grep the old page file, find the fetch call, that's your route.
- New requirement conflicts with existing infrastructure → stop, document the conflict, ask Paul. Don't refactor existing infrastructure to fit the new admin in this build.
- TypeScript fights you → narrow scope, add `// @ts-expect-error <reason>` rather than widening `@ts-nocheck`. Fix in a follow-up.
- Modal/dialog flickering or focus issues → fine to use `<dialog>` element with `showModal()` rather than building from scratch. Native dialogs handle escape, backdrop click, and focus trap correctly.
- Confused about what "right" looks like → re-read the customer-detail mockup discussion in chat. The mockup is the source of truth for visual hierarchy and what lives where.

---

## At the end of each PR

1. `npx tsc --noEmit` — clean (or no worse than baseline).
2. `npm run build` — passes.
3. Update `FIXES.md` with the section noted in the PR.
4. Update `ROADMAP.md` — mark the PR's items complete, surface what's next.
5. Commit message format: `feat(admin-v2): <PR title>` (use `fix` only for bug fixes inside the v2 build).
6. Tell Paul: "PR N complete. Surface added: [list]. Test on Vercel and confirm before I start PR N+1."
7. **Wait** for Paul's go-ahead. Do not chain into the next PR automatically.

Good luck. Read CLAUDE.md, REVIEW.md, and the existing 1444-line god-page before you write a single line.
