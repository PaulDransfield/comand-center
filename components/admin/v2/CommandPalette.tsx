'use client'
// components/admin/v2/CommandPalette.tsx
//
// ⌘K command palette — full implementation in PR 11 (replaces the PR 1 stub).
// Three result sections: customers (search org name or paste a UUID),
// saved investigations (label + query body match), and the v2 pages
// themselves (Overview, Customers, Health, Audit, Tools…).
//
// Native <dialog> handles focus trap + Esc. Backdrop-click is wired
// manually because <dialog>'s default ignores it.
//
// Keyboard: ⌘/Ctrl-K toggles. ↑/↓ moves the active item across all
// sections. Enter activates. Esc closes (native).
//
// FIXES.md §0al.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { adminFetch } from '@/lib/admin/v2/api-client'

interface SearchResponse {
  q:         string
  customers: Array<{ id: string; name: string; plan: string | null; org_number: string | null }>
  saved:     Array<{ id: string; label: string; org_id: string | null; org_name: string | null; query_preview: string }>
  pages:     Array<{ key: string; label: string; href: string; hint?: string }>
  saved_table_missing: boolean
}

type Item =
  | { kind: 'customer'; id: string;     name: string;  plan: string | null; org_number: string | null; href: string }
  | { kind: 'saved';    id: string;     label: string; org_name: string | null; preview: string; href: string }
  | { kind: 'page';     key: string;    label: string; hint?: string;        href: string }

