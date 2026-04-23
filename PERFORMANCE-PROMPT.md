# Claude Code prompt — build the Performance page

New page for CommandCenter: a unified business performance view that rolls up revenue, food cost, labour, overheads, and margin into a single page with a period picker, comparison overlay, and trend sparklines.

This is a **new page**, not a redesign of an existing one. It lives in the Financials section of the sidebar. It must follow the design system in `@DESIGN.md` exactly — same shell, same tokens, same component vocabulary. No new npm dependencies. No data model changes.

---

## Scope — non-negotiables

- Do not change the data model, schema, or any API endpoint signature
- Do not add npm packages — no chart library, no date library, no icon library
- Do not touch `lib/constants/colors.ts` or `app/globals.css`
- Do not modify any other page's code
- All existing shared components (`PageHero`, `SupportingStats`, `AttentionPanel`, `Sparkline`, `StatusPill`, `SegmentedToggle`, `SyncIndicator`) must be reused — not reimplemented inline
- If the data needed for this page isn't already fetched by an existing hook, ask before adding a new fetch

If you hit any of these walls, stop and ask.

---

## Route

Add at `app/financials/performance/page.tsx`. If the Financials routes are organised differently, match the existing convention. Sidebar nav entry: `Performance` under the Financials section, after `Budget vs Actual` and before `Forecast`.

---

## Data model — use what's already there

This page is a view over existing data. Expected sources you likely already have:

- **Revenue** — from `daily_metrics` or `weekly_metrics` / `monthly_metrics` summary tables
- **Labour cost** — from staff cost tracking (already on Staff page)
- **Food cost** — from invoice ingestion and/or a food_cost field on summary tables
- **Overheads** — rent, utilities, other — from wherever accounting data lives (Fortnox sync if integrated, or a cost categories table)

If overheads data doesn't exist yet:
- Check if there's an invoice categorisation system (the Invoices page shows AI-extracted invoices with categories)
- If categories like `rent`, `utilities`, `software` etc. exist, sum invoices in those categories for the period
- If no overhead data is available at all, render the overheads row with `—` and a "Connect accounting for full breakdown" CTA

**Ask before adding any new endpoint.** The page should work on whatever data is already available, gracefully showing `—` for missing categories.

---

## Shell

Standard page shell per `DESIGN.md`:

- `AppShell` with sidebar activeKey `financials/performance`
- `TopBar` with breadcrumb `Financials · Performance`
- Everything below goes in the main content area

---

## Top bar right slot — the control cluster

This is the most complex part of the page. Four controls sit together on the right side of the top bar:

### 1. Location picker
Existing `LocationPicker` or whatever's used on other pages. Keep consistent.

### 2. Granularity toggle (`SegmentedToggle`)
Four options: `Week | Month | Quarter | YTD`. Default: `Month`.

When granularity changes, the Period picker's selection resets to the current equivalent (this week / this month / this quarter / YTD to-date). The comparison default adjusts accordingly.

### 3. Period picker with prev/next arrows

A grouped control: `[ ◂ ] [ Apr 2026 ▾ ] [ ▸ ]`

- `◂ ▸` arrows step one granularity unit at a time
- Clicking the label opens a dropdown (see below)
- Granularity = `Week` → label reads `Week 17 · 20–26 Apr`, dropdown shows week picker
- Granularity = `Month` → label reads `Apr 2026`, dropdown shows month grid
- Granularity = `Quarter` → label reads `Q2 2026`, dropdown shows quarter grid (4 quarters × N years)
- Granularity = `YTD` → label reads `YTD 2026`, dropdown shows year picker only

**Month grid dropdown (the common case) must have:**
- Header row: `◂` prev-year button · year label · `◂` next-year button, centered
- 4-column × 3-row grid of month abbreviations (Jan through Dec)
- Current month has an indigo outline (`UX.indigo`)
- Selected month has a navy fill with white text
- Future months are disabled (greyed, no hover, no click)
- Below the grid: a "QUICK" section with pill buttons: `This month`, `Last month`, `YTD {currentYear}`, `{lastYear}`
- Menu closes on: selecting a month, clicking outside, Escape key

**Future period protection:** never allow selecting a period that hasn't happened yet. The `▸` next arrow is disabled at the current period. Future months in the grid are disabled. Future quarters likewise. YTD can't select a future year.

### 4. Compare dropdown

A pill button styled differently from the period picker (indigo-tinted background `UX.indigoBg`, indigo text, indigo border) so it's visibly a different kind of control. Default state: `+ Compare` (empty, not yet active).

When clicked, opens a menu with these options:

- `No comparison` — clears the compare state
- `Previous period` — dynamic label based on granularity: "Previous month", "Previous week", "Previous quarter", "Previous year"
- `Same period last year` — e.g. "Apr 2025" when current is Apr 2026. Disabled if last year's equivalent data doesn't exist
- `YTD last year` — only shown when granularity is YTD
- `Pick custom…` — opens a second month-picker grid on top of the first. The grid lets the user pick any single past period of the matching granularity to compare against.

