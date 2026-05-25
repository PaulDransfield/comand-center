'use client'
// app/suppliers/page.tsx — full rebuild with master-list + PDF drawer
//
// Now lists EVERY supplier in the Fortnox master, categorised
// (food / drink / takeaway / cleaning / services / utilities / other)
// so the operator can filter "show me every food supplier" without
// manually tagging anything. Suppliers with no spend in the 6-month
// window are kept at the bottom — useful for confirming the supplier
// exists in Fortnox before chasing a missing invoice.
//
// Clicking a row opens a side drawer with that supplier's recent
// invoices. Each invoice exposes a "View PDF" link that streams
// through /api/integrations/fortnox/file (the existing PDF proxy
// route) so the owner doesn't bounce out to apps.fortnox.se to see
// the paperwork.

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import KpiCardUX from '@/components/ux/KpiCard'
import Sparkline from '@/components/ui/Sparkline'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import type {
  SuppliersRollupPayload,
  SupplierRollupRow,
  SupplierCategory,
} from '@/app/api/suppliers/rollup/route'

type CategoryFilter = SupplierCategory | 'all'

const CATEGORY_LABELS: Record<SupplierCategory, string> = {
  food:      'Food',
  drink:     'Drink',
  takeaway:  'Takeaway',
  cleaning:  'Cleaning',
  utilities: 'Utilities',
  services:  'Services',
  other:     'Other',
}

const CATEGORY_ORDER: SupplierCategory[] = [
  'food', 'drink', 'takeaway', 'cleaning', 'utilities', 'services', 'other',
]

