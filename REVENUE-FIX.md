# Fix prompt — Revenue

This is the best page shipped so far. The hero tells a real story, data is honest, and the right-column stack works. A handful of polish issues remain, plus the global sync pill and one spec miss on the daily breakdown table.

Stay on the same branch.

---

## 1. Sidebar shows `Synpd 5m ago` — broken truncation

Text is rendering as `Synpd` (letters dropped, possibly `Synced` truncated at a weird boundary). Same root cause as every other page — the sync pill is broken.

Fix globally per previous fix prompts:

```tsx
<span style={{ fontSize: 11, color: UX.ink3, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
  <span style={{ width: 6, height: 6, borderRadius: '50%', background: UX.greenInk }} />
  Synced {timeAgo}
</span>
```

No separate "Sync now" button. Click the text/dot to fire sync. Use ` · ` between status and time if needed for compactness. Never `Synpd`, never `Synced 2m…`, never truncated. If the container is too narrow, show just the dot with a tooltip.

This is the fifth page I've flagged this on. Please grep for all sidebar renderings and replace with a single shared component so the fix sticks everywhere.

## 2. Chart colors appear swapped

The chart legend shows `Food` with a dark/navy-ish swatch and `Beverage` with a green/indigo swatch, but looking at the bars themselves, the bright green (beverage?) is the larger portion and the dark (food?) is smaller. Given `FOOD VS BEVERAGE` card says food 264,837 kr (49%) and beverage 279,596 kr (51%), the bars and legend should reflect that split closely.

Audit: which color maps to which field in the chart series? Per spec:
- Food → `UX.navy` (dark)
- Beverage → `UX.indigo` or your chosen accent (lighter/bright)

Confirm the data key → color mapping matches the legend swatches and the values in the side card.

## 3. Add x-axis labels to the daily chart

The bar chart has no labels on the x-axis. A viewer can't tell which bars are which days without counting from the left. Fix options:

- Label every 5th day (1, 5, 10, 15, 20, 25, 30) — minimum viable
- Label today's bar with a small `↑ today` marker
- On hover, highlight the bar and show a tooltip with date + revenue + food/bev split

Minimum acceptable: labels every 5 days + highlighted "today" bar.

## 4. Remove the SOURCE column from Daily breakdown

The `SOURCE` column shows `pk_carne, pk_rosali_select, pk_bella, pk_brus, pk_ltaren…` etc. on every row. This was flagged in the original FIX-PROMPT § Phase 6 to remove. It's data provenance — useful for debugging, not for daily operations.

Delete the column. If provenance is sometimes needed, move it to a hover tooltip on the row or into a debug/admin panel.

## 5. Show top 5 days by default, not all 13

The Daily breakdown table currently lists every day of data (13 rows, all scrollable). Per spec:

- Default: sort by revenue descending, show top 5 rows
- Add `View full breakdown (13 days) →` link at the bottom of the card that expands the list inline or routes to a full page
- Each row already has the nice `% of total revenue` on some cells — apply that consistently once top-5 is in place

If the user wants chronological order (which is useful), add a small toggle at the top right of the card: `[Top days] | [Chronological]`. Default to top days.

## 6. Be consistent with the `(%)` annotations

Some cells show the percent-of-total in grey (e.g. `1,475 kr (24%)` on the takeaway column for Mon 20). Others don't. Pick one:

- **Preferred**: show `(% of total)` only on the REVENUE column, not on every sub-column. Too many % marks makes the table noisy.
- If keeping on sub-columns, apply consistently across all rows and all cells.

## 7. Hide empty columns

`COVERS` and `PER COVER` are `—` for every row except a handful. If < 50% of rows have data, hide the column entirely (or collapse behind a `Show all columns` toggle). An always-empty column is wasted horizontal space.

Same for `TIPS` if it's mostly empty.

Don't remove columns from the schema — just don't render them in the table when data is sparse.

## 8. Style `+ Log covers` as a clear button

Currently it reads like a text link, making it easy to miss. Style as a proper subtle button so the "missing data, click to add" affordance is obvious:

```tsx
<button style={{
  fontSize: 11, padding: '4px 10px',
  background: UX.indigoBg, color: UX.indigo,
  border: `0.5px solid ${UX.indigo}`,
  borderRadius: 6, cursor: 'pointer',
}}>
  + Log covers
</button>
```

Same styling pattern for any other inline "add missing data" CTA across the app.

## 9. Hero subtitle vs Channel Split card mismatch

Hero subtitle: `dine-in 3.3% / takeaway 1%`
Channel Split card: `Dine-in 179,545 kr (37%)`, `Takeaway 6,473 kr (1%)`

These numbers don't tell the same story. Possible issue:

- Hero might be quoting growth % (delta vs prev month) while card is quoting share %.
- Or the hero is picking up a wrong data field.

Either way, the user will read both and be confused. Fix:

- If hero subtitle is growth %, label it: `dine-in ↓ 3.3% · takeaway ↓ 99%` with arrows
- If it's share %, make sure the numbers match the card
- If one is wrong, fix the data source

Same numbers, different labels is fine. Different numbers with the same label is a bug.

## 10. Simplify chart title

Chart card title currently reads `Revenue — Apr 2026`. The breadcrumb already shows `Operations · Revenue · Apr 2026` context. The chart title can just be `Daily revenue` or drop the card title entirely.

If you want context in the card, put it as a subtitle: `30 days · 13 with data`.

---

## Verification

- [ ] Sidebar sync status uses a single component, renders as `● Synced Nm ago` everywhere, no truncation, no broken text
- [ ] Chart legend swatch colors match the actual bar colors and match the side card values
- [ ] X-axis labels visible (every 5th day minimum) + today highlighted
- [ ] No SOURCE column in the daily breakdown table
- [ ] Daily breakdown shows top 5 by default with `View full breakdown →` to expand
- [ ] Empty columns (COVERS/PER COVER if < 50% data) are hidden
- [ ] `+ Log covers` is a clearly-styled button
- [ ] Hero numbers match the side-card numbers, or are clearly labeled as something different
- [ ] Chart title doesn't duplicate the breadcrumb

Push to the same branch when done.

---

## Meta-observation for all remaining phases

This page is good evidence that Phase 6 onwards is landing closer to spec. If Phase 1–4 were largely "add new on top of old," Phase 6 is "replace old with new." The remaining pages (Staff, Scheduling, Departments) should follow this pattern — favour deletion over preservation where the spec says to remove something.
