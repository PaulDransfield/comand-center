# CommandCenter UX Redesign — Claude Code Spec

> **Goal:** apply the new design system across all 12 views of the app **without touching data wiring, API routes, database queries, or component contracts.** The visual layer changes. Everything else stays.

---

## 0. Read Me First — Non-Negotiables

### Off-limits (do not modify)
- `app/api/**` — API route handlers
- `lib/db/**`, `lib/supabase/**`, any `*.sql` or migration files
- `.env*`, `next.config.*`, `middleware.ts`
- React Query hooks, SWR hooks, or any data-fetching logic (`useQuery`, `useSWR`, `fetch`, `getServerSideProps`, `loader`, etc.)
- Component **prop interfaces** — signatures must stay identical. If a component takes `{ data, loading, error }`, it still takes `{ data, loading, error }` after the redesign.
- Authentication / session logic
- Routing (keep URLs and file-based routes exactly as they are)
- Anything under `integrations/`, `services/`, or directories with external connector logic (Personalkollen sync, etc.)

### Fair game (change freely)
- JSX/TSX markup *inside* components (layout, element hierarchy for visual purposes)
- `className` values — Tailwind, CSS modules, or plain classes
- Global stylesheets (`globals.css`, `app.css`)
- Icon imports (swap emoji / generic icons for Lucide or FontAwesome)
- New presentation-layer components you create (e.g. `Pill.tsx`, `KpiCard.tsx`)
- Font loading setup (`next/font` config, `layout.tsx` font imports)
- `tailwind.config.*` — extending theme tokens

### Golden rule
**Before editing any file, read it first.** If a component wraps `useQuery` or maps over `data.items`, preserve that exactly. Only change how it *looks*, not what it *does*.

---

## 1. Reference Material

Open these side-by-side before starting:

| File | What it is |
|------|-----------|
| `commandcenter-v2.html` | The complete visual mockup, all 12 views switchable via sidebar. Source of truth for tokens, spacing, typography, and every component pattern. |
| Current app screenshots | What exists today. Each screen maps 1:1 to a view in the mockup. |

When in doubt, inspect the mockup in a browser and read its CSS. Every decision is already made there.

---

## 2. Recon Phase — Run These First

Before writing any code, map the existing structure:

```bash
# 1. Identify styling approach
ls src/ app/ 2>/dev/null
cat package.json | grep -iE "tailwind|styled|emotion|stitches|vanilla-extract|css-modules"

# 2. Identify component library
cat package.json | grep -iE "shadcn|radix|headlessui|mantine|chakra|mui"

# 3. Find all pages
find app/ src/app/ src/pages/ pages/ -name "page.tsx" -o -name "index.tsx" 2>/dev/null

# 4. Find icon imports currently in use
grep -rE "from ['\"](lucide-react|@heroicons|react-icons|@fortawesome)" src/ app/ 2>/dev/null | head -30

# 5. Find emoji in JSX (these need replacing)
grep -rnE "(📊|⏰|🔔|📧|✓|→)" src/ app/ 2>/dev/null

# 6. Check current font setup
grep -rE "next/font|@import.*fonts" src/ app/ styles/ 2>/dev/null
```

**Report back** what you found before starting Phase 3. Specifically: styling approach (Tailwind? CSS modules?), whether shadcn/Radix primitives are in use, and where the existing design tokens live (if any).

---

## 3. Setup Phase — Dependencies & Fonts

### 3a. Install icon library (pick ONE based on what's already installed)

- If `lucide-react` is already in the project → **use it**. It has every icon we need.
- If `@fortawesome/*` is already in the project → use that.
- If neither → install `lucide-react`:
  ```bash
  pnpm add lucide-react    # or npm / yarn
  ```

> Do **not** add both. Pick one and stick to it app-wide.

### 3b. Icon mapping reference

The mockup uses FontAwesome class names. Here's the Lucide equivalent for every icon used:

