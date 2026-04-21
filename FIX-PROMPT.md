# Fix prompt — Phase 1 preview doesn't match the spec

The preview at `comand-center-bcbkbi8bx-paul-7076s-projects.vercel.app` shipped the new shell and tokens but left most of the old page bodies in place. The redesign was supposed to **replace** the old layouts, not add new components above them. Below is the exact list of what's wrong on each page, why it's wrong against `@DESIGN.md`, and what to change.

Do **not** merge `ux/phase-1-overview` to main yet. Work on the same branch; keep pushing commits until the verification checklist at the bottom passes on every page. Only then merge.

---

## Rule one — the big one

The spec listed removals under each page in `DESIGN.md`. Those removals are **mandatory, not optional**. If the spec says "Remove the 4-KPI card row", that row must be deleted from the JSX, not just pushed below the new hero. When in doubt: if a block of UI would make the hero's information appear twice on the same page, delete the block.

A safe reading of the spec: **replace the page body with the new pattern, then check whether any feature listed in "Not touched" got lost. If something was lost, re-add it. If something survived that's in the remove list, delete it.**

---

## Global fixes (apply everywhere before page-specific fixes)

### G1. Sidebar has duplicate branding

Screenshots show two brand elements stacked: a top blue bar reading `CommandCenter` and inside the sidebar another line `COMMAND·CENTER <`. Delete the top blue bar. The sidebar's own brand row is the only brand marker. Find where the top bar is rendered (likely `AppShellV2` or an old `AppShell` that didn't get removed) and remove it.

### G2. Sidebar collapse arrow at top of sidebar is useless

The `<` arrow next to `COMMAND·CENTER` doesn't collapse anything. Either wire it up to the collapse state in localStorage (per `DESIGN.md § Shared components → Sidebar`) or remove it until the collapse feature is actually built. Do not ship a button that does nothing.

### G3. `Synced 1…` pill looks truncated and broken

Either show `Synced 2m ago` in full with wrapping allowed, or show just a green dot + tooltip. The truncated `1…` with a separate `Sync now` button below looks broken. Pick one: status indicator OR action button, not a broken hybrid.

### G4. Character encoding corruption on Scheduling

Image 8 shows `â€`, `â°`, `À·`, `â–` etc. peppered through the Scheduling page. This is UTF-8 bytes being interpreted as Windows-1252 somewhere. Check:
- Is the data coming from the API already corrupted, or does it corrupt during render?
- If during render — there's a `String.fromCharCode` or a wrongly-encoded template literal somewhere
- If from the API — it's a fetch header or a DB column collation issue

This is a UX-breaking bug even though it's technically a data issue. Fix the rendering path without touching the data layer. **If the fix requires a data-layer change, stop and ask first.**

### G5. Right-side "Ask AI" floating button is fine, keep it

Don't remove the `Ask AI` pill. It's a good universal affordance. Make sure it appears on every page consistently, not just some.

---

## Page-by-page fixes

### Phase 1 — Overview (image 1)

**What's wrong:**
- The four KPI cards (Revenue 26,115 kr / Labour cost 87,545 kr / Labour % 335.2% / Gross margin −61,430 kr) are still rendered between the period picker and the chart. The spec said **remove** these — their numbers now live in SupportingStats in the hero.
- The chart is broken: Monday is a huge solitary bar, the other 6 days are tiny, there's no striped pattern on future days, no margin line overlay connecting days, no hover tooltip data. Either data is mis-wired or the chart rendering got regressed during the redesign.
- The chart header redundantly shows `Week 17 · 20–26 Apr` / `Rosali Deli` inside the chart card, duplicating what's already in the top-bar breadcrumb.

**What to do:**
1. Delete the 4-KPI-card row between the period picker and the chart. Its numbers are in the hero's SupportingStats — do not render them a second time.
2. Debug the chart. Monday 26,115 kr suggests only one day of data exists in the `weekData` — the other 6 days likely have `{ rev: 0, lab: 0 }`. The chart should render those as empty (just the x-axis label) not as a tiny non-zero bar. Check the data-join logic.
3. Confirm the striped-pattern `<pattern id="pk-pred">` is in the SVG defs and that future-day bars use `fill="url(#pk-pred)"`. Per screenshot, none are striped.
4. Confirm the `marginLine` path is being rendered across all days with a non-null margin. Per screenshot, it's missing entirely.
5. Remove `Week 17 · 20–26 Apr / Rosali Deli` from inside the chart card. The breadcrumb already shows this.

### Phase 2 — Group (image 2)

