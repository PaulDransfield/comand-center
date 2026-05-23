'use client'
// @ts-nocheck
// app/invoices/page.tsx — full rebuild on the new system
//
// Phase 5 only added the KPI strip on top of the legacy navy table +
// drop-zone + filter tabs. This is the body rebuild — every surface
// lives on UXP + KpiCardUX + BreakdownTable.
//
// Data:
//   GET    /api/invoices?business_id      — list invoices
//   POST   /api/invoices/extract          — PDF → extracted invoice
//   PATCH  /api/invoices                  — update status
//   DELETE /api/invoices?id=              — delete

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'

import AppShell from '@/components/AppShell'
import KpiCardUX from '@/components/ux/KpiCard'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Invoice {
  id:         string
  vendor:     string
  amount:     number
  date:       string
  category:   string
  status:     'paid' | 'pending' | 'overdue' | string
  notes:      string | null
  created_at: string
  file_url:   string | null
}

const fmtDate = (s: string) =>
  s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

type StatusFilter = 'all' | 'paid' | 'pending' | 'overdue'

export default function InvoicesPage() {
  const t = useTranslations('alerts.invoices')

  const [bizId,     setBizId]     = useState<string | null>(null)
  const [invoices,  setInvoices]  = useState<Invoice[]>([])
  const [loading,   setLoading]   = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragging,  setDragging]  = useState(false)
  const [filter,    setFilter]    = useState<StatusFilter>('all')
  const fileRef = useRef<HTMLInputElement>(null)

  // BizPicker
  useEffect(() => {
    const sync = () => { const s = localStorage.getItem('cc_selected_biz'); if (s) setBizId(s) }
    sync()
    window.addEventListener('storage', sync)
    return () => window.removeEventListener('storage', sync)
  }, [])

  const [fortnoxFallback, setFortnoxFallback] = useState(false)

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true)
    let localCount = 0
    try {
      const res  = await fetch(`/api/invoices?business_id=${bizId}`)
      const data = await res.json()
      if (Array.isArray(data)) {
        setInvoices(data)
        localCount = data.length
      }
    } catch {}

    // Fall back to live Fortnox supplier invoices when the local
    // invoices table is empty (Fortnox-connected customer, sync hasn't
    // populated local yet, OR they've never used the manual upload
    // flow). Maps Fortnox shape → local Invoice shape so the rest of
    // the page renders without branching.
    if (localCount === 0) {
      try {
        const r = await fetch(`/api/integrations/fortnox/recent-invoices?business_id=${bizId}&days=90`,
                              { cache: 'no-store' })
        if (r.ok) {
          const j = await r.json()
          if (Array.isArray(j?.invoices) && j.invoices.length > 0) {
            setFortnoxFallback(true)
            setInvoices(j.invoices.map((inv: any) => ({
              id:         `fortnox_${inv.given_number || inv.invoice_number}`,
              vendor:     inv.supplier_name,
              amount:     Number(inv.total ?? 0),
              date:       inv.invoice_date,
              category:   'fortnox',
              // Use real status derived from Fortnox payment signals:
              // Balance=0 / FinalPayDate set → paid; DueDate < today & balance > 0 → overdue;
              // otherwise pending. Falls back to 'pending' for old payloads
              // that don't carry the status field yet.
              status:     (inv.status as 'paid' | 'pending' | 'overdue') ?? 'pending',
              notes:      inv.comments,
              created_at: inv.invoice_date,
              file_url:   inv.file_id ? `/api/integrations/fortnox/file?file_id=${inv.file_id}&business_id=${bizId}` : null,
            })))
          }
        }
      } catch {}
    } else {
      setFortnoxFallback(false)
    }

    setLoading(false)
  }, [bizId])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  async function uploadFile(file: File) {
    if (!bizId) return
    setUploading(true)
    const fd = new FormData()
    fd.append('file', file)
    fd.append('business_id', bizId)
    try {
      const res = await fetch('/api/invoices/extract', { method: 'POST', body: fd })
      if (res.ok) load()
    } catch {}
    setUploading(false)
  }

  async function updateStatus(id: string, status: string) {
    await fetch('/api/invoices', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    })
    load()
  }

  async function deleteInvoice(id: string) {
    if (!confirm(t('table.deleteConfirm'))) return
    await fetch(`/api/invoices?id=${id}`, { method: 'DELETE' })
    load()
  }

  // Filter + derived stats
  const filtered = filter === 'all' ? invoices : invoices.filter(i => i.status === filter)
  // 'Total this month' must mean the current calendar month, NOT the whole
  // 90-day Fortnox-fallback window. Pre-fix this tile read sum-of-all and
  // surfaced 1.75 MSEK for a customer with ~600 k SEK/month revenue —
  // obviously wrong. Filter to current YYYY-MM before summing.
  const thisMonthPrefix = new Date().toISOString().slice(0, 7)   // YYYY-MM
  const thisMonthInvoices = invoices.filter(i => (i.date ?? '').startsWith(thisMonthPrefix))
  const total    = thisMonthInvoices.reduce((s, i) => s + Number(i.amount ?? 0), 0)
  const overdue  = invoices.filter(i => i.status === 'overdue')
  const pending  = invoices.filter(i => i.status === 'pending')
  const overdueAmt = overdue.reduce((s, i) => s + Number(i.amount ?? 0), 0)
  const pendingAmt = pending.reduce((s, i) => s + Number(i.amount ?? 0), 0)

  const largestSupplier = (() => {
    if (invoices.length === 0) return null
    const byVendor: Record<string, number> = {}
    invoices.forEach(i => { byVendor[i.vendor] = (byVendor[i.vendor] ?? 0) + Number(i.amount ?? 0) })
    const top = Object.entries(byVendor).sort((a, b) => b[1] - a[1])[0]
    return top ? { name: top[0], amount: top[1] } : null
  })()

  return (
    <AppShell>
      <div style={{ display: 'grid', gap: 14, maxWidth: 1280 }}>

        {/* Fortnox live-fallback banner — only visible when the local
            invoices table is empty and we're rendering data straight from
            Fortnox /supplierinvoices. Tells the owner why
            'Mark paid' etc. won't stick yet. */}
        {fortnoxFallback && (
          <div style={{
            padding:      '10px 14px',
            background:   UXP.lavFill,
            border:       `0.5px solid ${UXP.lavMid}`,
            borderRadius: 8,
            fontSize:     12,
            color:        UXP.lavText,
            lineHeight:   1.5,
          }}>
            <strong>Live från Fortnox.</strong> Visar leverantörsfakturor de senaste 90 dagarna direkt från Fortnox. Statusändringar (markera som betald, snooza) lagras inte ännu — det kommer när Fortnox-synken aktiveras.
          </div>
        )}

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' as const }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>{t('page.title')}</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>{t('page.subtitle')}</p>
            <span style={{
              display:        'inline-flex',
              alignItems:     'center',
              gap:            5,
              marginTop:      8,
              padding:        '3px 10px',
              background:     UXP.lavFill,
              color:          UXP.lavText,
              borderRadius:   999,
              fontSize:       10,
              fontWeight:     500,
              letterSpacing:  '0.02em',
            }}>
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: UXP.green, display: 'inline-block' }} />
              Synkad från Fortnox
            </span>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf"
              style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.[0]) uploadFile(e.target.files[0]) }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              style={{
                padding:      '8px 16px',
                background:   UXP.lavDeep,
                color:        '#fff',
                border:       'none',
                borderRadius: 999,
                fontSize:     12,
                fontWeight:   500,
                fontFamily:   'inherit',
                cursor:       'pointer',
              }}
            >
              {t('page.uploadPdf')}
            </button>
          </div>
        </div>

        {/* KPI strip */}
        <div style={{
          display:             'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap:                 12,
        }}>
          <KpiCardUX
            title={t('kpi.invoicesCount', { count: invoices.length })}
            value={String(invoices.length)}
            microLabel="In current view"
          />
          <KpiCardUX
            title={t('kpi.totalThisMonth')}
            value={fmtKr(total)}
            microLabel={largestSupplier ? `Largest: ${largestSupplier.name}` : ''}
          />
          <KpiCardUX
            title="Pending"
            value={String(pending.length)}
            microLabel={pendingAmt > 0 ? fmtKr(pendingAmt) : 'None pending'}
          />
          <KpiCardUX
            title={t('kpi.overdue')}
            value={String(overdue.length)}
            deltaGood={false}
            delta={overdue.length > 0 ? `${fmtKr(overdueAmt)} outstanding` : null}
            microLabel={overdue.length === 0 ? t('kpi.noneOverdue') : 'Needs action'}
          />
        </div>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f) }}
          onClick={() => fileRef.current?.click()}
          style={{
            background:    dragging ? UXP.lavFill : UXP.subtleBg,
            border:        `1.5px dashed ${dragging ? UXP.lav : UXP.lavMid}`,
            borderRadius:  UXP.r_lg,
            padding:       '16px 20px',
            textAlign:     'center' as const,
            cursor:        'pointer',
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 500, color: UXP.lavText }}>
            {uploading ? t('drop.extracting') : t('drop.drop')}
          </div>
          <div style={{ fontSize: 10, color: UXP.lavText, opacity: 0.75, marginTop: 3 }}>
            {t('drop.hint')}
          </div>
        </div>

        {/* Filter pills */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
          {(['all', 'paid', 'pending', 'overdue'] as const).map(f => (
            <FilterPill key={f} active={filter === f} onClick={() => setFilter(f)}>
              {t(`filter.${f}`)}
            </FilterPill>
          ))}
        </div>

        {/* Table */}
        {loading ? (
          <div style={{ padding: 60, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>{t('table.loading')}</div>
        ) : filtered.length === 0 ? (
          <Empty>{invoices.length === 0 ? t('table.emptyAll') : t('table.emptyFilter')}</Empty>
        ) : (
          <BreakdownTable<Invoice>
            columns={[
              {
                key: 'supplier', header: t('table.supplier'), align: 'left',
                render: (inv) => <span style={{ color: UXP.ink1, fontWeight: 500 }}>{inv.vendor}</span>,
              },
              {
                key: 'date', header: t('table.date'), align: 'left',
                render: (inv) => <span style={{ color: UXP.ink3 }}>{fmtDate(inv.date || inv.created_at)}</span>,
              },
              {
                key: 'amount', header: t('table.amount'), align: 'right',
                render: (inv) => (
                  <span style={{ color: UXP.ink1, fontWeight: 500, fontVariantNumeric: 'tabular-nums' as const }}>
                    {fmtKr(Number(inv.amount))}
                  </span>
                ),
              },
              {
                key: 'category', header: t('table.category'), align: 'left',
                render: (inv) => (
                  <span style={{
                    display:       'inline-block',
                    fontSize:      10,
                    padding:       '2px 7px',
                    background:    UXP.subtleBg,
                    color:         UXP.ink2,
                    borderRadius:  6,
                    border:        `0.5px solid ${UXP.border}`,
                  }}>{inv.category}</span>
                ),
              },
              {
                key: 'status', header: t('table.status'), align: 'right',
                render: (inv) => (
                  <select
                    value={inv.status}
                    onChange={e => updateStatus(inv.id, e.target.value)}
                    style={{
                      padding:       '3px 8px',
                      background:    statusBg(inv.status),
                      color:         statusFg(inv.status),
                      border:        `0.5px solid ${statusBorder(inv.status)}`,
                      borderRadius:  6,
                      fontSize:      10,
                      fontWeight:    500,
                      cursor:        'pointer',
                      fontFamily:    'inherit',
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase' as const,
                    }}
                  >
                    <option value="pending">{t('status.pending')}</option>
                    <option value="paid">{t('status.paid')}</option>
                    <option value="overdue">{t('status.overdue')}</option>
                  </select>
                ),
              },
              {
                key: 'actions', header: '', align: 'right',
                render: (inv) => (
                  <div style={{ display: 'inline-flex', gap: 6 }}>
                    {inv.file_url && (
                      <a
                        href={inv.file_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          padding:        '3px 10px',
                          background:     UXP.lavFill,
                          color:          UXP.lavText,
                          border:         'none',
                          borderRadius:   999,
                          fontSize:       10,
                          fontWeight:     500,
                          textDecoration: 'none',
                          letterSpacing:  '0.02em',
                        }}
                      >PDF</a>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteInvoice(inv.id)}
                      style={{
                        padding:      '3px 10px',
                        background:   UXP.roseFill,
                        color:        UXP.roseText,
                        border:       'none',
                        borderRadius: 999,
                        fontSize:     10,
                        fontWeight:   500,
                        cursor:       'pointer',
                        fontFamily:   'inherit',
                      }}
                    >
                      {t('table.delete')}
                    </button>
                  </div>
                ),
              },
            ]}
            sections={[{ rows: filtered }]}
            footer={filter === 'all' ? {
              label: 'Total',
              cells: {
                date:     '',
                amount:   fmtKr(total),
                category: '',
                status:   '',
                actions:  '',
              },
            } : null}
            rowKey={(row) => row.id}
          />
        )}
      </div>
    </AppShell>
  )
}

// ── Status palette ─────────────────────────────────────────────────
function statusBg(status: string) {
  if (status === 'paid')    return UXP.greenFill
  if (status === 'overdue') return UXP.roseFill
  return UXP.lavFill
}
function statusFg(status: string) {
  if (status === 'paid')    return UXP.greenDeep
  if (status === 'overdue') return UXP.roseText
  return UXP.coral
}
function statusBorder(status: string) {
  if (status === 'paid')    return UXP.green
  if (status === 'overdue') return UXP.rose
  return UXP.lavMid
}

// ── Atoms ──────────────────────────────────────────────────────────

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
        textTransform: 'capitalize' as const,
      }}
    >
      {children}
    </button>
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
    }}>{children}</div>
  )
}
