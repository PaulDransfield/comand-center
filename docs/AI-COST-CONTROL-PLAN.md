# AI Cost Control Plan — CommandCenter

> Last updated: 2026-05-07 (§7 cost model refreshed for the 2026-04-23 pricing overhaul; rates and tranche status otherwise unchanged from 2026-04-18)
> Owner: Paul Dransfield
> Status: design in progress. Tranche 1 shipped (data capture, per-request cost, admin endpoint). Tranches 2–4 below.
> **Constraint:** AI usage is the only variable cost CommandCenter carries per customer. Every decision must balance customer convenience, data privacy, operational security, and a hard ceiling on what we spend.

---

## 1. Objective

CommandCenter resells Anthropic Claude inference to restaurant customers as an embedded AI assistant. We charge per-plan (Starter / Pro / Group) plus a Booster add-on. Our gross margin depends entirely on AI cost staying below the per-plan allowance.

**The plan must guarantee four things:**

1. **No customer ever costs us more than their plan covers** — hard ceiling enforced at the API layer, not a back-office hope.
2. **Customers know where they stand** — usage transparency, warnings before blocks, clear upgrade paths.
3. **Customer data is handled lawfully** — minimum data sent to Anthropic, no permanent storage of question text without explicit consent, auditable admin access.
4. **Operators can see and act on risk** — per-customer + global dashboards, alerts when thresholds approach, one-click kill switches.

---

## 2. What's already in place (Tranche 1 — shipped 2026-04-18)

### Data capture
- `ai_request_log` table, one row per Claude call, with: `org_id`, `user_id`, `request_type`, `model`, `tier`, `page`, `question_preview` (first 100 chars), `input_tokens`, `output_tokens`, `total_cost_usd`, `cost_sek`, `duration_ms`, `created_at`.
- `ai_usage_daily` (org-wide counter, gates the plan cap).
- `ai_usage_daily_by_user` (per-user attribution within an org).
- `ai_booster_purchases` (tracks +100/day add-on per billing period).

### Cost primitives
- `lib/ai/cost.ts` — single source of truth for Claude per-model rates + USD→SEK conversion.
- `lib/ai/usage.ts`:
  - `checkAiLimit(db, orgId, plan)` — returns 429 if over cap, `warning` at 80 %, `booster` amount unlocked.
  - `incrementAiUsage(db, orgId)` — org-wide daily counter.
  - `logAiRequest(db, …)` — full audit row + per-user aggregate.
  - `getEffectiveDailyLimit(db, orgId, plan)` — plan base + active Boosters.

### Gates
- Every `/api/ask`, `/api/budgets/generate`, `/api/budgets/analyse` call runs through `checkAiLimit` → 429 if over, then `incrementAiUsage` + `logAiRequest` after a successful Claude response.
- Group plan "unlimited" is capped at 500/day as a safety ceiling.
- Notebook uses the `light` tier (Haiku), saving ~6× vs Sonnet.

### Admin read surface
- `GET /api/admin/ai-usage` (global rollup: top spenders, model mix, Booster revenue).
- `GET /api/admin/ai-usage?org_id=…` (single-org detail: today/week/month, per-user breakdown, last 20 questions, active Boosters).

---

## 3. Gap analysis — what still needs to happen

Ranked by risk to the business.

### P0 — Hard cost ceilings beyond the per-day cap

**Gap:** Per-day cap stops today's spend. But a Starter customer generating 20 high-input queries every day for 30 days is ~$3/month on Haiku — fine. On Sonnet with the rich-context pages (dashboard / tracker / staff), same volume is ~$18/month against a 499 kr plan price (47 USD at 10.5 SEK/USD). Gross margin still positive, but thin.

**Risk:** a token-heavy context (e.g. a massive P&L table) plus verbose Claude output can turn a single Pro-plan query into $0.05. Fifty such queries in a day is $2.50 — still fine, but no ceiling exists to stop a runaway from spiking the monthly bill.