export default function SuppliersPage() {
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [data,     setData]     = useState<SuppliersRollupPayload | null>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState<string | null>(null)
  const [needsReauth, setNeedsReauth] = useState(false)
  const [filter,   setFilter]   = useState<CategoryFilter>('all')
  const [openRow,  setOpenRow]  = useState<SupplierRollupRow | null>(null)
  const [hideZero, setHideZero] = useState(true)

  useEffect(() => {
    const read = () => { try { setBizId(localStorage.getItem('cc_selected_biz')) } catch {} }
    read()
    window.addEventListener('storage', read)
    return () => window.removeEventListener('storage', read)
  }, [])

  useEffect(() => {
    if (!bizId) { setLoading(false); return }
    let cancelled = false
    setLoading(true); setError(null); setNeedsReauth(false)
    fetch(`/api/suppliers/rollup?business_id=${bizId}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          // Either the refresh token is dead (server flipped the row to
          // needs_reauth and threw) or no Fortnox connection exists for
          // this business yet. Both resolve via /integrations OAuth.
          if (j.error === 'fortnox_token_refresh_failed' || j.error === 'no_fortnox_connection') {
            if (!cancelled) setNeedsReauth(true)
            return null
          }
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        return r.json() as Promise<SuppliersRollupPayload>
      })
      .then(j => { if (!cancelled && j) setData(j) })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bizId])

  const all     = data?.suppliers ?? []
  const flagged = useMemo(() => all.filter(s => s.flag_price_rise), [all])
  const visible = useMemo(() => {
    return all
      .filter(s => filter === 'all' ? true : s.category === filter)
      .filter(s => hideZero ? s.spend_total > 0 : true)
  }, [all, filter, hideZero])
  const visibleSpend = useMemo(() => visible.reduce((s, r) => s + r.spend_total, 0), [visible])
  const totalSpend   = useMemo(() => all.reduce((s, r) => s + r.spend_total, 0), [all])
  const activeCount  = useMemo(() => all.filter(s => s.spend_total > 0).length, [all])

  return (
    <AppShell>
      <div style={{ maxWidth: 1280 }}>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Suppliers</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
              Every supplier in your Fortnox master — categorised, with one-click invoice PDFs.
            </p>
          </div>
          {data?.window && (
            <span style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em' }}>
              {data.window.from} → {data.window.to}
            </span>
          )}
        </div>

        {/* KPI strip */}
        {!loading && data && all.length > 0 && (
          <div style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap:                 12,
            marginBottom:        14,
          }}>
            <KpiCardUX
              title="Suppliers"
              value={String(all.length)}
              microLabel={`${activeCount} active in window`}
            />
            <KpiCardUX
              title="Total spend"
              value={fmtKr(totalSpend)}
              microLabel={`${all.reduce((s, r) => s + r.invoice_count, 0)} invoices`}
            />
            <KpiCardUX
              title="Price rises"
              value={String(flagged.length)}
              deltaGood={false}
              delta={flagged.length > 0 ? '≥ +10% vs trailing' : null}
              microLabel={flagged.length === 0 ? 'No flags' : 'Needs review'}
            />
          </div>
        )}

        {/* Category filter + zero-spend toggle */}
        {!loading && data && all.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' as const, marginBottom: 14 }}>
            <CategoryFilterRow
              value={filter}
              counts={data.category_counts}
              total={all.length}
              onChange={setFilter}
            />
            <label style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 10, color: UXP.ink3, letterSpacing: '0.04em',
              textTransform: 'uppercase' as const, fontWeight: 500,
              cursor: 'pointer',
            }}>
              <input
                type="checkbox"
                checked={hideZero}
                onChange={e => setHideZero(e.target.checked)}
                style={{ accentColor: UXP.lavDeep }}
              />
              Hide zero-spend
            </label>
          </div>
        )}

        {/* States */}
        {loading && (
          <Empty>Loading supplier rollup…</Empty>
        )}
        {!loading && needsReauth && (
          <ReconnectCard />
        )}
        {!loading && !needsReauth && error && (
          <Banner tone="bad" text={error} />
        )}
        {!loading && !error && !needsReauth && all.length === 0 && bizId && (
          <Empty>No Fortnox suppliers found. Wait for the next sync or check the connection in Settings.</Empty>
        )}
        {!loading && !error && !bizId && (
          <Empty>Pick a business in the top toolbar to view supplier intelligence.</Empty>
        )}

        {/* Table */}
        {visible.length > 0 && (
          <BreakdownTable
            columns={[
              {
                key: 'supplier', header: 'Supplier', align: 'left',
                render: (row: SupplierRollupRow) => (
                  <button
                    type="button"
                    onClick={() => setOpenRow(row)}
                    style={{
                      background: 'none', border: 'none', padding: 0,
                      cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' as const,
                      display: 'inline-flex', alignItems: 'center', gap: 8,
                    }}
                  >
                    {row.flag_price_rise && (
                      <span aria-hidden style={{
                        width: 6, height: 6, borderRadius: '50%', background: UXP.rose, display: 'inline-block',
                      }} />
                    )}
                    <span style={{ color: UXP.ink1, fontWeight: 500 }}>{row.supplier_name}</span>
                    {row.invoice_count === 0 && (
                      <span style={{
                        fontSize: 8, padding: '1px 6px', background: UXP.subtleBg,
                        color: UXP.ink4, borderRadius: 6, letterSpacing: '0.04em',
                        textTransform: 'uppercase' as const, fontWeight: 500,
                      }}>No spend</span>
                    )}
                    {row.invoice_count > 1 && (
                      <span style={{ fontSize: 9, color: UXP.ink4 }}>· {row.invoice_count}×</span>
                    )}
                  </button>
                ),
              },
              {
                key: 'category', header: 'Category', align: 'left',
                render: (row: SupplierRollupRow) => <CategoryChip category={row.category} />,
              },
              {
                key: 'spend', header: 'Spend', align: 'right',
                render: (row: SupplierRollupRow) =>
                  row.spend_total > 0 ? fmtKr(row.spend_total) : <span style={{ color: UXP.ink4 }}>—</span>,
              },
              {
                key: 'last_invoice', header: 'Last invoice', align: 'right',
                render: (row: SupplierRollupRow) => (
                  <span>
                    <span>{row.last_invoice_kr != null ? fmtKr(row.last_invoice_kr) : <span style={{ color: UXP.ink4 }}>—</span>}</span>
                    {row.last_invoice_date && (
                      <span style={{ display: 'block', fontSize: 9, color: UXP.ink4, marginTop: 1 }}>
                        {row.last_invoice_date}
                      </span>
                    )}
                  </span>
                ),
              },
              {
                key: 'delta', header: 'Δ vs trailing avg', align: 'right',
                render: (row: SupplierRollupRow) => {
                  if (row.delta_pct == null) return <span style={{ color: UXP.ink4 }}>—</span>
                  const pct = row.delta_pct * 100
                  const txt = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`
                  return <DeltaChip value={txt} positiveIsGood={false} />
                },
              },
              {
                key: 'trend', header: '6-mo trend', align: 'right',
                render: (row: SupplierRollupRow) => {
                  if (row.spend_total === 0) return <span style={{ color: UXP.ink4 }}>—</span>
                  const points = row.monthly_series.map(s => s.kr)
                  const tone: 'good' | 'bad' | 'warning' | 'neutral' =
                    row.delta_pct == null      ? 'neutral'
                    : row.delta_pct >= 0.10    ? 'bad'
                    : row.delta_pct <= -0.10   ? 'good'
                    :                            'warning'
                  return (
                    <span style={{ display: 'inline-block' }}>
                      <Sparkline points={points} tone={tone} width={88} height={20} />
                    </span>
                  )
                },
              },
              {
                key: 'invoices', header: '', align: 'right',
                render: (row: SupplierRollupRow) => (
                  row.recent_invoices.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => setOpenRow(row)}
                      style={{
                        padding:      '3px 8px',
                        background:   UXP.lavFill,
                        color:        UXP.lavText,
                        border:       'none',
                        borderRadius: 999,
                        fontSize:     9,
                        fontWeight:   500,
                        fontFamily:   'inherit',
                        cursor:       'pointer',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {row.recent_invoices.length}× invoices →
                    </button>
                  ) : <span style={{ color: UXP.ink4 }}>—</span>
                ),
              },
            ]}
            sections={[{ rows: visible }]}
            footer={{
              label: filter === 'all' ? 'Total' : `${CATEGORY_LABELS[filter as SupplierCategory]} total`,
              cells: {
                category:     '',
                spend:        fmtKr(visibleSpend),
                last_invoice: '',
                delta:        '',
                trend:        '',
                invoices:     '',
              },
            }}
            rowKey={(row: SupplierRollupRow) => row.supplier_name}
          />
        )}

        {!loading && !error && all.length > 0 && visible.length === 0 && (
          <Empty>No suppliers match this filter. Try a different category or toggle "Hide zero-spend".</Empty>
        )}

        {openRow && (
          <InvoiceDrawer row={openRow} bizId={bizId} onClose={() => setOpenRow(null)} />
        )}
      </div>
    </AppShell>
  )
}

