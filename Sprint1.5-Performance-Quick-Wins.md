# CLAUDE CODE HANDOFF — Sprint 1.5: Performance quick wins
> Generated 2026-04-26 from a perf review of the same codebase snapshot.
> Companion to `CLAUDE-CODE-HANDOFF.md` (Sprint 1) and `REVIEW.md` / `PERFORMANCE-REVIEW.md`.

---

## Why this exists

Sprint 1 is about correctness and security. This sprint is about speed. They're independent — you can run them in either order, or interleave, but **don't bundle commits across sprints**. Each task here is its own commit referencing its own `FIXES.md` section.

Total effort: ~1 day. Four tasks, all surgical, no big refactors. The bigger perf items (server components migration, pre-aggregating `dept_daily_metrics`, adding SWR) are deferred to their own sprints because they're real refactors and need their own planning.

Expected outcome:
- `/api/departments` p50 drops ~5–10× (depends on data volume).
- Dashboard cold load drops ~300–600ms.
- First paint on logged-in pages improves ~100–200ms.

---

## Pre-flight

1. Read `CLAUDE.md`. Honour every rule, especially the auto-push hook and the §10b Supabase footguns.
2. Read `PERFORMANCE-REVIEW.md` for context on *why* these specific things.
3. Run `npx tsc --noEmit` and capture the baseline error count. After each task, re-run and confirm no regressions.
4. Confirm Sprint 1 is either finished, or you're on a branch that doesn't conflict with it. If Sprint 1's middleware rewrite is in flight, do **not** start Task 6 here until it lands — Task 6 touches `lib/auth/session-cookie.ts` which Sprint 1 creates.

---

## Hard constraints — same as Sprint 1

- Don't change sign conventions, tracker_data writers, or RLS settings.
- Don't widen `@ts-nocheck` — only remove it if explicitly told to.
- Don't run destructive SQL — write the migration file, Paul applies it.
- Don't add Redis. Don't add Datadog/New Relic. Don't add a CDN cache layer for API responses.
- One task = one commit. Don't bundle.

---

## Task 1 — M034 indexes on `revenue_logs` and `staff_logs` [CRITICAL, ~10 min]

**Why:** these are the two heavy-read tables behind `/api/departments` (which the dashboard hits on every load), and they have **zero indexes** in any tracked migration. The route currently does paginated full-table scans of both. Today it's invisible (~5k rows total), but at 50 customers and a year of history this is the slowest query in the system.

I verified by grepping `CREATE INDEX` across `sql/*.sql` and `M*.sql` — there are indexes on `daily_metrics`, `dept_metrics`, `monthly_metrics`, but nothing on `revenue_logs` or `staff_logs`.

**Steps:**

1. Create `M034-PERF-INDEXES.sql` at repo root:

```sql
-- ════════════════════════════════════════════════════════════════════════════
-- M034 · Performance indexes for revenue_logs and staff_logs
-- ════════════════════════════════════════════════════════════════════════════
-- These tables pre-date M008 summary-tables migration so they never had any
-- indexes added. /api/departments paginates through both on every dashboard
-- load. With <10k rows total today the seq scan is invisible; at 50 customers
-- × 2 years of history (~200k+ rows) it becomes the slowest query.
--
-- Two indexes per table: one for the (org_id, business_id, date) hot path
-- used by /api/departments, one for the secondary filter (provider for
-- revenue_logs, staff_group for staff_logs) used by the same route.
--
-- Production note: use CREATE INDEX CONCURRENTLY in the Supabase SQL Editor
-- to avoid an exclusive table lock. CONCURRENTLY can't run inside a
-- transaction block, so each statement must be executed individually if
-- pasting into the editor.
-- ════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS idx_revenue_logs_org_biz_date
  ON revenue_logs (org_id, business_id, revenue_date);

CREATE INDEX IF NOT EXISTS idx_revenue_logs_org_provider_date
  ON revenue_logs (org_id, provider, revenue_date);

CREATE INDEX IF NOT EXISTS idx_staff_logs_org_biz_date
  ON staff_logs (org_id, business_id, shift_date);

CREATE INDEX IF NOT EXISTS idx_staff_logs_org_group_date
  ON staff_logs (org_id, staff_group, shift_date);

-- ── Verification ────────────────────────────────────────────────────────────
-- Run after applying:
--
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE tablename IN ('revenue_logs', 'staff_logs')
--  ORDER BY indexname;
--
-- Should show 4 idx_*_date entries. EXPLAIN ANALYZE on a /api/departments
-- query should show 'Index Scan' instead of 'Seq Scan' on these tables.
```

