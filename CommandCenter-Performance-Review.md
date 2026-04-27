# CommandCenter — Performance Review
> 2026-04-26 · Based on the snapshot zip · Findings ranked by impact.

## TL;DR — biggest wins, in order

1. **Add indexes to `revenue_logs` and `staff_logs`.** They have *zero* indexes in any tracked migration. The dashboard's `/api/departments` call paginates through full table scans of both. This is the #1 perf gap. ~10× speedup on the heaviest endpoint, takes 5 minutes to fix.
2. **Cache `auth.getUser` for ~30s.** Every API request makes a Supabase auth network call (~80–150ms). The dashboard fires 5 API calls in parallel on every load → that's 5× the auth cost. A 30-second in-memory cache keyed on the access token cuts dashboard cold-load by ~400ms.
3. **Pre-aggregate `/api/departments` like you did `daily_metrics`.** It pulls every revenue and staff row in the date range and aggregates in Node. At 50 customers × 2 restaurants × 365 days that's 36k rows per call. Push the aggregation into Postgres via a materialised view or a per-(business, month) summary table.
4. **Code-split the dashboard.** It's 813 lines of client-side React + 1453-line `financials/performance/page.tsx` + 717-line `tracker/page.tsx`, all loaded eagerly. Move heavy components behind `next/dynamic`. Cuts initial JS by 30–40%.
5. **Make pages server components where possible.** 37 of 40 pages are `'use client'`. That means every authenticated page does a roundtrip-after-hydration to fetch its data, when it could ship pre-rendered HTML. Single biggest perceived-speed improvement.

Ranked details below.

---

## #1 — `revenue_logs` and `staff_logs` have no indexes (CRITICAL)

**The smoking gun.** I checked every `CREATE INDEX` in `sql/*.sql` and `M*.sql`. There is one on `daily_metrics`, one on `dept_metrics`, one on `monthly_metrics` — but **none on `revenue_logs` or `staff_logs`**, which are the heavy-read tables behind `/api/departments`.

The route does this on every dashboard load:
```ts
db.from('revenue_logs')
  .select('revenue_date, provider, revenue, covers')
  .eq('org_id', auth.orgId)
  .gte('revenue_date', dateFrom)
  .in('provider', allRevProviders)
```
With no index on `(org_id, revenue_date)` or `(org_id, business_id, revenue_date)`, Postgres seq-scans the whole table. Same for `staff_logs.shift_date`.

Today (2 customers) the tables are tiny so it's invisible. At 50 customers with a year of data, this becomes the single slowest query in the system.

**Fix — add this as M034:**
```sql
CREATE INDEX IF NOT EXISTS idx_revenue_logs_org_biz_date
  ON revenue_logs (org_id, business_id, revenue_date);

CREATE INDEX IF NOT EXISTS idx_revenue_logs_org_provider_date
  ON revenue_logs (org_id, provider, revenue_date);

CREATE INDEX IF NOT EXISTS idx_staff_logs_org_biz_date
  ON staff_logs (org_id, business_id, shift_date);

CREATE INDEX IF NOT EXISTS idx_staff_logs_org_group_date
  ON staff_logs (org_id, staff_group, shift_date);
```
Apply with `CREATE INDEX CONCURRENTLY` in production to avoid table locks.

5 minutes of work. ~10× speedup on `/api/departments`.

---

## #2 — `getRequestAuth` calls Supabase auth on every API request

`lib/supabase/server.ts:105` does `await adminDb.auth.getUser(accessToken)` on *every* call to `getRequestAuth`. That's a network round-trip to Supabase auth (~80–150ms p50, often 200ms+).

The dashboard fires 5 parallel API calls on initial load (`businesses`, `metrics/daily` ×2, `departments`, `alerts`). Each one does its own auth call. Even though they're parallel, you're saturating the auth path with redundant work.

**Two-line fix (in-process LRU cache):**
```ts
// lib/supabase/server.ts
const authCache = new Map<string, { value: AuthContext; expires: number }>()
const TTL_MS = 30_000

// inside getRequestAuth, after extractAccessToken:
const cached = authCache.get(accessToken)
if (cached && cached.expires > Date.now()) return cached.value

// ...existing auth + membership lookup...

authCache.set(accessToken, { value: result, expires: Date.now() + TTL_MS })
// Eviction: prune anything past TTL whenever cache > 1000 entries
if (authCache.size > 1000) {
  const now = Date.now()
  for (const [k, v] of authCache) if (v.expires < now) authCache.delete(k)
}
```
Caveats:
- 30s TTL means a logout-then-relogin within 30s won't immediately re-fetch. For a B2B app that's fine — you're not optimising for shared devices.
- Each Vercel function instance has its own cache, but that's actually correct: cache hit rate is high *within* a single user's burst, which is exactly when it matters.
- Don't push the cache to Redis. The whole point is "no network call." Redis would just shift the network call.

Expected: dashboard cold-load drops ~300–500ms. Subsequent navigations within 30s drop ~100ms each.

---

