// lib/auth/permissions.ts
//
// Single source of truth for which roles can access which surfaces.
// Used by:
//   - Sidebar nav (hides items the role can't see)
//   - Page-level <RoleGate> wrapper (redirects to /no-access)
//   - Server route guards (returns 403 on forbidden API calls)
//
// Role vocabulary (M043, extended M072):
//   owner   — full access
//   manager — operations + dept-level views, NO finance/billing/settings
//   viewer  — read-only across owner-permitted pages (reserved for v2)
//   revisor — external accountant, read-only access to /revisor/* ONLY.
//             Never sees the operational app (dashboard, scheduling, etc.).
//             The /revisor surface composes month-end P&L + BAS line items
//             + overhead drilldown into a print-friendly close-cycle view.
//             Unique to the Nordic market — UK ops don't have this relationship.
//   staff   — kitchen/line staff. Pure allow-list: prep list, recipes
//             (operational view, no money), stock counts, waste. NEVER sees
//             financials, billing, settings, scheduling or other locations.
//             Real email login so every prep completion is attributable.
//
// Permission overrides:
//   can_view_finances=true → allows a manager to see finance pages too.
//                            Managers default to TRUE (they run service on the
//                            numbers); restrict per-manager if needed. Ignored
//                            for revisor (finance by definition) and staff
//                            (never finance regardless of the flag).
//
// Path matching is prefix-based ("/tracker" → also covers "/tracker/foo").
// Order doesn't matter — we check all rules and OR the results within a
// rule type.

export type Role = 'owner' | 'manager' | 'viewer' | 'revisor' | 'staff'

export interface AuthSubject {
  role:               Role
  business_ids:       string[] | null    // null = all businesses in the org
  can_view_finances:  boolean
}

// Routes the manager role CAN access. Everything else is owner-only by
// default. We allow-list rather than deny-list because adding a new
// finance page should default to "managers can't see this" — fail-closed.
const MANAGER_ALLOW_PATHS: string[] = [
  '/dashboard',
  '/dashboard/day',      // per-day drill-down (more specific covered by prefix; explicit for clarity)
  '/scheduling',
  '/staff',
  '/revenue',
  '/departments',
  '/covers',
  '/alerts',
  '/notebook',
  '/weather',
  '/no-access',          // the "you don't have access" page itself
  '/login',              // never gate auth pages
  '/reset-password',
  '/terms',
  '/privacy',
  '/security',
  '/settings/profile',   // own user profile is fine
]

// Finance pages — managers see these only when can_view_finances=true.
const FINANCE_PATHS: string[] = [
  '/tracker',
  '/financials',
  '/budget',
  '/forecast',
  '/overheads',
  '/invoices',
]

// Owner-only — never accessible to managers regardless of can_view_finances.
const OWNER_ONLY_PATHS: string[] = [
  '/settings',          // catches /settings, /settings/integrations, etc.
                        // /settings/profile is in the allow list above and
                        // wins via more-specific match.
  '/upgrade',
  '/group',
  '/admin',             // admin tooling — defence in depth (admin has its own auth too)
  '/ai',                // AI assistant burns owner's quota — manager can't trigger
]

// Same paths but for API routes. Most APIs follow the page convention
// (/api/tracker for /tracker, etc.) so we mirror; explicit map for the
// edge cases where naming diverged.
const MANAGER_ALLOW_API_PATHS: string[] = [
  '/api/auth/',
  '/api/businesses',
  '/api/metrics/',
  '/api/scheduling',
  '/api/scheduling/',
  '/api/staff',
  '/api/staff-revenue',
  '/api/revenue-detail',
  '/api/departments',
  '/api/alerts',
  '/api/sync',
  '/api/sync/',
  '/api/resync',
  '/api/notebook',
  '/api/weather/',
  '/api/settings/profile',
  '/api/health',
  '/api/dashboard/day',           // per-day drill-down (read-only by definition)
]

const FINANCE_API_PATHS: string[] = [
  '/api/tracker',
  '/api/tracker/',
  '/api/forecast',
  '/api/budgets',
  '/api/budgets/',
  '/api/overheads',
  '/api/overheads/',
  '/api/financials',
]

const OWNER_ONLY_API_PATHS: string[] = [
  '/api/settings/integrations',
  '/api/settings/ai-privacy',
  '/api/settings/company-info',     // owner sets the org-nr
  '/api/stripe/',
  '/api/upgrade',
  '/api/group',
  '/api/ask',                        // AI assistant
  '/api/agents/',                    // agent triggers
  '/api/admin/',                     // admin surface
]

// ── Revisor allow-list ───────────────────────────────────────────────────────
// Revisor sees ONLY the close-cycle view. Never sees /dashboard, /scheduling,
// settings, integrations, or anything operational. Owner explicitly opted to
// give the accountant month-end visibility; everything else is out of scope.
const REVISOR_ALLOW_PATHS: string[] = [
  '/revisor',
  '/no-access',
  '/login',
  '/reset-password',
  '/terms',
  '/privacy',
  '/security',
  '/settings/profile',     // own user profile is fine
]
const REVISOR_ALLOW_API_PATHS: string[] = [
  '/api/auth/',
  '/api/revisor/',
  '/api/businesses',       // for the business selector in the revisor landing
  '/api/me/',              // own-user data (profile, locale)
  '/api/health',
  '/api/settings/profile',
  // PDF download for source invoices — drilldown is part of close-cycle
  '/api/integrations/fortnox/file',
  // Cost-flag drilldown for variance review
  '/api/integrations/fortnox/drilldown',
]

