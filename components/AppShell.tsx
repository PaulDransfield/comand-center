// components/AppShell.tsx
// Wraps all authenticated pages with sidebar + mobile nav
// Usage: wrap page content with <AppShell>{children}</AppShell>

'use client'

// Phase 1 (ux/phase-1-overview): swapped to the redesigned SidebarV2. Old
// `components/Sidebar.tsx` is retained in-tree so it can be reinstated by
// reverting this one line if the redesign ever needs to roll back.
import Sidebar from './ui/SidebarV2'
import ConsentBanner from './ConsentBanner'
import MobileNav from './MobileNav'
import BackgroundSync from './BackgroundSync'
import PlanGate from './PlanGate'
import AiUsageBanner from './AiUsageBanner'
import { RoleGate } from './RoleGate'

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      {/* Sidebar — hidden on mobile */}
      <div style={{ display: 'none' }} className="cc-sidebar-wrapper">
        <Sidebar />
      </div>
      <style>{`
        @media (min-width: 768px) {
          /* Sticky sidebar — pins to the top of the viewport while the
             page scrolls. align-self:flex-start stops flex from
             stretching it to the full page height; max-height + overflow
             give it its own internal scroll if its own content (long
             nav list on a short viewport) exceeds the viewport. */
          .cc-sidebar-wrapper {
            display: block !important;
            position: sticky;
            top: 0;
            align-self: flex-start;
            max-height: 100vh;
            overflow-y: auto;
          }
          .cc-mobile-nav { display: none !important; }
        }
        @media (max-width: 767px) {
          .cc-main-content { padding-bottom: 70px !important; }
        }
      `}</style>

      {/* Main content — flex:1 fills the space next to the sidebar.
          No margin-left override: the sidebar is a flex sibling, not
          absolutely positioned, so flex already handles layout. The
          old 220px margin was leftover from the 220px Sidebar and
          was doubling the spacing with the 148px SidebarV2. */}
      <div className="cc-main-content" style={{ flex: 1, minWidth: 0, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        <AiUsageBanner />
        {/* M043: every page wrapped in AppShell goes through the role
            gate. The gate is path-aware via usePathname() — pages the
            current role can access render normally; forbidden pages
            render the "no-access" fallback inline. */}
        <RoleGate>
          {children}
        </RoleGate>
      </div>

      {/* Consent banner */}
      <ConsentBanner />

      {/* Fires /api/sync/today on mount (throttled server-side to 10 min/integration) */}
      <BackgroundSync />

      {/* Subscription gate — redirects trial/past_due orgs to /upgrade */}
      <PlanGate />

      {/* Mobile bottom nav */}
      <div className="cc-mobile-nav">
        <MobileNav />
      </div>
    </div>
  )
}
