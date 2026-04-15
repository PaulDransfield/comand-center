// @ts-nocheck
// components/shared/MobileBottomNav.tsx
//
// MOBILE BOTTOM NAVIGATION â€” visible only on screens < 600px wide.
// Replaces the left sidebar on mobile devices.
//
// Usage: Place inside DashboardLayout, outside the main grid.
// The CSS in mobile.css hides this on larger screens.

'use client'

import Link        from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/dashboard',    icon: 'âŠž',  label: 'Dashboard'   },
  { href: '/notebook',     icon: 'ðŸ“š', label: 'Notebook'    },
  { href: '/tracker',      icon: 'ðŸ“Š', label: 'Tracker'     },
  { href: '/studio',       icon: 'âœ¦',  label: 'Studio'      },
  { href: '/integrations', icon: 'âŸ³',  label: 'Integrations'},
]

export default function MobileBottomNav() {
  const pathname = usePathname()

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  return (
    // Only rendered visually on mobile via CSS â€” always in the DOM for simplicity
    <nav className="mobile-bottom-nav" role="navigation" aria-label="Main navigation">
      {NAV_ITEMS.map(item => (
        <Link
          key={item.href}
          href={item.href}
          className={`mobile-nav-item ${isActive(item.href) ? 'active' : ''}`}
          aria-label={item.label}
          aria-current={isActive(item.href) ? 'page' : undefined}
        >
          <span className="nav-icon" aria-hidden="true">{item.icon}</span>
          <span>{item.label}</span>
        </Link>
      ))}
    </nav>
  )
}
