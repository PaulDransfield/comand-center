# CommandCenter Rail Icons — Premium Set

The 7 sidebar nav icons + the floating Ask CC bubble, in the gradient-tile /
duotone "soft 3D" style. Inline SVG only — no images, no icon library. Verified
to compile under `strict` TypeScript and render via React SSR. Multiple
instances on one page are safe (gradient IDs are namespaced per instance via
`useId`).

## Files

- `RailIcon.tsx` — one component, `name` prop
- `RailIcon.module.css` — tile lift + idle / hover / click animations

Keep them side by side (e.g. `components/RailIcon/`).

## Why it's a client component

It starts with `"use client"` because each icon's SVG gradients/filters need
unique IDs (two icons sharing `id="tileLav"` would visually collide). `useId()`
namespaces every def per instance. There's no interactivity logic and no state —
just the render — so the client-JS cost is negligible. All motion is pure CSS.

## Names → nav

`insights · workforce · inventory · bookkeeping · alerts · ask · settings · chat`

`chat` is the floating Ask CC bubble (not in the rail). `alerts` uses the coral
tile; the rest use lavender. Exported as `RAIL_ICON_NAMES` / `RailIconName`.

## Usage

```tsx
import { RailIcon } from "@/components/RailIcon/RailIcon";

// rail item — hover/click motion fires from the <a>/<button> wrapper
<a href="/insights" aria-current={active ? "page" : undefined}>
  <RailIcon name="insights" label="Insights" />
</a>

// floating Ask CC bubble — bump the size
<button className="ask-fab" aria-label="Ask CC">
  <RailIcon name="chat" size={46} />
</button>

// header "Ask CC" button — small
<RailIcon name="ask" size={18} />
```

Default size is 42 (rail). `label` makes it accessible; omit for decorative.
`still` disables the idle loop but keeps hover/click. `prefers-reduced-motion`
disables all motion automatically.

## Active state

These are filled gradient tiles, not `currentColor` strokes — so the icon's
own color does NOT change with the parent. Show the active item with the rail
item's background (e.g. `var(--lav-fill)`), the way the live app already does:

```css
.railItem[aria-current="page"] { background: var(--lav-fill); }
```

The icon stays vivid in every state, which is the intended look.

## Restyling

Tile and accent colors are baked into the `<defs>` in `RailIcon.tsx`
(`tileLav`, `tileCoral`, `glyphHi`, `goldGrad`, `topLight`, `softShadow`).
Edit those stops to retune. They're deliberately not wired to CSS vars because
SVG gradient stops can't read CSS custom properties reliably across all
engines; keeping them inline guarantees consistent rendering.

## Motion summary

- Idle: sparkles twinkle, gear turns slowly, crate glints, chat dots type,
  tiles rest.
- Hover: tile lifts; glyph acts (insight line redraws + sparkle rises, people
  pop in, crate lid lifts, coin flips, alert shakes, sparkle spins, gear snaps).
- Click: tile presses in.
