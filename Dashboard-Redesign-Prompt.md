# CLAUDE CODE — DASHBOARD VISUAL REDESIGN
> Generated 2026-05-08 (late evening)
> UI redesign grounded in `DASHBOARD-INVESTIGATION-2026-05-08.md`. No new endpoints. No backend changes.

---

## What this is

We're redesigning `/dashboard` — the main post-login overview. The mockup at `prompts/dashboard-v7-investigation-aligned.html` shows the target. Open it in a browser before starting.

The redesign:
- Replaces the current yellow alert banner with a small pulsing pill in the page header
- Modernizes the big chart visually (rounded bars, area gradient under AI forecast, refined "TODAY" marker, anomaly callout as soft inline annotation, daily labour-ratio color-coding on labour bars + above-bar percentages)
- Re-introduces a four-stat strip on the chart header (Revenue / Labour / Labour margin / Covers) with label-above-value layout
- Combines the weather widget + holidays into a single "demand outlook" day-card grid below the chart
- Drops the on-dashboard departments summary
- Adds two small honesty notes beneath the chart (daily-vs-weekly framing; actual-vs-predicted reading)

This is **not**:
- A change to any backend endpoint
- A change to the OB-tillägg / line-item anomaly detection rules
- A consolidation of the two forecast streams (scheduling-AI's `est_revenue` vs weather's `predicted_revenue`) — they remain separate
- A refactor of the hand-rolled SVG chart into Recharts or another library
- A TypeScript discipline pass on the dashboard surface
- A schema migration

---

## Hard constraints — read these first

### Things you MUST NOT touch

- **Anomaly detection** — `lib/alerts/detector.ts`, `lib/alerts/line-item-anomalies.ts`, the `anomaly_alerts` table, `app/api/cron/anomaly-check/route.ts`. The OB-tillägg detector's title format and description template stay exactly as-is.
- **The AI explanation pipeline for alerts** — `explainAnomalyDescriptions()` in `lib/alerts/detector.ts:30-83`. The Haiku rewrite of alert descriptions remains untouched.
- **`/api/alerts`** — the dashboard banner already filters to high/critical and slices to 1 row. Same behaviour.
- **The two forecast streams** — `/api/scheduling/ai-suggestion` (powering chart predicted bars and the labour scheduling card) and `/api/weather/demand-forecast` (powering the day cards strip). They remain independent. Don't try to merge them, share a service, or pick a winner.
- **`/api/overheads/projection`** — drives the OverheadReviewCard's "18% → 29%" arrow.
- **`/api/metrics/daily`** — drives revenue, labour cost, labour_pct, covers per day. No changes to its response shape.
- **`/api/scheduling/ai-suggestion`** — drives chart predicted bars, labour scheduling card, AI compare whiskers. No changes.
- **`/api/weather/demand-forecast`** — drives the demand outlook day cards. No changes.
- **`/api/departments`** — even though the redesign drops the dashboard's department summary, the endpoint and the `/departments` route remain functional for other consumers.
- **The holiday compute path** — `lib/holidays/index.ts`, `lib/holidays/sweden.ts`, `lib/holidays/norway.ts`, `lib/holidays/uk.ts`. No changes.
- **Database schema.** No migrations. No new columns.
- **Other pages.** Don't refactor `/scheduling`, `/overheads/review`, `/p&l`, `/group`, `/alerts`, etc.

### Things you MUST do

- Use existing data sources for everything. Every value the v7 mockup shows is either already in the loaded payload or trivially derivable from it (per investigation §summary).
- Preserve the OB-tillägg deterministic title format byte-for-byte: `OB supplement spike +X% — {bizName}`. The pill in the redesigned header and the inline chart callout both render this format exactly. The AI-rewritten description (`alert.description` field) renders as the subtitle in the chart callout where space allows.
- Use the existing `daily_metrics.labour_pct` field (renamed `staff_pct` on the page) as the source for per-day labour ratio coloring in the chart. Map values to traffic-light tiers using `lib/finance/conventions.ts` thresholds if they exist; otherwise green ≤ target, amber within ~5pp of target, red > target +5pp. Where the target comes from is one of the investigation questions below.
- Source "Covers" from `summary.total_covers` already returned by `/api/metrics/daily`. The dashboard currently doesn't read this field; the redesign starts reading it. No new endpoint.
- Preserve the "Group" route (`/group`) untouched. The dashboard remains per-business; cross-business surfaces remain limited to the alerts pill (which is already cross-business in the existing implementation).
- For chart predicted bars: use the existing actual-vs-soft-fill distinction (currently 45° striped fills `pk-pred` / `pk-pred-lab`). Replace the striped pattern with a softer solid fill matching the v7 mockup but keep the underlying logic.
- For days where `aiSched` returns no entry (`pred` is null) AND there is no `daily_metrics` row: show the bar as "no data" — a faint placeholder or empty cell. Don't fabricate a percentage. Honest empty state.
- Use the existing design tokens from `lib/constants/tokens.ts` (per investigation bonus). Where the v7 mockup hardcodes colors, prefer the token. If the v7 color isn't in tokens, surface as a finding.
- Mobile is real work. At narrow widths (`< 880px`), the layout collapses to single-column. The four-stat strip wraps. The chart shrinks horizontally and shows fewer x-axis labels if needed. The day-card grid stacks 2-up. Test at 380px width.

