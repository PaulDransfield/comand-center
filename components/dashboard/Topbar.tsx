// components/dashboard/Topbar.tsx
//
// The TOP NAVIGATION BAR — visible on every dashboard page.
// Contains:
//   - CommandCenter logo + brand
//   - Business switcher dropdown (reads from BizContext)
//   - Aggregate view toggle
//   - Current month label
//   - User avatar / sign out

'use client'

import { useState }    from 'react'
import { useRouter }   from 'next/navigation'
import { useBiz }      from '@/context/BizContext'
import { createClient } from '@/lib/supabase/client'

export default function Topbar() {
  const router   = useRouter()
  const supabase = createClient()
  const biz      = useBiz()

  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [search,       setSearch]       = useState('')

  // Filter businesses by search term
  const filtered = biz.businesses.filter(b =>
    !search || b.name.toLowerCase().includes(search.toLowerCase()) ||
    b.city?.toLowerCase().includes(search.toLowerCase())
  )

  // Current month label e.g. "March 2026"
  const monthLabel = new Date().toLocaleDateString('sv-SE', { month: 'long', year: 'numeric' })

  async function signOut() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  // The label shown in the switcher button
  const switcherLabel = biz.isAggregate
    ? `All businesses (${biz.businesses.length})`
    : biz.current?.name ?? 'Select business…'

  return (
    <header style={S.bar}>
      {/* Brand */}
      <div style={S.brand}>
        <div style={S.logo}>CC</div>
        <span style={S.brandName}>CommandCenter</span>
      </div>

      <div style={S.divider} />

      {/* Business switcher */}
      <div style={{ position: 'relative' }}>
        <button
          style={S.switcher}
          onClick={() => setDropdownOpen(o => !o)}
          aria-expanded={dropdownOpen}
        >
          {/* Colour dot */}
          {!biz.isAggregate && biz.current && (
            <span style={{ ...S.dot, background: biz.current.colour }} />
          )}
          {biz.isAggregate && <span style={{ fontSize: 14 }}>⊞</span>}

          <span style={S.switcherLabel}>{switcherLabel}</span>
          <span style={{ fontSize: 10, opacity: .6, marginLeft: 2 }}>▼</span>
        </button>

        {/* Dropdown */}
        {dropdownOpen && (
          <>
            {/* Invisible backdrop to close on outside click */}
            <div
              style={S.backdrop}
              onClick={() => { setDropdownOpen(false); setSearch('') }}
            />
            <div style={S.dropdown}>
              {/* Search */}
              <div style={S.searchWrap}>
                <input
                  autoFocus
                  style={S.searchInput}
                  placeholder="Search…"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                />
              </div>

              {/* Aggregate option (only if 2+ businesses) */}
              {biz.canAggregate && (
                <button
                  style={{
                    ...S.dropItem,
                    ...(biz.isAggregate ? S.dropItemActive : {}),
                  }}
                  onClick={() => {
                    biz.setAggregate(true)
                    setDropdownOpen(false)
                    setSearch('')
                  }}
                >
                  <span style={{ fontSize: 14 }}>⊞</span>
                  <div>
                    <div style={S.dropName}>All businesses</div>
                    <div style={S.dropMeta}>{biz.businesses.length} locations · Group view</div>
                  </div>
                  {biz.isAggregate && <span style={S.checkmark}>✓</span>}
                </button>
              )}

              {filtered.length > 0 && <div style={S.dropSep} />}

              {/* Individual businesses */}
              {filtered.map(b => (
                <button
                  key={b.id}
                  style={{
                    ...S.dropItem,
                    ...((!biz.isAggregate && biz.currentId === b.id) ? S.dropItemActive : {}),
                  }}
                  onClick={() => {
                    biz.select(b.id)
                    setDropdownOpen(false)
                    setSearch('')
                  }}
                >
                  <span style={{ ...S.dot, background: b.colour, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={S.dropName}>{b.name}</div>
                    <div style={S.dropMeta}>{b.type ?? 'Restaurant'}{b.city ? ` · ${b.city}` : ''}</div>
                  </div>
                  {!biz.isAggregate && biz.currentId === b.id && (
                    <span style={S.checkmark}>✓</span>
                  )}
                </button>
              ))}

              {filtered.length === 0 && (
                <div style={S.dropEmpty}>No businesses found</div>
              )}
            </div>
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* Month label */}
      <span style={S.monthLabel}>{monthLabel}</span>

      {/* Sign out */}
      <button style={S.signOut} onClick={signOut} title="Sign out">
        ⎋
      </button>
    </header>
  )
}

// ── Styles ────────────────────────────────────────────────────────

const S: Record<string, React.CSSProperties> = {
  bar: {
    background:     'var(--navy)',
    height:         'var(--nav-h)',
    display:        'flex',
    alignItems:     'center',
    padding:        '0 16px',
    gap:            '8px',
    position:       'relative',
    zIndex:         100,
  },
  brand: {
    display:    'flex',
    alignItems: 'center',
    gap:        '8px',
    flexShrink: 0,
  },
  logo: {
    width:          '28px',
    height:         '28px',
    borderRadius:   '7px',
    background:     'rgba(255,255,255,.15)',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontFamily:     'var(--display)',
    fontSize:       '12px',
    fontWeight:     700,
    color:          'white',
  },
  brandName: {
    fontFamily: 'var(--display)',
    fontSize:   '14px',
    fontWeight: 600,
    color:      'rgba(255,255,255,.9)',
  },
  divider: {
    width:      '1px',
    height:     '20px',
    background: 'rgba(255,255,255,.15)',
    margin:     '0 4px',
  },
  switcher: {
    display:         'flex',
    alignItems:      'center',
    gap:             '7px',
    padding:         '5px 10px',
    background:      'rgba(255,255,255,.08)',
    border:          '1px solid rgba(255,255,255,.12)',
    borderRadius:    '8px',
    cursor:          'pointer',
    color:           'rgba(255,255,255,.9)',
    fontSize:        '13px',
    fontFamily:      'var(--font)',
    fontWeight:      500,
    transition:      'background .12s',
    maxWidth:        '260px',
  },
  switcherLabel: {
    flex:           1,
    textAlign:      'left' as const,
    whiteSpace:     'nowrap' as const,
    overflow:       'hidden',
    textOverflow:   'ellipsis',
  },
  dot: {
    width:          '8px',
    height:         '8px',
    borderRadius:   '50%',
    flexShrink:     0,
  },
  // Dropdown
  backdrop: {
    position:   'fixed',
    inset:      0,
    zIndex:     199,
  },
  dropdown: {
    position:     'absolute',
    top:          'calc(100% + 6px)',
    left:         0,
    minWidth:     '260px',
    background:   'var(--white)',
    border:       '1px solid var(--border-d)',
    borderRadius: '11px',
    boxShadow:    '0 12px 40px rgba(0,0,0,.18)',
    zIndex:       200,
    overflow:     'hidden',
  },
  searchWrap: {
    padding:      '8px',
    borderBottom: '1px solid var(--border)',
  },
  searchInput: {
    width:        '100%',
    padding:      '6px 10px',
    border:       '1px solid var(--border)',
    borderRadius: '7px',
    fontSize:     '12px',
    fontFamily:   'var(--font)',
    color:        'var(--ink)',
    outline:      'none',
    background:   'var(--parchment)',
  },
  dropItem: {
    display:     'flex',
    alignItems:  'center',
    gap:         '9px',
    padding:     '9px 12px',
    width:       '100%',
    background:  'none',
    border:      'none',
    cursor:      'pointer',
    textAlign:   'left' as const,
    fontFamily:  'var(--font)',
    transition:  'background .08s',
  },
  dropItemActive: {
    background: 'var(--blue-lt)',
  },
  dropName: {
    fontSize:   '13px',
    fontWeight: 500,
    color:      'var(--ink)',
  },
  dropMeta: {
    fontSize:   '11px',
    color:      'var(--ink-4)',
    marginTop:  '1px',
  },
  dropSep: {
    height:     '1px',
    background: 'var(--border)',
    margin:     '3px 0',
  },
  dropEmpty: {
    padding:    '16px',
    textAlign:  'center' as const,
    fontSize:   '12px',
    color:      'var(--ink-4)',
  },
  checkmark: {
    color:      'var(--blue)',
    fontSize:   '13px',
    flexShrink: 0,
  },
  monthLabel: {
    fontSize:   '11px',
    color:      'rgba(255,255,255,.4)',
    fontFamily: 'var(--mono)',
    flexShrink: 0,
  },
  signOut: {
    width:          '32px',
    height:         '32px',
    borderRadius:   '8px',
    background:     'rgba(255,255,255,.08)',
    border:         '1px solid rgba(255,255,255,.12)',
    color:          'rgba(255,255,255,.6)',
    fontSize:       '16px',
    cursor:         'pointer',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
}
