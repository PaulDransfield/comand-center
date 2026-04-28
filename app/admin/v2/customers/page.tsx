'use client'
// app/admin/v2/customers/page.tsx
// PR 3 — customer list with filter chips + free-text search.
// FIXES.md §0ad.

import { useMemo, useState } from 'react'
import { useAdminData } from '@/lib/admin/v2/use-admin-data'

type FilterKey = 'needs_attention' | 'trial_ending' | 'high_ai' | 'no_login_30d' | 'active_subscription'
type SortKey   = 'name' | 'plan' | 'mrr' | 'last_activity' | 'created'
type Order     = 'asc' | 'desc'

interface CustomerRow {
  id: string
  name: string
  plan: string
  is_active: boolean
  owner_email: string | null
  last_login_at: string | null
  trial_end: string | null
  created_at: string
  member_count: number
  integrations_total: number
  integrations_connected: number
  last_sync_at: string | null
  last_sync_days_ago: number | null
  has_integration_error: boolean
  ai_queries_today: number
  ai_daily_cap: number | null
  ai_pct_of_cap: number | null
  mrr_sek: number
  matches_filter: Record<FilterKey, boolean>
}

interface ListResponse {
  customers:       CustomerRow[]
  total:           number
  grand_total:     number
  filter_counts:   Record<FilterKey, number>
  sort:            SortKey
  order:           Order
  applied_filters: FilterKey[]
  applied_search:  string
}

const CHIPS: Array<{ key: FilterKey; label: string; hint: string }> = [
  { key: 'needs_attention',     label: 'Needs attention',     hint: 'Stuck integrations or silent for >24h' },
  { key: 'trial_ending',        label: 'Trial ending in 7d',  hint: 'Trial ends within the next week' },
  { key: 'high_ai',             label: 'High AI usage',       hint: 'Over 50% of plan cap today' },
  { key: 'no_login_30d',        label: 'No login in 30d',     hint: 'Owner hasn\'t signed in for a month+' },
  { key: 'active_subscription', label: 'Active subscriptions', hint: 'Founding / Solo / Group / Chain' },
]

const COLUMNS: Array<{ key: SortKey; label: string; align?: 'left' | 'right' }> = [
  { key: 'name',          label: 'Name',          align: 'left'  },
  { key: 'plan',          label: 'Plan',          align: 'left'  },
  { key: 'mrr',           label: 'MRR',           align: 'right' },
  { key: 'last_activity', label: 'Last activity', align: 'right' },
  { key: 'created',       label: 'Created',       align: 'right' },
]

