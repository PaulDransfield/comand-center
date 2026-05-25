// components/AppShell.tsx
//
// Wraps every authenticated page with the new pastel-lavender chrome:
//   • RailNav (46px icon rail) on the left
//   • AppShellUX (top toolbar + main column) on the right
//
// Phase 2 replaced the navy SidebarV2 import here. The old sidebar lives
// in-tree at components/ui/SidebarV2.tsx until Phase 7 retires it (final
// cleanup pass once every page is verified on the new shell).
//
// Pages can pass `dateLabel` / `onPrev` / `onNext` / `compareLabel` to
// wire up the toolbar's date stepper. Section + page dropdowns derive
// from pathname via lib/nav/areas — pages don't need to opt in for those.
//
// Gates + side-effects preserved verbatim from the SidebarV2 era:
//   RoleGate, OnboardingGate, PlanGate, AiUsageBanner, BackgroundSync,
//   ConsentBanner, MobileNav.

'use client'

import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { usePathname } from 'next/navigation'
import RailNav      from './ux/RailNav'
import AppShellUX   from './ux/AppShellUX'
import BizPicker    from './ux/BizPicker'
import UserMenu     from './ux/UserMenu'
import RailSyncSlot from './ux/RailSyncSlot'
import ConsentBanner   from './ConsentBanner'
import MobileNav       from './MobileNav'
import BackgroundSync  from './BackgroundSync'
import PlanGate        from './PlanGate'
import OnboardingGate  from './OnboardingGate'
import AiUsageBanner   from './AiUsageBanner'
import BrokenIntegrationBanner from './BrokenIntegrationBanner'
import { RoleGate }    from './RoleGate'
import { UXP }         from '@/lib/constants/tokens'

// Fallback Ask CC handler for pages that don't mount their own AskAI
// (e.g. /scheduling, /inventory, /settings). Hides its own floating
// button; the toolbar pill is the only trigger. Page-level AskAI mounts
// take precedence via the registry stack in AskAI.tsx.
const AskAI = dynamic(() => import('./AskAI'), { ssr: false, loading: () => null })

export interface AppShellProps {
  children:      ReactNode
  /** Optional date stepper label — e.g. "Week 21 · 18–24 May". */
  dateLabel?:    string
  onPrev?:       () => void
  onNext?:       () => void
  compareLabel?: string | null
  onAskCc?:      () => void
}

export default function AppShell({
  children,
  dateLabel,
  onPrev,
  onNext,
  compareLabel,
  onAskCc,
}: AppShellProps) {
  const pathname = usePathname() ?? ''
  // Short pathname-derived label for the fallback AskAI's `page` prop
  // (used to pick suggestion text). Pages with their own AskAI pass their
  // own — this is purely the AppShell fallback.
  const fallbackPage = pathname.split('/').filter(Boolean)[0] ?? 'general'

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: UXP.pageBg }}>
      {/* Rail — hidden on mobile; MobileNav takes over below 768px */}
      <div className="cc-sidebar-wrapper" style={{ display: 'none' }}>
        <RailNav footer={<RailSyncSlot />} />
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

      {/* Main column — toolbar + page content */}
      <div className="cc-main-content" style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <BrokenIntegrationBanner />
        <AiUsageBanner />
        <AppShellUX
          dateLabel={dateLabel}
          onPrev={onPrev}
          onNext={onNext}
          compareLabel={compareLabel}
          bizPicker={<BizPicker />}
          userMenu={<UserMenu />}
          onAskCc={onAskCc}
        >
          <RoleGate>{children}</RoleGate>
        </AppShellUX>
      </div>

      {/* Fallback Ask CC handler — page-level AskAI (when mounted) wins
          via the registry stack and the floating button is hidden here. */}
      <AskAI page={fallbackPage} context="" hideFloatingBtn isFallback />

      <ConsentBanner />
      <BackgroundSync />
      <OnboardingGate />
      <PlanGate />

      <div className="cc-mobile-nav">
        <MobileNav />
      </div>
    </div>
  )
}
