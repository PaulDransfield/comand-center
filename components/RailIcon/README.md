# CommandCenter Rail Icons

The 8 sidebar nav glyphs + the floating Ask CC bubble, matched to the live app.
Pure inline SVG + CSS — no icon library, no motion library, no client JS.
Server-renderable. Verified to compile under `strict` TypeScript and render via
React SSR.

## Files

- `RailIcon.tsx` — one component, `name` prop
- `RailIcon.module.css` — colocated idle / hover / click animations

Keep them side by side (e.g. `components/RailIcon/`).

## Names → your nav

| `name`        | Rail item            |
| ------------- | -------------------- |
| `darkmode`    | crescent (theme toggle, top) |
| `insights`    | Insights / Overview  |
| `workforce`   | Workforce & scheduling |
| `inventory`   | Inventory setup      |
| `bookkeeping` | Bookkeeping          |
| `alerts`      | Warning / alerts     |
| `ask`         | Ask CC (✦ sparkle)   |
| `settings`    | Settings (gear)      |
| `chat`        | Floating Ask CC bubble (not in rail) |

Exported as `RAIL_ICON_NAMES` and `RailIconName`.

## Usage

```tsx
import { RailIcon } from "@/components/RailIcon/RailIcon";

// rail item — hover/click motion fires from the <a>/<button> wrapper
<a href="/insights" aria-current={active ? "page" : undefined}>
  <RailIcon name="insights" aria-label="Insights" />
</a>

// floating bubble — bump the size
<button className="ask-fab" aria-label="Ask CC">
  <RailIcon name="chat" size={26} />
</button>
```

### Active state

Strokes are `currentColor`. Set the active item's color and the glyph follows:

```css
.railItem[aria-current="page"] { color: var(--lav-deep); background: var(--lav-fill); }
```

### Motion

- Idle: gentle, always-on (moon sways, gear turns slowly, bubble dots type, etc.)
- Hover: fuller action (gear quarter-turn, triangle shakes + bang pops, box opens, sparkle spins)
- Click: scale pop
- `still` prop disables idle only; `prefers-reduced-motion` disables all motion.

## Token fallbacks

Accents read `--lav`, `--lav-deep`, `--lav-fill`, `--coral`, `--card`, with the
CommandCenter hex values baked in as fallbacks. If your token names differ, do a
find-replace in both files (the `v` map in the .tsx and the `var(...)` calls in
the .css).

## Note on the feature icons

The earlier set (sales, flash P&L, cash, forecast, reviews, etc.) maps to the
tabs/cards *inside* Insights, not the rail. Both kits share the same visual
language and can coexist — use this one for navigation, that one on the
dashboard.
