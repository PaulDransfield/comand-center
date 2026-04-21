# CommandCenter — UX Redesign System

This document defines the visual language and layout patterns for CommandCenter. It is **purely a UX specification** — no data model, API, or business-logic changes. Any contributor applying this should modify only presentation layers (JSX, CSS, component structure), not data flow, schema, or endpoints.

> Read this top to bottom before touching any page. Every rule here exists because the current app breaks it somewhere.

---

## Non-negotiables (read first, break nothing)

1. **Do not change the data model.** No schema edits, no new API endpoints, no new fetches, no renaming of fields returned by existing endpoints. If a metric you need isn't in the response, show "—" and stop.
2. **Do not add npm dependencies.** No chart library, no icon library (no `lucide-react`, no `heroicons`), no component library (no `shadcn`, no `radix`). This app renders with inline `style={{}}`, raw SVG, and flex/grid. Keep it that way.
3. **Do not delete existing features.** If a page currently shows a metric, the redesign must still expose it — potentially behind a click or on a secondary panel, but not removed entirely.
4. **Additive tokens only.** Existing `lib/constants/colors.ts` and `app/globals.css` stay. Create a new `lib/constants/tokens.ts` alongside them.
5. **Work one page at a time.** Finish a page, commit, let the user verify in the browser, move on. Do not batch page redesigns.
6. **No new routes, no new pages.** Every page in this spec already exists at a known path under `app/`.

---

## The five principles

Every redesign decision must satisfy these:

1. **One page = one question.** Each page earns a single-sentence hero answering its implicit question ("Am I trading ahead this week?"). Not a grid of four equal KPI cards.
2. **Primary nav items ≤ 7.** The current 11-item sidebar collapses into 6 primary items with sub-nav inside Financials and Operations.
3. **Progressive disclosure.** Default view = summary + sparkline. Detail tables, daily breakdowns, and full staff lists hide behind `View all →` links or row expansion.
4. **Colour restraint.** Navy (brand) + indigo (AI/forecast accent) + semantic green/amber/red. Everything else becomes grey. No teal, no cyan, no purple gradients, no rainbow status pills.
5. **Sparklines over tables when direction matters.** A 48×16 px sparkline next to a row shows trend without needing a separate chart.

---

## Design tokens

Create `lib/constants/tokens.ts`. Do **not** modify the existing `colors.ts`.

```ts
// lib/constants/tokens.ts
// UX redesign tokens. Additive only — do not replace colors.ts.

export const UX = {
  // Surfaces
  pageBg:      '#f9fafb',
  cardBg:      '#ffffff',
  subtleBg:    '#fafbfc',
  border:      '#e5e7eb',
  borderSoft:  '#f3f4f6',

  // Text — use these, not raw hex inline
  ink1:        '#111827',  // primary — hero, KPI values, day names
  ink2:        '#374151',  // body copy
  ink3:        '#6b7280',  // secondary labels
  ink4:        '#9ca3af',  // tertiary, axis ticks, eyebrows
  ink5:        '#d1d5db',  // separators, disabled

  // Brand & accent
  navy:        '#1a1f2e',  // revenue bars, primary buttons, KPI values
  navyDeep:    '#0f1320',  // sidebar bg
  indigo:      '#6366f1',  // AI / forecast / predicted / links
  indigoLight: '#a5b4fc',  // predicted-stripe accent
  indigoBg:    '#eef2ff',  // light fill for AI tags
  indigoTint:  'rgba(99,102,241,0.14)',  // active nav state

  // Labour / cost — burnt orange (intentionally NOT the existing amber,
  // to distinguish from warning status)
  burnt:       '#c2410c',
  burntBg:     'rgba(194,65,12,0.28)',

  // Semantic — good / warning / bad
  greenInk:    '#15803d',
  greenBg:     '#dcfce7',
  greenBorder: '#bbf7d0',
  greenSoft:   '#eaf3de',
  amberInk:    '#d97706',
  amberBg:     '#fef3c7',
  amberBorder: '#fde68a',
  amberSoft:   '#faeeda',
  redInk:      '#dc2626',
  redInk2:     '#991b1b',
  redBg:       '#fee2e2',
  redBorder:   '#fecaca',
  redSoft:     '#fef2f2',

  // Margin line — brighter than CC_GREEN for contrast against navy bars
  marginLine:  '#16a34a',

  // Typography
  fsHero:      17,   // hero h1
  fsSection:   13,   // card titles
  fsBody:      12,   // default body
  fsLabel:     11,   // sub-labels, legend
  fsMicro:     10,   // eyebrow, column headers
  fsNano:       9,   // axis ticks

  fwMedium:    500,  // "bold" — headings, values, labels
  fwRegular:   400,  // body

  // Layout
  r_sm:        4,
  r_md:        6,
  r_lg:        10,
  sidebarW:    148, // expanded
  sidebarWCol: 52,  // collapsed icon-only

  shadowPop:   '0 8px 24px rgba(0,0,0,0.08)',
  shadowPill:  '0 1px 2px rgba(0,0,0,0.06)',
} as const
```

