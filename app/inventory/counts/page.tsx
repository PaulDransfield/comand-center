'use client'
// app/inventory/counts/page.tsx
//
// List of stock counts for the current business. Click into one to walk
// the shelves on the detail page. "+ New count" creates a header + jumps
// straight to the detail.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr, fmtDuration } from '@/lib/format'

interface CountRow {
  id:                    string
  count_date:            string
  location_id:           string | null
  location_name:         string | null
  notes:                 string | null
  started_at:            string
  completed_at:          string | null
  duration_seconds:      number | null
  total_value_at_count:  number | null
  total_lines:           number
  in_progress:           boolean
}

interface Location { id: string; name: string }

export default function StockCountsPage() {
  const router = useRouter()
  const [bizId,     setBizId]     = useState<string | null>(null)
  const [counts,    setCounts]    = useState<CountRow[]>([])
  const [locations, setLocations] = useState<Location[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState<string | null>(null)
  const [creating,  setCreating]  = useState(false)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const [r1, r2] = await Promise.all([
        fetch(`/api/inventory/counts?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' }),
        fetch(`/api/inventory/stock-locations?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' }),
      ])
      if (!r1.ok) throw new Error((await r1.json().catch(() => ({}))).error ?? `HTTP ${r1.status}`)
      const j1 = await r1.json()
      setCounts(j1.counts ?? [])
      const j2 = await r2.json().catch(() => ({ locations: [] }))
      setLocations(j2.locations ?? [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  async function createCount(locationId: string | null) {
    if (!bizId) return
    setCreating(true)
    try {
      const r = await fetch('/api/inventory/counts', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, location_id: locationId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      router.push(`/inventory/counts/${j.count.id}`)
    } catch (e: any) { alert(e.message); setCreating(false) }
  }

  async function createLocationAndCount() {
    if (!bizId) return
    const name = prompt('Location name (e.g. Walk-in, Bar, Dry store):')?.trim()
    if (!name) return
    try {
      const r = await fetch('/api/inventory/stock-locations', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, name }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      await createCount(j.location.id)
    } catch (e: any) { alert(e.message) }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 980, padding: '20px 24px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, gap: 12, flexWrap: 'wrap' as const }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
              Stock counts
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3, maxWidth: 640, lineHeight: 1.5 }}>
              Walk the shelves, type counts on your phone. Each count snapshots both the cost at-time-of-count AND the live current value so you can see drift.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const }}>
            <button disabled={creating || !bizId} onClick={() => createCount(null)} style={primaryBtn}>
              + New count
            </button>
            {locations.length > 0 && (
              <select disabled={creating || !bizId}
                onChange={e => { if (e.target.value) createCount(e.target.value); e.currentTarget.value = '' }}
                value=""
                style={{
                  padding: '6px 10px', fontSize: 12,
                  background: '#fff', border: `0.5px solid ${UXP.border}`,
                  borderRadius: 5, color: UXP.ink2, fontFamily: 'inherit',
                  cursor: 'pointer',
                }}>
                <option value="">New count by location…</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            )}
            <button disabled={creating || !bizId} onClick={createLocationAndCount}
              style={{
                padding: '6px 10px', fontSize: 12, fontWeight: 500,
                background: 'transparent', color: UXP.ink3,
                border: `0.5px solid ${UXP.border}`, borderRadius: 5,
                cursor: 'pointer', fontFamily: 'inherit',
              }}>
              + Location & count
            </button>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {loading && <Empty label="Loading…" />}
        {!loading && counts.length === 0 && !error && (
          <Empty label="No counts yet. Click + New count to walk the shelves." />
        )}

        {!loading && counts.length > 0 && (
          <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <Th label="Date" />
                  <Th label="Location" />
                  <Th label="Lines" align="right" />
                  <Th label="Value at count" align="right" />
                  <Th label="Time to count" align="right" />
                  <Th label="Status" />
                  <Th label="" />
                </tr>
              </thead>
              <tbody>
                {counts.map(c => (
                  <tr key={c.id}
                      onClick={() => router.push(`/inventory/counts/${c.id}`)}
                      style={{ cursor: 'pointer', borderTop: `0.5px solid ${UXP.borderSoft}` }}
                      onMouseEnter={e => (e.currentTarget.style.background = UXP.subtleBg)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={{ ...td(), color: UXP.ink1, fontWeight: 500 }}>{c.count_date}</td>
                    <td style={{ ...td(), color: UXP.ink3 }}>{c.location_name ?? '— global —'}</td>
                    <td style={{ ...td(), textAlign: 'right' as const, color: UXP.ink2 }}>{c.total_lines}</td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, fontWeight: 500, color: UXP.ink1 }}>
                      {c.total_value_at_count != null ? fmtKr(c.total_value_at_count) : '—'}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink2 }}>
                      {c.duration_seconds != null ? fmtDuration(c.duration_seconds) : '—'}
                    </td>
                    <td style={td()}>
                      {c.in_progress ? (
                        <span style={{ padding: '2px 8px', background: UXP.lavFill, color: UXP.lavText,
                                       borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                          In progress
                        </span>
                      ) : (
                        <span style={{ fontSize: 11, color: UXP.ink3 }}>Completed {c.completed_at?.slice(0, 10)}</span>
                      )}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const }}>
                      {!c.in_progress && (
                        <a href={`/api/inventory/counts/${c.id}/export`}
                           onClick={e => e.stopPropagation()}
                           style={{ fontSize: 11, fontWeight: 600, color: UXP.lavText, textDecoration: 'none', whiteSpace: 'nowrap' as const }}>
                          Export Excel
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </AppShell>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13,
                  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8 }}>
      {label}
    </div>
  )
}
function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, color: UXP.ink4,
                      letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: align }}>{label}</th>
}
function td(): React.CSSProperties { return { padding: '10px 12px', fontSize: 12, color: UXP.ink2 } }
const primaryBtn: React.CSSProperties = {
  padding: '6px 14px', fontSize: 12, fontWeight: 600,
  background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 5,
  cursor: 'pointer', fontFamily: 'inherit',
}
