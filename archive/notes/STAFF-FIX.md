# Fix prompt — Staff

Good page. Most of the structural work landed — top 5 default, real best/worst-day split, insights sidebar, clean hero. A few polish items, the chart bar colouring, and the perpetual sync pill.

Stay on the same branch.

---

## 1. Sidebar sync pill — this needs to be solved globally, not patch-by-patch

Current state: sidebar shows `Spued 5m ago` (a corrupted version of "Synced"). Previous pages have shown `Synpd`, `Synced 1…`, `Live · 2m …`, and `Syncd 2m ago`. This is the **sixth** different broken render of this one piece of UI.

Stop fixing it page by page. Fix it at the component level.

**Do this:**

1. Grep the codebase for every file that renders this sidebar sync indicator. Expected candidates: `Sidebar.tsx`, `SidebarV2.tsx`, `AppShell.tsx`, `AppShellV2.tsx`, and any per-page sidebar override.
2. Extract into a single component: `components/ui/SyncIndicator.tsx`.
3. Every page uses this one component. No custom inline renderings allowed.

```tsx
// components/ui/SyncIndicator.tsx
import { UX } from '@/lib/constants/tokens'

interface Props {
  status: 'synced' | 'syncing' | 'error' | 'offline'
  lastSyncAt?: Date
  onSync?: () => void
}

export function SyncIndicator({ status, lastSyncAt, onSync }: Props) {
  const color = {
    synced: UX.greenInk,
    syncing: UX.amberInk,
    error: UX.redInk,
    offline: UX.ink4,
  }[status]
  
  const label = status === 'synced' && lastSyncAt
    ? `Synced ${timeAgo(lastSyncAt)}`
    : status === 'syncing' ? 'Syncing…'
    : status === 'error' ? 'Sync failed'
    : 'Offline'
  
  return (
    <button
      onClick={onSync}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 8px',
        fontSize: 11,
        color: UX.ink3,
        background: 'transparent',
        border: 'none',
        cursor: onSync ? 'pointer' : 'default',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',       // NEVER truncate with …
      }}
      title={status === 'error' ? 'Click to retry sync' : 'Click to sync now'}
    >
      <span style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: color,
      }} />
      {label}
    </button>
  )
}

function timeAgo(d: Date): string {
  const mins = Math.floor((Date.now() - d.getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return d.toLocaleDateString('en-GB')
}
```

After you commit this component, send me a confirmation that every page in the app now uses it. I will check by loading each page and looking at the sidebar.

## 2. Colour the labour % bars by tier

Currently every bar in the chart looks red. The spec says:

- **Green (`UX.greenInk`)** — day's labour % ≤ target (40%)
- **Amber (`UX.amberInk`)** — 40% < labour % ≤ 70%
- **Red (`UX.redInk`)** — labour % > 70%

Thu 2 Apr is highlighted as BEST DAY at 30.8% — its bar should be green. Most days that are in the 50–65% range should be amber. Only the real offenders (like Mon 20 Apr at 162.9%) should be red.

Fix the bar fill colour logic to switch on value, not a single hardcoded colour.

## 3. Show the value above tall bars

Mon 20 Apr hit 162.9% — 4× the target. The bar towers over everything else but doesn't tell me the number without hovering or checking the callout card. The spec says bars > 100% should render the percentage as a label above.

Add to the chart rendering:

```tsx
{value > 100 && (
  <text x={barX + barWidth / 2} y={barY - 4} textAnchor="middle"
        fontSize={10} fontWeight={500} fill={UX.redInk2}>
    {Math.round(value)}%
  </text>
)}
```

This makes the outlier self-explanatory — someone scanning the chart sees `162%` floating above Mon 20 and knows what's up.

## 4. Fix the chart x-axis labels

The current axis has labels `1 2 3 4 5 6 7 8 9 10 11 12 13 14…` all jammed in sequentially. Fix with the same pattern Revenue page needed:

- Label every 5 days (1, 5, 10, 15, 20, 25, 30)
- Highlight today's bar with a slightly stronger stroke or a small `↑ today` marker
- On hover: tooltip showing date + labour % + labour kr + revenue kr

## 5. Remove the duplicate `All 18 staff →` link

The link appears twice: once in the top-right of the `Top 5 by cost` card header, and again as a centred link at the bottom of the rows. Pick one:

- **Preferred**: keep only the bottom centred link. It's the scanning pattern — eye sees top 5 names, drops to the bottom, sees "view more." Card header can be a plain `Top 5 by cost` title only.
- **Alternative**: keep only the top-right header link. Remove from bottom.

Either way, one link, not two.

## 6. Remove the search box from the default top-5 card

A search box on top of a 5-row table is confusing — typing `Sam` won't find `Sanna Beijer` because Sanna is in the visible 5 but Sam might not be. Or the user searches `Joakim` and gets no results because Joakim is in the 18 but not the 5.

Remove the search. It belongs on the "All 18 staff" expanded view only.

When the user clicks `All 18 staff →` and the table expands (or the page navigates to a full-staff view), the search box appears there.

## 7. Fill in `COST/HR` for every row

Many rows show `—` in COST/HR. This is computable: `cost / hours`. Both fields exist on every row (a row with cost has hours). No row should show `—` here.

Check the component — likely an early-return guard is hiding values when one edge condition is met. Remove it.

## 8. Label or remove the blue `OB` column values

Several rows show OB values in blue (`390 kr`, `317 kr`, `464 kr`, etc.). Blue typically = link. If they're clickable, add a hover underline and make the destination clear. If they're not clickable, use default colour — don't fake-link styling.

If clicking goes to an OB supplement detail view:
- Add `cursor: pointer`
- On hover: underline + `title="View OB details for {name}"`
- Or add a small `→` arrow icon

## 9. Optional — make the Highest cost day card actionable

The `HIGHEST COST DAY — Mon 20 Apr 162.9%` card currently shows the info but offers no next step. Add a small action link at the bottom:

```
HIGHEST COST DAY
Mon 20 Apr  162.9%
View schedule for that day →
```

The link routes to the scheduling page for that date. Turns the card from a report into something you can act on.

Only do this if the route exists — if there's no per-day scheduling page, skip this.

---

## Verification

- [ ] New `SyncIndicator` component exists at `components/ui/SyncIndicator.tsx`
- [ ] Every page imports and uses this component — no custom sidebar sync renderings anywhere
- [ ] Labour % chart bars are green/amber/red based on value, not all red
- [ ] Bars over 100% show the percentage label above them
- [ ] X-axis labels every 5 days, today highlighted
- [ ] Only one `All 18 staff →` link on the card, not two
- [ ] No search box on the default top-5 view
- [ ] COST/HR computed for every row, no `—` where cost and hours both exist
- [ ] OB column: either clearly-styled links or plain text, no fake-link styling
- [ ] Optional: Highest cost day card has a "View schedule" action link

Push to the same branch when done.