2. Add an entry to `MIGRATIONS.md` under the "Pending — apply when ready" section, same level of detail as M032/M033 entries. Note the production CONCURRENTLY caveat.

3. **Do not** modify `app/api/departments/route.ts`. The existing paginated query plan picks up the indexes automatically.

4. Add `FIXES.md §0x` with this content (adjust the date if needed):

```markdown
## 0x. revenue_logs and staff_logs had no indexes — full-table scans on every dashboard load (2026-04-26)

**Symptom:** External perf review noted that /api/departments (called on every dashboard load) reads revenue_logs and staff_logs via paginated full-table scans, with no indexes on either table. Invisible today with ~5k total rows but a known cliff at scale (~200k rows at 50 customers × 2yr).

**Root cause:** both tables pre-date the M008 summary-tables migration and were never given an explicit migration. Indexes were added to the new summary tables (daily_metrics, dept_metrics, monthly_metrics) but not retrofitted to the underlying logs.

**Fix:** M034 adds 4 indexes — `(org_id, business_id, date)` and `(org_id, [filter_col], date)` on each table. Filter cols are `provider` for revenue_logs (matches the `.in('provider', ...)` filter) and `staff_group` for staff_logs (matches the `.in('staff_group', deptNames)` filter).

**Why this should hold:** /api/departments has 4 distinct query shapes, all covered by these indexes. New endpoints reading these tables should add their own indexes if they introduce a different query shape — not silently rely on these.

**No code changes. M034 to be applied via Supabase SQL Editor, statement-by-statement, since CREATE INDEX CONCURRENTLY can't run inside a transaction block.**
```

5. Commit message:
```
perf(db): add indexes on revenue_logs and staff_logs hot paths

Both tables had zero indexes despite being read by /api/departments
on every dashboard load. M034 adds 4 indexes covering the route's
4 query shapes.

FIXES.md §0x. Apply via Supabase SQL Editor with CONCURRENTLY.
```

**Acceptance:** `M034-PERF-INDEXES.sql` exists, idempotent. `MIGRATIONS.md` updated. `FIXES.md §0x` written. Tell Paul to apply M034 statement-by-statement (CONCURRENTLY constraint).

---

## Task 2 — In-process auth cache [HIGH, ~30 min]

**Why:** `getRequestAuth` calls `adminDb.auth.getUser(accessToken)` on every request. That's a network round-trip to Supabase auth, ~80–150ms p50. The dashboard fires 5 parallel API calls on cold load — each does this redundantly. Within a single Vercel function instance, all 5 should share one auth lookup.

**Approach:** Module-scoped `Map` keyed on the access token. 30-second TTL. Per-instance only — no Redis, no shared cache. The whole point is "no network call." A different Vercel instance handling a different parallel request will do its own auth call, and that's fine — cache hit rate is high *within* a single user's burst, which is exactly when it matters.

**Important nuances:**
- Cache hits skip the `auth.getUser` call AND the `organisation_members` lookup. Both are cached.
- **`setSentryUser` must run on every request, not just cache misses.** Sentry user attribution is per-request metadata.
- A `null` result (invalid/expired token) **is** cached — for a short TTL — so a flood of invalid requests doesn't repeatedly hammer Supabase. Use a 5-second TTL for nulls vs 30s for valid results.
- The cache is per-process. On Vercel each function instance has its own `Map`. That's correct, not a bug — don't try to "improve" it with Redis.

**Steps:**

### 1. Add the cache to `lib/supabase/server.ts`

After the existing `createAdminClient` function, add:

```ts
// ────────────────────────────────────────────────────────────────────────────
// Auth cache — per-process, in-memory.
//
// Why: every API call resolves auth via getRequestAuth, which calls
// supabase.auth.getUser() (network) and then queries organisation_members.
// On dashboard cold-load 5 parallel API calls hit the same Vercel instance;
// without a cache they each do the same ~120ms lookup. With this cache,
// only the first one pays the cost.
//
// Why no Redis: the goal is "no network call." Redis would just shift the
// network call. Per-instance is correct — bursts share an instance, and
// cross-instance staleness is bounded by the TTL.
//
// Why short null TTL: a flood of invalid tokens shouldn't keep cache-missing
// and re-hitting Supabase. But we don't want to remember "invalid" too long
// in case the user logs in with a brand-new token whose hash collides with
// nothing in the cache anyway (token strings are unique per session).
// ────────────────────────────────────────────────────────────────────────────

type AuthResult = { userId: string; orgId: string; role: string; plan: string }

const AUTH_TTL_OK_MS    = 30_000
const AUTH_TTL_NULL_MS  =  5_000
const AUTH_CACHE_MAX    =  1_000

const authCache = new Map<string, { value: AuthResult | null; expires: number }>()

function authCacheGet(token: string): { hit: true; value: AuthResult | null } | { hit: false } {
  const entry = authCache.get(token)
  if (!entry) return { hit: false }
  if (entry.expires < Date.now()) {
    authCache.delete(token)
    return { hit: false }
  }
  return { hit: true, value: entry.value }
}

function authCacheSet(token: string, value: AuthResult | null) {
  const ttl = value ? AUTH_TTL_OK_MS : AUTH_TTL_NULL_MS
  authCache.set(token, { value, expires: Date.now() + ttl })

  // Bounded eviction — only when the map gets large, prune expired entries.
  // Avoids an O(n) scan on every set call.
  if (authCache.size > AUTH_CACHE_MAX) {
    const now = Date.now()
    for (const [k, v] of authCache) {
      if (v.expires < now) authCache.delete(k)
    }
    // If still oversized after expiry purge, drop the oldest 10% by insertion order
    if (authCache.size > AUTH_CACHE_MAX) {
      const toDrop = Math.floor(AUTH_CACHE_MAX * 0.1)
      let dropped = 0
      for (const k of authCache.keys()) {
        authCache.delete(k)
        if (++dropped >= toDrop) break
      }
    }
  }
}
```

### 2. Refactor `getRequestAuth` to use the cache

Inside `getRequestAuth`, after `accessToken` is resolved (currently around line 102, just before the `createAdminClient()` call), insert the cache lookup:

```ts
    // ── Cache check (Step 2 of getRequestAuth) ─────────────────────────────
    // Cache hit short-circuits the Supabase auth lookup AND the
    // organisation_members query. setSentryUser still runs below.
    const cached = authCacheGet(accessToken)
    if (cached.hit) {
      const result = cached.value
      if (result) {
        try {
          const { setSentryUser } = await import('@/lib/monitoring/sentry')
          setSentryUser({ orgId: result.orgId, userId: result.userId, plan: result.plan })
        } catch { /* non-fatal */ }
      }
      return result
    }

    // Validate and resolve org membership + plan using the admin client
    const adminDb = createAdminClient()
    // ... existing code continues unchanged ...
```

Then, where the function currently builds and returns `result` (lines 118–132), wrap the return so the result is cached:

```ts
    const result = {
      userId: user.id,
      orgId:  (m as any).org_id,
      role:   (m as any).role || 'viewer',
      plan:   org?.plan || 'trial',
    }

    authCacheSet(accessToken, result)   // ← NEW

    // Attach this customer to the current Sentry scope ...
    try {
      const { setSentryUser } = await import('@/lib/monitoring/sentry')
      setSentryUser({ orgId: result.orgId, userId: result.userId, plan: result.plan })
    } catch { /* non-fatal */ }

    return result
```