When a comparison is active, the pill label becomes `vs {compared period}` and the indigo background stays. Clicking again reopens the menu.

---

## Hero

Use `PageHero`. The hero adapts based on whether comparison is active:

### No comparison active

- Eyebrow: `{PERIOD LABEL IN CAPS} · FULL PERFORMANCE`
- Headline template: `Margin <tone>{net_margin_pct}%</tone> — {biggest_story}.`
  - `biggest_story` is one of:
    - "food cost on target, labour Npp over" (when labour is the issue)
    - "labour on target, food cost Npp over" (when food is the issue)
    - "all three costs in range" (when nothing's off)
    - "covers down Npp, costs holding" (when revenue dropped)
- Context: 1–2 sentences explaining the shape — which cost category is driving margin and by how much kr

### Comparison active

- Eyebrow: `{PERIOD LABEL} · FULL PERFORMANCE · VS {COMPARE PERIOD}`
- Headline: `Margin <tone>{pct}%</tone> — {direction} {Npp} vs {compare period}, {explanation}.`
  - e.g. `Margin 15.2% — up 1.8pp vs Mar 2026, but labour ate most of the gain.`
- Context: 1–2 sentences explaining what changed, with both period values

Right slot: two stat blocks — `REVENUE` and `NET MARGIN`. Each shows the current-period value prominently and (if comparison is active) a small `vs {compare kr}` subtitle in muted text.

---

## Primary visual — Profit waterfall

White card, `padding: 14px 16px`. Title: `Profit waterfall — {period label}`.

If comparison is on, add a small indigo tag next to the title: `◂ overlay: {compare period}`.

SVG waterfall, `viewBox="0 0 700 240"`, `height: 260px`. Bars from left to right:

1. **Revenue** — navy bar, full height from zero up to the revenue value
2. **Food cost** — burnt orange (`UX.burnt`), deduction bar stepping down from revenue
3. **Labour** — burnt orange at 75% opacity, stepping down further
4. **Overheads** — burnt orange at 45% opacity, stepping down further
5. **Net margin** — green (`UX.greenInk`), the remainder

Each bar has:
- Value label above (e.g. `−155k`, `544k kr`, `82k kr`)
- Name label below the axis
- Small sub-label below the name showing % of revenue or comparison delta

Dashed grey connector lines between bars at the top of each step.

**When comparison is on:** overlay a thin indigo dashed line on each bar at the height the comparison period's value would be. This shows "March's food cost was this much, April's is this much" visually in one chart.

Legend below the chart. Four swatches when compare is off (Revenue, Costs, Net margin), five when on (add `Compare overlay` with a dashed indigo swatch).

**Axis and labels:** 4 horizontal grid lines (0, 200k, 400k, 600k), dashed grey. Y-axis values on the left in 9px grey.

---

## Second row — Cost breakdown + Full breakdown table

Grid: `1.35fr 1fr`, gap 12px.

### Left card — Donut chart

Title: `Cost breakdown`, subtitle shows `{total cost kr} · {cost as % of revenue}`.

SVG donut, 140×140px. Single-colour (burnt orange) at different opacities per slice:
- Labour: opacity 0.75
- Food cost: opacity 1.0
- Overheads: opacity 0.45

Centre label: total cost (compact, e.g. `462k`) + `total cost` subtitle.

Legend to the right of the donut, one row per cost category: swatch · name · kr value · % of total cost.

The single-colour-different-opacity treatment is deliberate — all three are costs, same semantic category. Don't use different colours per slice.

### Right card — Full breakdown table

Title: `Full breakdown`, subtitle varies based on comparison:
- No compare: `% of revenue`
- Compare on: `◂ vs {compare period}`

Table columns when comparison is off:
`Category | Amount | % rev | vs prev`

Table columns when comparison is on:
`Category | Current | Compare | Δ`

Rows, in this order:
1. Revenue (navy swatch)
2. Food cost (burnt full opacity)
3. Labour (burnt 0.75 opacity)
4. Rent & utilities (burnt 0.45 opacity)
5. Other overheads (burnt 0.45 opacity)

Footer row: Net margin, green text, weight 500.

The table mirrors the donut order but includes revenue and separate overhead categories the donut didn't split.

---

## Third row — Trend sparklines

Three cards in a `repeat(3, 1fr)` grid. Each card:

- Small label top: e.g. `NET MARGIN · 12 MONTHS` (adapts to granularity — `12 WEEKS` when granularity is Week)
- Big value: current period's value, tone-coloured
- Inline delta next to the value: arrow + pp change
- Sparkline below, 36px tall, tone-coloured to match the value
- Footer row: target value on the left, 12-period avg or trend descriptor on the right

Three cards:
1. **Net margin** — green if above target, amber if within 10pp below, red if > 10pp below
2. **Labour %** — green if at/below target, amber if 0–15pp above, red if > 15pp above
3. **Food cost %** — same tiers as labour

The sparkline shows the last 12 periods of data for that metric. Use the existing `Sparkline` component.

---

## Fourth row — "What's tunable" panel

Reuse `AttentionPanel`. Title: `What's tunable`. Generate 2–3 bullets covering:

- The largest actionable lever (usually labour) — state how much kr is at stake for a 1pp move
- A positive trend to preserve (e.g. food cost improving 3 months running — "keep doing what you changed")
- A "no action needed" statement for any category that's stable — so the user knows not to waste attention there

Tone colours: amber for "needs attention", green for "working well / leave alone", red only if something is genuinely bad.

These bullets should come from an AI call if you have one (the same system that generates Group Overview bullets), using a prompt that specifically asks for actionable, differentiated advice. If no AI is wired yet, hardcode a template-driven version using thresholds — it can always be upgraded to AI later.

---

## Interaction rules

- **Granularity change** resets period to the current equivalent (today → this week / this month / etc.) and keeps the comparison mode active if the new granularity supports it
- **Period change** does not affect comparison mode; the compare target updates automatically if the comparison is relative (Previous period, Same period last year)
- **Comparison change** does not affect granularity or period
- **Clicking a cost bar in the waterfall** drills into that category — food cost bar → `/operations/revenue` food tab, labour bar → `/operations/staff`, overheads bar → `/invoices` filtered by overhead categories
- **Clicking a row in the Full breakdown table** drills the same way
- **Hover on any waterfall bar** shows a tooltip with: the value, % of revenue, comparison value (if compare is on), and delta
- **Keyboard navigation** — arrow keys on the period picker grid navigate cells; Enter selects; Escape closes the dropdown

---

## Defaults

- Granularity: `Month`
- Period: current month
- Comparison: `No comparison` (off by default — keeps first impression clean)

---

## Visual tokens reminder

Use only tokens from `lib/constants/tokens.ts`:

- Revenue bar: `UX.navy`
- Cost bars: `UX.burnt` at varying opacity
- Margin/profit: `UX.greenInk`
- Comparison overlay: `UX.indigo` (dashed 3 2)
- Card bg: `UX.cardBg`
- Border: `UX.border`
- Text: `UX.ink1` / `UX.ink2` / `UX.ink3` / `UX.ink4`

No raw hex values inline. No purple gradients. No rainbow cost categories.

---

## Sidebar addition

Add the new nav item to `SidebarV2`:

```
FINANCIALS
  P&L tracker
  Budget vs actual
  Performance   ← new
  Forecast
```

---

## Empty states

- **No data for current period** — render the hero with: headline `No data for {period} yet.` context `Data syncs nightly at 06:00. Try a previous period or wait for the next sync.` Hide the waterfall, donut, and breakdown table. Keep the trend sparklines (they show context from other periods).
- **Partial data** — e.g. revenue and labour sync but food cost doesn't. Render everything, show `—` in missing rows, and add a single bullet in the Attention panel: `Food cost data missing — connect accounting or upload invoices to complete the picture.`
- **No comparison data** — if the user picks a comparison period that has no data, disable the compare option in the dropdown with a muted tooltip `No data for this period`.

---

## Acceptance checklist

- [ ] Route exists at `app/financials/performance/page.tsx`
- [ ] Sidebar shows `Performance` under Financials between Budget vs Actual and Forecast
- [ ] Breadcrumb reads `Financials · Performance`
- [ ] Granularity toggle switches label format of the period picker correctly
- [ ] Month grid dropdown opens, closes on outside click and Escape
- [ ] Future periods are disabled (greyed in grid, `▸` disabled at current)
- [ ] Current month has indigo outline in grid
- [ ] Compare dropdown works, shows `No comparison` / `Previous period` / `Same period last year` / `YTD last year` / `Pick custom…`
- [ ] When compare is on, waterfall shows indigo dashed overlay on each bar
- [ ] When compare is on, breakdown table shows both periods + delta column
- [ ] When compare is on, hero mentions both periods in the headline
- [ ] Donut chart uses single-colour-different-opacity (no rainbow)
- [ ] Trend sparkline labels adapt to granularity (`12 MONTHS` / `12 WEEKS` / etc.)
- [ ] Attention panel shows 2–3 differentiated tone-coloured bullets
- [ ] All monetary values use `formatKr()` — no double `kr kr`
- [ ] No new npm dependencies
- [ ] No data model changes
- [ ] Uses `SyncIndicator` (not a custom sync pill)
- [ ] Keyboard navigable — Tab order makes sense, Escape closes dropdowns, arrows work in the month grid
- [ ] `npm run build` passes, no new lint warnings

---

## First message back

Before writing code:

1. Confirm you've read `@DESIGN.md` and this prompt
2. Report where each data source lives (revenue, labour, food cost, overheads) — file paths and the hook/endpoint names
3. Flag any data source that doesn't exist yet and propose the empty-state treatment
4. List the files you'll create and modify
5. Ask any clarifying questions

Then wait for my "go" before starting.

## Branch

Create `ux/phase-10-performance` off `main`. Work only on this branch. Do not merge to main — let me verify the preview first.