**What we need:**
- **Per-request max_tokens ceiling** — already in place via `MAX_TOKENS` constants. Keep enforcing.
- **Per-context max size** — cap `context.length` at ~6,000 chars before sending to Claude. Larger is truncated with `[context truncated for cost]`.
- **Per-call hard-fail on prohibited models** — never call Sonnet 4.6 from a code path tagged `tier: 'light'`. Already in place.
- **Per-customer monthly cost ceiling** — if this month's `ai_request_log.cost_sek` for an org exceeds `plan.monthly_ai_cost_ceiling` (say 60 kr for Starter, 150 kr Pro, 500 kr Group), gate further calls with a different 429 explaining "monthly cost ceiling reached — please contact support". Prevents the "normal usage pattern" from quietly turning into a loss-making month.
- **Global daily kill-switch** — if total spend across all orgs in the last 24 h exceeds `env.MAX_DAILY_GLOBAL_USD`, every `/api/ask` returns 503 with "AI temporarily paused — please try again shortly". Ops gets paged. Trivial to implement, guarantees we don't bleed through an exploit.

### P0 — Customer-visible usage transparency

**Gap:** The customer has no way to see their AI usage. They hit the cap and get a block with no prior warning.

**What we need:**
- **In-app meter**: small badge in the sidebar ("AI today: 17/50, 33 %") that updates after each call. Fetched once on page load + on every successful AI answer.
- **Warning banner at 80 %**: when `checkAiLimit` returns `warning: { percent: ≥80 }`, the AskAI panel shows a yellow banner: "You've used 80 % of today's AI quota. Upgrade or buy a Booster to keep going." Click-through to `/upgrade`.
- **Block-reason clarity**: when gated, response distinguishes three cases and messages accordingly:
  1. Daily cap reached (no Booster active) — CTA: "Buy AI Booster"
  2. Daily cap reached (Booster active) — CTA: "Upgrade plan"
  3. Monthly cost ceiling reached — CTA: "Contact support"

### P0 — Booster activation

**Gap:** `ai_booster_purchases` table exists but nothing writes to it. Customers can't actually buy the add-on.

**What we need:**
- **Stripe product + price** configured for AI Booster (+299 kr/mo recurring).
- **Stripe webhook handler** for `invoice.paid` with a Booster line item → insert active `ai_booster_purchases` row for the billing period.
- **Stripe webhook handler** for `customer.subscription.updated/deleted` → set `status = cancelled` on active Boosters when the subscription ends.
- **UI entry point**: Upgrade page → "Add AI Booster" button → Stripe Checkout session.

### P1 — Privacy hardening

**Gap:** `question_preview` stores the first 100 characters of every AI question. Could contain sensitive business data (staff names, revenue figures). Stored indefinitely.

**What we need:**
- **Opt-out toggle** per org: `organisations.log_ai_questions boolean default true`. When false, `logAiRequest` passes `question_preview = null`.
- **Default for new orgs**: `true` (we want the data to help debug / improve), but clearly mentioned in privacy policy + a checkbox in onboarding to toggle off.
- **Retention**: add a nightly cron that deletes `ai_request_log` rows older than 365 days. Kept inside EU (Supabase Frankfurt) — no change.
- **Sub-processor disclosure**: already in privacy policy. Confirm Anthropic ZDR is turned on once ComandCenter AB is registered and under DPA.
- **Context sent to Claude**: today we pass aggregate business metrics. We do NOT pass individual staff names or PII to Claude. Verify this at the context-building layer: `lib/ai/buildContext.ts` and `app/notebook/page.tsx` `buildContext()` both must only include aggregated monthly totals, never individual staff rows.

### P1 — Anomaly detection + ops alerting

**Gap:** A customer hitting 10× normal usage, a new exploit, a compromised API key — none of this surfaces until the monthly bill arrives.

**What we need:**
- **Daily ops email** to paul@comandcenter.se summarising: total queries, total SEK spent, any orgs over 2× their moving average, any orgs with 0 queries in the last 7 days (health signal).
- **Realtime alert** when any single org exceeds $10 in a 24 h window, regardless of plan. Runbook: check audit log, contact customer if the pattern looks unusual, throttle if needed.
- **Pattern detection for the future**: pre-compute moving average per org, flag sudden shifts. Not P0.

### P1 — Admin UI surfaces

**Gap:** `/api/admin/ai-usage` exists but no UI consumes it.

**What we need:**
- **`/admin/customers/[orgId]` god-page**: AI Spend widget (today / week / month totals in SEK, per-user breakdown, active Boosters, recent questions table, manual kill-switch).
- **`/admin/health`**: global AI metrics (top spenders, model mix, monthly SEK trend, active-Booster count).
- **`/admin/overview`**: already shows `AI today`. Extend with `AI SEK month-to-date`.

### P2 — Refinements

