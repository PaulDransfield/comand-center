// @ts-nocheck
// components/dashboard/Sidebar.tsx
//
// The VERTICAL ICON SIDEBAR â€” 64px wide strip of navigation icons.
// Links to: Dashboard, Notebook, Tracker, Studio, Integrations, Upgrade.

'use client'

import Link     from 'next/link'
import { usePathname } from 'next/navigation'

const NAV_ITEMS = [
  { href: '/dashboard',      icon: 'âŠž',  label: 'Dashboard'    },
  { href: '/notebook',       icon: 'ðŸ“š', label: 'Notebook'     },
  { href: '/tracker',        icon: 'ðŸ“Š', label: 'Tracker'      },
  { href: '/studio',         icon: 'âœ¦',  label: 'Studio'       },
  { href: '/integrations',   icon: 'âŸ³',  label: 'Integrations' },
]

const BOTTOM_ITEMS = [
  { href: '/upgrade',        icon: 'â†‘',  label: 'Upgrade'      },
]

export default function Sidebar() {
  const pathname = usePathname()

  function isActive(href: string) {
    if (href === '/dashboard') return pathname === '/dashboard'
    return pathname.startsWith(href)
  }

  return (
    <aside style={S.aside}>
      <div style={S.top}>
        {NAV_ITEMS.map(item => (
          <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
            <div
              style={{
                ...S.item,
                ...(isActive(item.href) ? S.itemActive : {}),
              }}
              title={item.label}
            >
              <span style={S.icon}>{item.icon}</span>
              <span style={S.label}>{item.label}</span>
            </div>
          </Link>
        ))}
      </div>

      <div style={S.bottom}>
        {BOTTOM_ITEMS.map(item => (
          <Link key={item.href} href={item.href} style={{ textDecoration: 'none' }}>
            <div
              style={{
                ...S.item,
                ...(isActive(item.href) ? S.itemActive : {}),
              }}
              title={item.label}
            >
              <span style={S.icon}>{item.icon}</span>
              <span style={S.label}>{item.label}</span>
            </div>
          </Link>
        ))}
      </div>
    </aside>
  )
}

const S: Record<string, React.CSSProperties> = {
  aside: {
    width:           '64px',
    background:      'var(--off-white)',
    borderRight:     '1px solid var(--border)',
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    paddingTop:      '8px',
    paddingBottom:   '8px',
    overflowY:       'auto',
    flexShrink:      0,
  },
  top: {
    flex:          1,
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           '2px',
    width:         '100%',
  },
  bottom: {
    display:       'flex',
    flexDirection: 'column',
    alignItems:    'center',
    gap:           '2px',
    width:         '100%',
    paddingTop:    '8px',
    borderTop:     '1px solid var(--border)',
  },
  item: {
    width:           '48px',
    height:          '48px',
    borderRadius:    '10px',
    display:         'flex',
    flexDirection:   'column',
    alignItems:      'center',
    justifyContent:  'center',
    gap:             '2px',
    cursor:          'pointer',
    transition:      'background .1s',
    color:           'var(--ink-4)',
  },
  itemActive: {
    background: 'var(--blue-lt)',
    color:      'var(--blue)',
  },
  icon: {
    fontSize: '18px',
    lineHeight: 1,
  },
  label: {
    fontSize:   '9px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '.04em',
    lineHeight: 1,
  },
}