// ── Category filter row ────────────────────────────────────────────
function CategoryFilterRow({
  value, counts, total, onChange,
}: {
  value:    CategoryFilter
  counts:   Record<SupplierCategory, number>
  total:    number
  onChange: (v: CategoryFilter) => void
}) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
      <FilterPill active={value === 'all'} onClick={() => onChange('all')}>
        All <span style={{ color: UXP.ink4, marginLeft: 4 }}>· {total}</span>
      </FilterPill>
      {CATEGORY_ORDER.map(cat => {
        const c = counts[cat] ?? 0
        if (c === 0) return null
        return (
          <FilterPill key={cat} active={value === cat} onClick={() => onChange(cat)}>
            {CATEGORY_LABELS[cat]} <span style={{ color: UXP.ink4, marginLeft: 4 }}>· {c}</span>
          </FilterPill>
        )
      })}
    </div>
  )
}

function FilterPill({ active, onClick, children }: any) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding:       '4px 10px',
        background:    active ? UXP.lavFill : UXP.cardBg,
        color:         active ? UXP.lavText : UXP.ink2,
        border:        `0.5px solid ${active ? UXP.lav : UXP.border}`,
        borderRadius:  999,
        fontSize:      10,
        fontWeight:    500,
        fontFamily:    'inherit',
        cursor:        'pointer',
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </button>
  )
}

function CategoryChip({ category }: { category: SupplierCategory }) {
  // Sober tone-per-category so the filter pills + the row chips read
  // as the same vocabulary.
  const palette: Record<SupplierCategory, { bg: string; fg: string }> = {
    food:      { bg: UXP.lavFill,   fg: UXP.lavText   },
    drink:     { bg: UXP.lavFill,   fg: UXP.lavDeep   },
    takeaway:  { bg: UXP.greenFill, fg: UXP.greenDeep },
    cleaning:  { bg: UXP.subtleBg,  fg: UXP.ink2      },
    utilities: { bg: '#f7e8db',     fg: UXP.coral     },
    services:  { bg: UXP.subtleBg,  fg: UXP.ink3      },
    other:     { bg: UXP.subtleBg,  fg: UXP.ink4      },
  }
  const p = palette[category]
  return (
    <span style={{
      display:       'inline-block',
      fontSize:      9,
      fontWeight:    500,
      padding:       '2px 7px',
      borderRadius:  6,
      background:    p.bg,
      color:         p.fg,
      letterSpacing: '0.04em',
      textTransform: 'uppercase' as const,
    }}>
      {CATEGORY_LABELS[category]}
    </span>
  )
}

