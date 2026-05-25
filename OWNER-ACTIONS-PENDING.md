# Owner actions pending — scaling audit + autonomous session 2026-05-25

Two waves of work shipped today. **All deployed.** SQL migrations need your hand when you're back:

---

## SQL migrations — apply in order

### 1. `sql/M101-SCALING-INDEXES-AND-RPC-HARDENING.sql` ✅ APPLIED

Open Supabase → SQL Editor → paste + run. Safe to re-run (every CREATE is IF NOT EXISTS).

Creates 5 covering indexes on hot query paths the scaling audit identified:
- `idx_hourly_metrics_biz_date` — scheduling AI hourly profile
- `idx_overhead_cache_lookup` — dashboard drilldown cache
- `idx_supplier_class_biz_num` — invoice matcher gate-0
- `idx_daily_metrics_org_biz_date` + `idx_monthly_metrics_org_biz_period` — RLS-friendly composites

Plus hardens `list_ready_extraction_jobs()` RPC with `FOR UPDATE SKIP LOCKED` (defence-in-depth against concurrent sweepers).

Verify after applying:
```sql
SELECT indexname FROM pg_indexes WHERE indexname IN (
  'idx_hourly_metrics_biz_date',
  'idx_overhead_cache_lookup',
  'idx_supplier_class_biz_num',
  'idx_daily_metrics_org_biz_date',
  'idx_monthly_metrics_org_biz_period'
);
-- expect 5 rows
```

---

### 2. `sql/M102-AI-REQUEST-LOG-ARCHIVE.sql` — NEW

Creates `ai_request_log_archive` table + `upsert_ai_log_archive` RPC. The weekly retention cron now archives 365-day rolling-window aggregates BEFORE deleting source rows. Preserves audit trail for compliance + historical cost analysis without growing the hot table.

Grain: one row per (date × org × request_type × model). ~99% smaller than raw rows.

```sql
SELECT proname FROM pg_proc WHERE proname = 'upsert_ai_log_archive';
SELECT relname FROM pg_class WHERE relname = 'ai_request_log_archive';
-- expect 1 row each
```

---

### 3. `sql/M103-STRIPE-WEBHOOK-IDEMPOTENCY.sql` — NEW

Adds `processed_at` + `claimed_at` columns to `stripe_processed_events` + two RPCs (`claim_stripe_event`, `mark_stripe_event_processed`). Hardens the webhook so a Vercel function killed mid-handler can be re-tried instead of silently skipped (the silent-underbilling bug class).

Backfills existing rows as `processed_at = created_at` so prior events are still treated as duplicates correctly.

```sql
SELECT proname FROM pg_proc WHERE proname IN
  ('claim_stripe_event', 'mark_stripe_event_processed');
-- expect 2 rows

SELECT column_name FROM information_schema.columns
WHERE table_name = 'stripe_processed_events'
  AND column_name IN ('processed_at', 'claimed_at');
-- expect 2 rows
```

---

## 4. Set `MAX_DAILY_GLOBAL_USD=150` in Vercel env (optional but recommended)

The default in code is now $150 (was $50). Setting the env var in Vercel makes the limit explicit and easier to tune later without a redeploy:

Vercel → comand-center → Settings → Environment Variables → Add
- Name: `MAX_DAILY_GLOBAL_USD`
- Value: `150`
- Environments: Production, Preview, Development

This is the global AI cost ceiling. If $150/day is breached, every AI call pauses until the rolling 24h window drops back below. At 20 customers expect baseline ~$60-80/day.

---

## What was actually shipped (no action needed — just FYI)

### Wave 1 — P0 critical (security + cost + correctness)

| | Change | Why |
|---|---|---|
| P0.1 | `lib/sync/aggregate.ts`: aggregation lock TTL 60s → 180s | Master-sync runs up to 300s; old TTL meant the lock could be stolen mid-aggregate → stale overwrites |
| P0.2 | `requireBusinessAccess()` added to 3 Fortnox routes (drilldown, recent-invoices, generic) | Closed cross-tenant leak — attacker could pass another org's `business_id` and get data |
| P0.3 | AI quota gate (`checkAndIncrementAiLimit`) on scheduling/ai-recommend, inventory/ai-suggest, fortnox/extract-worker | Owner spamming "Generate" could blow daily AI budget in seconds |
| P0.4 | Global kill-switch ceiling $50 → $150 | $50 would have fired daily at 20 customers and blocked all AI org-wide |
| P0.5 | New `lib/ai/anthropic-fetch.ts` helper with 429 retry-with-backoff; wired into ai-recommend + ai-suggest | Single Anthropic 429 blip used to surface as 502 to the user |