## #3 — `/api/departments` aggregates in Node what should aggregate in Postgres

`app/api/departments/route.ts` reads two tables in full (paginated to be safe — a sign this used to crash), then loops through every row in JS to build dept totals + monthly trend + per-staff breakdown.

Today: ~5k rows per call. Fine.
At 50 customers × 2 years of history: 200k+ rows, and you're shipping all of them from Postgres → Node → discarding 90% of the fields. That's bandwidth, memory, and CPU all wasted.

**Fix:** pre-aggregate during the existing sync flow into a `dept_daily_metrics` table:
```sql
CREATE TABLE IF NOT EXISTS dept_daily_metrics (
  org_id          UUID NOT NULL,
  business_id     UUID NOT NULL,
  date            DATE NOT NULL,
  dept_name       TEXT NOT NULL,
  revenue         NUMERIC(12,2) NOT NULL DEFAULT 0,
  covers          INT NOT NULL DEFAULT 0,
  staff_cost      NUMERIC(12,2) NOT NULL DEFAULT 0,
  estimated_salary NUMERIC(12,2) NOT NULL DEFAULT 0,
  hours           NUMERIC(8,2) NOT NULL DEFAULT 0,
  shifts          INT NOT NULL DEFAULT 0,
  ob_supplement   NUMERIC(10,2) NOT NULL DEFAULT 0,
  late_shifts     INT NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, business_id, date, dept_name)
);
CREATE INDEX idx_dept_daily_org_biz_date
  ON dept_daily_metrics (org_id, business_id, date);
```

Then `/api/departments` becomes a single `SELECT … GROUP BY dept_name` instead of a paginated full-table scan + JS aggregation. Per-staff breakdown stays as a fallback query, but only when the dept detail panel is expanded — not on every dashboard load.

Two-day refactor, but it removes the dashboard's heaviest call from the hot path.

---

## #4 — Bundle size & code splitting

You have **zero** uses of `next/dynamic` anywhere in the app. Every authenticated page loads its full component tree eagerly.

The biggest pages:
- `app/financials/performance/page.tsx` — 1453 lines
- `app/dashboard/page.tsx` — 813 lines
- `app/tracker/page.tsx` — 717 lines

These pages have huge components most users won't see on initial render — modals, expandable detail panels, charts that scroll into view, AI ask-bar.

**What to dynamic-import:**
- `AskAI` — only renders when the user clicks. Currently bundled into every authenticated page.
- Detail-panel components in dashboard/tracker (the expanded dept view, staff drilldown).
- Any modals (Settings → Targets, Upload, etc).

```tsx
// before
import AskAI from '@/components/AskAI'

// after
import dynamic from 'next/dynamic'
const AskAI = dynamic(() => import('@/components/AskAI'), { ssr: false })
```

Run `ANALYZE=true npm run build` (after adding `@next/bundle-analyzer`) — you'll see exactly which chunks are heavy. I'd bet good money the AI components and the chart-heavy financials page dominate.

---

## #5 — 37 of 40 pages are `'use client'` when they don't need to be

This is the single biggest perceived-speed improvement available, and the biggest refactor.

Today's flow on visiting `/dashboard`:
1. Browser requests page → server returns nearly-empty HTML shell + JS bundle
2. JS hydrates → React mounts AppShell + Dashboard
3. Dashboard mounts → `useEffect` fires → fetches `/api/businesses`
4. That resolves → another `useEffect` fires → fetches metrics, departments, alerts
5. *Now* there's data to render. Total: 1.5–3 seconds of nothing useful on a cold load.

In a server-component world:
1. Browser requests page → server fetches data server-side → returns rendered HTML
2. JS hydrates only the interactive parts
3. The user sees content immediately. Total: 300–600ms.

**The realistic path forward:**
- Make pages server components by default; promote interactive bits to client components.
- Pages that are mostly static reports (`/financials/performance`, `/budget`, `/forecast`, parts of `/dashboard`) become server components doing direct Supabase queries with the request cookies. No `/api/me/*` round trip needed.
- Pages that are genuinely interactive (the AI notebook, scheduling drag/drop) stay client components.

This is the route-group / SSR-auth refactor I deferred to "Sprint 3" in the review. Realistic estimate: 3–5 days, biggest perf win on the list.

---

## #6 — Smaller wins worth picking up

### 6a. The `daily_metrics` `.gte()` boundary bug forces in-memory filtering
`/api/metrics/daily` has the comment:
> *Same .gte().lte() Supabase/PostgREST bug as in lib/sync/aggregate.ts — the chained upper bound silently drops rows at the top of the range. Fetch with .gte() only, then filter in memory so the response still honours the `to` parameter.*

I'd push back on this. PostgREST does support both bounds; the bug is more likely in the date-string format. Either way, fetching extra rows and filtering in memory means the query plan doesn't get a range condition for the upper bound — so it can't use a covering index efficiently. Worth re-investigating with explain-analyze before perpetuating the workaround.

