# UX Sweep — Infra Debt

Things the UI now expects (or wants) that aren't yet wired up at the data /
infrastructure layer. Each item is small and self-contained — pick whichever
unlocks the customer story you care about next.

> Last updated: 2026-05-21 — end of the UXP page-by-page rebuild

---

## 1. Reviews page — reply tracking

**Where the UI asks for it:** `/reviews` headline strip now shows
"Replied · Needs reply · Avg response time" KPIs. They are currently rendered
from client-side guesses against the existing `reviews` table (no
`replied_at` / `reply_text` column).

**What's needed:**
- DB column: `reviews.replied_at TIMESTAMPTZ NULL`, `reviews.reply_text TEXT NULL`
- A way to mark a review as replied — manual button + a sync job that pulls
  reply state from Google Reviews if the API exposes it.
- Refresh the KPI computation to use the new columns instead of the placeholder.

**Why it matters:** the SLA-replying KPI is one of the most owner-actionable
signals on the reviews page. Right now the number is essentially placeholder.

---

## 2. Reviews page — AI reply drafting

**Where the UI asks for it:** the recent-reviews list has space for an
"AI reply" popover with a tone-rewrite picker, but the popover is stubbed.

**What's needed:**
- `POST /api/reviews/draft-reply` endpoint — takes the review_id + a tone
  ('warm', 'professional', 'apologetic'), returns a draft reply.
- Uses `lib/ai/models.ts` AGENT model (Haiku 4.5). Token cap ~400.
- Subject to the daily AI quota gate via `checkAndIncrementAiLimit()`.

**Why it matters:** when this lands, the response-time KPI from (1) becomes a
one-click activity instead of a context-switch into the Google dashboard.

---

## 3. Suppliers × BAS account split

**Where the UI asks for it:** `/suppliers` rows currently show a coarse
category derived by keyword heuristic in `/api/suppliers/rollup`. A real
restaurant owner wants to see per-supplier BAS breakdown (food 4010 vs
disposables 4015 vs cleaning 5840 vs alcohol 4011).

**What's needed:**
- Pull per-invoice line items from `/3/supplierinvoices/{number}/rows`
  (Fortnox endpoint — already in scope under `bookkeeping` permission).
- Aggregate per supplier × BAS account, persist or live-fetch with a
  short TTL cache (mirror the `/overheads/review` drilldown cache pattern).
- Surface in the suppliers drawer: instead of one "total spend" number,
  show the top 3 BAS accounts that supplier hits + percentage split.

**Why it matters:** unlocks the "Bestla owes us 70% food + 30% cleaning"
conversation. Today the rollup throws everything into one bucket.

---

## 4. `/financials/performance` per-location columns

**Where the UI asks for it:** the page currently aggregates across the
whole org for the selected period. The owner with multiple locations would
benefit from a per-location column comparison (Vero · Rosali · Bestla).

**What's needed:** either a different `/api/performance/rollup` endpoint
that fans out by `business_id` (returns one row per location instead of one
total row), or a per-biz parallel fetch on the page itself + a new "by
location" toggle next to the existing Week/Month/Quarter/YTD selector.

**Why it matters:** the comparison mental model ("Rosali's labour drift is
fine, Vero's is the problem") is what `/group` already does at the KPI
level — `/performance` should do the same at the P&L line-item level.

---

## 5. `/scheduling` day-details drill

**Where the UI asks for it:** the rebuilt `/scheduling` page replaced the
legacy day-grid with a clean BreakdownTable. The old per-shift modal
(staff name + role + start/end times + hours) is gone.

**What's needed:** add the per-day drill back, but as a UXP side-drawer
(matching `/budget` and `/suppliers`). On click → fetch the Personalkollen
shift detail for that day → render the rota in a clean list.

**Why it matters:** today the owner sees aggregates only. The drill is
where you actually catch "why does Tuesday have 18 hours when only 3 covers
are forecast" — which is the whole point of the page.

---

## 6. Landing page i18n

**Where the UI asks for it:** the landing page (`app/page.tsx`) was rebuilt
verbatim against `commandcenter-landing.html`. Copy is English-only.

**What's needed:**
- Wire `next-intl` into the landing route (it's currently exempt because
  the page is server-rendered at the very edge of the auth boundary).
- Extract every string into `messages/{en,sv}.json` under a `landing` namespace.
- Add a language-selector affordance in the landing nav (the rebuilt nav
  already has the selector — copy needs translating to make it useful).

**Why it matters:** Swedish-language owners hit the marketing page in
English today. Conversion improves dramatically with localised copy on
restaurant-vertical SaaS.

---

## 7. `ux-preview` ugly-data sandbox

**Where the UI asks for it:** `app/ux-preview/page.tsx` still exists as a
designer's sandbox (Phase 6 / 7 era). It uses isolated mocks via
`DemoDataBanner`. No production traffic — safe to keep around or delete.

**Recommendation:** keep it. Costs nothing and is useful for "show me what
this looks like with three months of zeroes" sanity-checks.

---

## 8. Legacy `UX.*` token map removal

**Where the UI asks for it:** after the final sweep, every customer-facing
page reads from `UXP.*`. The legacy `UX.*` map is still exported from
`lib/constants/tokens.ts` because the `/admin/*` surfaces (admin console,
customer-list, OAuth concierge) still use it.

**What's needed:** decide whether to migrate `/admin/*` to UXP (probably
not — admin is a separate aesthetic regime), or rename the legacy map to
something less collision-prone (`ADM` or `UX_ADMIN`) so future grep
auditing is unambiguous.

**Why it matters:** zero — this is housekeeping. Defer until something
else forces a tokens.ts edit.

---

## Out of scope (UI debt, not infra debt)

These are still UI-flavoured items but blocked by product decisions rather
than infrastructure:

- The `/dashboard/day/[date]` drilldown is on UXP tokens but uses the old
  layout. Worth a real rebuild when the page has its design moment.
- `/integrations` page hasn't been touched by the rebuild sweep — it's
  functional but visually inconsistent with the new system. Lowest
  priority because owners hit it once during onboarding then never again.
- `/admin/*` pages are intentionally on the legacy aesthetic regime
  (see item 8 above).