| Where | FontAwesome | Lucide |
|-------|-------------|--------|
| Sidebar: Overview | `fa-grip` | `LayoutGrid` |
| Sidebar: P&L | `fa-chart-line` | `TrendingUp` |
| Sidebar: Budget | `fa-bullseye` | `Target` |
| Sidebar: Forecast | `fa-flag` | `Flag` |
| Sidebar: Revenue | `fa-sack-dollar` | `Wallet` |
| Sidebar: Staff | `fa-user-group` | `Users` |
| Sidebar: Scheduling | `fa-calendar-days` | `CalendarDays` |
| Sidebar: Departments | `fa-layer-group` | `Layers` |
| Sidebar: Invoices | `fa-file-invoice` | `FileText` |
| Sidebar: Alerts | `fa-bell` | `Bell` |
| Sidebar: AI Assistant | `fa-comment-dots` | `MessageCircle` |
| Sidebar: AI Studio | `fa-wand-magic-sparkles` | `Wand2` |
| Sidebar: Integrations | `fa-plug` | `Plug` |
| Sidebar: Settings | `fa-gear` | `Settings` |
| Sidebar: Upgrade | `fa-arrow-up-right-from-square` | `ArrowUpRight` |
| AI header sparkle | `fa-sparkles` | `Sparkles` |
| Upload icon | `fa-file-arrow-up` | `FileUp` |
| Studio: Custom Reports | `fa-chart-column` | `BarChart3` |
| Studio: Scheduled Insights | `fa-clock` | `Clock` |
| Studio: Smart Alerts | `fa-bell` | `BellRing` |
| Studio: Email Digests | `fa-envelope` | `Mail` |
| Trend up | `fa-arrow-trend-up` | `TrendingUp` |
| Trend down | `fa-arrow-trend-down` | `TrendingDown` |
| Trophy | `fa-trophy` | `Trophy` |
| Warning | `fa-triangle-exclamation` | `AlertTriangle` |
| Check | `fa-check` | `Check` |
| Info | `fa-circle-info` | `Info` |
| Refresh / sync | `fa-arrows-rotate` | `RefreshCw` |
| Export / download | `fa-arrow-down-to-line` | `Download` |
| Calendar | `fa-calendar` | `Calendar` |
| Chevron left/right/down | `fa-chevron-*` | `Chevron*` |
| Search | `fa-magnifying-glass` | `Search` |
| Filter | `fa-filter` | `Filter` |
| Edit | `fa-pen` | `Pencil` |
| Plus | `fa-plus` | `Plus` |
| Ellipsis | `fa-ellipsis` | `MoreHorizontal` |
| Light bulb | `fa-lightbulb` | `Lightbulb` |
| Sign out | `fa-right-from-bracket` | `LogOut` |
| Arrow up (in composer) | `fa-arrow-up` | `ArrowUp` |

### 3c. Load Hanken Grotesk

In `app/layout.tsx` (App Router) or `pages/_app.tsx` (Pages Router):

```tsx
import { Hanken_Grotesk } from 'next/font/google'

const hanken = Hanken_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-hanken',
})

// apply to <html> or <body>: className={hanken.variable}
```

Set `font-family: var(--font-hanken), -apple-system, sans-serif;` in global CSS, or wire it through Tailwind config.

---

## 4. Design Tokens

Add these to `globals.css` (or extend your Tailwind theme). These come straight from the mockup — do not change values.

```css
:root {
  /* Surfaces */
  --bg: #f5f6f8;
  --surface: #ffffff;
  --surface-muted: #fafbfc;
  --surface-hover: #f0f1f4;
  --border: #e7e9ee;
  --border-strong: #d5d8df;

  /* Text */
  --text-primary: #131519;
  --text-secondary: #5f6570;
  --text-muted: #9aa0ab;

  /* Semantic */
  --good: #2abf92;       --good-bg: #d4f2e9;
  --bad:  #f25151;       --bad-bg:  #fcdcdc;
  --warn: #e8a23b;       --warn-bg: #fcedd4;
  --info: #3b6ee6;       --info-bg: #dfe8fc;
  --ai:   #7c6ef0;       --ai-bg:   #ebe7fc;

  /* Departments (stay stable across app) */
  --dept-bella:    #e8a23b;
  --dept-carne:    #f25151;
  --dept-chilango: #2abf92;
  --dept-olbaren:  #3b6ee6;
  --dept-rosalis:  #e86d3e;
  --dept-brus:     #f5b844;

  /* Sidebar (dark) */
  --side-bg:      #14172a;
  --side-surface: #1a1e35;
  --side-border:  #272c4d;
  --side-text:    #e5e7ed;
  --side-muted:   #8b92a8;
  --side-hover:   rgba(255,255,255,0.05);
  --side-active:  rgba(255,255,255,0.08);

  /* Elevation */
  --shadow-xs: 0 1px 2px rgba(16,24,40,0.04);
  --shadow-sm: 0 1px 3px rgba(16,24,40,0.06), 0 1px 2px rgba(16,24,40,0.04);
  --shadow-md: 0 4px 12px rgba(16,24,40,0.08);

  /* Radius */
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 14px;
}
```

