# Removed in the UX Sweep — Recovery Notes

A catalogue of code, components and UI affordances dropped during the
2026-05 UI rebuild on the UXP design system. Anything here can be
recovered from git history — pull the SHA listed against it.

> Scope: commits `cbd0e88..2ac3fac` on the `ux/rebuild-21-settings` branch
> chain (40 commits, May 2026).

---

## A. Deleted files (gone for good unless restored)

### Scheduling (commit `f7a829f`)
- `components/scheduling/AiHoursReductionMap.tsx` — **826 lines**.
  Inline-SVG heatmap showing AI-suggested hour cuts per day-of-week ×
  hour-of-day. Pretty but never the primary affordance owners reached for.
- `components/scheduling/AiSchedulePanel.tsx` — **848 lines**.
  Right-side panel listing every AI recommendation with confidence
  scores + accept/reject controls. The new page has a simpler
  "Apply all" banner.
- `components/scheduling/WeekGridView.tsx` — Day-by-day shift grid
  with per-staff row, per-hour columns. The owner-feedback signal said
  this view was rarely used — the BreakdownTable day list is what
  actually got opened.
- `components/scheduling/RotaDay.tsx` — Single-day sub-component used
  by WeekGridView.
- `components/scheduling/computeWeekStats.ts` — Stats helper for the
  same grid view.

