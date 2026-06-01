// lib/nav/areas.ts
//
// Single source of truth for the customer-facing two-level navigation built in
// Phase 2 of the UI overhaul. The rail (`components/ux/RailNav`) shows one
// icon per AREA; the top toolbar (`components/ux/AppShellUX`) shows the area
// name as a dropdown listing the area's PAGES.
//
// Adding a new page = one entry under the right area's `pages` array. The rail
// + toolbar pick it up automatically. The active area / page are resolved
// from the current pathname via `resolveActiveNav()` — longest-prefix match
// so that `/financials/performance` highlights as a single page under
// Insights without shadowing `/forecast` etc.
//
// Routes intentionally NOT in this map:
//   • /weather — admin/dev only, not in the customer rail
//   • /admin/* — own auth, own nav (AdminNavV2)
//   • /onboarding, /login, /signup, /upgrade — pre-shell flows

export type AreaKey =
  | 'insights'
  | 'schedule'
  | 'inventory'
  | 'recipes'
  | 'bookkeeping'
  | 'alerts'
  | 'ask'
  | 'settings'

export interface AreaPage {
  key:   string
  label: string
  href:  string
}

export interface Area {
  key:     AreaKey
  label:   string
  /** Tabler-style icon name. RailNav owns the rendering map. */
  icon:    AreaIcon
  pages:   AreaPage[]
  pinned?: 'bottom'
}

export type AreaIcon =
  | 'chart-pie'
  | 'calendar-event'
  | 'box'
  | 'chef-hat'
  | 'file-invoice'
  | 'alert-triangle'
  | 'sparkles'
  | 'settings'

// ── Areas + their pages ──────────────────────────────────────────────
//
// The first page in each area is the default landing route when the user
// clicks the area icon on the rail.

export const AREAS: Area[] = [
  {
    key:   'insights',
    label: 'Insights',
    icon:  'chart-pie',
    pages: [
      { key: 'overview',    label: 'Overview',    href: '/dashboard' },
      { key: 'group',       label: 'Group',       href: '/group' },
      { key: 'performance', label: 'Flash P&L',   href: '/financials/performance' },
      { key: 'tracker',     label: 'P&L tracker', href: '/tracker' },
      { key: 'forecast',    label: 'Forecast',    href: '/forecast' },
      { key: 'budget',      label: 'Budget',      href: '/budget' },
      { key: 'revenue',     label: 'Revenue',     href: '/revenue' },
      { key: 'suppliers',   label: 'Suppliers',   href: '/suppliers' },
      { key: 'reviews',     label: 'Reviews',     href: '/reviews' },
    ],
  },
  {
    key:   'schedule',
    label: 'Schedule & workforce',
    icon:  'calendar-event',
    pages: [
      { key: 'scheduling',  label: 'Scheduling',  href: '/scheduling' },
      { key: 'staff',       label: 'Staff',       href: '/staff' },
      { key: 'departments', label: 'Departments', href: '/departments' },
    ],
  },
  {
    key:   'inventory',
    label: 'Inventory',
    icon:  'box',
    // Articles (formerly Catalogue) is real (built from supplier
    // invoices). Article review (formerly Bulk review) is the review
    // queue. Non-inventory suppliers (formerly Skipped suppliers) is
    // the owner-overridden classification list. Counts / waste /
    // variance remain vision-stage behind a DemoDataBanner.
    pages: [
      { key: 'items',       label: 'Articles / Price creep',     href: '/inventory/items' },
      { key: 'review',      label: 'Article review',             href: '/inventory/review' },
      { key: 'skipped',     label: 'Non-inventory suppliers',    href: '/inventory/skipped' },
      { key: 'extractions', label: 'PDF review',                 href: '/inventory/extractions' },
      { key: 'sales',       label: 'Connect dishes to POS',      href: '/inventory/sales' },
      { key: 'counts',      label: 'Stock counts',               href: '/inventory/counts' },
      { key: 'waste',       label: 'Waste',                      href: '/inventory/waste' },
      { key: 'variance',    label: 'Variance',                   href: '/inventory/variance' },
    ],
  },
  {
    key:   'recipes',
    label: 'Recipes',
    icon:  'chef-hat',
    // Lifted out of Inventory 2026-06-01 — recipes are the heart of
    // dish-level margin and a top-level operator concern, not a
    // bookkeeping artefact of supplier invoices.
    pages: [
      { key: 'recipes', label: 'Recipes',    href: '/inventory/recipes' },
      // Manual-covers prep list — owner enters expected production, system
      // aggregates shared sub-recipes + raw ingredients. v1; demand-prediction
      // (POS-driven) is the future seam in lib/inventory/prep-list.ts.
      { key: 'prep',    label: 'Prep list',  href: '/inventory/recipes/prep' },
      // Smart shopping list — natural continuation of the prep list.
      // Derived from prep sessions + pre-orders; guide only, chef fills
      // the order qty themselves.
      { key: 'orders',  label: 'Order list', href: '/inventory/orders' },
    ],
  },
  {
    key:   'bookkeeping',
    label: 'Bookkeeping',
    icon:  'file-invoice',
    pages: [
      { key: 'invoices',  label: 'Invoices',  href: '/invoices' },
      { key: 'overheads', label: 'Overheads', href: '/overheads' },
      { key: 'revisor',   label: 'Revisor',   href: '/revisor' },
    ],
  },
  {
    key:   'alerts',
    label: 'Alerts',
    icon:  'alert-triangle',
    pages: [
      { key: 'alerts', label: 'Alerts', href: '/alerts' },
    ],
  },
  {
    key:   'ask',
    label: 'Ask CC',
    icon:  'sparkles',
    pages: [
      { key: 'notebook', label: 'Notebook', href: '/notebook' },
    ],
  },
  {
    key:    'settings',
    label:  'Settings',
    icon:   'settings',
    pinned: 'bottom',
    pages: [
      { key: 'settings', label: 'Settings', href: '/settings' },
    ],
  },
]