- **Per-user soft cap**: if one user of a 3-user org consumes 80 % of the daily quota, show a "your team is approaching the limit" banner. Fair-share hint only, not enforced.
- **Historical cost-by-tier reporting** — let admin see the Haiku/Sonnet split so we can tune.
- **Customer DSAR export** includes the customer's own `ai_request_log` rows (subject to the opt-out toggle).

---

## 4. Design decisions (with recommendations)

### Q1. Should `question_preview` be stored at all?

**Options:**
- **A. Never store question text.** Most private. Harder to debug / improve quality.
- **B. Store first 100 chars, configurable opt-out per org.** Current design. Balanced.
- **C. Store full question, configurable opt-out.** Most useful for product, highest privacy burden.

**Recommendation:** B. 100 chars covers enough intent to debug without quoting entire sensitive prompts. Opt-out respects customers who don't want any retention. Default on so we learn from real usage.

### Q2. When monthly cost ceiling hits, what do we do?

**Options:**
- **A. Block with friendly message, ops contacts customer.** Slow but transparent.
- **B. Silent throttle (slower responses, same quality).** Invisible to customer; cheaper.
- **C. Automatic upgrade nudge + block.** Could anger customers who just had a heavy month.

**Recommendation:** A. The ceiling is a safety net; if a customer hits it, we genuinely need to investigate. Block + ops-owns-the-conversation is less scary than silent degradation. Gate clearly labels it as a support case, not a plan issue.

### Q3. Should we cache answers for identical questions within an org?

**Options:**
- **A. Do nothing.** Simplest.
- **B. Cache by (org_id, question_hash, context_hash) for 1 hour.** Up to 30 % cost saving if customers repeatedly ask similar things.
- **C. Aggressive cache + LLM-deduplication.** Complex, maintenance burden.

**Recommendation:** A for now, revisit at 20+ customers. Cache invalidation is a bug source and the savings don't matter until we have volume.

### Q4. Global kill-switch threshold?

**Options:**
- **A. $5/day** — stops all usage past modest costs. Too aggressive — would trip on normal growth.
- **B. $50/day** — covers ~50 customers worth of typical usage with room. Still a hard ceiling at ~$1,500/mo exposure.
- **C. $200/day** — covers 200 customers, rarely triggers.

**Recommendation:** Start at $50/day while we're under 20 customers. Revisit monthly. Configurable via env var `MAX_DAILY_GLOBAL_USD` so we can change without a deploy.

### Q5. Who gets the daily ops email?

**Options:**
- **A. Paul only.** Simplest.
- **B. Paul + a shared ops@comandcenter.se inbox.** Future-proof for when a team joins.
- **C. A Slack webhook.** Noisy but immediate.

**Recommendation:** A for now (one operator), add ops@ once the company registers and we have a shared inbox. Skip Slack until there's a team to read it.

---

## 5. Build order — proposed tranches

### Tranche 2 — Hard ceilings + customer visibility (~6 hours)

**Hours 0–2:** Context size cap + monthly cost ceiling
- `lib/ai/usage.ts` — add `MONTHLY_COST_CEILINGS` per plan, check against sum of `cost_sek` this month.
- `/api/ask` etc. — truncate oversized context before sending.

**Hours 2–4:** Customer usage meter
- New endpoint `GET /api/ai/usage` (customer-facing): returns today's count, limit, warning, Booster status.
- `components/Sidebar.tsx` — AI meter badge.
- `AskAI` component — warning banner when response has `warning`.

**Hours 4–6:** Block messaging + error differentiation
- Gate responses distinguish Booster-eligible / upgrade-only / monthly-ceiling.
- `AiLimitReached.tsx` — three CTA variants.

### Tranche 3 — Booster purchase + admin dashboards (~8 hours)

**Hours 0–3:** Stripe Booster
- Stripe product + price for AI Booster.
- Webhook handler `invoice.paid` / `subscription.*` → `ai_booster_purchases`.
- Upgrade page — "Add AI Booster" button → checkout session.
- Admin god-page shows active Boosters + upcoming renewal.

**Hours 3–6:** Admin AI spend widgets
- `/admin/customers/[orgId]` — AI Spend widget with today/week/month/by-user/recent-questions/Boosters.
- `/admin/health` — top spenders, model mix, SEK trend.
- `/admin/overview` — `AI SEK MTD` stat.

**Hours 6–8:** Global kill-switch
- `MAX_DAILY_GLOBAL_USD` env var.
- `checkAiLimit` checks global total as well; returns 503 if exceeded.
- Admin health page shows live % of global cap used.