### Colour rules by role

| Role | Token | When |
|---|---|---|
| Revenue / primary bar | `navy` | Bars above zero; KPI values |
| Labour / cost bar | `burnt` | Cost bars below zero |
| Predicted revenue | `navy` × `indigo` 45° stripes, 8 px period | Future-day bars |
| AI suggestion / forecast whisker | `indigo` dashed | Comparison lines, forecast timelines |
| Margin / profit line | `marginLine` | Line overlay on charts |
| Status: good | `greenInk` text, `greenSoft` bg | Positive delta, GP ≥ 55%, "On track" |
| Status: warning | `amberInk` text, `amberSoft` bg | GP 30–55%, trending wrong direction, "At risk" |
| Status: bad | `redInk` text, `redSoft` bg | GP < 30%, labour > 70%, "Off track", "Needs action" |
| No data | `ink4` text, `ink5` dashed | Absent metrics |
| Active nav | `indigoTint` bg, white text, `indigoLight` icon | Sidebar current page |

**Never use in the redesign:** the existing `CC_GREEN #10b981` (replaced by `marginLine` and `greenInk` depending on context), purple gradient backgrounds, teal, cyan, pink.

---

## Layout shell

Every page uses the same shell:

```
┌─────┬────────────────────────────────────────────────┐
│Side │ Top bar: crumbs · period/location · sync       │
│bar  │ ────────────────────────────────────────────── │
│     │ Hero card (answers the page's question)        │
│     │ ────────────────────────────────────────────── │
│     │ Primary visual (chart or table)                │
│     │ ────────────────────────────────────────────── │
│     │ Supporting row (depts list + attention panel,  │
│     │                 or channel mix, or DoW summary) │
└─────┴────────────────────────────────────────────────┘
```

Implement the shell as `components/AppShell.tsx` if it doesn't exist. Pages consume it:

```tsx
<AppShell activeKey="overview">
  <TopBar crumbs={[{ label: 'Overview', active: true }]} rightSlot={<PeriodPicker/>}/>
  <PageHero eyebrow="THIS WEEK" headline={...} context={...} right={<SupportingStats ...//>}/>
  <PrimaryCard>{/* chart or table */}</PrimaryCard>
  <SupportingRow>{/* 1–2 cards */}</SupportingRow>
</AppShell>
```

---

## Shared components

### `components/Sidebar.tsx`

**Props:** `{ collapsed: boolean, onToggleCollapsed: () => void, activeKey: string }`

**States:**
- Expanded: 148 px wide, icon + label per item
- Collapsed: 52 px wide, icon only, tooltip on hover

**Nav structure (exactly 6 primary items + 1 utility + 1 user block):**

