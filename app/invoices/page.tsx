'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import { useEffect, useState, useRef, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { deptColor, deptBg, KPI_CARD, CARD, BTN, CC_DARK, CC_PURPLE, CC_GREEN, CC_RED } from '@/lib/constants/colors'
import { fmtKr } from '@/lib/format'
// Phase 5 — Bookkeeping. Replace the inline 3-card grid with 4 KpiCardUX
// + a "Synkad från Fortnox" indicator near the title.
import KpiCardUX from '@/components/ux/KpiCard'
import { UXP } from '@/lib/constants/tokens'

interface Invoice {
  id: string; vendor: string; amount: number; date: string
  category: string; status: string; notes: string | null
  created_at: string; file_url: string | null
}
interface Business { id: string; name: string }

const fmtDate = (s: string) => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

const STATUS_STYLE: Record<string, { bg: string; color: string }> = {
  paid:    { bg: '#f0fdf4', color: '#15803d' },
  overdue: { bg: '#fef2f2', color: '#dc2626' },
  pending: { bg: '#fef3c7', color: '#d97706' },
}

export default function InvoicesPage() {
  const t = useTranslations('alerts.invoices')
  const [businesses, setBusinesses] = useState<Business[]>([])
  const [selected,   setSelected]   = useState('')
  const [invoices,   setInvoices]   = useState<Invoice[]>([])
  const [loading,    setLoading]    = useState(true)
  const [uploading,  setUploading]  = useState(false)
  const [dragging,   setDragging]   = useState(false)
  const [filter,     setFilter]     = useState('all')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then((data: any[]) => {
      if (!Array.isArray(data) || !data.length) return
      setBusinesses(data)
      const sync = () => {
        const saved = localStorage.getItem('cc_selected_biz')
        const id = (saved && data.find((b: any) => b.id === saved)) ? saved : data[0].id
        setSelected(id)
      }
      sync()
      window.addEventListener('storage', sync)
    }).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    if (!selected) return
    setLoading(true)
    const res  = await fetch(`/api/invoices?business_id=${selected}`)
    const data = await res.json()
    if (Array.isArray(data)) setInvoices(data)
    setLoading(false)
  }, [selected])

  useEffect(() => { if (selected) load() }, [selected])

  async function uploadFile(file: File) {
    setUploading(true)
    const formData = new FormData()
    formData.append('file', file)
    formData.append('business_id', selected)
    try {
      const res = await fetch('/api/invoices/extract', { method: 'POST', body: formData })
      if (res.ok) load()
    } catch {}
    setUploading(false)
  }

  async function deleteInvoice(id: string) {
    if (!confirm(t('table.deleteConfirm'))) return
    await fetch(`/api/invoices?id=${id}`, { method: 'DELETE' })
    load()
  }

  async function updateStatus(id: string, status: string) {
    await fetch('/api/invoices', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status }),
    })
    load()
  }

  const filtered   = filter === 'all' ? invoices : invoices.filter(i => i.status === filter)
  const total      = invoices.reduce((s, i) => s + Number(i.amount ?? 0), 0)
  const overdue    = invoices.filter(i => i.status === 'overdue')
  const overdueAmt = overdue.reduce((s, i) => s + Number(i.amount ?? 0), 0)

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 1000 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>{t('page.title')}</h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>{t('page.subtitle')}</p>
            <span style={{
              display:      'inline-flex',
              alignItems:   'center',
              gap:          5,
              marginTop:    8,
              padding:      '3px 8px',
              background:   UXP.lavFill,
              color:        UXP.lavText,
              borderRadius: 999,
              fontSize:     10,
              fontWeight:   500,
              letterSpacing: '0.02em',
            }}>
              <span aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: UXP.green, display: 'inline-block' }} />
              Synkad från Fortnox
            </span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={selected} onChange={e => setSelected(e.target.value)}
              style={{ padding: '8px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, background: 'white' }}>
              {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <input ref={fileRef} type="file" accept=".pdf" style={{ display: 'none' }}
              onChange={e => { if (e.target.files?.[0]) uploadFile(e.target.files[0]) }} />
            <button onClick={() => fileRef.current?.click()}
              style={{ padding: '8px 16px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
              {t('page.uploadPdf')}
            </button>
          </div>
        </div>

        {/* Phase 5 KPI strip — Count · Total · Due-soon (pending) · Flagged
            (overdue). Spec called for due-soon based on a due_date, but the
            invoices table doesn't carry one; pending count is the closest
            actionable signal until that column lands. */}
        {(() => {
          const pending = invoices.filter(i => i.status === 'pending')
          const pendingAmt = pending.reduce((s, i) => s + Number(i.amount ?? 0), 0)
          return (
            <div
              style={{
                display:             'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                gap:                 12,
                marginBottom:        16,
              }}
            >
              <KpiCardUX
                title={t('kpi.invoicesCount', { count: invoices.length })}
                value={String(invoices.length)}
                microLabel="In current view"
              />
              <KpiCardUX
                title={t('kpi.totalThisMonth')}
                value={fmtKr(total)}
                microLabel={`${invoices.length} invoices`}
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
          )
        })()}

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) uploadFile(f) }}
          onClick={() => fileRef.current?.click()}
          style={{ background: dragging ? '#ede9fe' : '#f0f9ff', border: `1.5px dashed ${dragging ? '#6366f1' : '#bae6fd'}`, borderRadius: 12, padding: '16px 20px', textAlign: 'center', cursor: 'pointer', marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#0369a1' }}>
            {uploading ? t('drop.extracting') : t('drop.drop')}
          </div>
          <div style={{ fontSize: 11, color: '#0284c7', marginTop: 3 }}>
            {t('drop.hint')}
          </div>
        </div>

        {/* Filter tabs */}
        <div style={{ display: 'flex', gap: 4, background: '#f3f4f6', borderRadius: 8, padding: 3, width: 'fit-content', marginBottom: 14 }}>
          {(['all','paid','pending','overdue'] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ padding: '5px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: filter === f ? 600 : 400,
                background: filter === f ? 'white' : 'transparent', color: filter === f ? '#111' : '#6b7280' }}>
              {t(`filter.${f}`)}
            </button>
          ))}
        </div>

        {/* Invoice table */}
        <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>{t('table.loading')}</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              {invoices.length === 0 ? t('table.emptyAll') : t('table.emptyFilter')}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#fafafa', borderBottom: '1px solid #e5e7eb' }}>
                  {[
                    { key: 'supplier', label: t('table.supplier') },
                    { key: 'date',     label: t('table.date') },
                    { key: 'amount',   label: t('table.amount') },
                    { key: 'category', label: t('table.category') },
                    { key: 'status',   label: t('table.status') },
                    { key: 'actions',  label: '' },
                  ].map(h => (
                    <th key={h.key} style={{ textAlign: 'left', padding: '10px 14px', fontSize: 11, fontWeight: 600, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(inv => {
                  const ss = STATUS_STYLE[inv.status] ?? STATUS_STYLE.pending
                  return (
                    <tr key={inv.id} style={{ borderBottom: '0.5px solid #f3f4f6' }}>
                      <td style={{ padding: '11px 14px', fontWeight: 600, color: '#111' }}>{inv.vendor}</td>
                      <td style={{ padding: '11px 14px', color: '#6b7280' }}>{fmtDate(inv.date || inv.created_at)}</td>
                      <td style={{ padding: '11px 14px', fontWeight: 600 }}>{fmtKr(Number(inv.amount))}</td>
                      <td style={{ padding: '11px 14px' }}>
                        <span style={{ background: '#f3f4f6', color: '#374151', padding: '2px 8px', borderRadius: 4, fontSize: 12 }}>{inv.category}</span>
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <select value={inv.status} onChange={e => updateStatus(inv.id, e.target.value)}
                          style={{ padding: '3px 8px', background: ss.bg, color: ss.color, border: 'none', borderRadius: 4, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
                          <option value="pending">{t('status.pending')}</option>
                          <option value="paid">{t('status.paid')}</option>
                          <option value="overdue">{t('status.overdue')}</option>
                        </select>
                      </td>
                      <td style={{ padding: '11px 14px' }}>
                        <button onClick={() => deleteInvoice(inv.id)}
                          style={{ padding: '3px 10px', background: '#fef2f2', color: '#dc2626', border: 'none', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}>
                          {t('table.delete')}
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </AppShell>
  )
}