If using Tailwind, mirror these in `tailwind.config.ts` under `theme.extend.colors`, `theme.extend.boxShadow`, `theme.extend.borderRadius`. Keep the CSS variables too — some components will reference them directly (inline `style` attrs on dynamic bar widths, etc.).

### Typography rules
- All UI text: Hanken Grotesk
- All financial figures: add `font-variant-numeric: tabular-nums;` (makes digits align vertically in tables — critical for money)
- Label text (uppercase eyebrow labels on KPI cards): `font-size: 11px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-muted);`
- Page titles: `font-size: 24px; font-weight: 700; letter-spacing: -0.025em;`
- KPI values: `font-size: 22px; font-weight: 700; letter-spacing: -0.025em;`
- Huge numbers (hero values): `font-size: 30px; font-weight: 800; letter-spacing: -0.035em;`

---

## 5. Primitive Components — Build These First

These are the reusable building blocks. Create them in `components/ui/` (or wherever your existing primitives live — match the pattern). Build them all *before* touching any page — then pages become a matter of composition.

### 5.1 `<Pill>`
Tiny rounded badge used everywhere for status, percentages, and categories.
```tsx
type PillVariant = 'good' | 'bad' | 'warn' | 'info' | 'neutral' | 'dept-bella' | 'dept-carne' | /* etc */
interface PillProps {
  variant: PillVariant
  icon?: React.ReactNode
  children: React.ReactNode
}
```
Reference markup in mockup: class `.pill.good`, `.pill.warn`, etc.

### 5.2 `<Delta>`
Small percentage-change indicator with up/down arrow.
```tsx
interface DeltaProps {
  value: number       // e.g. 8.2 means +8.2% up; -3.1 means -3.1% down
  variant?: 'good' | 'bad' | 'warn' | 'neutral'  // override auto-detection
  suffix?: string     // e.g. "vs last week"
}
```

### 5.3 `<KpiCard>`
The stat card used on every page header.
```tsx
interface KpiCardProps {
  label: string
  value: React.ReactNode         // allows "175 794" + <span className="unit">kr</span>
  valueTone?: 'default' | 'good' | 'bad'
  tag?: { label: string; variant: 'actual' | 'forecast' | 'now' }
  footer?: React.ReactNode       // delta + context text
}
```

### 5.4 `<Card>` / `<CardHeader>` / `<CardBody>`
Standard white rounded container. If you already have shadcn `Card`, extend it — don't rebuild.

### 5.5 `<PageHeader>`
The crumb + title + subtitle + right-side filters layout that every view uses.
```tsx
interface PageHeaderProps {
  crumb?: string
  title: string
  subtitle?: string
  actions?: React.ReactNode   // filter chips, export buttons
}
```

### 5.6 `<Chip>` / `<SegmentedControl>` / `<DateNav>`
Right-side toolbar primitives.

### 5.7 `<Callout>`
The alert boxes with icon + title + body.
```tsx
interface CalloutProps {
  variant: 'good' | 'bad' | 'warn'
  icon: React.ReactNode
  title: string
  eyebrow?: string     // small uppercase before title
  children?: React.ReactNode
}
```

### 5.8 `<SplitBar>` ⭐ CORE NEW COMPONENT
The "cost vs income" visual line used in the Departments tables. Revenue split between labour and gross.
```tsx
interface SplitBarProps {
  labourPct: number       // 0-100
  grossPct: number        // 0-100 (grossTone auto-derived from GP%)
  grossTone?: 'good' | 'warn' | 'bad'   // >50% good, 30-50 warn, <30 bad by default
  grossAmount?: string    // "6 099 kr" shown as legend below
}
```
Reference: `.split-bar` / `.split-cell` / `.gross-seg` in mockup.