| Key | Label | Type |
|---|---|---|
| `overview` | Overview | primary |
| `group` | Group | primary |
| `financials` | Financials | primary (expandable) |
| `financials/pnl` | P&L tracker | sub |
| `financials/budget` | Budget vs actual | sub |
| `financials/forecast` | Forecast | sub |
| `operations` | Operations | primary (expandable) |
| `operations/revenue` | Revenue | sub |
| `operations/staff` | Staff | sub |
| `operations/scheduling` | Scheduling | sub |
| `operations/departments` | Departments | sub |
| `invoices` | Invoices | primary |
| `alerts` | Alerts | primary (with count badge when > 0) |
| `settings` | Settings | utility (bottom) |

**Icons:** inline SVG, 14×14, `stroke-width="1.2"`, stroke `currentColor`. Do not install an icon library. Keep the exact icon set consistent across pages.

**Active state:** `background: UX.indigoTint`, text white, icon `UX.indigoLight`.

**Hover state:** `background: rgba(255,255,255,0.04)`, text slightly brighter.

**Collapse persistence:** `localStorage.cc_sidebar_collapsed`, boolean. Default false (expanded).

**Location picker:** keep the existing business/location dropdown inside the sidebar near the top. Do not change its logic.

**Remove from current sidebar:**
- The nested "AI Assistant / Assistant / Studio" block with "BETA" pill — this belongs inline on pages that use AI, not in navigation
- The `Today 1/38` footer with arrow nav — this was prev/next navigation that's now in the top bar
- "Use it ago" meta text — meaningless in navigation

### `components/TopBar.tsx`

**Props:**
```ts
{ crumbs: { label: string, active?: boolean }[], rightSlot?: ReactNode }
```

Left: crumb trail like `Financials · P&L tracker` — last item weight 500, separators `·` coloured `UX.ink5`.
Right: freeform slot (period picker, W/M toggle, sync indicator, "Generate with AI" button).

Height: 40 px including margin. Font 12 px. No border under it — whitespace separates it from the hero.

### `components/PageHero.tsx`

```ts
{
  eyebrow: string
  headline: ReactNode   // single sentence, may contain <span>s for coloured deltas
  context?: string      // 1–2 sentences, ≤ 240 characters
  right?: ReactNode     // SupportingStats, a CTA, or a single big number
}
```

```tsx
<div style={{
  background: UX.cardBg, border: `0.5px solid ${UX.border}`,
  borderRadius: UX.r_lg, padding: '18px 20px', marginBottom: 14,
  display: 'grid',
  gridTemplateColumns: right ? '1fr auto' : '1fr',
  gap: 24, alignItems: 'center',
}}>
  <div>
    <div style={{ fontSize: UX.fsMicro, color: UX.ink4,
                  letterSpacing: '0.06em', marginBottom: 5 }}>
      {eyebrow}
    </div>
    <h1 style={{ fontSize: UX.fsHero, fontWeight: UX.fwMedium,
                 margin: '0 0 6px', lineHeight: 1.35, color: UX.ink1 }}>
      {headline}
    </h1>
    {context && (
      <div style={{ fontSize: UX.fsBody, color: UX.ink3, lineHeight: 1.5 }}>
        {context}
      </div>
    )}
  </div>
  {right && (
    <div style={{ paddingLeft: 20, borderLeft: `0.5px solid ${UX.border}` }}>
      {right}
    </div>
  )}
</div>
```

**Headline rules:**
- One sentence only. ≤ 14 words.
- Deltas inline, coloured by tone: wrap with `<span style={{ color: UX.greenInk }}>+4%</span>` for good, `UX.redInk` for bad.
- No emoji in the headline. No uppercase. No exclamation marks.

**Eyebrow rules:**
- Uppercase, letter-spacing 0.06em.
- Short temporal or scope context: `"THIS WEEK"`, `"APR 2026 · 18 DAYS OF DATA"`, `"2026 FORECAST"`, `"GROUP STATUS — APR 2026"`.

### `components/SupportingStats.tsx`

Replaces the 4-KPI-card row on every page. Lives in the hero's `right` slot.

