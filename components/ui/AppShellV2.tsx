// components/ui/AppShellV2.tsx
//
// Redesigned app shell per DESIGN.md § Layout shell. Phase 0 creates this
// alongside the existing `components/AppShell.tsx` so the old shell stays in
// use until each page phase migrates. Phase 1 swaps `AppShell` → `AppShellV2`
// on the Overview page first.
//
// Signature per audit Q5: { activeKey, children }. `activeKey` is forwarded
// to `SidebarV2` so the nav highlight is authoritative per page (rather than
// inferred from the URL — makes sub-routes easier to control).

'use client'

import type { ReactNode } from 'react'
import { UX } from '@/lib/constants/tokens'
import SidebarV2 from './SidebarV2'
import ConsentBanner from '@/components/ConsentBanner'
import MobileNav from '@/components/MobileNav'

export interface AppShellV2Props {
  activeKey?: string
  children:   ReactNode
}

export default function AppShellV2({ activeKey, children }: AppShellV2Props) {
  return (
    <div
      style={{
        display:       'flex',
        minHeight:     '100vh',
        background:    UX.pageBg,
      }}
    >
      {/* Sidebar — hidden on mobile via CSS media queries (matches existing
          AppShell behaviour so nothing jumps on narrow viewports). */}
      <div style={{ display: 'none' }} className="cc-sidebar-wrapper">
        <SidebarV2 activeKey={activeKey} />
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

      {/* Main content */}
      <main
        className="cc-main-content"
        style={{
          flex:        1,
          minWidth:    0,
          minHeight:   '100vh',
          display:     'flex',
          flexDirection: 'column',
          padding:     '18px 22px',
        }}
      >
        {children}
      </main>

      <ConsentBanner />
      <div className="cc-mobile-nav">
        <MobileNav />
      </div>
    </div>
  )
}
