# Mobile Phase 2+ — phased plan

Phase 1 (this branch, `feature/mobile-phase1-responsive-system`) shipped the responsive **system** — the 3 tiers, primitives (`<PageContainer>` / `<CardGrid>` / `<MetricCardRow>` / `<DataTable>` / `<ResponsiveChart>` / `<ProductThumb>` / `<Stack>` / `<Cluster>`), regression guardrail, banner fix, and rebuilt Overview as proof.

Phase 2 onward applies that system to the remaining hard surfaces. Each gets sized and labeled by approach (**simple breakpoint** = drop in primitives; **interaction redesign** = rethink how the surface works on small screens).

---

## Surface 1 — Scheduling grid (highest mobile-criticality)

**Approach**: interaction redesign + contributes a new primitive.

The current 2D matrix (days across, staff down) is intrinsically wide. You can't squeeze 7 days × 12+ staff into a 360 px viewport without losing the matrix.

**Mobile shape**: **one-day view**. The owner taps a day → sees that day's staff list as cards (staff name, hours, role, ±). Swipe left/right between days. Optionally a "Today" + "+1d / +2d" toolbar.

**Tablet shape**: 3-day matrix (today + 2 ahead). Compresses but doesn't squeeze.

**Desktop shape**: existing 7-day matrix unchanged.

**Primitive contribution**: `<ResponsiveGrid>` — a generic responsive 2D matrix that swaps to a 1D-card-per-cell on mobile. Useful later for any other matrix surface (weekly menu planning if/when that happens).

**Effort**: **~1.5 days** focused. The interaction redesign is the bulk; the data layer is unchanged.

---

## Surface 2 — Recipe editor (highest creative-use mobile-criticality)

**Approach**: simple-breakpoint via `<DataTable>` card-per-row.

The 14-column ingredient grid is the painful surface on mobile. `<DataTable cardsOn="mobile">` reduces it to one card per ingredient automatically — name + qty + unit + line cost on the card front, the rest (waste %, unit price, currency, edit pencil, ⚙) on a "Show details" expand.

The recipe editor already mounts `<EditItemModal>` on the ⚙ click. That continues to work on mobile (modal fills the screen).

**Headers**: collapsible sections (already done in current editor) stay; just the table body becomes card list.

**Primitive contribution**: none new — proves `<DataTable>` works on a complex case.

**Effort**: **~4 hours** focused. Mostly mechanical sed across `IngredientRow` to a `<DataTable>` declaration.

---

## Surface 3 — P&L (`/financials/performance`)

**Approach**: simple-breakpoint via `<DataTable>`.

Same pattern as Recipe editor — wide table → card-per-row. Primary column is the line item name; secondary columns (this month / last month / variance / %) become the card body. The waterfall + donut + sparkline trend cards already use `<CardGrid columns="auto" minWidth={…}>` patterns; just need the `<PageContainer>` swap.

**Effort**: **~3 hours** focused.

---

## Surface 4 — Items list (`/inventory/items`)

**Approach**: simple-breakpoint via `<DataTable>` + already has `<ProductThumb>` thumbnails when scraped.

The current items table has Name + Category + Unit Price + Latest Date + Change % + Status. Card form: thumb (small) + name as title; everything else as label/value pairs. Filter pills + Needs-attention chip remain at top.

**Effort**: **~2 hours** focused.

---

## Surface 5 — Prep list (`/inventory/recipes/prep`)

**Approach**: simple-breakpoint. The current grid (recipe row + portions input) is already mobile-narrow on the input. Wrap in `<PageContainer>`, replace any inline tables with `<DataTable>`. The product thumbnails are already wired (commit 7210c42).

**Effort**: **~1 hour** focused.

---

## Surface 6 — Order list (`/inventory/orders`)

**Approach**: simple-breakpoint via `<DataTable>` + thumbnails.

Same pattern as Items list. Per-supplier groups stay as section headers.

**Effort**: **~1.5 hours** focused.

---

## Surface 7 — Sweep across remaining pages

`/financials/*`, `/staff`, `/scheduling/grid`, `/scheduling/ai`, `/overheads`, `/revenue`, `/reviews`, `/notebook`, `/settings/*`, `/integrations`, `/invoices`, `/budget`, `/forecast`, `/alerts`, `/group`, `/weather`.

**Approach**: mechanical sweep. For each:
- Wrap in `<PageContainer>`
- Replace inline `gridTemplateColumns: 'repeat(N, …)'` with `<CardGrid>`
- Replace `window.innerWidth` chart sizing with `<ResponsiveChart>`
- Where there's a wide list/table → `<DataTable>`
- Run with the ESLint guardrail — it'll flag remaining hardcoded widths

**Effort**: **~5-6 hours** focused for the lot. Mostly find-replace; the guardrail catches what you miss.

---

## Phase ordering (recommended)

| Phase | Surface | Effort | Why this order |
|---|---|---|---|
| 2 | Recipe editor | 4 h | Highest chef-mobile-criticality + tests `<DataTable>` rigorously |
| 3 | Items + Order + Prep | 4.5 h | Same primitive; ships pictures + responsive together |
| 4 | Scheduling grid | 1.5 d | Owner mobile-critical; contributes new primitive |
| 5 | P&L | 3 h | Financial review surface — owner reads on phone |
| 6 | Remaining sweep | 5-6 h | One day for the lot |

**Total Phase 2-6**: ~3.5 days focused.

---

## What's already-ish responsive (sanity check)

These work mostly OK on mobile today and don't need urgent work:
- `/alerts` — list of cards, already auto-fit
- `/invoices` — list with filter + table; table needs `<DataTable>` but list flow works
- Sidebar (mobile nav at bottom on phone)
- Modals (`<Modal>` / `<Drawer>` from `components/ui/Overlay.tsx`) — already responsive

Surfaces that are landing-pages (no chrome) need `<PageContainer>` for consistency but aren't broken: `/login`, `/signup`, `/onboarding`, `/upgrade`, marketing pages.
