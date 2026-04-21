# Fix prompt — Budget vs Actual

The previous FIX-PROMPT.md § Phase 4 already specified every problem on this page. None of those fixes landed. We're repeating them here, firmer.

Before starting, re-read `@DESIGN.md § 4. Budget vs Actual`. The removals listed there are **mandatory**. If the current page contains a UI element listed under "Remove", delete it. Do not reinterpret. Do not preserve for safety.

Stay on the same branch.

---

## 1. Delete the purple AI BUDGET COACH banner

The full-width purple gradient card with text `AI BUDGET COACH — Set a budget for this month (or click "Generate with AI") to see pacing + recommendations.` must be **deleted entirely**.

Where its message goes:
- The `Generate with AI` CTA already exists in the top-right corner of the page — that's the discoverable entry point. No banner needed.
- If the AI has a real observation once data is present, it becomes 1–3 bullets in an `AttentionPanel` at the bottom of the page, white card styling, same as the Group page's Needs your attention panel.
- Empty state (no budget set yet) — drop the banner entirely. The empty `NOT SET` pills on every row are already clear enough.

No purple. No gradient. No banner. Delete the JSX block that renders this card.

## 2. Delete every `Set` button

There are 12 `Set` buttons, one per row. Delete all of them.

Replacement behaviour:
- Each row is clickable (`cursor: pointer`) — clicking opens an inline editor or modal where the user sets the month's budget.
- On row hover, show a small pencil icon on the far right of the row at 40% opacity. That's the affordance.
- The `Generate with AI` button in the top bar handles bulk budget creation.

No visible Set button per row by default. If Claude Code is unsure how to wire the row click to the existing budget-setter component, ask first rather than restoring the buttons.

## 3. Delete the `+ Analyse` button on April

The `+ Analyse` button on April's row must go. Same pattern as Set — make the row clickable, put actions on hover or behind an overflow menu.

## 4. Fix the empty progress bars

Every row currently renders a faint dashed grey line where the bar should be. April has actual data (`26,115 kr`) but still shows a dashed line — the actual isn't being plotted.

Implementation per `DESIGN.md § 4`:

```tsx
const yearMaxBudget = Math.max(
  ...months.map(m => m.budget || 0),
  ...months.map(m => m.actual || 0),
  1
);

function BudgetBar({ actual, budget, status }) {
  // Full-width grey track
  // Tick mark at (budget / yearMaxBudget) position — vertical 2×14 px
  // Actual bar from 0 to (actual / yearMaxBudget) — green if actual >= budget, red if below
  // If no budget set, show just the track with no tick and no fill
  
  const budgetPct = budget > 0 ? (budget / yearMaxBudget) * 100 : null;
  const actualPct = actual > 0 ? (actual / yearMaxBudget) * 100 : 0;
  const fillColor = actual >= budget ? UX.greenInk : UX.redInk;
  
  return (
    <div style={{ position: 'relative', height: 14, background: UX.borderSoft, borderRadius: 3 }}>
      {actual > 0 && (
        <div style={{
          position: 'absolute', left: 0, top: 0, height: '100%',
          width: `${actualPct}%`,
          background: fillColor,
          borderRadius: '3px 0 0 3px',
          opacity: 0.85,
        }} />
      )}
      {budget > 0 && (
        <div style={{
          position: 'absolute',
          left: `${budgetPct}%`,
          top: -2, height: 18,
          width: 2,
          background: UX.ink1,
        }} />
      )}
    </div>
  );
}
```

For the current state (no budgets set, 1 month of actual on Apr):
- Jan / Feb / Mar / May through Dec: empty grey track, no tick, no fill. That's correct — "budget not set" text below is enough.
- Apr: grey track with a green fill proportional to `26 115 / yearMaxBudget`. Since yearMaxBudget = 26 115 (apr is the only non-zero), April's fill is 100%. Correct — April IS the year's max right now. No tick because no budget is set.

Once budgets are set, ticks appear. Once more months have actuals, April's bar shrinks proportionally.

## 5. Fix the broken label overlap on April's row

Currently April shows `act 26,115 kr Set` crunched together in the Variance column area. That's the label from the bar positioning colliding with a `Set` button that shouldn't exist anyway.

Once `Set` buttons are deleted per #2, position labels like this:
- Actual value label: right-aligned at the end of the actual fill, just outside the bar — `act 26 115 kr` at font-size 10, color greenInk
- Budget label: just to the right of the tick mark — `bud {X} kr` at font-size 10, color ink3
- If they'd overlap, only show the label for the element with the longer bar; hide the other

Labels must never overlap with each other or with other columns.

## 6. Verify the status tally matches reality

`0 On track · 0 Off track · 11 Not started` — but April has actual data (26 115 kr) and no budget. It's technically `0 on track, 0 off track, 11 not started, 1 logged without budget`.

Options:
- Add a fourth category: `1 No budget set` (grey dot)
- Or count April under "Not started" since no budget was set
- Or count April under "On track" since actual > 0 with no budget to fail against

Pick the honest framing. "Not started" is probably wrong — April has started. Prefer adding a fourth category. This keeps the tally accurate.

---

## One more thing

The hero text `All 1 logged month on track` is grammatically awkward. With one month, say `1 month logged — on track` or `April tracking on budget (no budget set yet).` Natural English beats template consistency when the count is 1.

---

## Verification

- [ ] No purple banner anywhere on this page
- [ ] No `Set` buttons on any row
- [ ] No `+ Analyse` button anywhere
- [ ] April's row renders a green-filled bar (no tick since no budget set)
- [ ] Other months render as empty grey tracks
- [ ] No overlapping labels on April's row
- [ ] Hero status tally is accurate (April isn't miscategorised)
- [ ] Row hover shows a pencil icon for editing; clicking the row opens the budget setter
- [ ] `Generate with AI` in top-right still works

Push to the same branch when done.

---

## Process note for Claude Code

Before moving on to the remaining pages (Forecast, Revenue, Staff, Scheduling, Departments), re-read `FIX-PROMPT.md § Phase 4` through § Phase 9 and confirm each removal listed there has actually been applied. The pattern across all remaining phases is the same — old UI survived alongside new UI. The fix is mostly **deletion work**, not new component writing.