export function CommandPalette() {
  const router    = useRouter()
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const inputRef  = useRef<HTMLInputElement | null>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [open,    setOpen]    = useState<boolean>(false)
  const [q,       setQ]       = useState<string>('')
  const [data,    setData]    = useState<SearchResponse | null>(null)
  const [loading, setLoading] = useState<boolean>(false)
  const [error,   setError]   = useState<string | null>(null)
  const [active,  setActive]  = useState<number>(0)

  // Cmd-K toggle, global. Esc handled by <dialog> natively.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k'
      if (!isCmdK) return
      e.preventDefault()
      const d = dialogRef.current
      if (!d) return
      if (d.open) closePalette()
      else openPalette()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function openPalette() {
    setQ('')
    setActive(0)
    setError(null)
    dialogRef.current?.showModal()
    setOpen(true)
    setTimeout(() => inputRef.current?.focus(), 30)
    void doSearch('')
  }

  function closePalette() {
    dialogRef.current?.close()
    setOpen(false)
  }

  // Debounced search-as-you-type. 150 ms — fast enough not to feel laggy,
  // slow enough to coalesce a burst of keystrokes into one request.
  const doSearch = useCallback(async (term: string) => {
    setLoading(true)
    setError(null)
    try {
      const r = await adminFetch<SearchResponse>(`/api/admin/v2/search?q=${encodeURIComponent(term)}`)
      setData(r)
      setActive(0)
    } catch (e: any) {
      setError(e?.message ?? 'Search failed')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [])

  function onChangeQ(next: string) {
    setQ(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void doSearch(next.trim()) }, 150)
  }

  // Flatten all sections into a linear nav list (for ↑/↓/Enter handling).
  const items: Item[] = useMemo(() => {
    if (!data) return []
    const out: Item[] = []
    for (const c of data.customers) out.push({ kind: 'customer', id: c.id, name: c.name, plan: c.plan, org_number: c.org_number, href: `/admin/v2/customers/${c.id}` })
    for (const s of data.saved)     out.push({ kind: 'saved',    id: s.id, label: s.label, org_name: s.org_name, preview: s.query_preview, href: `/admin/v2/tools?saved=${s.id}` })
    for (const p of data.pages)     out.push({ kind: 'page',     key: p.key, label: p.label, hint: p.hint, href: p.href })
    return out
  }, [data])

  function activate(i: number) {
    const item = items[i]
    if (!item) return
    closePalette()
    router.push(item.href)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive(prev => Math.min(prev + 1, Math.max(items.length - 1, 0)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive(prev => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      activate(active)
    }
  }

  function onBackdropClick(e: React.MouseEvent<HTMLDialogElement>) {
    if (e.target === dialogRef.current) closePalette()
  }

  // Compute which item-index belongs to which section, for highlight rendering.
  const customerStart = 0
  const savedStart    = (data?.customers.length ?? 0)
  const pageStart     = savedStart + (data?.saved.length ?? 0)

  return (
    <dialog
      ref={dialogRef}
      onClick={onBackdropClick}
      onClose={() => setOpen(false)}
      style={{
        background: 'white', border: 'none', borderRadius: 12, padding: 0,
        boxShadow: '0 12px 40px rgba(0,0,0,0.18)',
        width:     'min(640px, calc(100vw - 32px))',
        maxHeight: 'min(540px, calc(100vh - 80px))',
      }}
    >
      <div style={{ padding: '14px 18px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 16, color: '#9ca3af' }}>⌘K</span>
        <input
          ref={inputRef}
          type="text"
          value={q}
          onChange={e => onChangeQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search customers, saved investigations, pages…"
          style={{
            flex: 1, border: 'none', outline: 'none', fontSize: 14, color: '#111', background: 'transparent',
          }}
        />
        {loading && <span style={{ fontSize: 11, color: '#9ca3af' }}>Searching…</span>}
      </div>

      <div style={{ overflowY: 'auto' as const, maxHeight: 420 }}>
        {error && (
          <div style={{ padding: 16, fontSize: 12, color: '#991b1b', background: '#fef2f2', borderBottom: '1px solid #fecaca' }}>
            {error}
          </div>
        )}

        {data && (
          <>
            <Section title={q.length === 0 ? 'Recent customers' : 'Customers'} count={data.customers.length}>
              {data.customers.length === 0 && <Hint text={q.length === 0 ? 'No customers in DB.' : 'No customers match.'} />}
              {data.customers.map((c, i) => {
                const orgNrFmt = c.org_number
                  ? `${c.org_number.slice(0, 6)}-${c.org_number.slice(6)}`
                  : null
                return (
                  <Row
                    key={c.id}
                    active={active === customerStart + i}
                    onMouseEnter={() => setActive(customerStart + i)}
                    onClick={() => activate(customerStart + i)}
                  >
                    <RowMain>
                      {c.name}
                      {orgNrFmt && <span style={{ marginLeft: 8, fontSize: 11, color: '#6b7280', fontFamily: 'ui-monospace, monospace' }}>{orgNrFmt}</span>}
                    </RowMain>
                    <RowSub mono>{c.id.slice(0, 8)}…{c.plan ? ` · ${c.plan}` : ''}</RowSub>
                  </Row>
                )
              })}
            </Section>

            <Section
              title={q.length === 0 ? 'Recent saved investigations' : 'Saved investigations'}
              count={data.saved.length}
              warn={data.saved_table_missing ? 'Run M038 to enable saved investigations' : undefined}
            >
              {!data.saved_table_missing && data.saved.length === 0 && <Hint text={q.length === 0 ? 'No saved investigations yet.' : 'No saved match.'} />}
              {data.saved.map((s, i) => (
                <Row
                  key={s.id}
                  active={active === savedStart + i}
                  onMouseEnter={() => setActive(savedStart + i)}
                  onClick={() => activate(savedStart + i)}
                >
                  <RowMain>{s.label}{s.org_name && <span style={{ color: '#1e40af', marginLeft: 6, fontSize: 11 }}>↳ {s.org_name}</span>}</RowMain>
                  <RowSub mono>{s.query_preview}</RowSub>
                </Row>
              ))}
            </Section>

            <Section title="Pages" count={data.pages.length}>
              {data.pages.length === 0 && <Hint text="No page matches." />}
              {data.pages.map((p, i) => (
                <Row
                  key={p.key}
                  active={active === pageStart + i}
                  onMouseEnter={() => setActive(pageStart + i)}
                  onClick={() => activate(pageStart + i)}
                >
                  <RowMain>{p.label}</RowMain>
                  {p.hint && <RowSub>{p.hint}</RowSub>}
                </Row>
              ))}
            </Section>
          </>
        )}
      </div>

      <div style={{ padding: '8px 18px', borderTop: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: '#9ca3af' }}>
        <span>↑↓ navigate · Enter open · Esc close</span>
        <span>{items.length} result{items.length === 1 ? '' : 's'}</span>
      </div>
    </dialog>
  )
}

// ────────────────────────────────────────────────────────────────────
//   Sub-components
// ────────────────────────────────────────────────────────────────────

function Section({ title, count, warn, children }: { title: string; count: number; warn?: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ padding: '10px 18px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: '#9ca3af' }}>{title}</span>
        <span style={{ fontSize: 10, color: '#9ca3af' }}>{count}</span>
      </div>
      {warn && (
        <div style={{ margin: '4px 18px 8px', padding: '4px 8px', background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', borderRadius: 6, fontSize: 11 }}>
          {warn}
        </div>
      )}
      {children}
    </div>
  )
}

function Row({ active, onMouseEnter, onClick, children }: { active: boolean; onMouseEnter: () => void; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      style={{
        display: 'flex', flexDirection: 'column' as const, alignItems: 'flex-start' as const,
        width: '100%', padding: '8px 18px', border: 'none', background: active ? '#f3f4f6' : 'transparent',
        textAlign: 'left' as const, cursor: 'pointer', gap: 2,
      }}
    >
      {children}
    </button>
  )
}

function RowMain({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 13, color: '#111', fontWeight: 500 }}>{children}</div>
}

function RowSub({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return <div style={{ fontSize: 11, color: '#6b7280', fontFamily: mono ? 'ui-monospace, monospace' : undefined, whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, maxWidth: '100%' }}>{children}</div>
}

function Hint({ text }: { text: string }) {
  return <div style={{ padding: '6px 18px 10px', fontSize: 11, color: '#d1d5db', fontStyle: 'italic' as const }}>{text}</div>
}
