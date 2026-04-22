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

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#f8f9fa' }}>
      {/* Sidebar — hidden on mobile */}
      <div style={{ display: 'none' }} className="cc-sidebar-wrapper">
        <Sidebar />
      </div>
      <style>{`
        @media (min-width: 768px) {
          .cc-sidebar-wrapper { display: block !important; }
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
        {children}
      </div>

      {/* Consent banner */}
      <ConsentBanner />

      {/* Fires /api/sync/today on mount (throttled server-side to 10 min/integration) */}
      <BackgroundSync />

      {/* Mobile bottom nav */}
      <div className="cc-mobile-nav">
        <MobileNav />
      </div>
    </div>
  )
}
