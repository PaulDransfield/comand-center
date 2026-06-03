# LAYOUT — responsive system (3 tiers, primitives, convention)

**Read this before building or editing any page.** The goal is that every page is responsive *automatically*, because it's composed from primitives that are responsive internally. You should rarely need to write a media query in page code.

---

## The 3 tiers (`lib/constants/breakpoints.ts`)

| Tier      | Width range  | Typical device                              |
|-----------|--------------|---------------------------------------------|
| `mobile`  | < 768 px     | phones, foldables, split-screen narrow      |
| `tablet`  | 768 – 1023   | iPad portrait, small laptops in split-screen |
| `desktop` | ≥ 1024 px    | full laptop / desktop                       |

**Tablet is first-class.** It's not "small desktop" or "big phone" — it's the middle, often a 2-column layout that sits between mobile (1-col stack) and desktop (3–4 col). When you design a page, draw all three tiers.

---

## Primitives (`components/ui/Layout.tsx`, `DataTable.tsx`, `ResponsiveChart.tsx`, `ProductThumb.tsx`)

Build pages **FROM** these. Never hand-roll fixed-width layout. Adding a new layout pattern? Add it here as a primitive, not in a page.

### `<PageContainer>`

Wraps every page. Provides max-width and breakpoint-aware padding. Replaces hand-rolled `<div style={{ maxWidth: 1280, padding: '20px 24px' }}>`.

```tsx
<PageContainer>
  …page content…
</PageContainer>
```

### `<CardGrid columns={…}>`

Responsive multi-column grid. Per-tier column counts OR `'auto'` for CSS auto-fit. Replaces every hand-rolled `gridTemplateColumns: 'repeat(…)' `.

```tsx
<CardGrid columns={{ mobile: 1, tablet: 2, desktop: 4 }}>…</CardGrid>
<CardGrid columns="auto" minWidth={280}>…</CardGrid>
```

### `<MetricCardRow>`

Specialised `<CardGrid>` for dashboard KPI strips. Default 1/2/4 across the tiers.

```tsx
<MetricCardRow>
  <KpiCard label="Revenue" value="…" />
  <KpiCard label="Food %"  value="…" />
  <KpiCard label="GP %"    value="…" />
  <KpiCard label="GP kr"   value="…" />
</MetricCardRow>
```

### `<DataTable columns={…} data={…}>`

The high-leverage primitive. Renders a table on desktop, **flips to card-per-row on mobile**. Mark one column `primary: true` (becomes the card title); columns marked `hideOnMobile: true` collapse into a "Show details" expand.

```tsx
<DataTable
  columns={[
    { id: 'name', header: 'Ingredient', primary: true, cell: r => r.name },
    { id: 'qty',  header: 'Qty', align: 'right', cell: r => r.qty },
    { id: 'unit', header: 'Unit', cell: r => r.unit },
    { id: 'cost', header: 'Line cost', align: 'right', cell: r => fmtKr(r.cost) },
  ]}
  data={ingredients}
  getKey={r => r.id}
  onRowClick={ing => openModal(ing)}
/>
```

**Use this for every list of N rows × M columns.** Recipe ingredients, items, prep lines, P&L rows, anything.

### `<ResponsiveChart>`

Render-prop chart wrapper. Replaces `width={window.innerWidth - 120}` everywhere. Reads its own container width via `ResizeObserver`.

```tsx
<ResponsiveChart minHeight={280}>
  {(width) => <OverviewChart width={width} height={280} data={…} />}
</ResponsiveChart>
```

### `<ProductThumb url={…} size="sm">`

One source of truth for every supplier-product image. Size variants: `xs` 20 / `sm` 28 / `md` 40 / `lg` 64 / `xl` 108. Silent fallback when url is null. Replaces every inline `<img>` of a product picture.

```tsx
<ProductThumb url={imageByProduct[pid]?.image_url} size="sm" alt={productName} />
```

### `<Stack gap={N}>` and `<Cluster gap={N}>`

Spacing primitives. `<Stack>` is vertical (replaces `flexDirection: 'column' + gap`), `<Cluster>` is horizontal-with-wrapping (replaces `flexWrap: 'wrap'`). Use these everywhere; they ensure consistent gap tokens.

### `useViewport()` hook

For layout decisions that CAN'T be expressed in CSS (swap pane to single-pane navigation, switch desktop UI for an inline mobile UI, etc.).

```tsx
const tier = useViewport()
if (tier === 'mobile') return <MobileLayout />
return <DesktopLayout />
```

**Prefer CSS primitives over `useViewport()`.** The primitives are SSR-friendly and don't cause layout shift on hydration.

---

## The convention (what you write, what you don't)

**Do**:
- Wrap every page in `<PageContainer>`
- Reach for `<CardGrid>` / `<MetricCardRow>` / `<DataTable>` / `<ResponsiveChart>` first
- Use `<Stack>` / `<Cluster>` for spacing
- Use `<ProductThumb>` for product images
- Use `BP`, `MIN_PX`, `MAX_PX` from `lib/constants/breakpoints.ts` if you need a media query

**Don't**:
- Hardcode `maxWidth: 1280` in a page (use `<PageContainer>`)
- Write inline `gridTemplateColumns: 'repeat(N, …)'` without a breakpoint plan (use `<CardGrid>`)
- Reference `window.innerWidth` for chart sizing (use `<ResponsiveChart>`)
- Write `<table>` directly for list data (use `<DataTable>`)
- Drop a new `<style>{`@media …`}</style>` inline (extend the primitives instead)

---

## The regression guardrail

`.eslintrc.cjs` includes a `no-restricted-syntax` rule that warns when page files contain:
- `maxWidth: 12\d{2}` in JSX style attributes (use `<PageContainer>`)
- `width: \d{3,}px` in JSX style attributes (use `<ResponsiveChart>` for charts; `<CardGrid>`/`flex: 1` for layout)

The rule **warns** rather than errors so legitimate exceptions (modal widths, tooltip sizes) aren't broken. Reviewer judges. The intent is to nudge — if you find yourself bypassing the warning twice on the same kind of layout, add a primitive instead.

---

## Phased adoption

Phase 1 (THIS BRANCH):
- ✅ System shipped (primitives + 3 tiers + guardrail + this doc)
- ✅ Banner fix
- ✅ Overview rebuilt from primitives (proof the system works)

Phase 2 onward (planned in `docs/investigation/mobile-responsive-step0.md` Step 4):
- Scheduling grid (interaction redesign — one-day view on mobile)
- Recipe editor (uses `<DataTable>` card-per-row)
- P&L (uses `<DataTable>`)
- Items + remaining sweep-to-usable

Every new page or major refactor from this point should be built FROM the primitives.
