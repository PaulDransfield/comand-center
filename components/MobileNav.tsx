// components/MobileNav.tsx
// Bottom tab bar for mobile — 5 tabs with a More drawer

'use client'

import { usePathname, useRouter } from 'next/navigation'
import { useState } from 'react'

const TABS = [
  { label: 'Overview',  href: '/dashboard'  },
  { label: 'P&L',       href: '/tracker'    },
  { label: 'Invoices',  href: '/invoices'   },
  { label: 'Alerts',    href: '/alerts'     },
  { label: 'More',      href: null          },
]

const MORE_ITEMS = [
  { label: 'Budget vs Actual', href: '/budget'        },
  { label: 'VAT',              href: '/vat'            },
  { label: 'Food / Bev',       href: '/revenue-split'  },
  { label: 'Scheduling',       href: '/scheduling'     },
  { label: 'Covers',           href: '/covers'         },
  { label: 'AI Assistant',     href: '/notebook'       },
  { label: 'AI Studio',        href: '/notebook/studio' },
  { label: 'Integrations',     href: '/integrations'   },
  { label: 'Settings',         href: '/settings'       },
  { label: 'Upgrade',          href: '/upgrade'        },
]

export default function MobileNav() {
  const pathname    = usePathname()
  const router      = useRouter()
  const [showMore, setShowMore] = useState(false)

  const isActive = (href: string | null) => {
    if (!href) return false
    return pathname === href || (href !== '/dashboard' && pathname.startsWith(href))
  }

  return (
    <>
      {/* More drawer */}
      {showMore && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setShowMore(false)}>
          <div style={{ position: 'absolute', bottom: 60, left: 0, right: 0, background: '#1a1f2e', borderRadius: '16px 16px 0 0', padding: 16, border: '0.5px solid rgba(255,255,255,0.08)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ width: 32, height: 3, background: 'rgba(255,255,255,0.2)', borderRadius: 2, margin: '0 auto 16px' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {MORE_ITEMS.map(item => (
                <div key={item.href} onClick={() => { router.push(item.href); setShowMore(false) }}
                  style={{ background: 'rgba(255,255,255,0.07)', borderRadius: 8, padding: '12px 14px', cursor: 'pointer' }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: item.label.startsWith('AI') ? '#a5b4fc' : 'white' }}>{item.label}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab bar */}
      <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, height: 60, background: '#1a1f2e',
        borderTop: '0.5px solid rgba(255,255,255,0.08)', display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', zIndex: 40 }}>
        {TABS.map(tab => {
          const active = tab.href ? isActive(tab.href) : showMore
          return (
            <div key={tab.label} onClick={() => tab.href ? router.push(tab.href) : setShowMore(s => !s)}
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, cursor: 'pointer' }}>
              <div style={{ width: 20, height: 3, borderRadius: 2, background: active ? '#6366f1' : 'rgba(255,255,255,0.15)' }} />
              <span style={{ fontSize: 10, color: active ? '#a5b4fc' : 'rgba(255,255,255,0.4)', fontWeight: active ? 500 : 400 }}>
                {tab.label}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}
