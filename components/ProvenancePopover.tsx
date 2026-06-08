'use client'
// components/ProvenancePopover.tsx
//
// A1.10 — shared owner-facing provenance popover. Mount next to any
// rendered metric value; the small "i" button opens a popover that
// fetches GET /api/audit/provenance and renders:
//   - the headline source(s)
//   - last updated (relative)
//   - raw stored value
//   - any disagreement / partial-coverage warnings
//   - small notes
//
// Honest-incomplete: when the API returns raw_value === null or empty
// sources, the popover says so explicitly.

import { useEffect, useRef, useState } from 'react'
import { UXP } from '@/lib/constants/tokens'

export type Metric = 'revenue' | 'staff_cost' | 'food_cost' | 'net_profit' | 'covers'

interface Provenance {
  business_id:     string
  metric:          Metric
  from:            string
  to:              string
  last_updated_at: string | null
  sources:         string[]
  raw_value:       number | null
  decision_code:   string | null
  disagreements:   string[]
  notes:           string[]
  table:           string
}

export function ProvenancePopover({
  businessId, metric, from, to, label,
}: {
  businessId: string | null
  metric:     Metric
  from:       string
  to:         string
  label?:     string
}) {
  const [open, setOpen]       = useState(false)
  const [data, setData]       = useState<Provenance | null>(null)
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Click outside closes the popover
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [open])

  // Lazy-fetch when first opened
  useEffect(() => {
    if (!open || data || !businessId) return
    let cancelled = false
    setLoading(true)
    fetch(`/api/audit/provenance?business_id=${encodeURIComponent(businessId)}&metric=${metric}&from=${from}&to=${to}`, {
      cache: 'no-store',
    })
      .then(r => r.json())
      .then(j => { if (!cancelled && !j.error) setData(j) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [open, data, businessId, metric, from, to])

  return (
    <div ref={ref} style={{ position: 'relative' as const, display: 'inline-block' }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        aria-label={`Where does ${label ?? metric} come from?`}
        title="Where does this number come from?"
        style={{
          width:          14,
          height:         14,
          borderRadius:   '50%',
          background:     open ? UXP.lavFill : 'transparent',
          border:         `0.5px solid ${UXP.border}`,
          color:          UXP.ink3,
          fontSize:       9,
          fontWeight:     600,
          cursor:         'pointer',
          display:        'inline-flex',
          alignItems:     'center',
          justifyContent: 'center',
          padding:        0,
          lineHeight:     1,
        }}
      >i</button>

      {open && (
        <div style={{
          position:      'absolute' as const,
          top:           18,
          right:         0,
          zIndex:        100,
          minWidth:      260,
          maxWidth:      320,
          background:    UXP.cardBg,
          border:        `0.5px solid ${UXP.border}`,
          borderRadius:  UXP.r_lg,
          boxShadow:     UXP.shadowCard,
          padding:       '12px 14px',
        }}>
          <div style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 6 }}>
            Source · {label ?? metric}
          </div>
          {loading && <div style={{ fontSize: 11, color: UXP.ink4 }}>Loading…</div>}
          {!loading && data && <ProvenanceBody p={data} />}
        </div>
      )}
    </div>
  )
}

function ProvenanceBody({ p }: { p: Provenance }) {
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      {p.sources.length > 0 ? (
        <Row label="Source">
          {p.sources.join(' · ')}
        </Row>
      ) : (
        <Row label="Source"><span style={{ color: UXP.ink4 }}>Unknown</span></Row>
      )}

      <Row label="Raw value">
        {p.raw_value != null
          ? <span style={{ fontVariantNumeric: 'tabular-nums' as const }}>{Math.round(p.raw_value).toLocaleString('sv-SE')}</span>
          : <span style={{ color: UXP.ink4 }}>—</span>}
      </Row>

      <Row label="Last updated">
        {formatRelative(p.last_updated_at) ?? <span style={{ color: UXP.ink4 }}>Unknown</span>}
      </Row>

      <Row label="From">
        <span style={{ fontFamily: 'monospace', fontSize: 10, color: UXP.ink4 }}>{p.table}</span>
      </Row>

      {p.disagreements.length > 0 && (
        <div style={{
          background:    UXP.lavFill,
          border:        `0.5px solid ${UXP.coral}33`,
          borderRadius:  6,
          padding:       '6px 8px',
          fontSize:      10,
          color:         UXP.coral,
          lineHeight:    1.5,
        }}>
          {p.disagreements.join(' ')}
        </div>
      )}

      {p.notes.length > 0 && (
        <div style={{ fontSize: 10, color: UXP.ink3, lineHeight: 1.5 }}>
          {p.notes.join(' · ')}
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'baseline' }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, minWidth: 64 }}>
        {label}
      </div>
      <div style={{ fontSize: 11, color: UXP.ink1, textAlign: 'right' as const, lineHeight: 1.4 }}>
        {children}
      </div>
    </div>
  )
}

function formatRelative(iso: string | null): string | null {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return null
  const sec  = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 60)        return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60)        return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24)         return `${hr}h ago`
  const day = Math.round(hr / 24)
  if (day < 30)        return `${day}d ago`
  const mo = Math.round(day / 30)
  return `${mo}mo ago`
}
