# CLAUDE CODE — SCHEDULING PAGE VISUAL UPDATE
> Generated 2026-05-07 (late evening)
> Visual UI update only. No backend changes. No new data. No architectural shifts.

---

## What this is

We're updating the visual design of the `/scheduling` page to introduce a new primary view (a three-row week grid) and reframe the existing scheduling recommendations around **week-level labour %** rather than per-day numbers. The existing day-by-day list view (`AiHoursReductionMap`) is preserved as a toggle.

The mockup at `prompts/scheduling-page-v4-mockup.html` shows the target. Open it in a browser before starting. It is faithful to what we want, but a few values in it are illustrative — see "Mockup-as-spec discipline" below.

This is **not**:
- A new feature (no new data is being computed or persisted)
- A backend change (the `/api/scheduling/ai-suggestion` endpoint stays exactly as-is)
- A schema change (no migrations)
- A redesign of the app shell (sidebar, top nav, brand pattern unchanged)

It **is**:
- A new component (the week grid)
- A restructured headline area on `/scheduling` leading with week labour %
- A restructured reasoning panel leading with week-impact framing
- A small info banner teaching the daily-vs-weekly distinction
- A view toggle between "Week grid" (new default) and "Day-by-day list" (existing `AiHoursReductionMap`)

---

## Hard constraints — read these first

### Things you MUST NOT touch

- The `/api/scheduling/ai-suggestion` endpoint or any of its computations (`app/api/scheduling/ai-suggestion/route.ts`). Output shape stays identical. No new fields, no removed fields, no renamed fields.
- The `scheduling_optimization` cron job (`app/api/cron/scheduling-optimization/route.ts`).
- The `scheduling_recommendations` table.
- The `schedule_acceptances` table (M026) or the `/api/scheduling/accept-day` and `/api/scheduling/accept-all` endpoints.
- Personalkollen integration code in `lib/pos/personalkollen.ts`.
- The Monday Memo flow (`lib/ai/weekly-manager.ts`) that consumes scheduling data.
- The `WeatherDemandWidget` on the dashboard or the `/api/weather/demand-forecast` endpoint.
- Database schema. No migrations.
- Other pages or routes (`/dashboard`, `/integrations`, `/p&l`, etc.). Do not refactor anything outside the `/scheduling` page.

### Things you MUST do

- Use the existing `/api/scheduling/ai-suggestion` payload as the single source of data for the week grid. Specifically, the `current[]`, `suggested[]`, and `summary` fields.
- Specifically use the `suggested[i].est_revenue` field for the demand forecast row. Do **not** introduce a parallel fetch to `/api/weather/demand-forecast` even though it exists. Single API call only.
- Preserve the existing `AiHoursReductionMap` component. The new week grid lives **alongside** it, accessed via a view toggle. Default to "Week grid" but the user can switch to "Day-by-day list" and see the existing UI unchanged.
- Wire the "Apply" and "Decline" buttons in the new reasoning panel to the existing `/api/scheduling/accept-day` (per-day) and the existing decline flow. No new endpoints.
- Wire the "Apply both ready days" bulk action to the existing `/api/scheduling/accept-all` endpoint.
- Preserve the existing "Open Personalkollen ↗" button and its behavior (opens PK in a new tab). The mockup includes it; keep its current target URL and tab-open behavior.
- Preserve all empty states, loading states, and error states the existing page has today. If the API returns empty or fails, the new grid degrades gracefully.
- Preserve the existing tabs at top right (This week / Next week / 2 weeks / 4 weeks / Next month). Do not change their behavior.

### Things you MUST investigate before implementing

Before writing any code, answer these questions and put the answers in your implementation report:

1. **Is a labour % target configurable today?** Search the codebase for any setting, env var, or per-business field that stores a target labour ratio (e.g., `labour_target_pct`, `target_labor_ratio`, etc.). If yes, wire the new headline display to it. If no, hardcode 30% with a clear `// TODO: make configurable` comment and surface this in your report.

2. **Does the existing `AiHoursReductionMap` component depend on internal state that the parent page passes in?** Find the prop shape and confirm the new week grid can consume the same data without changes to the parent fetch logic.