### 5.9 `<DataTable>` wrapper
Table with sticky header, right-aligned numerics, hover states, total row. If shadcn `Table` exists, apply the design-token classes to it rather than rebuilding.

### 5.10 `<Sidebar>` + `<SideLink>` + `<WorkspaceSwitcher>` + `<SyncStatus>` + `<AiSidebarSection>`
Preserve the dark navy treatment exactly as in the mockup. The sidebar is single-file — one component that renders the whole left rail.

---

## 6. Key Design Patterns

### Pattern: Revenue breakdowns always show cost vs income
Any table listing things that earn money (departments, shifts, products) should have a **Cost vs Income** column with `<SplitBar>` and the GP% pill next to it. This is the signature pattern of the app.

### Pattern: Status semantics
- **Good (green)** = desirable state — high margin, high revenue/hour, on target, active
- **Warn (amber)** = attention needed — overstaffed, over-budget, approaching threshold
- **Bad (red)** = problem — very low margin, critical alert, late
- **Info (blue)** = forecast / AI-generated value, informational
- **Neutral (gray)** = no data yet, pending, informational-only

**Critical:** on the Scheduling page, "Understaffed / High efficiency" = **good** (green). High revenue per labour hour is the goal. Do not use red for this state. Only "Overstaffed" gets amber.

### Pattern: Tabular numerics
Every cell with numbers (prices, percentages, hours, counts) needs `font-variant-numeric: tabular-nums`. In Tailwind: `tabular-nums` class or `font-feature-settings: 'tnum'`.

### Pattern: Department color consistency
Each department (Bella, Carne, Chilango, Ölbaren, Rosalis, Brus) has a fixed color defined in tokens. Use `<span className="dept-dot" style={{ background: deptColor(name) }} />` before department names in tables so they're recognizable at a glance.

### Pattern: Empty states
When a card/table has no data, use the `<EmptyState>` component (check mark icon in light-tint circle, heading, single line of supporting text, optional CTA chip). See Invoices and Alerts views in mockup.

### Pattern: Professional icons only
Zero emoji in JSX. The AI Studio cards in particular were rendering 📊 ⏰ 🔔 📧 — these are now `BarChart3` / `Clock` / `BellRing` / `Mail` with colored-tint backgrounds.

---

## 7. Page Migration Plan

Work in this order. Each page is a separate PR.

| # | View | Current state | Key changes |
|---|------|--------------|-------------|
| 1 | **Overview** | Orange stacked bars + dept table + P&L summary | Add `<SplitBar>` in dept table, add gross line visual in P&L card, professional icons |
| 2 | **P&L Tracker** | Monthly table w/ expandable Apr row | Apply new table styling, highlighted Apr row with warm tint, pill for margin |
| 3 | **Budget vs Actual** | Mostly empty shell | New empty state with "Set 2026 budgets" CTA |
| 4 | **Forecast** | Full year table, NOW marker | Purple "Forecast" pill, `ai` colored values, orange NOW tag, highlighted Apr row |
| 5 | **Revenue** | Weekly bars + daily table | Calmer single-color bars, source tags styled |
| 6 | **Staff** | Red labour% bars + staff table + insights | Target line on chart, best/highest callouts, insights panel on side |
| 7 | **Scheduling** ⭐ | Multi-colored bar chart | **Replace bar chart with `<DataTable>`.** Flip understaffed to good, overstaffed to warn. Rename "Best/Worst Weekday" → "Most/Least Efficient Day". See mockup for exact columns (Day · Avg Revenue · Avg Hours · Rev/Hr · vs Avg · Status · Days). |
| 8 | **Departments** ⭐ | Bar chart + table | **Remove bar chart entirely.** Table with `<SplitBar>` column matching Overview layout. |
| 9 | **Invoices** | Upload zone + empty table | Styled upload dropzone with `FileUp` icon, tab bar with counts, empty state |
| 10 | **Alerts** | Empty "All clear" state | Green check-in-circle, refined typography |
| 11 | **AI Assistant** | Chat w/ suggested prompts | CC-mark hero icon (not sparkle), pill-shaped prompt buttons with icons, sticky composer at bottom with pill shape |
| 12 | **AI Studio** ⭐ | 4 emoji cards | **Replace all emoji with Lucide icons** in colored-tint rounded squares (info blue, warn amber, bad red, good green) |

