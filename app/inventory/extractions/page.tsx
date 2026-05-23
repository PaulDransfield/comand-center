'use client'
// app/inventory/extractions/page.tsx
//
// Phase B.4 — PDF extraction review queue. Lists every invoice the
// extractor flagged for owner attention (status='needs_review' default)
// so the owner can curate / approve them. One click → detail page with
// editable row grid + apply button.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface ExtractionItem {
  id:                string
  status:            'pending' | 'extracting' | 'extracted' | 'needs_review' | 'failed' | 'no_pdf'
  supplier:          string
  invoice_number:    string
  invoice_date:      string
  rows_extracted:    number | null
  total_extracted:   number | null
  total_header:      number | null
  total_delta_pct:   number | null
  has_pdf:           boolean
  warning_codes:     string[]
  completed_at:      string | null
  cost_usd:          number | null
  fortnox_url:       string
}

interface ListResponse {
  counts:        Record<string, number>
  total:         number
  status_filter: string
  items:         ExtractionItem[]
}

const STATUSES = [
  { key: 'needs_review', label: 'Needs review' },
  { key: 'extracted',    label: 'Extracted' },
  { key: 'failed',       label: 'Failed' },
  { key: 'pending',      label: 'Pending' },
  { key: 'no_pdf',       label: 'No PDF' },
  { key: 'all',          label: 'All' },
]

export default function InventoryExtractionsPage() {
  const router = useRouter()
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<string>('needs_review')
  const [data,    setData]    = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    setError(null)
    try {
      const r = await fetch(`/api/inventory/extractions?business_id=${encodeURIComponent(bizId)}&status=${encodeURIComponent(filter)}&limit=200`,
                            { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      const j: ListResponse = await r.json()
      setData(j)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [bizId, filter])

  useEffect(() => { if (bizId) load() }, [bizId, filter, load])

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, padding: '20px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
          PDF extractions — review queue
        </h1>
        <p style={{ margin: '6px 0 20px', fontSize: 13, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
          Supplier invoices where the AI extracted rows but the totals don't match the Fortnox header, or where reading failed. Review, edit if needed, and approve to add the lines to your catalogue.
        </p>

        {/* Status filter tabs + counts */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' as const }}>
          {STATUSES.map(s => {
            const count = s.key === 'all' ? (data?.total ?? 0) : (data?.counts?.[s.key] ?? 0)
            const isActive = filter === s.key
            return (
              <button
                key={s.key}
                onClick={() => setFilter(s.key)}
                style={{
                  padding: '6px 12px',
                  fontSize: 12, fontWeight: 500,
                  background: isActive ? UXP.lavFill   : 'transparent',
                  color:      isActive ? UXP.lavText   : UXP.ink3,
                  border:     `0.5px solid ${isActive ? UXP.lavMid : UXP.border}`,
                  borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                }}
              >
                {s.label} <span style={{ marginLeft: 4, color: isActive ? UXP.lavText : UXP.ink4, fontWeight: 400 }}>{count}</span>
              </button>
            )
          })}
        </div>

        {error && (
          <div style={{
            padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
            borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12,
          }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13 }}>
            Loading extractions…
          </div>
        )}

        {!loading && data && data.items.length === 0 && (
          <div style={{
            padding: 30, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13,
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8,
          }}>
            No extractions with status "{STATUSES.find(s => s.key === filter)?.label ?? filter}".
          </div>
        )}

        {!loading && data && data.items.length > 0 && (
          <div style={{
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
            borderRadius: 8, overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <th style={th()}>Date</th>
                  <th style={th()}>Supplier</th>
                  <th style={th()}>Invoice #</th>
                  <th style={{ ...th(), textAlign: 'right' as const }}>Rows</th>
                  <th style={{ ...th(), textAlign: 'right' as const }}>Extracted total</th>
                  <th style={{ ...th(), textAlign: 'right' as const }}>Fortnox total</th>
                  <th style={{ ...th(), textAlign: 'right' as const }}>Δ</th>
                  <th style={th()}>Status</th>
                  <th style={th()}></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(it => (
                  <tr key={it.id}
                      onClick={() => router.push(`/inventory/extractions/${it.id}`)}
                      style={{ cursor: 'pointer', borderTop: `0.5px solid ${UXP.borderSoft}` }}
                      onMouseEnter={e => (e.currentTarget.style.background = UXP.subtleBg)}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                    <td style={td()}>{it.invoice_date}</td>
                    <td style={{ ...td(), fontWeight: 500, color: UXP.ink1 }}>{it.supplier}</td>
                    <td style={{ ...td(), fontFamily: 'ui-monospace, monospace' as const, color: UXP.ink3 }}>
                      #{it.invoice_number}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
                      {it.rows_extracted ?? '—'}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const }}>
                      {fmtKr(it.total_extracted)}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink3 }}>
                      {fmtKr(it.total_header)}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const,
                                  color: deltaColor(it.total_delta_pct) }}>
                      {it.total_delta_pct != null ? `${(it.total_delta_pct * 100).toFixed(1)} %` : '—'}
                    </td>
                    <td style={td()}><StatusBadge status={it.status} /></td>
                    <td style={td()}>
                      <span style={{ color: UXP.ink3, fontSize: 11 }}>→</span>
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

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; label: string }> = {
    needs_review: { bg: UXP.roseFill, color: UXP.roseText, label: 'Review' },
    extracted:    { bg: UXP.greenFill, color: UXP.greenDeep, label: 'Extracted' },
    failed:       { bg: UXP.roseFill, color: UXP.roseText, label: 'Failed' },
    pending:      { bg: UXP.lavFill, color: UXP.lavText, label: 'Pending' },
    extracting:   { bg: UXP.lavFill, color: UXP.lavText, label: 'Processing' },
    no_pdf:       { bg: UXP.subtleBg, color: UXP.ink3, label: 'No PDF' },
  }
  const s = map[status] ?? { bg: UXP.subtleBg, color: UXP.ink3, label: status }
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px',
      background: s.bg, color: s.color,
      borderRadius: 10, fontSize: 10, fontWeight: 500,
    }}>{s.label}</span>
  )
}

function deltaColor(d: number | null): string {
  if (d == null) return UXP.ink3
  const abs = Math.abs(d)
  if (abs < 0.02) return UXP.greenDeep   // within 2% tolerance
  if (abs < 0.1)  return UXP.coral
  return UXP.roseText
}

function th(): React.CSSProperties {
  return {
    padding: '8px 12px', fontSize: 10, fontWeight: 600,
    color: UXP.ink4, letterSpacing: '0.04em',
    textTransform: 'uppercase' as const, textAlign: 'left' as const,
  }
}
function td(): React.CSSProperties {
  return { padding: '10px 12px', fontSize: 12, color: UXP.ink2 }
}
