# Claude Code — Mobile Phase 1: Responsive SYSTEM (primitives + guardrails) + Banner + Overview

## Purpose

Mobile is broken (screenshots reviewed). But the goal isn't just to fix these pages — it's to build a **responsive system** so that **every future page works on mobile/tablet automatically, without anyone remembering to make it responsive.** Mobile broke because pages were built desktop-first with hand-rolled fixed-width layouts and responsiveness applied unevenly. The fix is to make responsiveness a **property of the building blocks**, not a per-page afterthought.

This is Phase 1 of a phased overhaul. It delivers: (a) the responsive *system* (primitives + breakpoint tiers + guardrails + convention), (b) the global banner fix, (c) Overview rebuilt as the first consumer of the system. The hard surfaces (scheduling grid, recipe editor) are PLANNED here, built in later phases — and each will *contribute a primitive* rather than being a one-off.

Read `/mnt/skills/public/frontend-design/SKILL.md` first. Locked lavender tokens `UXP.*`/`Z.*`, palette `#f1eff9`/`#fff`/lavender, Swedish formatting, no new libraries. Feature branch + preview, no prod deploy without review.

## What's broken (from screenshots)
1. **Global sync banner overlaps/unreadable on EVERY screen** ("FORTNOX SYNCING · Invoice scanner · Matching products · …" stacked on itself). One component, breaks everywhere. Highest priority.
2. **Dense surfaces show DESKTOP layout squeezed into phone width** — Overview (card grid + chart), P&L (wide table), Scheduling (2D matrix), Recipe editor (dense table).
3. **Some surfaces already work on mobile** — Alerts, Invoices, Scheduling summary cards. The patterns exist; extract and formalise them into the system.

## Step 0 — Investigate (READ-ONLY)
1. Is there any responsive/breakpoint system today, or fixed-width desktop? How do the surfaces that DO work on mobile achieve it? Extract the reusable pattern.
2. Banner root cause — why does it overlap (absolute stacking? non-rotating ticker? fixed widths colliding?).
3. Per dense surface (Overview, P&L, Scheduling grid, Recipe editor): how laid out, what breaks at phone width, and is it a simple-stack or a needs-rethought-interaction case.
Report before building.

## Step 1 — Build the responsive SYSTEM (the core of this phase — "automatic for future pages")

This is the part that makes future pages work without per-page effort. Build:

### 1a. Three-tier breakpoints
A documented breakpoint convention with a real **tablet** tier — mobile / tablet / desktop. Tablet is NOT "small desktop" or "big phone"; it's the middle (often 2-col where phone is 1-col and desktop is 3–4-col). Bake all three in now (annoying to retrofit later). Expose as tokens/constants so every primitive and page references the same tiers.

### 1b. Responsive-by-construction layout primitives
A small set of shared layout components that are responsive INTERNALLY, so a page built from them inherits responsiveness for free (the developer never writes a media query):
- `<PageContainer>` — consistent page padding/max-width, mobile-safe.
- `<CardGrid>` — auto-collapses multi-column → tablet 2-col → mobile 1-col at the tiers.
- `<MetricCardRow>` — the dashboard KPI row; single-column on mobile.
- `<DataTable>` (the high-value one) — a table that switches to **card-per-row** on mobile/tablet instead of squeezing/overflowing. This one primitive will later fix the recipe-editor ingredient table AND any future table for free.
- Whatever else the working surfaces reveal as a recurring layout need.

Extract these from how the WORKING surfaces already do it — formalise the existing pattern into reusable components; don't invent a new framework.

### 1c. Regression guardrail (make breaks LOUD, not silent)
You can't make a non-responsive page impossible, but you can make breaks visible before merge. Add at least one of:
- A lint/check flagging fixed pixel widths above a threshold in page components (nudges toward primitives), AND/OR
- A visual check that renders key pages at mobile/tablet/desktop widths so a layout break shows up in review.
Same principle as the fail-fast silent-null fix: can't prevent every mistake, but make it scream instead of shipping quietly.

### 1d. Convention doc
A short `docs/LAYOUT.md`: the three tiers, the primitives and when to use each, the rule "build pages FROM the primitives, don't hand-roll fixed-width layout," and how the guardrail works. So future-you and Claude Code reach for the system by default.

## Step 2 — Fix the global banner
Fix the sync banner to render cleanly (single readable line or clean rotating/collapsing status, "Hide" working) at all three tiers. Improves every screen at once.

## Step 3 — Rebuild Overview as the FIRST consumer of the system
Make Overview mobile/tablet-responsive **by building it from the Step 1 primitives** (not bespoke layout — it must prove the system works):
- Metric cards via `<MetricCardRow>`/`<CardGrid>` → single-column mobile, 2-col tablet.
- Revenue/labour chart mobile-readable (shrink/simplify/scroll).
- "What needs attention" + demand-outlook single-column on mobile.
- Layout only — all numbers + honest-incomplete states unchanged.
Overview being built from the primitives is the proof the system delivers "automatic responsiveness."

## Step 4 — Phased plan for remaining surfaces (PLAN, don't build)
For each, note simple-breakpoint vs interaction-redesign, which primitive it uses or contributes, and rough effort:
- **Scheduling grid** (2D matrix — rethought interaction: one-day or per-staff view; contributes a responsive-grid primitive). Owner mobile-critical.
- **Recipe editor** (dense table — uses/contributes the `<DataTable>` card-per-row primitive). Owner mobile-critical.
- **P&L** (wide table — likely `<DataTable>`). 
- **Items + rest** — sweep-to-usable via primitives.
Effort sizing so we know if grid/editor are a day or a week each before committing.

## Hard rules
- The SYSTEM (primitives + tiers + guardrail + doc) is the deliverable, not just fixed pages — that's what makes future pages automatic.
- Three tiers including a real tablet tier, baked in now.
- Overview (and every later surface) built FROM the primitives, not bespoke layout — enforce this.
- Formalise the EXISTING working pattern; no new framework, no new libraries.
- Layout/responsive only — no data/cost/logic changes; all numbers + honest-incomplete states identical.
- Read frontend-design SKILL.md; locked lavender tokens; Swedish formatting.
- Feature branch + preview; verify at all three widths before merge.

## Deliverable
Step 0 findings. Then: the responsive system (3-tier breakpoints + primitives + regression guardrail + `docs/LAYOUT.md`), banner fixed, Overview rebuilt from the primitives — feature branch + preview. Plus the Step 4 phased plan with effort sizing.

Three-line chat summary:
1. The system shipped — the primitives + 3 tiers + guardrail + convention doc, such that a NEW page built from them is responsive automatically (state how that's now enforced/encouraged);
2. Banner renders cleanly at all tiers + Overview rebuilt from the primitives reads correctly on mobile/tablet (numbers unchanged);
3. Phased plan — Scheduling grid + Recipe editor: simple-breakpoint or interaction-redesign, which primitive each uses/contributes, rough effort, so we sequence the next phases.