⭐ = pages that changed structurally during our mockup review. Pay extra attention.

### Per-page workflow
1. Read the existing page component top to bottom. Note every hook, prop, and data binding.
2. Sketch: "these data points show up on screen, here's how they map to the mockup."
3. Refactor the JSX to use new primitives and tokens. **Do not change**:
   - What hooks are called
   - What props they pass
   - What data fields they render
   - Route paths and file locations
4. Side-by-side compare: old page at `localhost:3000/foo`, new page on branch. Data should be identical, visuals should match mockup.
5. Commit with a message like `feat(ux): redesign <page-name> — visuals only`.

---

## 8. Testing / QA Checklist

After each page, verify:

- [ ] Loads with no console errors
- [ ] All data values that were visible before are still visible (numbers, labels, names)
- [ ] Loading state still works (mimic slow network in DevTools)
- [ ] Empty state still works (point to an empty workspace or mock empty response)
- [ ] Error state still works if one exists
- [ ] All interactive elements still fire the same handlers (filter chips, tab switches, export buttons, row clicks)
- [ ] Responsive: check at 1280px, 1024px, 768px. Sidebar collapses below 768px.
- [ ] No emoji characters rendering anywhere
- [ ] Font loaded (check Network tab for Hanken Grotesk)
- [ ] `tabular-nums` applied on every numeric cell

---

## 9. Git Workflow — Safety Rails

```bash
# Start
git checkout main
git pull
git checkout -b feature/ux-redesign

# Per page, commit after each one is complete
git add .
git commit -m "feat(ux): redesign overview — visuals only"

# When all 12 done, open PR against main
# DO NOT merge without:
#   - side-by-side visual review of every page
#   - confirmation that no API calls changed (check Network tab diff)
#   - confirmation that no prop drilling broke (TypeScript build clean)
```

If something breaks mid-migration, `git revert` the specific page's commit. Because each page is isolated, a regression in one view doesn't block the others.

---

## 10. Tools Claude Code Needs

| Tool | Purpose | How to use |
|------|---------|-----------|
| **Filesystem access** | Read/edit files | Native to Claude Code |
| **Bash** | Run dev server, install deps, git commands | Native |
| **Dev server running** (`pnpm dev` or equivalent) | See changes live at `localhost:3000` | Start it in a separate terminal before Claude Code begins |
| **`lucide-react`** (or equivalent) | Replace emoji + old icons | Install in Phase 3 |
| **`next/font`** (already in Next.js) | Load Hanken Grotesk | Configure in `app/layout.tsx` |
| **This spec** | Reference for tokens, patterns, page-level changes | Keep open in another editor tab or pass as context |
| **`commandcenter-v2.html`** | Visual source of truth | Open in browser next to dev server |

### Optional but recommended

- **Playwright or Chrome DevTools MCP** — lets Claude Code take screenshots of pages and compare against the mockup. If you can wire this up, Claude Code can self-verify each page looks right before moving on.
- **TypeScript strict mode** (likely already on) — catches broken prop interfaces immediately when you rename or retype something you shouldn't.

### Not needed

- No new database migrations
- No new env vars
- No changes to Vercel deployment config
- No new API routes

---

## 11. Suggested First Prompt to Claude Code

Copy this into your first Claude Code session:

> I'm handing you a UX redesign spec at `docs/ux-redesign.md` (this file) and a visual reference at `docs/commandcenter-v2.html`. Before touching any code, run the recon commands in Section 2 and report back what you find. Do not modify anything yet — I need to confirm your understanding of the existing stack before we begin Phase 3.

Then iterate page by page, pausing after each for visual review.

---

## 12. What Success Looks Like

- All 12 pages match the visual mockup
- Zero regressions in data display
- Zero broken API calls
- Zero changed prop interfaces (verify with `tsc --noEmit`)
- Zero emoji characters in the rendered app
- Build passes, app deploys, everything that worked yesterday works today

Ship each page as its own PR so anything questionable is easy to isolate and roll back.