3. **What does the response look like in error/empty states?** Confirm the shape; the new grid must handle the same edge cases.

4. **Is there an existing way to format kr amounts and percentages for the Swedish market?** (Likely `lib/format.ts` or similar.) Use the existing helper rather than reinventing it.

5. **Are there existing icon components / svg patterns being used in the sidebar?** The sidebar in the mockup is illustrative — if your existing sidebar uses different icons, the visual update must use the actual existing sidebar.

If any answer surprises you (e.g., target IS configurable but stored in an unexpected place; or `AiHoursReductionMap` is more complex than the mockup assumes), pause and surface the finding before implementing.

---

## Mockup-as-spec discipline

The mockup at `prompts/scheduling-page-v4-mockup.html` is a faithful visual target but **a few values in it are illustrative**. Treat the visual design and structure as authoritative, but compute the actual values from the API:

| Element | In mockup | Should come from |
|---|---|---|
| `34% → 29%` headline | hardcoded | computed: `current_total_cost / sum(suggested[i].est_revenue) × 100` and `suggested_total_cost / sum(est_revenue) × 100` |
| `14 950 kr` savings | hardcoded | `summary.saving_kr` |
| `−26.5h` hours cut | hardcoded | `summary.current_hours - summary.suggested_hours` |
| `2 ready · 4 amber · 1 unchanged` legend | hardcoded | computed from per-day status |
| Day-pct values (`36%`, `31%`, etc.) | hardcoded | computed: `current[i].est_cost / suggested[i].est_revenue × 100` |
| `30%` target | hardcoded | from configurable target if it exists, else hardcoded 30 with TODO |
| Weather emoji (🌦, ⛅, ☀, 🌧) | hardcoded | mapped from `suggested[i].weather.bucket` (`wet`, `cloudy`, `clear`, etc.) |
| Reasoning text in panel | mocked | `suggested[i].reasoning` from the API |
| Department breakdown | mocked | `current[i].dept_breakdown` from the API |
| Currency formatting (spaces vs commas) | "14 950 kr" | use existing format helper; if no helper, format as Swedish (space as thousands separator) |

The mockup uses `1a4d2e` for the green and a particular set of grays for the rest. Match these closely enough that the page looks like it belongs in CommandCenter — but if you have a design tokens file (e.g., `tailwind.config.ts` colors, or CSS variables defined elsewhere), use those tokens instead of new hardcoded values. Tokens > exact-pixel-match.

---

## Concrete deliverables

### 1. The page itself
Modify `app/scheduling/page.tsx` so that:

- The page header crumb and tabs structure stays identical.
- The "AI Outlook · Next Week" section label appears as in the mockup.
- A new headline card (with green left-stripe, matching the existing card pattern) shows the week labour % with `current → projected` framing, plus three stat columns (Saves, Hours cut, Days breakdown).
- The existing "Ready to implement · Open Personalkollen" card stays where it is.
- A new info banner appears below the ready-card, with the daily-vs-weekly explanation text.
- A view toggle (`Week grid` / `Day-by-day list`) appears below the info banner, defaulting to `Week grid`.
- When `Week grid` is selected: the new week-grid component renders.
- When `Day-by-day list` is selected: the existing `AiHoursReductionMap` renders, unchanged.
- Below the grid: an "AI thinks about this week" rationale card and a "Signal sources" card, side by side. Both pull from the existing data.

### 2. The new week-grid component

Create `components/scheduling/WeekGridView.tsx`. It should:

- Accept the same props/data the parent already fetches (`current[]`, `suggested[]`, `summary`).
- Render the three-row × seven-column grid as in the mockup.
- Each AI-suggestion cell where `delta_hours < 0` is clickable; clicking opens the reasoning panel below the grid for that day.
- Cells where `delta_hours === 0` are styled as "on target" / "unchanged" (gray, non-clickable).
- The reasoning panel pulls `suggested[i].reasoning`, `dept_breakdown`, and computes the week-impact compounding (current %, current % minus selected day, current % minus all green days).
- Apply / Decline buttons in the reasoning panel call existing endpoints.

