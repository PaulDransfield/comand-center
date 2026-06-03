# Mobile Phase 1 — Step 0 investigation

**Captured 2026-06-03 on feature/mobile-phase1-responsive-system.**

---

## 1. Current responsive state

**No system today.** Ad-hoc per-page, single breakpoint where any exists (768px in AppShell for sidebar vs MobileNav). The tablet tier is missing entirely. Sweep numbers:

| | Count |
|---|---|
| Inline `gridTemplateColumns` (mostly desktop-shaped) | 65 |
| Fixed `maxWidth: 1280` (or similar) in page wrappers | 23 |
| `window.innerWidth - 120` chart-width hacks | 8 pages |
| Per-page `@media` queries (one-off inline `<style>`) | 3 pages |

### Working surfaces — patterns to extract

| Surface | Pattern |
|---|---|
| `/overheads/review` | `MOBILE_BREAKPOINT = 880` constant + `useState/useEffect` listener + `isMobile` flag → conditional flex/block layout. List + detail pane swaps to single-pane navigation on mobile. **The cleanest existing pattern.** |
| `app/page.tsx` (landing) | Direct `@media (max-width: 880px)` CSS in a `<style>` tag. Works but doesn't compose. |
| `/reviews` insights cards | Inline `<style>{`@media (max-width:680px){.cc-insights-grid{grid-template-columns:1fr !important}}`}</style>` — one-off, `!important` smell. |
| Anything using `repeat(auto-fit, minmax(X, 1fr))` | Auto-collapses by CSS grid. **Free responsiveness when used.** Overview KPI strip already does this. |

### Where it falls down

- **Chart widths**: `width={typeof window !== 'undefined' ? Math.min(window.innerWidth - 120, 1200) : 1100}` reads from window AT FIRST RENDER, doesn't update on rotate/resize. 8 pages.
- **Fixed pixel grids**: `repeat(7, minmax(120px, 1fr))` — 7 days × 120px = 840px minimum. Phone is 360-414px. Overflow.
- **Sticky banner stack**: BrokenIntegrationBanner + AiUsageBanner + SyncProgressBanner + ConsentBanner each `position: sticky; top: 0` competing — visual stacking only works on desktop because each is short; on mobile they wrap and overlap.

---

## 2. Banner root cause

`components/SyncProgressBanner.tsx` line 196: top flex row is `display: 'flex'; gap: 16` — children include a label, a `<JobRow>` flex group, an "Keep working" hint, and a Hide button.

**The bug**: each child uses `whiteSpace: 'nowrap'`. Each `<JobRow>` ALSO uses `whiteSpace: 'nowrap'` on every span (label, percent bar, percent number, detail text, ETA, error message). When viewport narrows, the children DON'T wrap — they overflow horizontally. The `flex: 1` `flex-wrap: wrap` on the middle container DOES wrap JobRows onto new lines, but each row itself is rigid-wide.

Compound: 4 sticky banners (Broken / AI usage / Sync / Consent) each set `top: 0; position: sticky` — only one can be at top, the others stack but each thinks it's at the top of the viewport. On mobile that means visual collision.

**Fix shape**: collapse banner to a single readable line on mobile (the 3px collapsed-state already exists — just default-collapse on mobile), wrap rich content on tablet, full content on desktop. Banners that aren't actively saying anything urgent become a single "syncing" pip in the rail/header rather than a strip.

---

## 3. Overview — what's already OK, what breaks

`app/dashboard/page.tsx` (1517 lines). Layout uses CSS-grid `repeat(auto-fit, minmax(…, 1fr))` for KPI cards and the "What's tunable" panel. **Already responsive for free.** What breaks at narrow widths:

- **Revenue/labour chart**: `width={window.innerWidth - 120}` set at render — frozen, doesn't update on rotate/resize.
- **7-day grid**: `gridTemplateColumns: repeat(${Math.min(days.length, 7)}, minmax(120px, 1fr))` — 840px floor, overflows phone.
- **Multi-card sections that look fine on desktop** stack to long scroll on mobile (intended — but should be one column not auto-fit).

The fix is mostly: replace ad-hoc grid with `<CardGrid>` primitive, replace chart with a `<ResponsiveChart>` that reads its own container width via `ResizeObserver`.

---

## 4. Conclusion → what Step 1 should build

The system is small but high-leverage. From the working patterns:

1. **Breakpoint tokens** (3 tiers): `mobile < 768`, `tablet 768-1023`, `desktop ≥ 1024`. Export as `BP.mobile`, `BP.tablet`, `BP.desktop` constants + a `useViewport()` hook that returns `'mobile' | 'tablet' | 'desktop'`.
2. **`<PageContainer>`** — wraps every page: `maxWidth: 1280; padding: 20px; mobile: 12px`. One source of truth for page chrome. Replaces 23 inline `maxWidth` blocks.
3. **`<CardGrid columns={…}>`** — accepts `{ mobile: 1, tablet: 2, desktop: 4 }`. Internally `repeat(auto-fit, minmax(…, 1fr))` with breakpoint-aware mins. Replaces 65 inline grids.
4. **`<MetricCardRow>`** — KPI strip wrapper. Always full-bleed on mobile (1 col), 2/3 on tablet, 4 on desktop.
5. **`<DataTable cards={true}>`** — table that swaps to card-per-row on mobile/tablet. Key columns become card title + meta; rest collapse into a "Details" expand. **The highest-leverage primitive** — fixes the recipe-editor ingredient table AND any future table.
6. **`<ResponsiveChart>`** — wraps the chart in a `ResizeObserver`-driven container; reads its own width. Replaces 8 `window.innerWidth` hacks.
7. **`<ProductThumb size="…">`** — already partially built (task #162); becomes one of the responsive primitives. Sizes are responsiveness.

**Regression guardrail** (so future pages don't regress):
- ESLint rule (`no-restricted-syntax` regex) flagging `maxWidth: 12\d{2}` and `width: \d{3,}px` outside `lib/constants/tokens.ts` and `components/ui/*.tsx`. Warns, doesn't error.
- `docs/LAYOUT.md` convention.

**Banner fix** (Step 2): on `mobile` tier, banner defaults to the existing collapsed 3px strip. On `tablet`, the rich content with `flex-wrap: wrap` on JobRow children (remove nowrap). On `desktop`, current layout.

**Overview rebuild** (Step 3): replace inline grids with `<CardGrid>`, replace chart with `<ResponsiveChart>`. Numbers + honest-incomplete states unchanged.

**Step 4** (PLAN ONLY, don't build): Scheduling grid (interaction redesign — one-day view on mobile; contributes `<ResponsiveGrid>` primitive). Recipe editor (DataTable consumer — card-per-row solves it). P&L (DataTable consumer). Items + remaining sweep-to-usable with existing primitives.
