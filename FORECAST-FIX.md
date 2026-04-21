# Fix prompt — Forecast

This page is the closest to the mockup of anything shipped so far — the chart actually looks like a forecast chart. A few polish items remain, plus the global issues that persist.

Stay on the same branch.

---

## 1. Fix the `Sync now` status pill (global issue, final attempt)

Every page still shows this pattern in the sidebar:

```
Live · 2m …    [Sync now]
```

The truncated "2m …" with a separate "Sync now" button looks like a bug. Pick one treatment and use it everywhere:

**Preferred:** single compact indicator in the sidebar footer or top bar, green dot + text, no button:

```
● Synced 2m ago
```

Clicking the dot/text fires a sync (the existing `Sync now` handler). No separate button. If sync is in-progress, show `⟳ Syncing...` with a subtle spin on the icon.

Apply this everywhere. It's appeared in every screenshot so far across 4 pages and is the most consistent visual wart in the app.

## 2. April data point is misleading

The chart shows the actual line plunging from ~1.5M (Mar) to 0 (Apr) then jumping up to ~1M (May forecast). This reads as "April collapsed to zero."

Root cause options:
- **April is the current month in progress** — only part-month actuals are in. The line should indicate "month in progress" rather than drawing as if April already ended at that value.
- **April's data is missing/broken** — no data synced yet but the point defaults to 0.

Either way, the visual is wrong. Fix:

- **If current month:** render April as a hollow navy circle (unfilled, stroked) instead of a solid dot, with the label `Apr (in progress)` underneath. Don't draw the navy line from March to April — stop the solid line at March, let the dashed forecast line pick up from there.
- **If month is complete but value is tiny:** the dot is accurate; add a tooltip on hover explaining the drop (e.g. `Apr: 26 115 kr — down 98% from Mar`) and colour the dot red (tone: bad) per the spec's "tone-coloured dots" rule.

Right now it's neither — it's a solid navy dot at zero with no context. Pick the right treatment based on the data state.

## 3. Add the Forecast flags card below the chart

Per `DESIGN.md § 5`, a `Forecast flags` card lists months that look risky in the forecast. With the current data, candidates:

- **April (MISSED)** — if the actual is below the forecast for April, flag it red
- **November (AT RISK)** — the forecast dips significantly; if it's below the annual average margin, flag it amber with a one-line reason (seasonal, holiday staffing, etc.)
- **December (AT RISK)** — similar

Card structure:

```
┌────────────────────────────────────────────┐
│ Forecast flags — 3 months need attention   │
├────────────────────────────────────────────┤
│ 🔴 Apr  Missed forecast by 950k kr.        │
│         Labour overrun + food cost gap.    │
│ 🟡 Nov  Margin forecast 36% — 22pp below   │
│         annual average. Seasonal dip.      │
│ 🟡 Dec  Margin forecast 19.6% — lowest of  │
│         the year. Christmas overtime.      │
└────────────────────────────────────────────┘
```

Use the same `AttentionPanel`-style card styling used on Group and Overview. Tone-coloured bullets (red / amber / green). One line per flag, ≤ 120 chars. Auto-hide the card if there are zero flags.

If your forecast data doesn't include a flag/risk field, compute it client-side: any month where forecast margin is > 10pp below the year's average margin is `at risk`. Any month where actual is > 15% below forecast is `missed`.

## 4. Merge `Refresh forecast` into the location picker group

Currently `Refresh forecast` is a full-width button next to the `Vero Italiano` dropdown. Two controls competing for the same corner. Options:

- Replace with a small `↻` icon button next to the location dropdown. Tooltip on hover: `Refresh forecast`.
- Or move `Refresh forecast` into a menu — e.g. a `⋯` overflow beside the location picker.

The text button is fine functionally but visually heavy. Prefer the icon.

## 5. Add margin context to the hero

Current hero:
```
2026 FORECAST
Tracking to 12 394 208 kr revenue this year.
3 months actual · 9 months forecast
```

Better hero — adds the margin story so the hero actually answers "where are we projected to land":
```
2026 FORECAST
Tracking to 12 394 208 kr revenue · forecast margin 52%.
3 months actual (2 173 370 kr profit). May–Dec forecast 
assumes labour returns to 40% target.
```

Keep the right slot with YTD NET PROFIT and `3 months actual`. Or add a second stat: `FORECAST MARGIN 52%`.

## 6. Tone-colour the actual-month dots

Per `DESIGN.md § 5`, dots on the actual line should be tone-coloured:

- **Green** — month hit or exceeded its forecast
- **Amber** — within 10% of forecast, under target
- **Red** — missed forecast by more than 10%
- **Navy (default)** — forecast exists but no threshold breach

Currently all dots are solid navy. Update the dot rendering to pick a tone based on actual vs. forecast for that month. Pass the tone colour to the circle's `fill`.

The January and February dots currently appear green — check if that's intentional (correct tone) or accidental.

## 7. `Financials · Forecast` breadcrumb needs a separator

Currently reads `Financials Forecast` with very small spacing — the `·` separator from the `TopBar` spec isn't rendering. Confirm `TopBar`'s crumb array is being passed properly and the separator is getting inserted between items.

Also: Financials isn't bold (parent), Forecast isn't visually distinguishable as the active page. Active crumb should be weight 500, inactive should be ink3.

---

## Verification

- [ ] Sync status is a single clean indicator, no broken truncation + button combo
- [ ] April dot is either a hollow "in progress" marker OR tone-coloured with tooltip — not a silent solid dot at zero
- [ ] Forecast flags card appears below the chart with 1–3 tone-coloured bullets (or auto-hides if no flags)
- [ ] `Refresh forecast` is an icon button or overflow menu, not a full-width text button
- [ ] Hero mentions margin, not just revenue
- [ ] Actual-month dots are tone-coloured based on miss/hit vs forecast
- [ ] Breadcrumb shows `Financials · Forecast` with proper separator, active crumb bold

Push to the same branch when done.

---

## Note

This page is genuinely close to spec — good work on the chart. The items above are polish and the global `Sync now` issue. None of this requires data model changes.