### 3. The info banner component

Create `components/scheduling/DailyVsWeeklyBanner.tsx` or inline it in the page. Either way, the text is:

> **Daily % varies — week target is what matters.** A rainy Monday will run hot. A sunny Friday will run cool. The week's average is what we optimize against. Daily % is shown for context, not as a goal.

Optional polish: dismissible per user (localStorage flag), but not required. If you do dismissible, simple key like `cc_scheduling_banner_dismissed`.

### 4. Computed values helper

Add a small utility (likely in `components/scheduling/computeWeekStats.ts` or similar) that takes the API payload and returns:

```ts
{
  weekLabourPctCurrent: number,      // current_total_cost / sum_est_revenue * 100
  weekLabourPctProjected: number,    // suggested_total_cost / sum_est_revenue * 100
  weekLabourPctIfDayApplied: (dayIdx: number) => number,  // for reasoning panel compounding
  daysReadyCount: number,
  daysAmberCount: number,
  daysUnchangedCount: number,
  perDayPct: number[],               // 7 values for the day-pct footer
}
```

This isolates the math from the components.

---

## What "done" looks like

- The `/scheduling` page renders without errors for Vero (org_id `e917d4b8-635e-4be6-8af0-afc48c3c7450`, business_id Vero Italiano).
- The week-grid is the default view; toggling to day-by-day shows the unchanged existing component.
- All numbers shown in the new UI are computed from the existing API response — none hardcoded except the 30% target if no configurable target exists.
- Apply / Decline buttons in the reasoning panel hit the existing endpoints.
- The page works on mobile (the existing breakpoint behaviour is preserved or improved).
- TypeScript clean. No new ESLint warnings.
- The existing `AiHoursReductionMap` component is **not modified** — only its parent rendering is reorganized.

---

## Hard rules of engagement

- **No FIXES.md entry.** This isn't a fix.
- **One PR, one descriptive commit.** No "auto-checkpoint" commits during the work. If your environment is auto-committing on a timer, disable it for this work or squash before opening the PR.
- **Don't open the PR until you've manually verified the page renders for Vero with real data.** Mock data sanity-check is fine for development; production verification is required before opening.
- **If you find a bug in adjacent code while doing this work**, do NOT fix it. Surface it in your implementation report and let Paul decide whether to scope a follow-up. The discipline of "fix only what you came to fix" is non-negotiable for this work.
- **If the existing `AiHoursReductionMap` doesn't behave the way the mockup assumes** (e.g. the toggle interaction breaks something), surface the finding before adapting. Don't quietly modify the existing component.
- **If a value in the mockup turns out to not be computable from the existing API** (e.g. you can't determine "ready vs amber vs unchanged" from the existing fields), surface the gap. Don't fabricate a way to compute it.

---

## Implementation order suggestion

1. **Investigation pass** (45 min): answer the five investigation questions, confirm the API payload shape against the mockup's assumed values, identify any gaps. Write findings to a short pre-implementation note.

2. **Build the computed-values helper** (30 min): a pure function from the API payload to all derived values. Write tests if there's a test setup.

3. **Build the week-grid component** (90 min): static rendering first, then click-to-expand reasoning panel, then wire Apply/Decline.

4. **Reorganize the page** (45 min): the new headline card, info banner, view toggle, two-column footer.

5. **Visual polish pass** (30 min): match the mockup's spacing, color tokens, typography. Test light/dark if your app has a dark mode.

6. **Manual verification** (30 min): real data, real customer (Vero), all states (loading, error, empty, populated).

7. **Open PR** with a clear description and a screenshot of the new view.

Total: roughly half a day of focused work. If it's taking materially longer, surface what's hard before continuing.

---

## Implementation report

After the PR is open, write a one-page report covering:

- The five investigation answers
- Any deviations from the mockup and why
- Any adjacent issues you noticed but did not fix
- Anything that needs follow-up (e.g., the target % being non-configurable; the dismissible banner being a future enhancement)

This report goes in the PR description, not as a separate file.

---

> "Visual UI update only. No backend changes. No new data. No architectural shifts."