### 6b. `/api/businesses` and `/api/me/*` are called on every page
`AppShell` mounts on every navigation. `BackgroundSync`, `AiUsageBanner`, and the dashboard each call `/api/me/usage`, `/api/me/plan`, or `/api/businesses`. These are stable for minutes-to-hours. Wrap their callers with SWR (you don't have it yet — add it) with a 5-minute `dedupingInterval`. One dependency, ~50 lines of refactor, removes ~3 fetches from every page navigation.

### 6c. Browser cache is fully disabled on data fetches
Every dashboard fetch uses `{ cache: 'no-store' }`. The comment explains why — you got bitten by the browser serving stale data after an aggregation. But the right fix isn't no-store; it's `s-maxage=0, max-age=15, stale-while-revalidate=60`. That gives users a 15-second cache (so back-button doesn't refetch) without breaking the "after-aggregation" freshness.

### 6d. `ai_request_log` 24-hour scan (already in the prior review)
Already covered in Task 5 of the original handoff. The RPC fix removes another N×rows scan.

### 6e. `BackgroundSync` triggers `window.location.reload()` on success
`components/BackgroundSync.tsx:43` — when the background sync finds new data, it does a hard page reload. That's a full re-fetch of the JS bundle plus all the API calls. Better: use a state lift / mutate pattern with SWR (when you add it) so just the affected data refreshes. 200–500ms saved every time the sync hits.

### 6f. Sentry on every page
`@sentry/nextjs ^10.48.0` is in deps. Sentry's bundle is ~50KB gzipped on the client. Make sure it's configured with `tunnel` route + `widenClientFileUpload: false` and that the *replay integration* (which can add 100KB+) is off unless you actively need it.

### 6g. `xlsx ^0.18.5` is huge and lazy-loadable
The xlsx library is ~1MB. If it's only used by the export buttons, dynamic-import on click rather than bundle into every page. Same for `docx ^9.5.3` and `pdf-parse`.

### 6h. No `<link rel="preconnect">` for Supabase
Add to `app/layout.tsx`:
```tsx
<link rel="preconnect" href="https://llzmixkrysduztsvmfzi.supabase.co" />
```
Saves the DNS+TLS handshake (~100–200ms) on the first API call after page load.

### 6i. Custom system font stack but no `font-display`
You're using `-apple-system, BlinkMacSystemFont, Segoe UI` — fine, fast, no FOUT. Don't switch to a webfont unless you have a brand reason; if you do, use `next/font` with `display: 'swap'`.

### 6j. No image optimisation usage
0 `<img>` tags AND 0 `next/image` imports. So no images in the app at all? If that's true, ignore. If you've added images since the snapshot, use `next/image`.

---

## What NOT to do

- **Don't add Redis yet.** Adds infra complexity, latency, a failure mode. The in-process auth cache + better indexes handle 90% of the problem.
- **Don't add CDN caching for API responses.** Per-tenant data, hard to invalidate, easy to leak between users.
- **Don't switch to React Server Components everywhere.** You'll break more than you fix. Move incrementally — start with `/budget` and `/forecast` which are the most read-only.
- **Don't add an APM tool (Datadog, New Relic).** Sentry's performance tracing is enough at this scale. Vercel Analytics is free and gives you Core Web Vitals.

---

## Sprint priority for the perf work

If you want to slot this into the existing remediation sprints:

**Quick wins (1 day, do alongside Sprint 1):**
- M034 indexes on `revenue_logs` / `staff_logs` (#1)
- 30-second auth cache (#2)
- preconnect link (#6h)
- dynamic-import xlsx/docx (#6g)

**Sprint 2 (1–2 days):**
- Add SWR, refactor `/api/me/*` and `/api/businesses` callers (#6b)
- Replace `cache: 'no-store'` with proper Cache-Control on data routes (#6c)
- Dynamic-import `AskAI` and modals (#4)

**Sprint 3 (3–5 days):**
- Pre-aggregate `dept_daily_metrics` (#3)
- Promote read-only pages to server components (#5)

The first bullet alone gets you most of the way. Indexes on the two un-indexed hot tables will make today's experience snappier *and* prevent the 50-customer cliff.

---

## How to measure

Before/after, on dashboard cold load (incognito):

```bash
# Vercel Analytics will show this if you have it on
# Otherwise:
curl -w "@curl-format.txt" -o /dev/null -s "https://comandcenter.se/api/departments?business_id=...&from=2026-04-01&to=2026-04-26"
```
Where `curl-format.txt` is:
```
time_namelookup:  %{time_namelookup}s\n
time_connect:     %{time_connect}s\n
time_appconnect:  %{time_appconnect}s\n
time_pretransfer: %{time_pretransfer}s\n
time_starttransfer: %{time_starttransfer}s\n
time_total:       %{time_total}s\n
```

Track three numbers across changes:
1. `/api/departments` p50 response time
2. `/api/metrics/daily` p50 response time
3. Dashboard LCP (Largest Contentful Paint) from Vercel Analytics

If you don't measure it, you can't tell whether a "perf fix" is a perf fix.