// ── Invoice drawer — list + one-click PDF ──────────────────────────
function InvoiceDrawer({ row, bizId, onClose }: { row: SupplierRollupRow; bizId: string | null; onClose: () => void }) {
  const [pdfModal, setPdfModal] = useState<{ url: string; title: string } | null>(null)
  return (
    <div role="dialog" aria-label={`Invoices for ${row.supplier_name}`} style={{
      position:   'fixed' as const,
      top:        0, right: 0, bottom: 0,
      width:      'min(460px, 100%)',
      background: UXP.cardBg,
      borderLeft: `0.5px solid ${UXP.border}`,
      boxShadow:  '-8px 0 24px rgba(58,53,80,0.08)',
      padding:    '18px 22px',
      overflow:   'auto' as const,
      zIndex:     50,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <CategoryChip category={row.category} />
            {row.flag_price_rise && (
              <span style={{
                fontSize:      9,
                fontWeight:    600,
                letterSpacing: '0.04em',
                textTransform: 'uppercase' as const,
                padding:       '2px 7px',
                background:    UXP.roseFill,
                color:         UXP.roseText,
                borderRadius:  6,
              }}>Price rise</span>
            )}
          </div>
          <div style={{ fontSize: 17, fontWeight: 500, color: UXP.ink1 }}>{row.supplier_name}</div>
          {row.supplier_number && (
            <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2, fontFamily: 'ui-monospace, monospace' }}>
              # {row.supplier_number}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 16 }}
        >×</button>
      </div>

      {/* Summary stats */}
      <div style={{
        display:             'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap:                 8,
        marginBottom:        14,
      }}>
        <Stat label="Spend"     value={fmtKr(row.spend_total)} />
        <Stat label="Invoices"  value={String(row.invoice_count)} />
        <Stat label="Last"      value={row.last_invoice_date ?? '—'} />
      </div>

      {/* Recent invoices */}
      <div style={{ fontSize: 11, color: UXP.ink2, fontWeight: 500, marginBottom: 6 }}>
        Recent invoices
      </div>
      {row.recent_invoices.length === 0 ? (
        <Empty>No invoices in the last 6 months for this supplier.</Empty>
      ) : (
        <div style={{ display: 'grid', gap: 0 }}>
          {row.recent_invoices.map((inv, idx) => (
            <div key={inv.given_number || `${idx}-${inv.invoice_date}`} style={{
              display:             'grid',
              gridTemplateColumns: '1fr auto auto',
              gap:                 12,
              padding:             '10px 0',
              borderBottom:        idx < row.recent_invoices.length - 1 ? `0.5px solid ${UXP.borderSoft}` : 'none',
              alignItems:          'center',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: UXP.ink1, fontWeight: 500 }}>
                  #{inv.invoice_number}
                </div>
                <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 1 }}>
                  {inv.invoice_date}
                </div>
              </div>
              <span style={{
                fontSize:           11,
                fontWeight:         500,
                color:              UXP.ink1,
                fontVariantNumeric: 'tabular-nums' as const,
                minWidth:           80,
                textAlign:          'right' as const,
              }}>
                {inv.total != null ? fmtKr(inv.total) : '—'}
              </span>
              {/* Single PDF button — opens inline modal. Stay-in-app:
                  prefer file_id → file proxy URL; else fall back to
                  invoice-pdf endpoint (just-in-time detail fetch +
                  302 to file proxy). Never link out to Fortnox web. */}
              {bizId && (inv.file_id || inv.given_number) && (
                <button
                  type="button"
                  onClick={() => {
                    const url = inv.file_id
                      ? `/api/integrations/fortnox/file?business_id=${encodeURIComponent(bizId)}&file_id=${encodeURIComponent(inv.file_id)}`
                      : `/api/integrations/fortnox/invoice-pdf?business_id=${encodeURIComponent(bizId)}&given_number=${encodeURIComponent(inv.given_number!)}`
                    setPdfModal({ url, title: `${row.supplier_name} — #${inv.invoice_number}` })
                  }}
                  style={{
                    padding:        '4px 10px',
                    background:     UXP.lavFill,
                    color:          UXP.lavText,
                    border:         'none',
                    borderRadius:   999,
                    fontSize:       10,
                    fontWeight:     500,
                    cursor:         'pointer',
                    fontFamily:     'inherit',
                    letterSpacing:  '0.02em',
                  }}
                >PDF</button>
              )}
            </div>
          ))}
        </div>
      )}

      {pdfModal && (
        <SuppliersPdfModal
          url={pdfModal.url}
          title={pdfModal.title}
          onClose={() => setPdfModal(null)}
        />
      )}
    </div>
  )
}