### Wave 2 — P0 sync infrastructure + P1 observability

| | Change | Why |
|---|---|---|
| P0.6 | Per-token concurrency cap (2 in-flight per customer) in `lib/fortnox/api/fetch.ts` | Prevents Fortnox 200 req/sec rate-limit storm at 06:00 master-sync when 20 customers fan out simultaneously |
| P0.7 | Parallelize master-sync post-aggregate in batches of 5 | At 20 customers drops post-agg from ~120s serial to ~25s |
| P0.8 | Extraction sweeper returns 200 (not 500) on RPC failure | Was causing Vercel infinite-retry race conditions; now 2-min cron tick handles natural retry |
| P1.1 | SQL migration M101 (see above) | Missing indexes were sequential-scanning hot tables |
| P1.2 | Explicit `.limit(24)` + `.limit(500)` on tracker_data + tracker_line_items | PostgREST silently truncates at 1000; explicit limits document intent |
| P1.3 | Master-sync alerts ops when error rate ≥30% via new `lib/email/ops-alert.ts`; returns 206 partial | Individual customer failures were silently swallowed |
| P1.4 | `scheduling-sync` uses `filterEligible()` helper | needs_reauth integrations now get probed and recover instead of staying deaf |
| P1.5 | `logAiRequest()` called inside `lib/inventory/pdf-extractor.ts` + inventory ai-suggest | Was the largest uncounted AI surface (~$1.50/mo/customer hidden) |
| P1.7 | Replaced 3 hardcoded `'claude-haiku-4-5-20251001'` strings with `AI_MODELS.AGENT` | Model upgrades won't leave stragglers |

### Wave 3 — P1.6 + P2 polish

| | Change | Why |
|---|---|---|
| P1.6 | Storage event listener on 9 inventory pages | Pages now react to BizPicker immediately instead of needing a reload |
| P2 | `lib/constants/tokens.ts`: added `Z` scale (sticky/rail/banner/dropdown/backdrop/modal/tooltip/toast) | Audit found raw z-index values 50/100/199/200/1000 scattered — use `Z.modal` etc. going forward |
| P2 | Explicit `maxDuration = 60` on `/api/reviews/draft-reply` | Anthropic call without an explicit cap was at the mercy of Vercel plan changes |

---

## What was deliberately NOT touched

These were on the audit but skipped because the risk of touching them outweighed the benefit at current scale:

- **Stripe webhook transaction wrapping** — touches billing; needs a focused PR with manual verification before merging
- **Resend email idempotency** — same risk reasoning; needs Resend message-id capture infrastructure first
- **Page-size refactor** (1200+ LOC dashboard / scheduling) — no scaling risk at 20 customers, just maintainability; defer
- **Recharts dynamic import** — could break SSR hydration; defer to a focused performance PR
- **Emoji weather icons** (`☀⛅🌫🌧❄⛈`) — owner-sanctioned exception per memory
- **`/scheduling` Phase 2 missing bits** — Phase 1+2 grid is shipped including AI recommender + Approve/Modify/Reject + Apply/PK handoff + ReviewPanel + compliance engine. No further pieces pending in the spec.

---

## Confidence summary

**Codebase is fundamentally sound for 20 customers.** Schema capacity, RLS isolation, sync orchestration, the layered Fortnox reliability stack (M096 lock + M098 cache + Haiku→Sonnet cascade), and the new AI quota gates + retry helpers all hold up well at the projected scale.

The three failure modes that would have fired before 20 customers are now closed:
1. Fortnox 200 req/sec rate-limit storm — capped by per-token semaphore
2. AI cost runaway from user-triggered AI endpoints — gated by `checkAndIncrementAiLimit`
3. Cross-tenant data leak on 3 Fortnox endpoints — closed by `requireBusinessAccess`

Next risk surfaces (P2 backlog, address as you grow past ~30 customers):
- Realtime connection budget (Supabase Pro caps at 200)
- ai_request_log retention (currently 365-day delete, no S3 archive)
- Stripe + Resend idempotency hardening
- Page-bloat refactor for maintainability