```ts
{ items: Array<{
    label: string            // "Revenue"
    value: string            // "208 567 kr"
    delta?: string           // "↑ +4%"
    deltaTone?: 'good' | 'bad' | 'neutral'
    sub?: string             // "vs AI 200 500 kr"
  }>
}
```

Rendering: horizontal flex, gap 18 px, max 4 items. Each item:
- label: 10 px, `UX.ink4`, margin-bottom 2
- value: 14 px, weight 500, `UX.ink1`, `tabular-nums`
- delta: 10 px, coloured by tone
- sub: 10 px, `UX.ink3`

If `right` is not `SupportingStats`, it may be a single big number block (see P&L Tracker, Scheduling), a CTA, or nothing.

### `components/AttentionPanel.tsx`

Universal page footer. Replaces scattered "Best GP%", "Needs Attention", and "Insights" cards across current pages.

```ts
{ title?: string    // default: "Needs your attention"
  items: Array<{
    tone: 'good' | 'warning' | 'bad'
    entity: string  // "Carne", "Rosali Deli", "AI"
    message: string // one sentence, ≤ 120 chars
  }>
}
```

Card: white, 0.5 px border, radius 10, padding `12px 14px`.
Each row: 5 px bullet in tone colour, entity in weight 500 `UX.ink1`, message in `UX.ink2` 12 px. 0.5 px bottom border between rows except last.

Show max 4 items. If there are more, add `+ N more →` link at bottom.

### `components/Sparkline.tsx`

```ts
{ points: number[]
  tone?: 'good' | 'bad' | 'warning' | 'neutral'
  width?: number      // default 48
  height?: number     // default 16
  dashed?: boolean    // for forecast/no-data states
}
```

Single SVG line, stroke width 1.3, colour per tone (`greenInk`, `redInk`, `amberInk`, `ink4`). No axis, no labels, no markers. For "no data" render a single dashed horizontal line in `ink5`.

### `components/StatusPill.tsx`

```ts
{ tone: 'good' | 'warning' | 'bad' | 'neutral' | 'info'
  children: string }
```