**What's wrong:**
- The AI Group Manager block shows prose paragraphs (`Verdict — ...`, `Why — ...`, `Do this — ...`) with a small colored bullet in front. The spec said this becomes three short actionable bullets using `AttentionPanel`, not prose formatted as a list.
- Prose is in Swedish but the rest of the app is in English. Language mismatch.
- Location cards are missing their sparkline, delta (`↓ −61.9%` is shown for Vero only, not Rosali), and the 4-cell meta grid at the bottom per `DESIGN.md § 2`. Rosali card shows labour/labour %/margin/rev-hour as 2 rows × 2 cols — good — but no sparkline above.

**What to do:**
1. Rewrite the AI Group Manager output:
   - Title: `Needs your attention`
   - 3 bullets max, each ≤ 120 chars, each starting with the entity name in bold followed by the action
   - Each bullet gets a tone dot: red for "outlier / close / fix", amber for warnings, green for praise
   - Example: `🔴 Rosali Deli — close or restructure. 874% labour on 26 115 kr revenue this month.`
2. English only. If the AI output is Swedish because of the data source, translate on the frontend or change the AI prompt. The app is English throughout — language consistency is a UX rule.
3. Add a sparkline row to each location card (SVG inside the card, under the headline revenue, per the `DESIGN.md § 2` card anatomy).
4. Add the delta row (↓ or ↑ with % vs prev month) to Rosali Deli's card, same as Vero's.

### Phase 3 — P&L Tracker (image 3)

**What's wrong:**
- `Edit` buttons on every month row. The spec said remove these — Edit moves to row hover, not a persistent button.
- `+ Add` buttons on every future month row (May through Dec, 8 of them). The spec said future months render dimmed with a forecast badge, not an action button per row.
- The inline revenue-vs-cost bar renders as two solid segments (red on left, navy on right) for past months — but past months with no revenue (Jan/Feb/Mar showing 0 kr) shouldn't have any bar at all, they should show "no data".
- April's bar shows orange on the left, navy on the right — the spec's pattern is **navy revenue fill + burnt-orange cost overlay at the left**, not two side-by-side segments. These are different things visually.
- Purple "AI P&L" narrative box still exists above the table. The spec said this condenses into the hero + optional `AttentionPanel` bullets.

**What to do:**
1. Delete all `Edit` buttons. On row hover, show a pencil icon that navigates to the edit experience (if one exists) or opens an inline editor. No buttons visible by default.
2. Delete all `+ Add` buttons for future months. Future rows render with grey text and no action.
3. For months with zero actual revenue, don't render the bar. Show `—` in the Revenue column and dashed placeholder where the bar would be.
4. Fix the bar rendering. Pattern is: a single horizontal bar, width scaled to year's max revenue. Revenue portion filled `UX.navy`. Cost portion overlays as `UX.burnt` at the left edge, covering the proportion `staff_cost / revenue`. So a month with 70% margin shows mostly navy with a 30% burnt-orange strip at the start.
5. Collapse the purple AI P&L narrative into: (a) the hero headline already says `YTD margin 50.3% across 1 month`, which is fine, and (b) 1–3 bullets in an `AttentionPanel` at the bottom if the AI has specific observations. Kill the purple gradient background. Use the standard `AttentionPanel` white card.

### Phase 4 — Budget vs Actual (image 4)

**What's wrong:**
- Purple "AI BUDGET COACH" banner still rendered. Same issue as P&L — the spec said condense.
- Status tally dots show `0 On track / 0 Off track / 11 Not started` — good, this part worked.
- Monthly rows have `Set` button on every single row and `+ Analyse` button on Apr. Spec said keep a single top-level "Generate with AI" button and remove per-row buttons.
- `act 26,115 kr` is shown tiny to the left of the bar on Apr's row — illegible. Should be a proper label with `actual` label + value.
- The bars themselves are empty tracks with no tick marks and no actual fills for any month. Even Apr with `act 26,115 kr` shows no filled bar.

**What to do:**
1. Replace the purple `AI BUDGET COACH` banner with the condensed hero. If AI has specific flagging (e.g. "2 months at risk"), those become `AttentionPanel` bullets at the bottom. No purple gradient.
2. Remove `Set` buttons from every row. Clicking the row (or a small gear icon on hover) opens the budget-setter. Top-right single `+ Generate with AI` button handles bulk.
3. Remove `+ Analyse` button from Apr's row.
4. Render the progress bars properly per `DESIGN.md § 4`:
   - Grey track full-width
   - Tick mark at the `budget / yearMaxBudget` position
   - Fill from 0 to `actual / yearMaxBudget` — green if `actual >= budget`, red if `actual < budget`
   - Labels: `act {kr}` at the end of the fill, `bud {kr}` at the tick