const ALL_PAGES: Array<AreaPage & { areaKey: AreaKey }> = AREAS.flatMap(a =>
  a.pages.map(p => ({ ...p, areaKey: a.key }))
)

export interface ActiveNav {
  area:    Area | null
  page:    AreaPage | null
}

/**
 * Resolve the active area + page from a pathname. Longest-prefix wins so
 * `/financials/performance` matches the Insights "performance" page even
 * though `/financials` isn't itself a page entry.
 */
export function resolveActiveNav(pathname: string | null | undefined): ActiveNav {
  const p = pathname ?? ''
  const matches = ALL_PAGES
    .filter(entry => p === entry.href || p.startsWith(entry.href + '/'))
    .sort((a, b) => b.href.length - a.href.length)
  if (matches.length === 0) return { area: null, page: null }
  const top = matches[0]
  const area = AREAS.find(a => a.key === top.areaKey) ?? null
  const page: AreaPage = { key: top.key, label: top.label, href: top.href }
  return { area, page }
}

export function defaultPageFor(area: Area): AreaPage | null {
  return area.pages[0] ?? null
}

// ── i18n helpers ────────────────────────────────────────────────────
//
// Consumers pass a `t` function bound to the `sidebar` namespace (e.g.
// `useTranslations('sidebar')`). These helpers look up the translated
// label, with a soft-fail to the hardcoded English label baked into
// AREAS — so a missing locale key never crashes the rail, it just
// renders the English fallback. The next-intl onError handler
// (configured in i18n/request.ts) logs the missing key for follow-up.

type SidebarT = (key: string) => string

export function areaLabel(area: Area, t: SidebarT): string {
  try {
    const v = t(`areas.${area.key}.label`)
    // next-intl returns the wrapped key `{areas.foo.label[MISSING_MESSAGE]}`
    // when a key is missing (per i18n/request.ts getMessageFallback).
    // Detect + fall back to the hardcoded English.
    return v.startsWith('{') ? area.label : v
  } catch {
    return area.label
  }
}

export function pageLabel(area: Area, page: AreaPage, t: SidebarT): string {
  try {
    const v = t(`areas.${area.key}.pages.${page.key}`)
    return v.startsWith('{') ? page.label : v
  } catch {
    return page.label
  }
}
