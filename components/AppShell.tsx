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
          .cc-main-content { margin-left: 220px !important; }
        }
        @media (max-width: 767px) {
          .cc-main-content { padding-bottom: 70px !important; }
        }
      `}</style>

      {/* Main content */}
      <div className="cc-main-content" style={{ flex: 1, marginLeft: 0, minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
        {children}
      </div>

      {/* Consent banner */}
      <ConsentBanner />

      {/* Mobile bottom nav */}
      <div className="cc-mobile-nav">
        <MobileNav />
      </div>
    </div>
  )
}