5. Months without a budget set show just the `budget not set` text (already working) — no bar, no tick.

### Phase 5 — Forecast (image 5)

**What's wrong:**
- The line chart is supposed to show 12 months with actual (navy) transitioning to forecast (indigo dashed) at today's boundary. The screenshot shows a single dot near April and a dashed vertical "today" line. The rest of the chart area is empty.
- This is either a data-join problem or the chart is rendering 0 for all future months (so they draw at y=0 which isn't visible).
- No forecast flags card below the chart.

**What to do:**
1. Debug the forecast data. Does the API return `forecast` values for May through Dec? If yes, why aren't they rendering? If no, that's a data-layer issue — surface it in the UI as "No forecast data available yet" rather than rendering an empty chart.
2. The actual navy line should connect Jan → Feb → Mar → Apr dots, even if some months are zero. Currently only Apr shows.
3. Add the `Forecast flags` card below the chart per `DESIGN.md § 5`. It lists months flagged as missed (red) or at-risk (amber). If there are none, hide the card entirely — don't render an empty one.
4. `Tracking to 26 115 kr revenue this year` in the hero is suspicious — that's ~2k per month. If the forecast genuinely says that, fine. If the calculation is broken (e.g. using only Apr's actual as the annual projection), fix the math.

### Phase 6 — Revenue (image 6)

**What's wrong:**
- The daily stacked bars only show one bar on day 20. The rest of the month is empty — same data issue as Overview. Confirm whether the data actually has only one day or the chart is filtering wrongly.
- Day 21 is highlighted in blue as "today" — good.
- The hero only mentions takeaway, but there's plenty of takeaway/dine-in/food/beverage data visible below. The hero should summarize more: mix split, best day, channel gap.
- The `CHANNEL SPLIT` card on the right shows `Dine-in 16,397 kr (63%)` and `Takeaway 9,719 kr (37%)` which contradicts the hero's "— No cover data". Inconsistency between hero and supporting card.
- `Food vs Beverage` card shows `Food 26,115 kr (100%)` and `Beverage 0 kr (0%)` — this is a real data state but the hero should mention it.

**What to do:**
1. Same data-rendering debugging as Overview: if only day 20 has data, that's fine, but the bar should render clearly, not as a thin sliver the eye has to hunt for. Consider an empty-state message: "Only 1 day of data this month".
2. Rewrite the hero to reflect what's actually in the data:
   - Eyebrow: `APR 2026 · 1 DAY OF DATA`
   - Headline: `Only Mon 20 Apr has data — 26 115 kr, food-only.`
   - Context: `Dine-in 63% / takeaway 37%. Beverage shows 0 kr — check POS sync if this seems wrong.`
3. Reconcile the Channel Split card with the hero. If channel data exists, say so in the hero. If it doesn't, hide the card.

### Phase 7 — Staff (image 7)

**What's wrong:**
- The red bar on day 20 is the only bar shown — fine given 1 day of data.
- `BEST DAY` and `HIGHEST COST DAY` both show `Mon 20 Apr 49.7%`. This is weird UX — the same day is flagged both ways because there's only one day. When data is this sparse, don't show both callouts.
- Below the chart, the full 13-member staff table is open by default. The spec said top 5 + `All 13 staff →` link.
- `INSIGHTS` and `OB SUPPLEMENTS` right-side cards are working correctly.

**What to do:**
1. When there's only 1 day of data, hide the `BEST DAY / HIGHEST COST DAY` split. Show a single `Only day: Mon 20 Apr at 49.7%` card instead, or nothing.
2. Limit the staff table to 5 rows by default. Add `All 13 staff →` link in the card header that expands the list or routes to a full table page.
3. Hero reads `Labour ran 874.5% of revenue — 834.5pp over target.` — this is correct framing but bombastic. When labour % is in four digits, the message should be: `Labour spent exceeds revenue — 228k kr on 26k kr sales.` Plain language beats shocking numbers.

### Phase 8 — Scheduling (image 8)

**What's wrong:**
- Character encoding corruption everywhere (`â€`, `â°`, `À·` etc). Top priority fix.
- The `AI can save 72,260 kr — trim 7 days, keep 0.` hero is misleading — "trim 7 days, keep 0" reads like "cancel the whole week". The spec's template assumed some days would be trimmed and some kept; when the data says trim all, the headline needs different phrasing: `AI suggests zero hours all week — 72 260 kr save available.` or similar.
- The AI-suggested schedule table still has the `WHY` column with long text. The spec said this column goes away and becomes a row tooltip.
- `Method.` explainer paragraph at the bottom still rendered. The spec said this moves behind a help icon popover.
- `How this period performed` row at the very bottom still has corrupted text.
- No `By day of week` summary row — the spec called for this as the primary visual above the schedule table.
- All the predicted values in the schedule rows show `â€` corruption.