### Things you MUST investigate before implementing

Five questions. Answer them in your implementation report before writing code.

1. **Why was the four-stat KPI strip on the chart header previously removed?** The investigation noted "KPI strip removed per FIX-PROMPT § Phase 1." Find the FIX-PROMPT entry or the commit. If the previous strip had a real problem (e.g. it duplicated OverviewHero, made mobile unreadable, was confusing about which period it covered), the v7 redesign needs to address that problem — not just re-add what was removed.

2. **Where is the "labour target %" actually configured?** The OverviewHero uses `businesses.target_staff_pct` with default 35. Confirm. The chart's per-day green/amber/red tiers should use the same target so the colors align with the operator's mental model. If the target isn't business-configurable, surface and pause.

3. **What's the prop shape the existing `OverviewChart` consumes?** `app/dashboard/page.tsx:619-761` passes data to it. Map the shape exactly. The redesign reuses the same prop interface — no new props, no removed props. The redesign is internal styling and a few new annotations.

4. **How does the existing labour bar fill get applied?** Inline style? CSS variable? Hardcoded fill attribute on the `<rect>`? This affects how the per-day color-tier change gets implemented. If it's inline `<rect fill="">`, it's a per-bar conditional. If it's CSS, it's a class-name swap. Either is fine; just confirm before coding.

5. **Where do design tokens actually live in the components today?** Investigation says `lib/constants/tokens.ts` is "ADDITIVE ONLY — do not replace colors.ts" with a comment noting both tokens.ts and the legacy colors.ts coexist. Confirm which file the dashboard already references (probably both). Use the same import patterns the existing dashboard files use; don't introduce a new token-import pattern.