### Tranche 4 — Privacy hardening + ops alerting (~4 hours)

**Hours 0–1:** Privacy toggle
- Add `log_ai_questions` column to `organisations` (M014).
- `logAiRequest` respects it.
- Settings page toggle.

**Hours 1–2:** 365-day retention cron
- `/api/cron/ai-log-retention` — deletes `ai_request_log` rows older than 365 days. Runs weekly.
- Added to `vercel.json`.

**Hours 2–4:** Daily ops email
- `/api/cron/ai-daily-report` — runs at 08:00 UTC, sends email to `OPS_EMAIL`.
- Template: total queries today, total SEK today, % of global cap used, top 5 spenders, any org > 2× its 7-day average.

---

## 6. Data model summary (final)

```
ai_request_log                          — one row per Claude call, full audit
  org_id, user_id, request_type, model, tier, page,
  question_preview (nullable, respects opt-out),
  input_tokens, output_tokens,
  total_cost_usd, cost_sek, duration_ms, created_at
  retention: 365 days

ai_usage_daily                          — org-wide daily counter, gates the cap
  (org_id, date) unique, query_count

ai_usage_daily_by_user                  — per-user attribution, admin visibility
  (org_id, user_id, date) unique, query_count, cost_usd, cost_sek

ai_booster_purchases                    — Booster add-ons
  org_id, stripe_invoice_id, period_start, period_end,
  extra_queries_per_day, amount_sek, status (active|cancelled|expired)

organisations
  + log_ai_questions boolean default true    (Tranche 4, M014)
```

---

## 7. Cost model reference (current rates 2026-04)

| Model | Input $/MTok | Output $/MTok | Used for |
|---|---|---|---|
| Haiku 4.5 | 1.00 | 5.00 | Notebook, all background agents |
| Sonnet 4.6 | 3.00 | 15.00 | Dashboard / tracker / staff AskAI, scheduling optimisation |

**USD→SEK:** 11.0 (conservative — real is ~10.5). Update in `lib/ai/cost.ts` when meaningfully off.

**Per-query cost (indicative):**

| Surface | Model | Input tok | Output tok | Cost USD | Cost SEK |
|---|---|---|---|---|---|
| Notebook | Haiku | 700 | 300 | $0.0022 | 0.02 kr |
| Dashboard AskAI | Sonnet | 1 800 | 500 | $0.0129 | 0.14 kr |
| Budget generate | Haiku | 2 000 | 2 000 | $0.0120 | 0.13 kr |
| Scheduling opt (Sonnet) | Sonnet | 2 000 | 400 | $0.0120 | 0.13 kr |

**At plan caps, monthly cost-of-goods per customer** (current pricing — see `lib/stripe/config.ts`):

| Plan | Daily cap | Expected mix | Worst case mix (Sonnet-only) | Plan price | Margin worst case |
|---|---|---|---|---|---|
| Founding | 30 | 2 kr/day = 60 kr/mo | 4 kr/day = 120 kr/mo | 995 kr (24-mo lock) | 88 % |
| Solo | 30 | 2 kr/day = 60 kr/mo | 4 kr/day = 120 kr/mo | 1 995 kr | 94 % |
| Group | 100 | 7 kr/day = 210 kr/mo | 14 kr/day = 420 kr/mo | 4 995 kr | 92 % |
| Chain | 500 safety | 30 kr/day = 900 kr/mo | 70 kr/day = 2 100 kr/mo | 9 995 kr | 79 % |
| Enterprise | unlimited (500 safety) | quoted bespoke | quoted bespoke | bespoke | – |

**Implication:** the 2026-04-23 reprice (Solo 1 995 / Group 4 995 / Chain 9 995) restored healthy margins across every plan, including Chain at the safety cap — the legacy "Group as loss" scenario no longer exists at current prices. Monthly cost ceilings still matter as a runaway-protection backstop, not a margin defence: see `MONTHLY_COST_CEILING_SEK` in `lib/ai/usage.ts` (founding/solo 150, group 500, chain 1 500). Above the ceiling, block with "contact support" until we agree scope.

---

## 8. Privacy / security constraints