**What to do:**
1. Fix the encoding. Inspect where the schedule data becomes a string in the render tree. Likely candidates: a `JSON.parse` on a bytestring, a character-entity escape that's being double-escaped, or a `charset=iso-8859-1` header somewhere. Test with `console.log` on the raw data to locate the corruption point.
2. Rewrite the hero with a dynamic template:
   - If `saving > 0 && trimDays > 0 && keepDays > 0`: `AI can save {kr} — trim {N} days, keep {M}.`
   - If `saving > 0 && trimDays === 7`: `AI suggests zero scheduled hours this week — {kr} save available.`
   - If `saving === 0`: `Schedule matches AI suggestion — no changes needed.`
3. Delete the `WHY` column. Put its content into a row-hover tooltip. Row clicks can drill to day detail if that route exists.
4. Move the `Method.` paragraph behind a `?` help icon next to the "AI-suggested schedule" title. Clicking opens a small popover.
5. Add the `By day of week` summary row per `DESIGN.md § 8` — 7 small tiles showing Mon through Sun with output (kr/h) and status (Lean / On target / Overstaffed). This goes between the hero and the schedule table.
6. Remove the `How this period performed` footer row or move it into the hero's `right` slot as supporting stats.

### Phase 9 — Departments (image 9)

**What's wrong:**
- Hero says `No department data in this period yet.` but the table below shows one row for Bella. Contradiction.
- `Revenue 0 kr / Profit 0 kr / Rev/hour —` in the top-right supporting stats — these should either be real totals or not rendered at all.
- The Bella row shows all `—` for revenue/profit/GP%/labour%/sparkline, but it's listed as active (green dot).
- No `AttentionPanel` at the bottom.

**What to do:**
1. Resolve the hero contradiction. If department data exists (Bella is listed), write a real hero headline. If it doesn't, hide the table entirely and show a proper empty state: `No department data for Apr 2026 — departments sync nightly. Last sync: {time}.`
2. A department row with all `—` shouldn't render — hide it. Or render it with clear "no sync" status, not as an active green-dot row.
3. Add the `AttentionPanel` per `DESIGN.md § 9` if there are departments needing attention. If not, hide the panel.

---

## Phase 10 — Invoices and Alerts (not originally in the spec)

Looking at images 10 and 11, the Invoices and Alerts pages already look reasonable — they follow the 3-card stat row + content area pattern which isn't identical to the new design system but isn't offensive either. **Leave these alone for now**. They're not in `DESIGN.md`.

If you want them updated later, that's a separate phase with its own spec section.

---

## Settings page (image 12)

Also not in the spec. Looks fine. **Leave it alone**.

---

## Verification checklist — must pass on every page before merging

- [ ] No page renders the same number twice (hero number ≠ KPI-card number — because KPI cards shouldn't exist anymore)
- [ ] No purple gradient backgrounds anywhere (P&L and Budget had these)
- [ ] No `Edit` / `+ Add` / `Set` / `+ Analyse` buttons per row — actions live on hover or in top-level CTAs
- [ ] No column showing long text (Why / Method / AI narrative) — long text moves to tooltip or help popover
- [ ] No encoding artifacts (`â€`, `À·`, `â°`) anywhere
- [ ] No top blue `CommandCenter` header bar — only the sidebar brand
- [ ] Chart bars use the striped navy/indigo pattern on future days (Overview chart)
- [ ] Margin line is visible across all days on the Overview chart
- [ ] Empty states are intentional — if data is missing, the page says so clearly rather than rendering broken visuals
- [ ] English everywhere — no Swedish prose in AI outputs
- [ ] All CTAs, hover states, and focus rings work
- [ ] `npm run build` passes, no new lint warnings

---

## Process — how to do this

1. Stay on `ux/phase-1-overview` branch. Don't branch again.
2. Work through each page in the order above (Overview → Group → P&L → Budget → Forecast → Revenue → Staff → Scheduling → Departments).
3. Commit per page with a clear message: `fix(ux): overview — remove KPI row, fix chart data join, remove duplicate title`.
4. Push after each page. Vercel preview updates automatically.
5. Tell me which pages are done and I'll check the preview before you move to the next.
6. After all 9 pages pass the checklist, merge to main.

Do not merge anything to main until every item above is addressed or explicitly confirmed as "keeping as-is" with a reason.