And in **every** branch that returns `null` (after `if (!user)`, after `if (!m)`, after `if (org && org.is_active === false)`, and inside the outer `catch`), call `authCacheSet(accessToken, null)` before returning — but **only** if `accessToken` is in scope (the outer catch isn't, so skip it there).

### 3. Don't touch `getOrgFromRequest`

`lib/auth/get-org.ts` is the deprecated duplicate (covered in Sprint 1 Task 6). Don't add caching to it; it's getting deleted soon. If you accidentally add the cache there too, you'll create two competing caches.

### 4. Verify

- `npx tsc --noEmit` clean.
- `npm run build` passes.
- Manual test: log in, open dashboard, watch the network tab. The first wave of API calls should each take their normal time. Refresh — second-load API calls should each respond noticeably faster (fewer ~100ms blocks).
- No correctness regression: log out → API calls return 401 (cache TTL on the now-invalid token expires, or `auth.getUser` returns null on the next miss).

### 5. Document

Add `FIXES.md §0y`:

```markdown
## 0y. Every API request did a fresh Supabase auth network call (2026-04-26)

**Symptom:** External perf review noted /api/* endpoints each did a full `auth.getUser(token)` round-trip on every call, ~80–150ms p50. Dashboard cold-load fires 5 parallel API calls — they all paid the auth cost redundantly.

**Fix:** added a per-process Map cache in lib/supabase/server.ts keyed on the access token. 30s TTL for valid results, 5s TTL for nulls (so invalid-token floods don't keep hammering Supabase). Bounded at 1000 entries with O(n) eviction only when the cap is hit.

setSentryUser is called on every request even on cache hits — Sentry user attribution is per-request metadata, not cache-derived.

**Why this should hold:** the cache is per-Vercel-instance. Cross-instance staleness is bounded by TTL. The 30s window is short enough that a logout-then-relogin within 30s is still safe (the new session has a different token, different cache key). No Redis — the goal is to skip network calls, not move them.
```

### 6. Commit

```
perf(auth): add 30s in-process cache to getRequestAuth

Each API request was making a fresh auth.getUser network call (~120ms).
Dashboard cold-load fires 5 parallel requests — the cache lets them
share one lookup. Per-instance, no Redis. Sentry attribution still
runs on every request.

FIXES.md §0y.
```

**Acceptance:** cache implemented, all 5 return paths in `getRequestAuth` are covered (success, no-token, no-user, no-membership, inactive-org), Sentry call still fires on cache hits, no TypeScript errors, build passes.

---

## Task 3 — Preconnect link to Supabase [TRIVIAL, ~2 min]

**Why:** the first API call on page load pays for DNS + TLS handshake to `*.supabase.co`. Adding `<link rel="preconnect">` does the handshake during HTML parse, so the first API call's network time drops by ~100–200ms.

**Steps:**

1. Open `app/layout.tsx`. Inside `<head>`, after the existing `<meta name="viewport">` line, add:

```tsx
<link rel="preconnect" href="https://llzmixkrysduztsvmfzi.supabase.co" />
<link rel="dns-prefetch" href="https://llzmixkrysduztsvmfzi.supabase.co" />
```

The `dns-prefetch` is a fallback for browsers that don't honour preconnect.

2. **Don't** hardcode the project ref like that long-term — but until the broader "derive project ref from `NEXT_PUBLIC_SUPABASE_URL`" cleanup happens elsewhere (see REVIEW.md §2.8), match the existing pattern. The hardcoded value is already in `lib/supabase/server.ts:56` and `app/api/onboarding/setup-request/route.ts:78`, so this is consistent. Note this in `FIXES.md` so future-you remembers to update three places at once when the env-var-derivation refactor happens.

3. Verify: `npm run build` passes. View source on the deployed page — both link tags should be in `<head>`.

4. Add to `FIXES.md §0z`:

```markdown
## 0z. No preconnect to Supabase — first API call paid full TLS handshake (2026-04-26)

**Symptom:** every page load's first API call took an extra ~100–200ms for DNS + TLS handshake to *.supabase.co.

**Fix:** added `<link rel="preconnect">` and `<link rel="dns-prefetch">` to app/layout.tsx pointing at the project's Supabase URL. Browser does the handshake during HTML parse, so the first API call resolves immediately into a warm connection.

**Note:** the URL is hardcoded to match the existing pattern in lib/supabase/server.ts:56 and app/api/onboarding/setup-request/route.ts:78. When the broader project-ref-from-env-var refactor happens (see REVIEW.md §2.8), update all three places.
```

5. Commit:

```
perf(layout): preconnect to Supabase to skip first-call TLS handshake

FIXES.md §0z.
```

**Acceptance:** two link tags in `<head>`, build passes, `FIXES.md §0z` written.

---

## Task 4 — Replace `cache: 'no-store'` with proper Cache-Control [MEDIUM, ~45 min]

**Why:** the dashboard's data fetches all use `{ cache: 'no-store' }`. The comment in `app/dashboard/page.tsx:228–230` explains why: a stale aggregator response was being served from browser cache after a DB update. The fix-with-a-hammer was no-store; the right fix is `Cache-Control: max-age=15, stale-while-revalidate=60` — gives users a 15-second cache (so back-button doesn't refetch the dashboard) while bounding staleness.