// Inline PDF viewer — embedded iframe of the file proxy (or invoice-pdf
// 302). Stay-in-app. Footer has 'Open in new tab' fallback for browsers
// that don't render PDFs in iframes (rare mobile Chrome).
function SuppliersPdfModal({ url, title, onClose }: { url: string; title: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose}
      style={{
        position: 'fixed' as const, inset: 0, background: 'rgba(20,18,40,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 200, padding: 16,
      }}>
      <div onClick={e => e.stopPropagation()}
        style={{
          width: 'min(960px, 100%)', height: '90vh',
          background: '#fff', borderRadius: 8, overflow: 'hidden' as const,
          display: 'flex', flexDirection: 'column' as const,
          boxShadow: '0 20px 60px rgba(0,0,0,0.40)',
        }}>
        <div style={{
          padding: '10px 14px', borderBottom: `0.5px solid ${UXP.borderSoft}`,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
        }}>
          <div style={{ fontSize: 13, fontWeight: 500, color: UXP.ink1, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>
            {title}
          </div>
          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            <a href={url} target="_blank" rel="noopener noreferrer"
              style={{
                padding: '5px 10px', fontSize: 11, fontWeight: 500,
                background: 'transparent', color: UXP.ink3,
                border: `0.5px solid ${UXP.border}`, borderRadius: 4,
                textDecoration: 'none', fontFamily: 'inherit',
              }}>Open in new tab ↗</a>
            <button onClick={onClose}
              style={{
                padding: '5px 12px', fontSize: 11, fontWeight: 600,
                background: UXP.ink1, color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit',
              }}>Close (Esc)</button>
          </div>
        </div>
        <iframe src={url} title="Invoice PDF"
          style={{ flex: 1, border: 'none', width: '100%', background: '#fff' }} />
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: UXP.subtleBg, padding: '8px 10px', borderRadius: 8 }}>
      <div style={{ fontSize: 9, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</div>
      <div style={{
        fontSize:           13,
        fontWeight:         500,
        color:              UXP.ink1,
        marginTop:          2,
        fontVariantNumeric: 'tabular-nums' as const,
      }}>{value}</div>
    </div>
  )
}

function Banner({ tone, text }: { tone: 'bad' | 'good'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: UXP.roseFill,  border: UXP.rose,  fg: UXP.roseText  }
    : { bg: UXP.greenFill, border: UXP.green, fg: UXP.greenDeep }
  return (
    <div style={{
      background:    palette.bg,
      border:        `0.5px solid ${palette.border}`,
      borderRadius:  UXP.r_md,
      padding:       '10px 14px',
      fontSize:      12,
      color:         palette.fg,
      marginBottom:  12,
    }}>
      {text}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      padding:       40,
      textAlign:     'center' as const,
      color:         UXP.ink4,
      fontSize:      12,
      background:    UXP.cardBg,
      borderRadius:  UXP.r_lg,
      border:        `0.5px solid ${UXP.border}`,
      marginBottom:  12,
    }}>
      {children}
    </div>
  )
}

// Shown when Fortnox responds invalid_grant — the refresh token was
// rotated, revoked, or expired. The server has already flipped the
// integration row to status='needs_reauth' so other endpoints will
// short-circuit cleanly; the owner just needs to re-OAuth.
function ReconnectCard() {
  return (
    <div style={{
      background:    UXP.cardBg,
      borderRadius:  UXP.r_lg,
      border:        `0.5px solid ${UXP.lavMid}`,
      padding:       28,
      textAlign:     'center' as const,
      marginBottom:  12,
    }}>
      <div style={{
        display:        'inline-flex',
        padding:        '4px 10px',
        background:     UXP.lavFill,
        color:          UXP.lavText,
        border:         `0.5px solid ${UXP.lavMid}`,
        borderRadius:   999,
        fontSize:       10,
        fontWeight:     600,
        letterSpacing:  '0.08em',
        textTransform:  'uppercase',
        marginBottom:   12,
      }}>
        Reconnect needed
      </div>
      <h2 style={{
        margin:       '0 0 6px',
        fontSize:     18,
        fontWeight:   500,
        color:        UXP.ink1,
        letterSpacing: '-0.01em',
      }}>
        Fortnox connection expired
      </h2>
      <p style={{
        margin:    '0 auto 18px',
        fontSize:  12,
        color:     UXP.ink3,
        lineHeight: 1.55,
        maxWidth:  420,
      }}>
        The refresh token Fortnox issued has been rotated or revoked,
        so we can&apos;t pull supplier data right now. Reconnecting takes
        about 30 seconds and restores access to invoices, suppliers,
        and overhead drilldowns.
      </p>
      <a
        href="/integrations"
        style={{
          display:        'inline-flex',
          alignItems:     'center',
          gap:            6,
          padding:        '9px 18px',
          background:     UXP.lavDeep,
          color:          'white',
          borderRadius:   10,
          fontSize:       12,
          fontWeight:     600,
          textDecoration: 'none',
        }}
      >
        Reconnect Fortnox →
      </a>
    </div>
  )
}