Small uppercase pill, font 10 px, weight 500, letter-spacing 0.04em, padding `2px 6px`, radius 4.
- `good`: `greenBg` / `greenInk`
- `warning`: `amberBg` / `amberInk2` (#854F0B)
- `bad`: `redBg` / `redInk2`
- `neutral`: `#f3f4f6` / `ink3`
- `info`: `indigoBg` / `#4338ca`

Use sparingly — only when a row needs a badge like `OUTLIER`, `ON TRACK`, `OFF TRACK`, `NEEDS ACTION`, `AI`.

### `components/SegmentedToggle.tsx`

```ts
{ options: { value: string, label: string }[]
  value: string
  onChange: (v: string) => void }
```

Horizontal pill, inline-flex, 0.5 px border, white bg, padding 2. Active button: `UX.navy` bg, white text, radius 4, shadow `shadowPill`. Inactive: transparent, `ink3`. Used for W/M toggles and Compare toggles.

### `components/DayFilterCalendar.tsx`

Already specified in the earlier chart redesign prompt. Behavioural summary:
- Dropdown button shows current filter state: `All days` / `Weekdays` / `Weekends` / `6 Mar` / `N days`.
- Menu: Quick buttons (All / Weekdays / Weekends) + month calendar grid.
- Click toggles day; Shift+click extends range. Selection recomputes KPIs and fades non-matching bars.

---

## Per-page specifications

Each page inherits the shell. Only the hero, primary visual, and supporting row change.

### 1. Overview (`app/dashboard/page.tsx`)

**Question:** "Am I trading ahead this week, and where should I look first?"

**Hero:**
- Eyebrow: `THIS WEEK` (or `THIS MONTH` when `viewMode === 'month'`)
- Headline: `Trading <green>+4%</green> ahead of forecast, with labour running lean.` — numbers are dynamic; tone swaps to red if revenue is below forecast. If no forecast exists, fall back to `Revenue 208 567 kr, margin 143 936 kr this week.`
- Context: compare to forecast, call out weekend volume or weekday outlier
- Right: `<SupportingStats>` with Revenue / Labour / Margin (3 items, not 4)

**Primary visual:** the `OverviewChart` component (already specified in the chart redesign prompt — keep as is).

**Supporting row:** two cards side by side, grid `1fr 220px`:
- **Departments** card: condensed list of departments for the current period. 5 rows max (or fewer if there are fewer active). Each row: status dot · name · revenue kr · margin % · 7-day sparkline. `View all →` link routes to `/dashboard/departments`.
- **AttentionPanel** with 3 items max: worst department + trending-down dept + AI saving available.

**Remove:**
- The `NEXT 7 DAYS OREBRO` weather strip. Per-day weather already appears in the chart tooltip for future days.
- The top row of 4 KPI cards (Revenue 0 kr / Labour cost 0 kr / etc). The SupportingStats in the hero replace this and reflect the visible period.
- The P&L summary card at the bottom with the 4 CTA buttons (Staff / AI Assistant / Forecast / Tracker). These are navigation shortcuts that duplicate the sidebar.

### 2. Group (`app/group/page.tsx` or similar)

**Question:** "Which of my locations is doing best/worst?"

**Hero:**
- Eyebrow: `GROUP STATUS — {MONTH YYYY}`
- Headline: named outlier. E.g. `<red>Rosali Deli is draining the group</red> — 874 labour hours on zero revenue.` If no outlier, switch to best performer framing: `Vero Italiano carrying the group at 44.3% margin.`
- Context: total revenue across group, total labour %, group margin, and the most important one-line insight
- Right: omit (hero is already dense enough) or a single big stat like `Group margin 6.3%`

**Primary visual:** grid of location cards, `repeat(auto-fit, minmax(180px, 1fr))`. Each card:
- Location name + status dot
- `OUTLIER` / `BEST` / `NO DATA` pill
- Headline number (monthly revenue)
- Delta vs prev month
- 7-day sparkline
- 4-cell meta grid: Labour / Labour % / Margin / Covers (or Rev/hour)
- `warn` variant: `redBg` background, `redBorder`
- `best` variant: `greenBorder`

**Supporting row:** `AI Group Manager` card as a single `AttentionPanel`-styled block. Title: `AI Group Manager  [CLAUDE]` with a small `info`-toned pill. `Generated {date}` on the right. Bullets: 3 items max, tone-coloured.

**Remove:**
- The dense paragraph of AI summary prose (replaced by bullets).
- The 4-KPI card row (summarised in hero + cards).

### 3. P&L Tracker (`app/pnl/page.tsx`)

**Question:** "Are we profitable, month by month?"

**Hero:**
- Eyebrow: `YTD — {MONTH YYYY}`
- Headline: best/worst month contrast. E.g. `YTD margin <green>57.4%</green>, but <red>April crashed to 44.3%</red> on a labour spike.`
- Context: specifics driving the outlier
- Right: two-line block — `YTD PROFIT` label + big number + 12-month sparkline below (no axis, just shape)

**Primary visual:** monthly list as a table with custom rows. Columns: `MONTH | REVENUE VS COST (inline bar) | REVENUE (right) | MARGIN (right) | TREND (sparkline)`.
- Each month is one row with a horizontal inline bar showing revenue as dark navy and staff_cost as burnt overlay at the left. The bar's width is scaled to the year's max revenue.
- Click a month row → expands inline to show daily breakdown below as mini-rows with the same bar pattern.
- Future months render with `ink5` colours + `fc` prefix in the margin column (e.g. `fc 58.5%`).
- The current month gets `redSoft` or `greenSoft` background to flag if it's off/on pattern.

**Supporting row:** none beyond the inline daily drill-down.

**Remove:**
- The purple gradient "AI P&L" message box — this was the wall of prose. Condense to 1 sentence in the hero and 2 bullets in an optional `AttentionPanel` at the bottom.
- The 4-KPI card row.

### 4. Budget vs Actual (`app/budget/page.tsx`)

**Question:** "For each month, am I on or off budget?"

**Hero:**
- Eyebrow: `{YYYY} BUDGET`
- Headline: `<green>{N} of {M} months on track</green> — {MONTH} off target by <red>{kr}</red>.` Adapt when all are on/off.
- Context: YTD % delivered, the single biggest miss
- Right: status tallies — `On track N`, `Off track N`, `Not started N`, each with a coloured dot

**Primary visual:** 12-row list. Each row has an inline horizontal progress bar:
- Track background: `borderSoft`
- Actual bar: `greenInk` fill if on/ahead of budget, `redInk` if behind
- Budget target: 2×14 px vertical tick on the track where 100% of budget sits
- Labels: `act {kr}` + `bud {kr}` positioned on the bar
- Right columns: variance kr (coloured) + status pill
- Months with no data yet render dimmed with just the tick + `bud` label

**Supporting row:** none, or a compact `AttentionPanel` with the 2–3 months requiring attention.

**Remove:**
- The combined `FOOD COST / STAFF COST` column — split if needed or hide behind row expansion.
- `Edit` / `Analyse` buttons per row — move Edit into the row hover state and Analyse into a single "Analyse with AI" button at the top.
- The 3 top KPI cards.

### 5. Forecast (`app/forecast/page.tsx`)

**Question:** "Where are we projected to land, and what's risky?"

**Hero:**
- Eyebrow: `{YYYY} FORECAST`
- Headline: `Tracking to <green>{kr}</green> revenue — but <red>{month} is the weak spot</red> at {margin}% margin.`
- Context: where actual ends, where forecast begins, margin trend
- Right: `YTD NET PROFIT` block — label + big number + `{N} months actual` sub

**Primary visual:** single full-year line chart in one card.
- X axis: 12 month labels
- Y axis: revenue
- Navy solid line for actual months (Jan–{current})
- Indigo dashed line for forecast months ({current+1}–Dec)
- Light grey rectangle over the forecast region to reinforce the split
- Vertical "today" dashed line at the boundary with `today` label
- Dots coloured by tone — red for missed, amber for at-risk, navy for hit
- Tooltip on hover (reuse chart tooltip pattern from overview chart)

**Supporting row:** `Forecast flags` card — listing months that missed or are at risk. Each row: month label (red/amber), one-line reason, status pill (`MISSED` / `AT RISK`).

**Remove:**
- The 12-row table with triangle expand arrows.
- The 4 KPI cards and the `ACTUAL` / `FORECAST` badges — the chart's visual split replaces this.
- The strip of legend items at the bottom (`NOW / Current month / Actual values / Forecast values / Beat forecast / Missed forecast`) — too much vocabulary. Replace with the in-chart legend already covered: navy = actual, indigo dashed = forecast.

### 6. Revenue (`app/revenue/page.tsx`)

**Question:** "What did we sell, through what channels?"

**Hero:**
- Eyebrow: `{MONTH YYYY} · {N} DAYS OF DATA`
- Headline: `Revenue <red>down 61.7%</red> vs {prev month} — food dominant, takeaway has no data.` Swap to green when up.
- Context: split, best day callout, any missing data sources
- Right: `<SupportingStats>` with Revenue / Per cover / Days w/ data (3 items). If Per cover has no data, show `—` and use the sub line to say "No cover data" — do not hide.

**Primary visual:** daily stacked bars — navy (food) + indigo (beverage) — for the whole month. X axis is day 1 through 30/31, every 5th day labelled. No right-side mini chart — mix is in the bars themselves.

**Supporting row:** two cards side by side, grid `1fr 200px`:
- **Top revenue days** — 5 rows, each with rank · date · revenue · covers · food/bev mix mini bar. `Daily breakdown →` link to the full table.
- **Food vs Beverage + Channel** — stacked bar showing food/beverage split with % below each; channel section below shows Dine-in / Takeaway with "No data" in grey if not connected, and a `Connect POS channels →` action link.

**Remove:**
- 5 KPI cards → condensed to 3 in supporting stats.
- The large food/beverage horizontal bar at the right of the table — it's now inside the supporting row.
- The `SOURCE` column with cryptic `pk_bella, pk_carne` etc — this is provenance data that doesn't belong on the main view. Move to a tooltip or a debug view.

### 7. Staff (`app/staff/page.tsx`)

**Question:** "Is labour in range, and who's costing the most?"

**Hero:**
- Eyebrow: `LABOUR — {MONTH YYYY}`
- Headline: `Labour ran <red>57.6%</red> of revenue — <red>17.6pp over target</red>. {DAY} spiked to 126%.`
- Context: total labour kr, hours, shift count, delta vs prev month
- Right: `<SupportingStats>` — Labour / Hours / Late arrivals

**Primary visual:** daily labour % bars for the current month, with:
- Y axis 0% → ~150% (dynamic)
- Dashed green target line at 40%
- Bars coloured by tone: `greenInk` if ≤ target, `amberInk` if target < lab ≤ 70%, `redInk` if > 70%
- Bars > 100% get the percentage number printed above them
- X axis labels every 5 days

**Supporting row:** two cards side by side, grid `1fr 220px`:
- **Top 5 by cost** — 5 staff rows. Avatar initials · name + dept · hours · cost kr · kr/h pill (red if > 300). `All {N} staff →` link routes to `/staff/all` or expands the list.
- **Side column** — two stacked cards:
  - `Costly outlier`: single big label + date + sub ("126.1% labour · 7 324 kr rev")
  - `OB supplements`: total kr + shift count + late-arrivals mini rows

**Remove:**
- 18-row full staff table on default view.
- The 3-card Insights sidebar (consolidated into the side column).
- The `BEST GP%` / `NEEDS ATTENTION` banner row — move to `AttentionPanel` at the bottom if still needed.
- 4 KPI cards → 3 supporting stats.

### 8. Scheduling (`app/scheduling/page.tsx`)

**Question:** "Where am I overstaffed, and how much can AI save next week?"

**Hero:**
- Eyebrow: `NEXT WEEK — {DATE RANGE}`
- Headline: `AI can save <green>{kr}</green> — trim {days}, keep {days}.`
- Context: days analysed, lean days count, overstaffed days count, cuts-only policy reminder
- Right: `POTENTIAL SAVE` label + big green number + primary CTA button `Apply to schedule →`

**Primary visual:** two stacked cards inside the primary slot.
1. **By day of week** — 7 small tiles in a grid. Each tile: day label · value (kr/h) · status line. Status colouring uses the 3-tier `lean / on target / overstaffed` palette (green / white / amber). No-data days render dimmed. Legend below the grid.
2. **Week schedule** — 7 rows, one per day:
   - Columns: `DAY | YOUR PLAN vs AI SUGGESTION (side-by-side bars) | WEATHER | REVENUE | MARGIN | SAVE`
   - The YOUR PLAN vs AI bar is two thin horizontal bars stacked vertically: navy (top) = your plan hours, indigo (bottom) = AI hours, on a shared grey track. Label each with hour count.
   - Rows where AI suggests a cut get the `amberSoft` background.
   - No long text column — the info that was in the `WHY` column becomes a tooltip on hover of the row.
   - Bottom legend: swatches + `Total save: −{kr} across {N} days` aligned right.

**Supporting row:** none. Everything is above.

**Remove:**
- 4 KPI cards at top (subsumed into hero).
- The 7 coloured day-of-week cards that visually shouted (replaced by tighter grid).
- The `Weekly AI observations` banner promoting an upgrade — move to an unobtrusive footer link or empty state inside the DoW card.
- The `Method` explanation paragraph — move to a help icon beside the title that opens a popover.

### 9. Departments (`app/departments/page.tsx`)

**Question:** "Which departments drive margin, which drag it down?"

**Hero:**
- Eyebrow: `DEPARTMENTS — {MONTH YYYY}`
- Headline: `<green>{Best dept} {GP}% margin</green>, <red>{Worst dept} at {GP}%</red> — labour is the swing factor.`
- Context: total revenue, avg labour %, worst dept specifics
- Right: `<SupportingStats>` — Revenue / Profit / Rev/hour

**Primary visual:** one table with all departments (max 8 rows incl. "Total"). Columns:
- Status dot (1 px diameter, coloured by margin tier)
- DEPARTMENT name (with inline `NEEDS ACTION` pill if margin < 0)
- REVENUE (right)
- PROFIT (right, red if negative)
- GP% (right, coloured by margin tier)
- LABOUR % (right, coloured by labour tier — green ≤ target, amber to 70%, red > 70%)
- 30D sparkline (right)

Rows with margin < 0 get `redSoft` background. No-data depts render at 55% opacity with dashed sparkline. Total row pinned at the bottom with `subtleBg` background + top border.

**Supporting row:** `AttentionPanel` with 3 bullets — the departments needing action, trending-down depts, and any anomaly (like 100% margin depts that may need labour allocation).

**Remove:**
- 4 KPI cards + 2 banner cards (`BEST GP%` / `NEEDS ATTENTION`) → all consolidated into hero + in-row pill + attention panel.

---

## Cross-cutting behaviour rules

- **Numbers**: always `toLocaleString('en-GB')` then `.replace(/,/g, ' ')` for Swedish spacing; suffix ` kr`. Percentages one decimal. Hours one decimal or integer. Use `font-variant-numeric: tabular-nums` on all numeric cells and values for alignment.
- **Dates**: `en-GB`. Day names Monday-first. Short format like `Fri 10 Apr`, full format like `Friday 10 March`.
- **Empty states**: never show a broken chart or missing number without context. Show `—` with a muted colour and a `sub` line explaining ("No cover data", "POS disconnected"). Offer an action link when one is obvious (`Connect POS channels →`).
- **Loading states**: use a single low-contrast shimmer on the card being loaded. Do not spin. Do not block the whole page if only one card is loading.
- **Hover state on table rows**: subtle `subtleBg` background change only. Do not change text colour.
- **Click targets**: every clickable non-button element (dept row, month row, sparkline card) gets `cursor: pointer` and a subtle hover. Actions that drill in show a `→` after the label.
- **Focus state**: all interactive elements get a 2 px `indigo` focus ring. Do not remove default browser focus outlines without replacing them.
- **Accessibility**: every SVG chart gets `role="img"` + descriptive `aria-label`. Every bar group gets `tabIndex={0}` and keyboard activation (Enter / Space fires click). Dropdowns close on Escape.

---

## Files this redesign creates or modifies

**New files (additive only):**
- `lib/constants/tokens.ts` — the UX token block above
- `components/AppShell.tsx` — shared shell (if it doesn't exist)
- `components/Sidebar.tsx` — updated sidebar (may replace existing sidebar)
- `components/TopBar.tsx`
- `components/PageHero.tsx`
- `components/SupportingStats.tsx`
- `components/AttentionPanel.tsx`
- `components/Sparkline.tsx`
- `components/StatusPill.tsx`
- `components/SegmentedToggle.tsx`

**Modified per-page files:** only the `page.tsx` (or equivalent) for each of the 9 pages listed. No other source files should be touched.

**Not touched:**
- `lib/constants/colors.ts`
- `app/globals.css`
- any `api/` route
- any schema or migration file
- any test file (update tests only if a redesign moves a DOM structure a test depended on)

---

## When to ask the user

Ask before proceeding if you encounter any of these:

1. A page references a metric that isn't in the data response — confirm whether to hide it or show `—`.
2. A page has functionality not covered by this spec (e.g. a bulk export button on the Staff page) — confirm whether to keep/remove/move.
3. A component already exists with a similar name to one in this spec (e.g. `KpiCard`) — confirm whether to replace, extend, or leave.
4. The hero headline rule (≤ 14 words, one sentence) would truncate critical info — confirm a 2-sentence exception.
5. Routing for drill-in links (`View all →`) isn't obvious from the current routes.

Never guess when the answer affects what the user sees.