export default function CustomersPage() {
  const [activeFilters, setActiveFilters] = useState<Set<FilterKey>>(new Set())
  const [searchInput, setSearchInput]     = useState('')
  const [sort, setSort]                   = useState<SortKey>('last_activity')
  const [order, setOrder]                 = useState<Order>('desc')

  // Build URL with current filter state. useMemo so adminFetch's URL
  // identity is stable when nothing changed → no needless refetch.
  const url = useMemo(() => {
    const sp = new URLSearchParams()
    for (const f of activeFilters) sp.append('filter', f)
    if (searchInput.trim()) sp.set('search', searchInput.trim())
    sp.set('sort', sort)
    sp.set('order', order)
    return `/api/admin/v2/customers?${sp.toString()}`
  }, [activeFilters, searchInput, sort, order])

  const { data, loading, error } = useAdminData<ListResponse>(url)

  function toggleFilter(f: FilterKey) {
    setActiveFilters(prev => {
      const next = new Set(prev)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return next
    })
  }

  function toggleSort(col: SortKey) {
    if (sort === col) setOrder(prev => (prev === 'asc' ? 'desc' : 'asc'))
    else { setSort(col); setOrder('desc') }
  }

  return (
    <div>
      {/* ─── Filter chips ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8, marginBottom: 14 }}>
        {CHIPS.map(c => {
          const active = activeFilters.has(c.key)
          const count  = data?.filter_counts?.[c.key] ?? null
          return (
            <button
              key={c.key}
              onClick={() => toggleFilter(c.key)}
              title={c.hint}
              style={{
                padding:      '6px 12px',
                borderRadius: 18,
                border:       active ? '1px solid #1a1f2e' : '1px solid #d1d5db',
                background:   active ? '#1a1f2e' : 'white',
                color:        active ? 'white' : '#374151',
                fontSize:     12,
                fontWeight:   500,
                cursor:       'pointer',
                transition:   'all 0.1s',
              }}
            >
              {c.label}
              {count !== null && (
                <span style={{
                  marginLeft:   6,
                  fontWeight:   700,
                  color:        active ? '#fff' : '#9ca3af',
                  fontSize:     11,
                }}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
        {activeFilters.size > 0 && (
          <button
            onClick={() => setActiveFilters(new Set())}
            style={{ padding: '6px 12px', background: 'transparent', border: 'none', color: '#6b7280', fontSize: 12, cursor: 'pointer', textDecoration: 'underline' }}
          >
            Clear all
          </button>
        )}
      </div>

      {/* ─── Search + result count ────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <input
          type="search"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          placeholder="Search org name or owner email…"
          style={{
            flex:         1,
            padding:      '8px 12px',
            border:       '1px solid #e5e7eb',
            borderRadius: 7,
            fontSize:     13,
            outline:      'none',
          }}
        />
        <span style={{ fontSize: 12, color: '#6b7280', whiteSpace: 'nowrap' as const }}>
          {data ? `${data.total} of ${data.grand_total}` : ''}
        </span>
      </div>

      {/* ─── Table ─────────────────────────────────────────────────── */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' as const }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
          <thead style={{ background: '#fafbfc', borderBottom: '1px solid #e5e7eb' }}>
            <tr>
              {COLUMNS.map(col => {
                const isSort = sort === col.key
                return (
                  <th
                    key={col.key}
                    onClick={() => toggleSort(col.key)}
                    style={{
                      padding:    '10px 14px',
                      textAlign:  (col.align ?? 'left') as any,
                      fontSize:   11,
                      fontWeight: 600,
                      color:      isSort ? '#111' : '#6b7280',
                      cursor:     'pointer',
                      whiteSpace: 'nowrap' as const,
                      userSelect: 'none' as const,
                    }}
                  >
                    {col.label}
                    {isSort && <span style={{ marginLeft: 4, fontSize: 10 }}>{order === 'asc' ? '↑' : '↓'}</span>}
                  </th>
                )
              })}
              <th style={{ padding: '10px 14px', fontSize: 11, color: '#6b7280', textAlign: 'left' }}>Status</th>
              <th style={{ padding: '10px 14px' }} />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>Loading customers…</td></tr>
            )}
            {error && !loading && (
              <tr><td colSpan={7} style={{ padding: 24, color: '#b91c1c', fontSize: 12, background: '#fef2f2' }}>Error loading: {error}</td></tr>
            )}
            {data && !loading && data.customers.length === 0 && (
              <tr><td colSpan={7} style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>No customers match the current filters.</td></tr>
            )}
            {data && !loading && data.customers.map(c => <CustomerRowEl key={c.id} c={c} />)}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────

function CustomerRowEl({ c }: { c: CustomerRow }) {
  // Status badges (shown together — there can be more than one issue at once).
  const badges: Array<{ label: string; color: string }> = []
  if (c.matches_filter.needs_attention) badges.push({ label: 'attention',     color: '#dc2626' })
  if (c.matches_filter.trial_ending)    badges.push({ label: 'trial ending',  color: '#d97706' })
  if (c.matches_filter.high_ai)         badges.push({ label: 'high AI',       color: '#d97706' })
  if (c.matches_filter.no_login_30d)    badges.push({ label: 'inactive owner',color: '#6b7280' })
  if (!c.is_active)                     badges.push({ label: 'churned',       color: '#6b7280' })

  return (
    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
      <td style={{ padding: '12px 14px' }}>
        <a href={`/admin/v2/customers/${c.id}`} style={{ color: '#111', fontWeight: 500, textDecoration: 'none' }}>{c.name}</a>
        {c.owner_email && <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>{c.owner_email}</div>}
      </td>
      <td style={{ padding: '12px 14px', textTransform: 'uppercase' as const, fontSize: 11, fontWeight: 700, color: '#6b7280', letterSpacing: '0.04em' }}>
        {c.plan}
      </td>
      <td style={{ padding: '12px 14px', textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
        {c.mrr_sek > 0 ? `${c.mrr_sek.toLocaleString('en-GB').replace(/,/g, ' ')} kr` : <span style={{ color: '#d1d5db' }}>—</span>}
      </td>
      <td style={{ padding: '12px 14px', textAlign: 'right' as const, fontSize: 12, color: '#6b7280' }}>
        {c.last_sync_days_ago === null ? <span style={{ color: '#d1d5db' }}>—</span>
          : c.last_sync_days_ago === 0 ? 'today'
          : c.last_sync_days_ago === 1 ? 'yesterday'
          : `${c.last_sync_days_ago}d ago`}
      </td>
      <td style={{ padding: '12px 14px', textAlign: 'right' as const, fontSize: 12, color: '#6b7280' }}>
        {fmtDate(c.created_at)}
      </td>
      <td style={{ padding: '12px 14px' }}>
        {badges.length === 0 ? (
          <span style={{ fontSize: 11, color: '#15803d', fontWeight: 500 }}>OK</span>
        ) : (
          <span style={{ display: 'inline-flex', flexWrap: 'wrap' as const, gap: 4 }}>
            {badges.map(b => (
              <span key={b.label} style={{
                fontSize:      9,
                fontWeight:    700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase' as const,
                color:         b.color,
                border:        `1px solid ${b.color}`,
                borderRadius:  3,
                padding:       '1px 5px',
                whiteSpace:    'nowrap' as const,
              }}>{b.label}</span>
            ))}
          </span>
        )}
      </td>
      <td style={{ padding: '12px 14px', textAlign: 'right' as const }}>
        <a href={`/admin/v2/customers/${c.id}`} style={{ color: '#6366f1', fontSize: 12, fontWeight: 500, textDecoration: 'none' }}>Open →</a>
      </td>
    </tr>
  )
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return `${d.getUTCDate()}/${d.getUTCMonth() + 1}/${String(d.getUTCFullYear()).slice(2)}`
}