- All AI-usage tables are RLS-enabled with default-deny. Only the service-role admin client can read them.
- Admin access to usage is gated by `checkAdminSecret` (timing-safe) + TOTP in production.
- Every admin read of `/api/admin/ai-usage` writes an `admin_audit_log` row.
- No individual customer PII leaves our system. What goes to Anthropic is aggregated business data (monthly totals, labour %, margin). When ZDR is enabled post company-formation, Anthropic doesn't retain prompts or completions at all.
- `question_preview` is 100 chars, opt-out per org, 365-day retention.
- Customer DSAR export (GDPR Art. 15/20) includes their own ai_request_log.
- Customer hard-delete (Art. 17) already cascades into all ai_* tables (verified in the hard-delete tenant-table list).

---

## 9. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Exploited endpoint generates 1 000 AI calls in an hour | Low | High | Global $50/day kill-switch + per-org monthly ceiling |
| Customer legitimately hits cap and churns | Medium | Medium | 80 % warning + clear upgrade path + easy Booster |
| Anthropic rate change mid-month | Medium | Medium | Single source in `lib/ai/cost.ts`; update and redeploy; existing logged rows keep their historical cost |
| SEK/USD moves 10 % | Medium | Low | Conservative 11.0 multiplier; we slightly overestimate cost — good for us |
| `question_preview` leaks sensitive business data | Low | Medium | Opt-out toggle, 365-day retention, never shown outside admin panel |
| Booster cancelled mid-period but kept active | Medium | Low | Stripe webhook handles `subscription.deleted`; nightly reconciliation cron catches misses |
| Admin audit log fills up | Low | Low | 2-year retention was already specified; no action needed |

---

## 10. Testing plan

Before declaring done:

1. Log in as a test org, ask 10 AskAI questions. Verify:
   - 10 rows in `ai_request_log`
   - `ai_usage_daily.query_count` = 10
   - `ai_usage_daily_by_user.query_count` = 10 (for that user)
   - `/admin/customers/[orgId]` shows 10 queries, SEK cost matches sum
2. Hit the daily cap. Verify:
   - 429 response with correct CTA
   - 80 % warning appeared at query 40 (for Pro plan, 50/day)
3. Buy a Booster in Stripe test mode. Verify:
   - `ai_booster_purchases` row created
   - Effective limit = base + 100
   - Active badge on admin god-page
4. Log in as a different org. Verify:
   - Their `/notebook` shows only their business data
   - Their usage counter is independent
   - Admin view for this org excludes the first org's queries
5. Set `MAX_DAILY_GLOBAL_USD=1` env var. Make a single expensive query. Verify:
   - Next query returns 503 kill-switch
   - Admin health page shows 100 %+ of global cap
6. Turn off `log_ai_questions` for an org. Verify:
   - Subsequent queries have `question_preview = null`
   - Prior rows remain as-is (no retroactive scrub — admin-initiated option is a separate feature)

---

## 11. Open questions for Paul

1. **Monthly cost ceilings per plan** — propose Starter 60 kr, Pro 150 kr, Group 500 kr. Confirm.
2. **Global daily kill-switch** — propose $50/day start. Confirm.
3. **`log_ai_questions` default** — propose `true` (with privacy-policy note). Alternative: `false` by default, opt-in. Your call.
4. **Ops email address** — `paul@comandcenter.se` today. Future `ops@comandcenter.se` once AB registered — OK?
5. **Booster price** — confirmed 299 kr/mo for +100/day?
6. **Retention for `ai_request_log`** — propose 365 days. Legal review might prefer 180 days for PII minimisation. Confirm.
7. **UI warning tone** — 80 % banner: soft yellow or urgent orange? I'll build soft yellow unless you say otherwise.
8. **Multiple Boosters at once** — allowed (stack to +200, +300…) or capped at one active?

---

## 12. Definition of done

- Every AI call produces an `ai_request_log` row with accurate token + SEK cost ✅ (Tranche 1)
- No customer can exceed their plan cap or monthly cost ceiling ✅ (Tranche 2)
- No single day across all customers can cost us more than `MAX_DAILY_GLOBAL_USD` ✅ (Tranche 2)
- Customers see their own usage + a warning before they hit the cap ✅ (Tranche 2)
- Customers can self-serve purchase a Booster via Stripe ☐ (blocked on company formation; manual admin activation live)
- Admin can see per-customer + global usage in one click, with SEK cost ✅ (Tranche 3)
- Customer can opt out of question storage ✅ (Tranche 4)
- Old logs auto-delete after 365 days ✅ (Tranche 4)
- Daily ops email summarises usage + flags anomalies ✅ (Tranche 4)
- Tests 1–6 above pass end-to-end ☐

---

*This is the contract we build against. Changes here require a version bump + commit note; changes to the code without updating here are drift.*
