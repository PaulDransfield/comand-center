// lib/auth/permissions.ts
//
// Single source of truth for which roles can access which surfaces.
// Used by:
//   - Sidebar nav (hides items the role can't see)
//   - Page-level <RoleGate> wrapper (redirects to /no-access)
//   - Server route guards (returns 403 on forbidden API calls)
//
// Role vocabulary (M043):
//   owner   — full access
//   manager — operations + dept-level views, NO finance/billing/settings
//   viewer  — read-only across owner-permitted pages (reserved for v2)
//
// Permission overrides:
//   can_view_finances=true → allows a manager to see finance pages too.
//                            Useful for trusted finance-savvy managers.
//
// Path matching is prefix-based ("/tracker" → also covers "/tracker/foo").
// Order doesn't matter — we check all rules and OR the results within a
// rule type.

export type Role = 'owner' | 'manager' | 'viewer'

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

  const isApi    = path.startsWith('/api/')
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
