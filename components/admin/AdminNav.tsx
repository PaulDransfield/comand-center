'use client'
// components/admin/AdminNav.tsx
// Shared navigation strip used across all /admin/* pages so pages feel like one app.

import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/admin/overview',  label: 'Overview' },
  { href: '/admin/customers', label: 'Customers' },
  { href: '/admin/agents',    label: 'Agents' },
  { href: '/admin/health',    label: 'Health' },
  { href: '/admin',           label: 'Legacy' },
]

export function AdminNav() {
  const pathname = usePathname() ?? ''

  return (
    <div style={{
      background: 'white', borderBottom: '1px solid #e5e7eb',
      padding: '0 24px', display: 'flex', alignItems: 'center',
      gap: 0, overflowX: 'auto', position: 'sticky', top: 0, zIndex: 50,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#111', marginRight: 24, padding: '14px 0', whiteSpace: 'nowrap' }}>
        CommandCenter Admin
      </div>
      {TABS.map(tab => {
        // Match prefix so /admin/customers/[id] stays under Customers
        const active = tab.href === '/admin'
          ? pathname === '/admin'
          : pathname.startsWith(tab.href)
        return (
          <a
            key={tab.href}
            href={tab.href}
            style={{
              padding: '14px 14px', fontSize: 13, fontWeight: 600,
              color: active ? '#111' : '#6b7280',
              borderBottom: active ? '2px solid #1a1f2e' : '2px solid transparent',
              textDecoration: 'none', whiteSpace: 'nowrap',
              transition: 'color .15s',
            }}
          >
            {tab.label}
          </a>
        )
      })}
    </div>
  )
}