This is a small but meaningful win: every back-button navigation, every "open dashboard in a new tab while it's already open in another", every dashboard-to-page-and-back pattern saves 4 API calls × ~100ms each.

**Important constraint:** server-side `Cache-Control` headers don't help here because Next.js with `cache: 'no-store'` on the client side overrides whatever the server says. Both ends need to agree.

**Steps:**

### 1. Pick the routes to change

Only routes that:
- Read user-specific data (so they can't go in a CDN — `private` cache scope)
- Are read on dashboard load (so the speedup is visible)
- Have aggregation freshness lag of ~minutes anyway (so 15s is invisible)

That list: `/api/metrics/daily`, `/api/departments`, `/api/businesses`, `/api/me/usage`, `/api/me/plan`, `/api/alerts`. **Don't** touch `/api/sync/today`, `/api/ask`, `/api/fortnox/*`, `/api/admin/*`, or any POST/PATCH route.

### 2. On the API side

For each of the 6 routes above, add to the response:

```ts
return NextResponse.json(
  payload,
  {
    headers: {
      'Cache-Control': 'private, max-age=15, stale-while-revalidate=60',
    },
  }
)
```

`private` means "browser cache only, never CDN" — important since this is per-user data.

For `/api/departments` specifically, **remove** the existing `'Cache-Control': 'no-store, max-age=0, must-revalidate'` header (it's at the bottom of the route) and replace with the new value.

### 3. On the client side

In `app/dashboard/page.tsx`, find the `noStore` constant (line 231) and remove it. Update all 4 fetch calls that use it:

```ts
// before
const noStore: RequestInit = { cache: 'no-store' }
Promise.all([
  fetch(`/api/metrics/daily?...`, noStore).then(...),
  // ...
])

// after — let the browser honor the API's Cache-Control header
Promise.all([
  fetch(`/api/metrics/daily?...`).then(...),
  // ...
])
```

Same pattern for the `/api/scheduling/ai-suggestion` fetch (line 208) — but **don't** touch that one yet. AI predictions are more sensitive to staleness and that route isn't in the perf-critical list.

Search the rest of the codebase for `cache: 'no-store'`:

```bash
grep -rn "cache: 'no-store'" components/ app/
```

For each occurrence: if it's calling one of the 6 routes above, remove the option. If it's calling something else, leave it alone.

### 4. The aggregator-staleness concern

The original no-store was added because the aggregator updates `daily_metrics` and the browser was serving a pre-update cached response. With 15-second `max-age`, the worst case is: aggregator runs at T=0, user refreshes at T=5, sees pre-update data; user refreshes at T=20, sees post-update data. That's acceptable. The `stale-while-revalidate=60` means even within those 5 seconds, if the user navigates away and back, the browser revalidates in the background.

If Paul reports a recurrence of the original "stale data after aggregation" bug, the fix is to **bust the cache from the aggregator side** by invalidating with a query-param or `Cache-Control: no-cache` response on the next request — not to revert to no-store everywhere.

### 5. Verify

- `npm run build` passes.
- Manually: open dashboard, F12 → Network tab. First load shows `200 OK`. Hit back, then forward — should show `(memory cache)` or `(disk cache)` for the metrics calls. Wait 20 seconds, refresh — should show `200 OK` again.

### 6. Document

Add `FIXES.md §0aa` (using `aa` since `§0z` is the last single-letter):

```markdown
## 0aa. Replaced cache: 'no-store' on dashboard fetches with proper Cache-Control (2026-04-26)

**Symptom:** every dashboard back-button or tab-switch refetched all 4 API calls, ~400ms wasted per navigation.

**Background:** the no-store option was added (see §0X earlier in this file, where X is the original entry — find by grep) because the aggregator was updating daily_metrics and the browser served pre-update cache. The fix-with-a-hammer was no-store; the right fix was bounding cache by Cache-Control.

**Fix:**
- 6 API routes now return `Cache-Control: private, max-age=15, stale-while-revalidate=60`. List: /api/metrics/daily, /api/departments, /api/businesses, /api/me/usage, /api/me/plan, /api/alerts.
- Removed `cache: 'no-store'` from app/dashboard/page.tsx and any other client callers of those 6 routes.
- `private` scope means browser cache only — no CDN, no shared cache. Per-user data stays per-user.
- 15s max-age + 60s SWR means back-button feels instant, while the worst-case staleness window is bounded.

**Why this should hold:** routes that mutate state (POST/PATCH, /api/sync/today, /api/admin/*, /api/fortnox/*) were left at no-store. AI routes (/api/ask, /api/scheduling/ai-suggestion) were also left at no-store because their freshness expectations differ. If aggregator-staleness recurs, fix is to bust cache from the writer side, not to remove this header.
```

7. Commit:

```
perf(api): replace cache: 'no-store' with bounded Cache-Control on read routes

6 dashboard-critical GET routes now return private, max-age=15, swr=60.
Client callers no longer pass cache: 'no-store'. Back-button feels
instant; staleness window bounded to 15s.

POST routes, AI routes, and sync routes unchanged.

FIXES.md §0aa.
```

**Acceptance:** 6 routes return the new header; client `cache: 'no-store'` removed from dashboard (and any other caller of those 6 routes); other no-store usages preserved; build passes.

---

## End-of-sprint checklist

After Tasks 1–4:

1. `npx tsc --noEmit` — no new errors.
2. `npm run build` — passes.
3. **Tell Paul to apply M034 in Supabase**, statement-by-statement (CONCURRENTLY can't run inside a transaction).
4. Update `MIGRATIONS.md` — flip M034 from "Pending" to "Applied" once Paul confirms.
5. Update `CLAUDE.md` invariants block: add a line under "Performance" — "auth cache is 30s in-process; preconnect to Supabase in layout; dashboard read routes use SWR Cache-Control."
6. Final commit: `chore: sprint 1.5 docs`.

## Measuring the result

Before/after, on dashboard cold load (fresh incognito window):

```bash
# Time to first byte on the heaviest endpoint
time curl -s -o /dev/null \
  -H "Cookie: sb-...-auth-token=$TOKEN" \
  "https://comandcenter.se/api/departments?business_id=$BIZ&from=2026-04-01&to=2026-04-26"
```

Expected before: 400–800ms.
Expected after Tasks 1+2: 100–300ms.

If you have Vercel Analytics on, watch the LCP (Largest Contentful Paint) for `/dashboard` over the next few days — should drop ~300–600ms.

## What NOT to do

- **Don't add SWR** in this sprint. It's a meaningful improvement but it's a multi-file refactor of every component that fetches data, and it adds a dependency. Deferred to its own sprint.
- **Don't migrate pages to server components.** Same — that's the big SSR-auth refactor and it deserves real planning.
- **Don't pre-aggregate `dept_daily_metrics`** here. That's a 2-day refactor with its own correctness concerns (sync-flow integration, backfill, projectRollup-style single-writer discipline). Worth doing, not in this sprint.
- **Don't try to "improve" the auth cache by sharing across instances via Redis.** The whole point is no network call. Redis is a network call.

## When done

Tell Paul: "Sprint 1.5 done. M034 needs to be applied — paste each CREATE INDEX statement separately in the Supabase SQL Editor. After that, dashboard cold-load should noticeably improve. Watch /api/departments p50 in the network tab."