**Recovery use-case:** if owners ask for the per-day shift drill back
(infra-debt item #5), restore `WeekGridView.tsx` or `RotaDay.tsx` as
the starting point for the drawer body — most of the layout maths is
there.

### Admin V1 routes (commit `57ec28d`)
- `app/admin/agents/page.tsx`
- `app/admin/audit/page.tsx`
- `app/admin/customers/page.tsx`
- `app/admin/customers/[orgId]/page.tsx`
- `app/admin/health/page.tsx`
- `app/admin/overview/page.tsx`
- `components/admin/AdminNav.tsx`

All superseded by `/admin/v2/*`. The `/admin/page.tsx` redirect shim is
kept so old bookmarks land at `/admin/v2/overview`. Recovery only
makes sense if `/admin/v2/*` itself loses something — unlikely.

### Shell scaffolding (commits `50d952b`, `57ec28d`)
- `components/ui/AppShellV2.tsx` — predecessor to AppShellUX
- `components/ui/SidebarV2.tsx` — predecessor to RailNav
- `components/shared/MobileBottomNav.tsx` — superseded by `MobileNav`

Recovery use-case: none expected. The new shell + rail covers every
case the old V2 did.

### Dashboard sub-components (folded into `app/dashboard/page.tsx` by `fb3788b`)
These weren't strictly *deleted* — they were inlined into the new
dashboard during the ground-up rebuild. The named cards/widgets:

- `components/dashboard/DashboardHeader.tsx` — old top bar with date
  + business switcher + AI badge. Replaced by `AppShell` toolbar.
- `components/dashboard/WeekScorecardCard.tsx` — Mon–Sun row of mini
  KPIs. Replaced by the 4-card KPI strip.
- `components/dashboard/DemandOutlook.tsx` — original demand-outlook
  block. Recreated inline as 7 horizontal day cards.
- `components/dashboard/WhatHappenedCard.tsx` — past-week narrative
  card. Replaced by `AttentionPanel` items.
- `components/dashboard/WhyThisWeekCard.tsx` — week-comparison
  narrative. Folded into the same Attention card.
- `components/dashboard/CashPositionTile.tsx` — opening-balance tile
  (Fortnox 1xxx accounts). Not currently rendered. **Recovery
  candidate** once live bank feeds ship (see `project_live_bank_feeds_parked` memory).
- `components/dashboard/CashFlowProjectionTile.tsx` — 30/60/90-day
  projection tile based on AP/AR. **Recovery candidate** same trigger.
- `components/dashboard/WeatherDemandWidget.tsx` — weather-correlated
  demand widget. Not rendered. Recovery: tied to whether weather
  signal makes it into the forecast model.
- `components/dashboard/ReviewThemesCard.tsx` — Google review themes
  card. Recreated inline in the new dashboard. Old version had a
  fancier "trend over weeks" mini-chart that was simplified.

### Misc (commit `57ec28d`)
- `components/OverheadReviewCard.tsx` — old single-flag card. The
  rebuilt `/overheads/review` uses `FlagListPane` + `FlagDetailPane`
  instead.

---

## B. Style exports retired (commit `57ec28d`)

From `lib/constants/colors.ts`:

- `KPI_CARD` — old grey-card kpi style object
- `CARD` — generic card style object
- `FONT` — typography helper
- `BTN` — button style object

These were style objects used by ~50 call sites before the rebuild. UXP
moves to inline styles + tokens, so the helper objects are dead.

**Kept** in `colors.ts`: `STATUS`, `DEPT_COLORS`, `DEPT_PALETTE`,
`deptColor`, `deptBg`, `CC_*` brand colours — still consumed.

---

## C. UI affordances dropped from rebuilt pages

These weren't deleted as files but removed from the rebuilt pages.
If owners say "where did X go?" — start here.

### `/dashboard` (commit `fb3788b`, 1688 → 840 lines)
- The Mon–Sun weekday scorecard row at the top (replaced by the
  Demand Outlook horizontal cards).
- The "Compare to last week" toggle pill above the chart (W/M
  segmented toggle replaces it).
- AI-narrative paragraph above the KPI strip (folded into the
  AttentionPanel as one item among several).

### `/staff` (commit `6e7f7e7`, 778 → 580 lines)
- Per-staff "trend over 30 days" sparkline column in the breakdown
  table. Recovery: easy — `<Sparkline>` component still exists.
- "Late minutes" stacked-bar visualisation per staff. The KPI card
  preserves the total, but the per-staff distribution is gone.

### `/revenue` (commit `78e8f8f`, 714 → 620 lines)
- Inline daily revenue inline-edit grid for the whole month.
  Replaced by the covers inline form + Fortnox-canonical totals.
  Recovery: this form is now considered legacy because daily
  revenue should flow from POS/Fortnox, not manual entry.

### `/budget` (commit `104412f`, 967 → 720 lines)
- The "AI thinking explainer" expandable panel on the analyse flow.
  Recovery: easy — the API still returns the explainer payload, the
  drawer just doesn't render it.
- Per-cost-line target sliders. Replaced by edit drawer with raw
  numeric inputs.

### `/forecast` (commit `5ad0d03`, 646 → 430 lines)
- The "explainer" line below each monthly forecast describing why
  the model picked that number. API still returns it; drawer
  doesn't show it. Recovery: easy.
- The +/- 1σ confidence band rendered as a translucent ribbon on
  the chart. Replaced by the `ConfidenceChip` (MAPE-based).
  Recovery: would need to read variance from `forecasts.confidence_*`
  fields and re-add the ribbon to `<PairedBarChart>`.

### `/group` (commit `2732aa5`, 563 → 415 lines)
- Per-location mini-spark chart in each card. The new table is
  flat. Recovery: easy — re-add `<Sparkline>` to the location row.

### `/departments` (commit `37fd22e`, 458 → 525 lines — gained lines)
- The old "department cards grid" hover-card with full P&L preview.
  Replaced by the BreakdownTable with click → detail.

### `/financials/performance` (commit `a62473d`, 1551 → 1404 lines)
- The "per-location columns" view (was experimental, not behind a
  flag). See infra-debt item #4 — replacement spec.
- The cost-mix donut hover tooltip with sub-category drill. The
  donut is preserved but click-drill needs re-adding.

### `/tracker` (commit `c8fb58b`, 721 → 660 lines)
- The full-table monthly grid with all 12 months side-by-side.
  Replaced by per-month rows + click-into-drawer. The grid was
  cleaner for skim-reads. Recovery: keep the side-by-side as a
  printable view option later.

### `/overheads` (commit `943f900`, 846 → 530 lines)
- The "category timeline" mini-chart on each subcategory row.
  Replaced by YoY drift indicator. Recovery: easy — Sparkline exists.

### `/scheduling` (commit `f7a829f`, 984 → 530 lines + 2000 LOC of components removed)
- The 7-day grid view with per-staff row × per-hour column. Already
  on infra-debt item #5 (replacement: per-day drawer).
- The AI hours-reduction heatmap (drop visualisation).
- The accept/reject-per-recommendation panel. The new page has only
  an "Apply all" banner — granular accept/reject is gone.

### `/reviews` (commit `0575b0a`, 910 → 660 lines)
- Per-review reply textarea (was placeholder anyway). See infra-debt
  items #1 and #2 — proper replacement spec.
- "Rating timeline" sparkline next to each platform. Replaced by
  unified `RatingTrendChart`.

### `/alerts` (commit `fd546ea`, 352 → 440 lines — gained)
- The old severity-grouped accordion (Critical / High / Medium / Low
  sections). New page is a flat severity-stripe list. Recovery:
  would need a "group by severity" toggle in the toolbar.

### `/notebook` (commit `1e35c96`)
- The starter-pill row was a flex-row at the bottom; now it's a
  centred wrap-cluster when the thread is empty. Visual only — no
  functionality lost.

### `/overheads/upload` (commit `3732cea`)
- The validation-blocked modal's old "fold" / "unfold" reasoning
  sections. The new modal shows all blocking errors and warnings
  at once. Recovery: easy — `findings` array still exists.

### `/landing` (`app/page.tsx`, commits `011f815` + `a905b16` + `21208b5`)
- The simple original landing page. The new landing is a full port
  of `commandcenter-landing.html` (2-column hero, 8-screen
  auto-cycling product tour, integrations marquee, dark Problem
  card, 9-card platform grid, pricing). The OLD landing was a
  single hero + feature list — easy to find at SHA `cbd0e88^`.

---

## D. PageHero retired from rebuilt pages

`components/ui/PageHero.tsx` still exists and renders correctly, but
all rebuilt pages replaced it with an inline UXP hero block (lavText
eyebrow + ink1 22px display + ink3 12px context).

Pages migrated:
- `/overheads/review`, `/overheads/upload`, `/settings/company`,
  `/notebook` (added new style)

Pages still using PageHero (haven't been touched by the sweep):
- A handful of admin V2 pages. Keep PageHero for them.

Recovery: re-add `<PageHero>` if a future page wants the centred
hero card aesthetic instead of the left-aligned inline hero.

---

## E. Legacy `UX.*` token map status

`lib/constants/tokens.ts` still exports the legacy `UX` map. Zero
customer-facing pages import it after this sweep. Remaining
consumers are admin pages + the admin/legacy nav.

See `UX-INFRA-DEBT.md` item #8 for the rename-or-remove decision.

---

## How to recover something

```bash
# Pinpoint the file + commit from the list above, then:
git checkout cbd0e88^ -- path/to/file.tsx
# That fetches the file as it existed before the sweep,
# without affecting any other work.
```

Or to view (without pulling):

```bash
git show cbd0e88^:path/to/file.tsx
```

The shared ancestor `cbd0e88^` is the last main-tip before the UX
sweep started in this session. Pre-Session-18 work is at the
checkpoint immediately before that.
