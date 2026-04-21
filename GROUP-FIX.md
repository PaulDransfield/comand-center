# Fix prompt — Group page round 2

The Group page is close but missing the visual elements that make the cards actually useful. Below is the exact gap list and how to close it. Stay on the same branch.

---

## 1. Add sparklines to every location card

Every location card needs a 7-day revenue sparkline under the headline revenue number, per `DESIGN.md § 2`. The card anatomy is:

```
┌──────────────────────────────┐
│ ● Location name       [pill] │  ← name + status pill same row
│   orebro                     │  ← small grey sub
│                              │
│   542 449 kr       ↓ 61.9%   │  ← headline value + delta same row
│                              │
│   ┌────────────────────────┐ │
│   │  sparkline 7 days      │ │  ← uses <Sparkline> component
│   └────────────────────────┘ │
│                              │
│   LABOUR        LABOUR %     │
│   309 850 kr    57.1%        │
│   MARGIN        REV/HOUR     │
│   42.9%         429 kr       │
└──────────────────────────────┘
```

Use the existing `Sparkline` component from `components/ui/Sparkline.tsx`. Pass 7 data points (last 7 days of revenue for that location). Tone: `good` (green) if week-over-week is up, `bad` (red) if down, `neutral` grey if flat or no comparison available. If the location has no data, render a dashed flat grey line.

**Data source:** reuse whatever query already powers the location's weekly revenue on other pages. Do not add a new API endpoint. If the hook doesn't exist, use the current daily_metrics data already fetched and slice the last 7 days.

## 2. Rosali Deli needs the delta row too

Vero Italiano shows `↓ 61.9%` right-aligned with its revenue. Rosali Deli has no delta at all. Every card must show the month-over-month delta, even if the number is extreme.

For Rosali (26 115 kr this month vs whatever it was last month), compute and show the delta with an arrow and percent. If `prev === 0`, show `↑ new` instead of dividing by zero. If the delta is extreme (> 500%), still show it — don't cap or hide.

## 3. Fix the OUTLIER pill layout

Current: the `OUTLIER` pill appears to be stretched to the full right edge of the card, making it look like a banner.

Expected: a tight pill, `padding: 2px 6px`, `font-size: 10px`, using `StatusPill` with `tone="bad"`. It should sit inline with the name, right-aligned:

```tsx
<div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
  <div>
    <span style={{ dot + name }}>● Rosali Deli</span>
    <div style={{ sub }}>orebro</div>
  </div>
  <StatusPill tone="bad">OUTLIER</StatusPill>
</div>
```

Use `StatusPill` from `components/ui/StatusPill.tsx`. Do not re-implement it inline.

## 4. AttentionPanel should have 2–3 bullets, not 1

Right now the `Needs your attention` panel has a single bullet repeating what the hero already said (`Rosali Deli — margin -774.5% on 26 115 kr — labour 874.5% is the swing factor.`). This duplicates the hero headline — if the attention panel only has one insight, and that insight is already the hero, it's redundant.

Generate 2–3 bullets covering different angles:

- **Bad tone (red bullet) — what to do:** `Rosali Deli — close, restructure, or cut labour to cover only. 228k kr spend on 26k kr revenue is unsustainable this month.`
- **Warning tone (amber bullet) — opportunity:** `Reallocate hours to Vero Italiano. At 429 kr/h efficiency, it could absorb ~40 Rosali hours for ~17k kr recovered revenue.`
- **Good tone (green bullet) — what's working:** `Vero Italiano carrying the group — 42.9% margin, 429 kr/h. Keep its current schedule pattern.`

These should come from the AI Group Manager, not be hardcoded. If the existing AI prompt only returns one observation, update the prompt to request 2–3 bullets covering (a) the biggest problem, (b) an opportunity or reallocation, (c) what's working. Keep each bullet ≤ 120 characters. English only.

## 5. Tighten the right-side supporting stats

The `REVENUE / LABOUR % / MARGIN` stats in the hero's right slot are colliding with the `< Apr 2026 >` period picker above. Add vertical padding or move the period picker into a proper top bar.

Preferred: the period picker belongs in the `TopBar` component with the breadcrumb, not floating above the hero. Move it there. The hero's right slot should contain only the 3 supporting stats.

## 6. Remove the `2 locations` subtitle under the REVENUE stat

The hero context already says `2 locations · 568 564 kr total · labour 94.7% · Rosali Deli margin -774.5%`. The `2 locations` under the REVENUE number in the supporting stats duplicates this. Delete the subtitle, keep just the number and label.

## 7. Check if Studio should be rendered

Earlier mockups had 3 locations. If your business list has Studio and it just isn't showing because of no data, render it as a third card with a disconnected state:

```
┌──────────────────────────────┐
│ ● Studio          [NO DATA]  │
│   orebro                     │
│                              │
│   —                          │
│   No sync in 14 days         │
│                              │
│   ┌────────────────────────┐ │
│   │  dashed grey line      │ │
│   └────────────────────────┘ │
│                              │
│   Last sync   6 Apr          │
│   POS         Disconnected   │
│                              │
│   Reconnect POS →            │
└──────────────────────────────┘
```

If Studio was intentionally removed from the location list, skip this — but confirm with me first rather than silently dropping it.

---

## Verification

- [ ] Every location card has a sparkline below the headline value
- [ ] Every location card has a month-over-month delta next to the revenue
- [ ] `OUTLIER` is a tight pill using `StatusPill`, not a banner
- [ ] `Needs your attention` has 2–3 tone-coloured bullets covering different angles
- [ ] Period navigator lives in the top bar, not floating above the hero
- [ ] No duplicated numbers (e.g. `2 locations` appears once, not twice)
- [ ] Studio rendered with disconnected state (or confirmed removed)
- [ ] English only in all AI output

Push to the same branch. Tell me when done so I can verify the preview.