// ── Staff allow-list ─────────────────────────────────────────────────────────
// Kitchen/line staff. Pure allow-list, fail-closed like revisor. Only the
// operational surfaces they need: prep list, recipes (operational view — the
// page/API strips cost for this role), stock counts, waste. Never financials,
// scheduling, items/orders, settings (beyond own profile), or other locations.
const STAFF_ALLOW_PATHS: string[] = [
  '/inventory/recipes',   // recipe list + detail (cost-stripped for staff) + /prep
  '/inventory/counts',    // stock counts
  '/inventory/waste',     // waste log
  '/no-access',
  '/login',
  '/reset-password',
  '/terms',
  '/privacy',
  '/security',
  '/settings/profile',
]
const STAFF_ALLOW_API_PATHS: string[] = [
  '/api/auth/',
  '/api/me/',
  '/api/businesses',                    // business selector
  '/api/health',
  '/api/settings/profile',
  '/api/support',                       // in-app contact
  '/api/inventory/recipes',             // recipe read (cost stripped server-side)
  '/api/inventory/prep-sessions',       // prep list + line toggle (their core action)
  '/api/inventory/counts',              // stock counts
  '/api/inventory/waste',               // waste log
  '/api/inventory/stock-locations',     // count locations
  '/api/inventory/supplier-article',    // article thumbnails
]

function pathMatches(path: string, prefixes: string[]): boolean {
  return prefixes.some(p => path === p || path.startsWith(p + '/') || (p.endsWith('/') && path.startsWith(p)))
}

/**
 * Can this subject access this path? Path can be a UI route (`/tracker`) or
 * an API route (`/api/tracker/foo`). Same predicate handles both — we infer
 * which list to check from the `/api/` prefix.
 */
export function canAccessPath(subject: AuthSubject | null | undefined, path: string): boolean {
  if (!subject) return false
  if (subject.role === 'owner') return true

  const isApi = path.startsWith('/api/')

  // Revisor: pure allow-list. Nothing else is reachable. Fail-closed by
  // default so any future addition to the app stays invisible to the
  // accountant until we explicitly add it here.
  if (subject.role === 'revisor') {
    const allowedRevisor = isApi ? REVISOR_ALLOW_API_PATHS : REVISOR_ALLOW_PATHS
    return pathMatches(path, allowedRevisor)
  }

  // Staff: pure allow-list, fail-closed. Nothing financial is reachable.
  if (subject.role === 'staff') {
    const allowedStaff = isApi ? STAFF_ALLOW_API_PATHS : STAFF_ALLOW_PATHS
    return pathMatches(path, allowedStaff)
  }

  const allowed  = isApi ? MANAGER_ALLOW_API_PATHS : MANAGER_ALLOW_PATHS
  const finance  = isApi ? FINANCE_API_PATHS       : FINANCE_PATHS
  const ownerOnly = isApi ? OWNER_ONLY_API_PATHS    : OWNER_ONLY_PATHS

  // Owner-only ALWAYS wins (managers never see admin/billing regardless
  // of finance flag). Settings/profile is the only "/settings/*" the
  // manager sees because it's in MANAGER_ALLOW_PATHS as a more specific
  // prefix — we check that BEFORE the broader /settings owner-only rule.
  if (pathMatches(path, allowed)) return true

  if (pathMatches(path, ownerOnly)) return false

  if (pathMatches(path, finance)) return subject.can_view_finances === true

  // Default: deny. Adding a new page should require an explicit
  // entry above. Fail-closed.
  return false
}

/**
 * Can this subject access data scoped to this business? Returns true when
 * - the user is owner (sees all)
 * - business_ids is null (unscoped — sees all in their org)
 * - businessId is in their assigned list
 */
export function canAccessBusiness(subject: AuthSubject | null | undefined, businessId: string | null | undefined): boolean {
  if (!subject || !businessId) return false
  if (subject.role === 'owner')        return true
  // Revisor MUST be explicitly scoped to specific businesses. An accountant
  // who has access to "all businesses in the org" is a security smell — if
  // they serve multiple unrelated clients in the org somehow, the owner
  // should be deliberate about which one.
  if (subject.role === 'revisor') {
    return subject.business_ids != null && subject.business_ids.includes(businessId)
  }
  // Staff MUST be scoped to their location(s) — an unscoped staff login that
  // sees every business is a leak. Mirror the revisor rule: explicit only.
  if (subject.role === 'staff') {
    return subject.business_ids != null && subject.business_ids.includes(businessId)
  }
  if (subject.business_ids == null)    return true   // unscoped manager sees all
  return subject.business_ids.includes(businessId)
}

/**
 * Filter a list of business_ids down to the ones this subject can see.
 * Used by aggregator/list endpoints that return cross-business data.
 */
export function filterAccessibleBusinesses(subject: AuthSubject | null | undefined, businessIds: string[]): string[] {
  if (!subject) return []
  if (subject.role === 'owner')        return businessIds
  if (subject.business_ids == null)    return businessIds
  const allow = new Set(subject.business_ids)
  return businessIds.filter(id => allow.has(id))
}

/**
 * For sidebar / nav rendering. Returns the list of menu keys the role
 * is allowed to see. Centralised so the sidebar component doesn't need
 * its own permission rules.
 */
export function navItemsAllowed(subject: AuthSubject | null | undefined): { allow: (href: string) => boolean } {
  return {
    allow: (href: string) => canAccessPath(subject, href),
  }
}