If any answer surprises you (e.g. the previous KPI strip was removed because it was visibly wrong on mobile and the redesign hasn't solved that), pause and surface before implementing.

---

## Mockup-as-spec discipline

The mockup at `prompts/dashboard-v7-investigation-aligned.html` is the visual target. **Some values in it are illustrative**. Compute the actual values from existing data:

| Element | In mockup | Should come from |
|---|---|---|
| `110 072 kr` revenue | hardcoded | `dailyRows.reduce(s, r) => s + r.revenue, 0)` from `/api/metrics/daily` |
| `−38.6%` revenue delta | hardcoded | `(totalRev - prevRev) / prevRev * 100` from current + previous period fetches |
| `63.3%` labour | hardcoded | `totalLabour / totalRev * 100` |
| `+21pp` labour delta | hardcoded | derived from current vs prev period labour ratio |
| `40 414 kr` labour margin | hardcoded | `Math.max(0, totalRev - totalLabour)` (NOT net margin) |
| `+9pp YoY` margin delta | hardcoded | derived from comparable period last year, if available; if not, use prev-period delta and label accordingly |
| `285` covers | hardcoded | `summary.total_covers` from `/api/metrics/daily` (already in response, just newly consumed) |
| `OB supplement spike +78% — Vero Italiano` | hardcoded | `alert.title` from the highest-severity active alert; falls back to "no anomalies" pill if none |
| `Vero Italiano · May 8 · check overtime` (chart callout subtitle) | hardcoded | `alert.description` (Haiku-rewritten in production) |
| Daily revenue/labour bars | hardcoded shapes | `dailyRows[i].revenue` and `dailyRows[i].staff_cost` |
| `32%`, `38%`, `42%` above-bar labour % | hardcoded | `dailyRows[i].labour_pct` (already in chart data) |
| Bar tier colors (green/amber/red) | hardcoded | computed from `dailyRows[i].labour_pct` vs `targetPct` |
| AI forecast line points | hardcoded | `aiSched.suggested[].est_revenue` |
| Predicted soft-fill bars (Sat/Sun) | hardcoded | `aiSched.suggested[].est_revenue` and `effectiveAiCost(d)` |
| `~ 28 900 kr` Wednesday holiday baseline | hardcoded | `predicted_revenue` from `/api/weather/demand-forecast` for that holiday day; the model returns `baseline_revenue` (not bucket-lifted) for holidays per `lib/weather/demand.ts` |
| `Kr. himmelsfärds dag` holiday name | hardcoded | `holiday_name` from `/api/weather/demand-forecast` per `DemandDay` |
| `158 200 kr` 7-day forecast total | hardcoded | sum of `predicted_revenue` across the 7 `DemandDay` rows |
| `+12% vs typical week` | hardcoded | derived from baseline; if not available, omit |
| `−20.5h cut available` (Saturday flag) | hardcoded | from `aiSched.suggested[i].delta_hours` for that day; only show when negative |

Anything in the mockup that's purely visual (gradient under AI line, rounded bar corners, "TODAY" pill, soft anomaly callout treatment, two footer notes, label-above-value layout, dimensional rhythm of the row) is the design target. Implement faithfully.

---

## Concrete deliverables

### 1. Page-level redesign
Modify `app/dashboard/page.tsx` so:
- The yellow alert banner (lines 594-602) is replaced by a small anomaly pill in a new page header strip.
- The 3-column auto-fit grid (lines 619-761) is preserved structurally — OverviewHero, labour scheduling card, OverheadReviewCard remain. Visual treatment refined to match v7 mockup card patterns.
- The big chart's container gets a new header-row above it: page-title block on top, then a single horizontal row beneath containing the four-stat strip (Revenue / Labour / Labour margin / Covers) on the left and the View+Compare controls on the right.
- The DepartmentsSummary section (lines 794-815) is removed from the dashboard. The component definition is inline in the page; remove it cleanly.
- The WeatherDemandWidget is replaced by a new "Demand outlook" component combining weather + holidays + AI sales pattern in a single 7-day day-card grid.
- The AttentionPanel becomes a compact horizontal strip at the bottom (was a right-column panel).

### 2. New page-header strip component
Create `components/dashboard/DashboardHeader.tsx` (or inline if simpler):
- Page title and breadcrumb on the left
- Pulsing anomaly pill in the middle, populated from the existing top-severity alert (use the same filter the page already applies)
- Time-range toggle and Export button on the right
- The pill renders the deterministic title (`alert.title`); clicking navigates to `/alerts` (same target as today's banner)
- When no high/critical alerts are active, the pill is hidden (not "all clear" — just absent)

### 3. Chart visual modernization
Modify `components/dashboard/OverviewChart.tsx`:
- Remove the regular vertical gridlines; keep horizontal-only lines, very faint
- Round bar corners more generously (rx=5)
- Replace the 45° striped predicted-bar pattern with a soft solid fill (the underlying logic — which days are "predicted" — stays the same)
- Add an area gradient under the AI forecast line (subtle, fading 14% to 0%)
- Add the "TODAY" vertical line spanning chart height with a small "TODAY" pill at the top
- Refine the anomaly callout to soft inline annotation (no red rectangle, no white-on-red text)
- Apply per-day color-tier on labour bars based on `staff_pct` vs `targetPct`
- Add small above-bar labour percentage annotations
- Add weekday + date two-line x-axis labels (currently single weekday label only)
- Y-axis labels right-aligned in their own implicit column, lighter weight
- Compact legend with smaller swatches, lighter color, less prominent

### 4. New "Demand outlook" component
Create `components/dashboard/DemandOutlook.tsx`:
- Replaces `WeatherDemandWidget`
- Reads from `/api/weather/demand-forecast` — same endpoint
- Renders a 7-day grid of day cards with weekday name, date, weather emoji, temp range, predicted revenue, and contextual flags (holiday name, "−Xh cut available" from scheduling, etc.)
- Holiday days get an amber background and corner "H" badge; revenue is shown as `~ X kr · baseline est.` to communicate the model's lower confidence
- Today gets a white-paper background with dark border
- Peak/dip days get green/red backgrounds based on `delta_pct`

### 5. Two chart footer notes
- One: "Day labour % is informational — week target is what matters" framing (already in v7 mockup)
- Two: "Reading the bars: solid = actual, soft fill = AI forecast" actual-vs-predicted disambiguation

### 6. Mobile responsive design
At < 880px:
- Single-column stack
- Four-stat strip wraps (no horizontal scroll)
- Chart shrinks; consider hiding above-bar percentages or reducing x-axis label density
- Day-card grid stacks 2-up
- Anomaly pill wraps below page title, doesn't push it off-screen
- Test at 380px (iPhone SE width). Don't ship if anything breaks at that width.

---

## What "done" looks like

- `/dashboard` renders without errors for Vero (Rosali Deli AND Vero Italiano businesses).
- The pulsing anomaly pill renders the actual high/critical alert title for the org; hides if none.
- The chart shows daily labour ratio coloring + above-bar percentages from existing `staff_pct` data.
- The four-stat strip displays correct values for Revenue / Labour / Labour margin / Covers.
- The "Demand outlook" component renders 7 days from `/api/weather/demand-forecast`; Wednesday's Kr. himmelsfärds dag shows correctly.
- Mobile renders cleanly at 380px.
- TypeScript still passes (with `// @ts-nocheck` preserved where it currently exists; don't add type discipline).
- No new ESLint warnings.
- The 16-fetch shell behavior is preserved or improved (don't add fetches; ideally consolidate where possible without changing endpoints).
- Existing detection, AI explanation, decision, and forecast code paths are unchanged.

---

## Hard rules of engagement

- **No FIXES.md entry.** This isn't a fix.
- **One PR, one descriptive commit.** No "auto-checkpoint" commits during the work. If your environment auto-commits on a timer, disable it for this work or squash before opening the PR.
- **Don't open the PR until you've manually verified the page renders for Vero with real data** — both Rosali Deli and Vero Italiano. Both populated states must render correctly. Test the mobile breakpoint at 380px width.
- **If you find a bug in adjacent code while doing this work, do NOT fix it.** Surface it in the implementation report. The discipline of "fix only what you came to fix" is non-negotiable.
- **If the existing data shape doesn't support something the mockup assumes**, surface the gap. Don't fabricate fields or invent endpoints to fill the gap.
- **Don't try to consolidate the two forecast streams** (scheduling-AI vs weather-demand). Both stay. The mockup is honest about them being separate.
- **Don't add tests** (no test infrastructure exists per investigation). Manual verification is sufficient.
- **Don't add TypeScript discipline.** The dashboard files are `// @ts-nocheck`. Adding type discipline is its own multi-day task; not in scope here.

---

## Adjacent observations (from the investigation — surface, don't fix)

The investigation surfaced these. They're real but out of scope for this PR:

- **Two parallel forecast streams.** Scheduling-AI's `est_revenue` and weather-demand's `predicted_revenue` are independently computed. Both are reasonable; both use weather buckets and per-business rolling baselines. Consolidation is a future effort, not part of this PR.
- **TypeScript off across dashboard surface.** `// @ts-nocheck` on `app/dashboard/page.tsx`, `OverviewChart.tsx`, `WeatherDemandWidget.tsx`, `app/api/departments/route.ts`. Adding type safety is its own task.
- **No tests anywhere outside node_modules.** Test infrastructure doesn't exist; don't introduce it as part of this PR.
- **16 API calls fire on dashboard mount.** Aggressive but works under HTTP/2. Performance optimization is a separate effort.
- **`DepartmentsSummary` removed by this PR.** The on-dashboard department summary's data shape (`/api/departments`) only feeds the dashboard. The `/departments` route is unchanged and continues to use the same endpoint. Removing the dashboard component doesn't strand any other consumer.
- **The OB-tillägg detector's daily-cron behaviour** is unchanged. The pill in the redesigned header reads from `/api/alerts` exactly as the current banner does.
- **`labour_pct` is per-day; the four-stat strip's "63.3%" is period-aggregate labour ratio.** These are distinct numbers (per investigation §7). The redesign should be careful: chart bar coloring uses per-day labour_pct; header stat uses period-aggregate.

---

## Implementation order suggestion

1. **Investigation pass** (60-90 min): answer the five investigation questions, confirm response shapes, identify any surprises. Especially: why was the previous KPI strip removed?

2. **Build the new components** (4-5 hours):
   - `DashboardHeader` first — simplest, visual orchestration of existing data
   - `DemandOutlook` second — replaces existing widget, same endpoint, just visual restructure
   - Chart modernization third — the most surgery; do it last

3. **Page-level reorganization** (90 min): wire the new components into `app/dashboard/page.tsx`, preserve the OverviewHero / labour scheduling card / OverheadReviewCard cards visually, drop DepartmentsSummary.

4. **Mobile pass** (90 min): genuine work, not just shrinking. Test at 380px. The four-stat strip is the riskiest piece.

5. **Visual polish pass** (60 min): exact spacing, design tokens, typography. Match the v7 mockup faithfully.

6. **Manual verification** (60 min): Rosali Deli AND Vero Italiano, real data, all states (loading, error, empty alerts queue, populated alerts queue, holidays this week, no holidays this week). Mobile at 380px.

7. **Open PR** with a clear description, screenshots of desktop + mobile, and the implementation report.

Total: roughly 1 — 1.5 days of focused work. If it's taking materially longer, surface what's hard before continuing.

---

## Implementation report

After the PR is open, write a one-page report covering:

- The five investigation answers
- Why the previous KPI strip was removed and how the v7 redesign addresses or avoids that issue
- Any deviations from the mockup and why
- Any adjacent issues you noticed but did not fix
- Anything that needs follow-up (e.g., the two forecast streams should consolidate eventually; mobile needs more thought; etc.)

This report goes in the PR description, not as a separate file.

---

> "Visual UI redesign. No new endpoints, no schema changes, no consolidation of forecast streams. Detection, AI, decisions, and forecast code paths unchanged."
