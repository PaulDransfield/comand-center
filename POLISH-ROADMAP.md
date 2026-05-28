# UI Polish Roadmap

> Status: live document · Started 2026-05-28
> Owner: Paul Dransfield · Engineering: Claude

## Why this exists

The product works and the numbers are accurate, but the visual quality lags
the polished SaaS we'd want to be compared to (Linear, Mercury, Stripe
Dashboard, Notion, Vercel, Posthog). The cause isn't any single bug — it's
months of design drift from building pages one at a time without an enforced
design system, plus a few foundational misses (no font smoothing, no shadow /
typography / motion tokens, mixed iconography).

This roadmap takes the **lowest-risk-to-find-out** approach: pilot a complete
polish pass on one page — **the dashboard, because it's what every customer
sees first on login** — without changing the layout or features. Then judge
whether the visible payoff is worth doing the rest, before committing to it.

---

## The Pilot — Dashboard polish (no layout changes)

**Scope:** `app/dashboard/page.tsx`. Visual polish only. Everything stays where
it is; every component keeps its data and its position; only the way it's
*rendered* changes.

**What changes**
- Add the missing design tokens to `lib/constants/tokens.ts` (additive, won't
  touch other pages until they opt in): shadow / elevation, typography scale
  for UXP, font-weight constants, motion durations, editorial off-white
  background.
- Refine typography across the dashboard — consistent sizes, weights, and
  letter-spacing; tabular-nums on every numeric value so they line up.
- Hairline borders + subtle shadow elevation on cards instead of just borders.
- Unified spacing scale (consistent paddings, gaps, radii).
- Refined hover and focus states; kill any "mushy" universal transitions
  locally on this page.
- Swap any emoji or text-glyph icons (✎ → ✦ etc.) for SVG icons in a single
  weight (lucide).
- Add `-webkit-font-smoothing: antialiased` so text renders sharply on macOS
  (free win across the app, but the dashboard "shows it off" first).

**What does NOT change**
- The card layout, count, or order.
- Any component's data or logic.
- The lavender brand identity in `UXP`.
- Any other page in the app.

**Success criteria**
After it ships, look at the polished dashboard next to any other page in the
app for a day. The pilot has worked if:
- The dashboard visibly stands apart as more polished, *and*
- The work would clearly compound — meaning what I built on the dashboard is
  the foundation for the rest, not a one-off.

If it works: continue with Phase 1.
If it's marginal: park it and ship features.

**Risk:** low. Worst case we revert one file plus the additive tokens.

---

## Phase 1 — Foundation (only if pilot wins)

About a day's work. Once we've validated the look on the dashboard, the
foundational pieces move out of "dashboard-local" and become app-wide.

- Move font smoothing to `globals.css` so every page benefits.
- Replace the universal `* { transition: ... }` rule with targeted transitions
  on the elements that should actually animate.
- Publish the new UXP tokens (shadow, typography, motion) as canonical — they
  were already additive in the pilot, this just confirms them as the standard
  going forward.
- Adopt **lucide** as the single icon library and start swapping text glyphs /
  emoji in shared chrome (nav, buttons, common cards).

End of Phase 1: every page in the app *feels* a little sharper just from the
foundational changes, before we even touch each page individually.

---

## Phase 2 — High-traffic pages

About a day's polish per page, in priority order — the pages customers spend
the most time on:

1. **Financials / Performance** (`app/financials/performance/page.tsx`)
2. **Scheduling** (`app/scheduling/page.tsx`)
3. **Inventory items + recipes** (`app/inventory/items/page.tsx`, `recipes/page.tsx`)
4. **Overheads review** (`app/overheads/review/page.tsx`)
5. **Reviews** (`app/reviews/page.tsx`)
6. **Tracker / Staff** (whichever the owner spends more time in)

Same rule as the pilot: no layout changes, only visual polish. Each page
inherits the foundation from Phase 1 and gets the same per-card refinement
treatment the dashboard got.

Estimated effort: 1 day per page, so 6 days. In practice probably 2 weeks of
calendar time around other work.

---

## Phase 3 — Long tail

The remaining pages: settings, smaller surfaces, the admin v2 console.
Faster per page (15–30 min each) because they reuse the patterns established
in Phases 1–2.

---

## Phase 4 — Optional: engage a designer

After Phases 1–3, we'll have squeezed everything I can produce as an engineer
applying design discipline. If it's still not where you want it, this is the
point to spend ~30–50k SEK on a real designer for a system pass — a small
mockup library to anchor the brand voice + system, which I then implement.

Most VC-backed SaaS hires a designer once around this stage. Worth saving for
*after* the in-house polish is done so the designer's pass is purely
elevation, not fundamentals.

---

## What this does NOT solve

Be honest about the ceiling here: **a BI app is information-dense by nature.**
Even polished perfectly, a dashboard with 6 KPIs + chart + attention panel
will look denser than a marketing artifact with 3 cards and whitespace. The
correct target is **Linear / Mercury / Stripe Dashboard** — apps that are
*also* dense and *feel* polished. Not airy marketing mockups.

If the dashboard pilot ships and someone says "still doesn't look like the
Claude artifact preview" — that gap is the apples-to-oranges baseline, not a
polish failure.

---

## Brand constraints (must respect throughout)

- **No emojis** anywhere in the UI (owner-explicit preference, 2026-05-25).
  Use small uppercase text labels and SVG icons instead.
- **English default**, Swedish domain terms kept (Revisor, Moms, Resultatrapport,
  BAS-konto, etc.).
- **Lavender palette (UXP) identity preserved** — refinements only, no rebrand.
- **"Management view, not regulated output"** framing untouched.
- **All AI surfaces stay labelled** as AI.

---

## Decision log

| Date | Decision | Why |
|------|----------|-----|
| 2026-05-28 | Pilot on dashboard, no layout changes | First-impression page; lowest-risk way to judge whether full polish pass is worth doing |
