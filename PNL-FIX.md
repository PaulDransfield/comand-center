# Fix prompt — P&L Tracker

This page is closer to the spec than Group was. The `Edit` and `+ Add` buttons are gone, the purple AI banner is a clean white card now, and future months are properly dimmed. But the hero, the bar rendering, and a few structural issues still need work.

Stay on the same branch.

---

## 1. Remove the top blue `CommandCenter` bar

Same as global issue G1 from the previous fix. There's a thin blue bar at the top of the page with `CommandCenter` and a `← Dashboard` link. Delete it. The sidebar's own brand row is the only brand marker. Every page must look the same — find where this extra bar is rendered and remove it, not just hide it with CSS.

## 2. The hero is dishonestly optimistic

Current: `YTD margin 50.3% across 1 month.` with a green sparkline that implies growth.

Problem: 50.3% margin on 1 month of data where food cost is 0 kr (data gap, not real) isn't a real margin. The AI narrative below the hero even says `"that's a false win"`. The hero is contradicting its own AI commentary.

Rewrite the hero to be honest:

- Eyebrow: `YTD — 2026 · 1 MONTH LOGGED`
- Headline: `April margin 50.3% — but food cost is missing, so this isn't the real number.`
- Context: `1 month of data out of 12. Labour ate 49.7% of revenue (target 35%). Food cost shows 0 kr — likely a sync gap, not a win.`
- Right slot: keep `YTD PROFIT 13 133 kr` but drop the sparkline — a sparkline with 1 data point is noise. Replace with a supporting stat trio if you have the numbers, or leave blank.

## 3. Fix the monthly bar rendering

Current: April's bar is split into ~40% burnt-orange on the left and ~60% navy on the right, side by side.

Expected per `DESIGN.md § 3`: one horizontal bar per month, **width scaled to the year's maximum revenue**, with cost as an **overlay** at the left edge covering the `staff_cost / revenue` proportion.

Implementation:

```tsx
const yearMaxRev = Math.max(...months.map(m => m.revenue || 0), 1);
const fillPct = month.revenue / yearMaxRev * 100;   // how wide the bar is
const costPct = month.revenue > 0 
  ? (month.staff_cost / month.revenue) * 100         // of the month's own bar, not the year
  : 0;

return (
  <div style={{ position: 'relative', height: 14, background: '#f3f4f6', borderRadius: 3 }}>
    {/* revenue fill — navy, scaled to year max */}
    <div style={{
      position: 'absolute', left: 0, top: 0, height: '100%',
      width: `${fillPct}%`,
      background: UX.navy,
      borderRadius: '3px 0 0 3px',
    }} />
    {/* cost overlay — burnt, covering the first N% of the revenue fill */}
    <div style={{
      position: 'absolute', left: 0, top: 0, height: '100%',
      width: `${fillPct * costPct / 100}%`,   // cost as % of revenue, of year's max
      background: UX.burnt,
      borderRadius: '3px 0 0 0',
    }} />
  </div>
);
```

For April specifically: if Apr is the only month with data, `yearMaxRev === 26 115`, so Apr's bar fills 100% width. That's accurate — it IS the year's max. But when May through Dec fill in, Apr's bar will shrink proportionally. The bar should honestly show each month's scale against the others.

A month with zero revenue renders as just the grey track with no fill.

## 4. Fix the AI narrative truncation

The AI narrative ends with `...Revenue dropped vers...` which is a mid-word truncation. Either:

- **Option A — show it all.** Remove the character limit. The AI narrative can be 3-4 sentences; readability isn't hurt.
- **Option B — trim cleanly.** Cut at the last full sentence before the character limit. Never mid-word, never `...`.

Prefer Option A. The AI has already generated something useful; let the user read it.

Also remove the tiny `AI` pill in the top right of the card — the card's title `AI P&L — Apr 2026` already signals it's AI-generated. One signal is enough.

## 5. Make April expandable

Per `DESIGN.md § 3`, clicking a month with actual data should expand inline to show the daily breakdown for that month. April is the only month with data — so:

1. Add a small chevron (▸) to the left of the `Apr` label that rotates to ▾ when expanded.
2. Give the row `cursor: pointer`.
3. On click, expand a nested section below Apr's row showing day-by-day revenue / cost / margin for April.
4. Use the same bar pattern as the month row, scaled to April's max-daily-revenue.
5. Future months (May onwards) aren't clickable and don't show the chevron.

If the daily-breakdown data isn't in the response today, don't add a new fetch — instead, show a small "Daily breakdown not available" line inside the expansion. Ask first if you want to add a new daily endpoint.

## 6. Future months: show forecast values or drop the `forecast` label

Currently every future month row reads `May forecast`, `Jun forecast`, etc., but every column shows `—`. The `forecast` badge is writing a cheque the data can't cash.

Two options:

- **If forecast data exists** — populate the revenue / margin / profit columns with the forecast values (dimmed grey text, prefix `fc` like the mockup showed, e.g. `fc 58.5%`).
- **If forecast data doesn't exist** — remove the `forecast` label. Future months just show `May`, `Jun` etc. in grey.

Confirm which applies in your data and pick accordingly.

## 7. Move `Rosali Deli` and `2026` dropdowns into the top bar

Same as the Group fix #5. These dropdowns are floating in the top-right corner of the content area with no breadcrumb on the left. Move them into the `TopBar` component so they sit in a proper horizontal strip like:

```
Financials · P&L tracker                     [Rosali Deli ▾] [2026 ▾]
```

The `TopBar` component already exists from Phase 0 — use its `rightSlot` prop.

## 8. REVENUE VS COST column header is there but the first three rows show only a dashed grey line

Jan, Feb, Mar have no data and show `—` in revenue/margin/profit columns — that's correct. But their `REVENUE VS COST` cell shows a dashed grey line across the column. Drop the dashed line for zero-revenue months — show nothing. An empty cell is fine.

## 9. Optional — fix the sparkline colouring logic

The YTD sparkline in the hero (if you keep it against advice in #2) goes flat-then-up-then-down with green colour. If you're only showing 1 data point, this is synthetic. If you're keeping it for future months once they populate, fine — but default tone should be `neutral` grey until there are at least 3 months of data, then switch to `good`/`bad` based on trend.

---

## Verification

- [ ] No top blue `CommandCenter` bar on this page (or any page)
- [ ] Hero doesn't claim a win that the AI narrative contradicts
- [ ] Monthly bars scale to year max revenue, with cost as left-edge overlay on the revenue fill (not side-by-side)
- [ ] AI narrative shows in full or trims at a clean sentence boundary
- [ ] April (and any month with data) is expandable with a chevron
- [ ] Future months either show forecast values or drop the `forecast` label
- [ ] Period / location pickers live in the top bar, not floating
- [ ] Months with no data have an empty bar cell, not a dashed line

Push to the same branch when done.
