$content = @'
// app/invoices/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'

interface Business { id: string; name: string; city: string | null }
interface Invoice {
  id: string; business_id: string; vendor: string; description: string | null
  amount: number; vat_amount: number; amount_inc_vat: number
  invoice_date: string | null; due_date: string | null; paid_date: string | null
  invoice_number: string | null; category: string; status: string
  days_until_due: number | null; is_overdue: boolean; notes: string | null
  source: string; snoozed_until: string | null
  businesses: { name: string; city: string | null } | null
}

const CAT_COLOURS: Record<string, string> = {
  food_beverage: '#2D6A35', alcohol: '#7A3B1E', staff: '#1A3F6B',
  rent: '#4A237A', cleaning: '#1A5F5F', repairs: '#6B4C1A',
  marketing: '#1E5F3F', utilities: '#5F3F1E', admin: '#3F3F5F', other: '#666',
}

const fmtKr   = (n: number) => Math.round(n).toLocaleString('sv-SE') + ' kr'
const fmtDate = (s: string | null) => s ? new Date(s).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short', year: 'numeric' }) : '--'

function urgencyColour(inv: Invoice): string {
  if (inv.status === 'paid')      return '#D1FAE5'
  if (inv.status === 'snoozed')   return '#EDE9FE'
  if (inv.status === 'cancelled') return '#F3F4F6'
  if (inv.is_overdue || (inv.days_until_due !== null && inv.days_until_due < 0)) return '#FEE2E2'
  if (inv.days_until_due !== null && inv.days_until_due <= 7)  return '#FEF3C7'
  if (inv.days_until_due !== null && inv.days_until_due <= 30) return '#FFF7ED'
  return '#F0FDF4'
}

function dueBadge(inv: Invoice): React.ReactNode {
  if (inv.status === 'paid')      return <span style={{ color: '#065F46', fontWeight: 700 }}>Paid {fmtDate(inv.paid_date)}</span>
  if (inv.status === 'cancelled') return <span style={{ color: '#9CA3AF' }}>Cancelled</span>
  if (inv.status === 'snoozed')   return <span style={{ color: '#5B21B6' }}>Snoozed to {fmtDate(inv.snoozed_until)}</span>
  if (!inv.due_date)              return <span style={{ color: '#9CA3AF' }}>No due date</span>
  if (inv.is_overdue) {
    const days = Math.abs(inv.days_until_due ?? 0)
    return <span style={{ color: '#991B1B', fontWeight: 700 }}>! {days}d overdue</span>
  }
  if (inv.days_until_due === 0) return <span style={{ color: '#D97706', fontWeight: 700 }}>Due today!</span>
  if (inv.days_until_due !== null && inv.days_until_due <= 7)
    return <span style={{ color: '#D97706', fontWeight: 700 }}>Due in {inv.days_until_due}d</span>
  return <span style={{ color: '#6B7280' }}>Due {fmtDate(inv.due_date)}</span>
}

export default function InvoicesPage() {
  const [businesses,  setBusinesses]  = useState<Business[]>([])
  const [selected,    setSelected]    = useState('all')
  const [invoices,    setInvoices]    = useState<Invoice[]>([])
  const [loading,     setLoading]     = useState(true)
  const [filter,      setFilter]      = useState('active')
  const [showForm,    setShowForm]    = useState(false)
  const [actionInv,   setActionInv]   = useState<Invoice | null>(null)
  const [saving,      setSaving]      = useState(false)
  const [extracting,  setExtracting]  = useState(false)
  const [dragOver,    setDragOver]    = useState(false)
  const [lineItems,   setLineItems]   = useState<any[]>([])
  const [detailInv,   setDetailInv]   = useState<Invoice | null>(null)
  const [detailItems, setDetailItems] = useState<any[]>([])
  const [docUrl,      setDocUrl]      = useState<string | null>(null)

  const [form, setForm] = useState({
    business_id: '', vendor: '', amount: '', vat_amount: '',
    due_date: '', invoice_date: '', invoice_number: '', description: '', category: 'food_beverage',
  })

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then(data => {
      if (Array.isArray(data) && data.length > 0) {
        setBusinesses(data)
        setForm(f => ({ ...f, business_id: f.business_id || data[0].id }))
      }
    })
  }, [])

  // Ensure business_id is always set when form opens
  useEffect(() => {
    if (showForm && !form.business_id && businesses.length > 0) {
      setForm(f => ({ ...f, business_id: businesses[0].id }))
    }
  }, [showForm, businesses])

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams()
    if (selected !== 'all') params.set('business_id', selected)
    if (filter === 'paid') params.set('status', 'paid')
    const res  = await fetch('/api/invoices?' + params)
    const data = await res.json()
    if (Array.isArray(data)) setInvoices(data)
    setLoading(false)
  }, [selected, filter])

  useEffect(() => { load() }, [load])

  async function handleFile(file: File) {
    if (!file) return
    if (!['application/pdf','image/jpeg','image/png','image/jpg'].includes(file.type)) {
      alert('Please use a PDF or image file')
      return
    }
    setExtracting(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res  = await fetch('/api/invoices/extract', { method: 'POST', body: fd })
      const data = await res.json()
      setForm(f => ({
        ...f,
        vendor:         data.vendor         ?? f.vendor,
        amount:         data.amount         ? String(data.amount)     : f.amount,
        vat_amount:     data.vat_amount     ? String(data.vat_amount) : f.vat_amount,
        due_date:       data.due_date       ?? f.due_date,
        invoice_date:   data.invoice_date   ?? f.invoice_date,
        invoice_number: data.invoice_number ?? f.invoice_number,
        category:       data.category       ?? f.category,
      }))
      if (Array.isArray(data.line_items)) setLineItems(data.line_items)
      if (data.file_url) setDocUrl(data.file_url)
    } catch { alert('Extraction failed -- fill in manually') }
    setExtracting(false)
  }

  async function saveInvoice(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    await fetch('/api/invoices', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...form, line_items: lineItems, doc_url: docUrl }),
    })
    setSaving(false)
    setShowForm(false)
    setLineItems([])
    setDocUrl(null)
    setForm(f => ({ ...f, vendor: '', amount: '', vat_amount: '', due_date: '', invoice_date: '', invoice_number: '', description: '' }))
    await load()
  }

  async function doAction(id: string, action: string, extra?: Record<string, any>) {
    await fetch('/api/invoices', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action, ...extra }),
    })
    setActionInv(null)
    await load()
  }

  async function deleteInvoice(id: string) {
    if (!confirm('Delete this invoice permanently?')) return
    await fetch(`/api/invoices?id=${id}`, { method: 'DELETE' })
    setDetailInv(null)
    setActionInv(null)
    await load()
  }

  const overdue     = invoices.filter(i => i.is_overdue && i.status === 'unpaid')
  const dueThisWeek = invoices.filter(i => !i.is_overdue && i.days_until_due !== null && i.days_until_due >= 0 && i.days_until_due <= 7 && i.status === 'unpaid')
  const dueThisMth  = invoices.filter(i => !i.is_overdue && i.days_until_due !== null && i.days_until_due > 7 && i.days_until_due <= 30 && i.status === 'unpaid')
  const totalUnpaid = invoices.filter(i => i.status === 'unpaid').reduce((s, i) => s + Number(i.amount_inc_vat ?? i.amount), 0)
  const totalOverdue= overdue.reduce((s, i) => s + Number(i.amount_inc_vat ?? i.amount), 0)

  const displayed = filter === 'active'
    ? invoices.filter(i => i.status !== 'paid' && i.status !== 'cancelled')
    : filter === 'paid'
    ? invoices.filter(i => i.status === 'paid')
    : invoices

  return (
    <div style={{ padding: 24, maxWidth: 1100 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 style={{ fontFamily: 'Georgia,serif', fontSize: 24, fontStyle: 'italic', color: '#1E2761', margin: '0 0 4px' }}>
            Invoice Tracker
          </h1>
          <p style={{ fontSize: 12, color: '#999', margin: 0 }}>Due dates and payment status across all restaurants</p>
        </div>
        <button onClick={() => setShowForm(true)}
          style={{ padding: '9px 16px', background: '#1E2761', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          + Add invoice
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 20 }}>
        {[
          { label: 'Overdue',        value: fmtKr(totalOverdue), count: overdue.length,     colour: '#FEE2E2', text: '#991B1B' },
          { label: 'Due this week',  value: fmtKr(dueThisWeek.reduce((s,i) => s + Number(i.amount_inc_vat ?? i.amount), 0)), count: dueThisWeek.length, colour: '#FEF3C7', text: '#92400E' },
          { label: 'Due this month', value: fmtKr(dueThisMth.reduce((s,i) => s + Number(i.amount_inc_vat ?? i.amount), 0)),  count: dueThisMth.length,  colour: '#FFF7ED', text: '#9A3412' },
          { label: 'Total outstanding', value: fmtKr(totalUnpaid), count: invoices.filter(i => i.status === 'unpaid').length, colour: '#F0F9FF', text: '#0369A1' },
        ].map(kpi => (
          <div key={kpi.label} style={{ background: kpi.colour, borderRadius: 12, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.08em', color: kpi.text, marginBottom: 6 }}>{kpi.label}</div>
            <div style={{ fontFamily: 'Georgia,serif', fontSize: 22, fontWeight: 700, color: kpi.text }}>{kpi.value}</div>
            <div style={{ fontSize: 11, color: kpi.text, opacity: .7, marginTop: 3 }}>{kpi.count} invoice{kpi.count !== 1 ? 's' : ''}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' as const }}>
        <select value={selected} onChange={e => setSelected(e.target.value)}
          style={{ padding: '8px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, background: 'white' }}>
          <option value="all">All restaurants</option>
          {businesses.map(b => <option key={b.id} value={b.id}>{b.name}{b.city ? ` (${b.city})` : ''}</option>)}
        </select>
        {['active','paid','all'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: '8px 14px', borderRadius: 8, border: '1.5px solid', fontSize: 12, cursor: 'pointer',
              borderColor: filter === f ? '#1E2761' : '#ddd',
              background:  filter === f ? '#1E2761' : 'white',
              color:       filter === f ? 'white'   : '#333' }}>
            {f === 'active' ? 'Outstanding' : f === 'paid' ? 'Paid' : 'All'}
          </button>
        ))}
      </div>

      <div style={{ background: 'white', border: '1px solid #eee', borderRadius: 12, overflow: 'hidden' }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: '#999' }}>Loading...</div>
        ) : displayed.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: '#999' }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>No invoices found</div>
            <div style={{ fontSize: 12 }}>Add invoices manually or connect Fortnox to sync automatically.</div>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#fafafa', borderBottom: '1px solid #eee' }}>
                <th style={{ textAlign: 'left' as const, padding: '10px 16px', color: '#999', fontWeight: 600 }}>Vendor</th>
                <th style={{ textAlign: 'left' as const, padding: '10px 8px', color: '#999', fontWeight: 600 }}>Restaurant</th>
                <th style={{ textAlign: 'left' as const, padding: '10px 8px', color: '#999', fontWeight: 600 }}>Category</th>
                <th style={{ textAlign: 'right' as const, padding: '10px 8px', color: '#999', fontWeight: 600 }}>Amount</th>
                <th style={{ textAlign: 'right' as const, padding: '10px 8px', color: '#999', fontWeight: 600 }}>Inc. VAT</th>
                <th style={{ textAlign: 'left' as const, padding: '10px 8px', color: '#999', fontWeight: 600 }}>Status</th>
                <th style={{ padding: '10px 16px' }}></th>
              </tr>
            </thead>
            <tbody>
              {displayed.map((inv, i) => (
                <tr key={inv.id}
                  onClick={() => { setDetailInv(inv); setDetailItems((inv as any).line_items ?? []); setDocUrl((inv as any).doc_url ?? null) }}
                  style={{ borderBottom: i < displayed.length-1 ? '1px solid #f5f5f5' : 'none', background: urgencyColour(inv), cursor: 'pointer' }}>
                  <td style={{ padding: '12px 16px' }}>
                    <div style={{ fontWeight: 600 }}>{inv.vendor}</div>
                    {inv.invoice_number && <div style={{ fontSize: 11, color: '#999' }}>#{inv.invoice_number}</div>}
                  </td>
                  <td style={{ padding: '12px 8px', color: '#666', fontSize: 12 }}>{inv.businesses?.name ?? '--'}</td>
                  <td style={{ padding: '12px 8px' }}>
                    <span style={{ background: CAT_COLOURS[inv.category] ?? '#666', color: 'white', padding: '2px 8px', borderRadius: 4, fontSize: 11 }}>
                      {inv.category.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td style={{ padding: '12px 8px', textAlign: 'right' as const, fontFamily: 'Georgia,serif' }}>{fmtKr(inv.amount)}</td>
                  <td style={{ padding: '12px 8px', textAlign: 'right' as const, fontFamily: 'Georgia,serif', fontWeight: 600 }}>{fmtKr(Number(inv.amount_inc_vat ?? inv.amount))}</td>
                  <td style={{ padding: '12px 8px' }}>{dueBadge(inv)}</td>
                  <td style={{ padding: '12px 16px', textAlign: 'right' as const }}>
                    {inv.status !== 'paid' && inv.status !== 'cancelled' && (
                      <button onClick={e => { e.stopPropagation(); setActionInv(inv) }}
                        style={{ background: 'none', border: '1px solid #ddd', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer', color: '#666' }}>
                        Actions
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showForm && (
        <>
          <div onClick={() => setShowForm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'white', borderRadius: 14, padding: 28, width: 540, maxWidth: '94vw', zIndex: 101, boxShadow: '0 20px 60px rgba(0,0,0,.2)', maxHeight: '90vh', overflowY: 'auto' as const }}>
            <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 20, fontStyle: 'italic', color: '#1E2761', margin: '0 0 16px' }}>Add Invoice</h2>

            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={async e => {
                e.preventDefault(); setDragOver(false)
                const file = e.dataTransfer.files[0]
                if (file) await handleFile(file)
              }}
              style={{
                border: `2px dashed ${dragOver ? '#1E2761' : '#ddd'}`,
                borderRadius: 10, padding: '20px 16px', textAlign: 'center' as const,
                marginBottom: 18, background: dragOver ? '#f0f7ff' : '#fafafa',
              }}>
              {extracting ? (
                <div style={{ color: '#1E2761', fontSize: 13 }}>Extracting invoice details with AI...</div>
              ) : (
                <>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#333', marginBottom: 4 }}>
                    Drag and drop invoice PDF or image
                  </div>
                  <div style={{ fontSize: 11, color: '#999', marginBottom: 10 }}>
                    Claude Vision will extract vendor, amount, and due date automatically
                  </div>
                  <label style={{ display: 'inline-block', padding: '6px 14px', background: '#1E2761', color: 'white', borderRadius: 6, fontSize: 12, cursor: 'pointer' }}>
                    Browse file
                    <input type="file" accept=".pdf,image/*" style={{ display: 'none' }} onChange={async e => {
                      const file = e.target.files?.[0]
                      if (file) await handleFile(file)
                    }} />
                  </label>
                </>
              )}
            </div>

            {/* Line items table - shown after extraction */}
            {lineItems.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#999', marginBottom: 8 }}>
                  Line Items ({lineItems.length})
                </div>
                <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                        <th style={{ textAlign: 'left' as const, padding: '7px 10px', color: '#9ca3af', fontWeight: 600 }}>Item</th>
                        <th style={{ textAlign: 'right' as const, padding: '7px 10px', color: '#9ca3af', fontWeight: 600 }}>Qty</th>
                        <th style={{ textAlign: 'right' as const, padding: '7px 10px', color: '#9ca3af', fontWeight: 600 }}>Unit price</th>
                        <th style={{ textAlign: 'right' as const, padding: '7px 10px', color: '#9ca3af', fontWeight: 600 }}>Amount</th>
                        <th style={{ textAlign: 'right' as const, padding: '7px 10px', color: '#9ca3af', fontWeight: 600 }}>VAT%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lineItems.map((item, i) => (
                        <tr key={i} style={{ borderBottom: i < lineItems.length-1 ? '1px solid #f3f4f6' : 'none' }}>
                          <td style={{ padding: '7px 10px', color: '#111' }}>{item.description}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' as const, color: '#666' }}>
                            {item.quantity != null ? `${item.quantity}${item.unit ? ' ' + item.unit : ''}` : '--'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' as const, color: '#666' }}>
                            {item.unit_price != null ? Math.round(item.unit_price).toLocaleString('sv-SE') + ' kr' : '--'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' as const, fontWeight: 600 }}>
                            {item.amount != null ? Math.round(item.amount).toLocaleString('sv-SE') + ' kr' : '--'}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right' as const, color: '#666' }}>
                            {item.vat_rate != null ? item.vat_rate + '%' : '--'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb', fontWeight: 700 }}>
                        <td colSpan={3} style={{ padding: '7px 10px', fontSize: 12 }}>Total ex VAT</td>
                        <td style={{ padding: '7px 10px', textAlign: 'right' as const }}>
                          {Math.round(lineItems.reduce((s, i) => s + (i.amount ?? 0), 0)).toLocaleString('sv-SE')} kr
                        </td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}

            <form onSubmit={saveInvoice}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div style={{ gridColumn: '1/-1' }}>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#999', marginBottom: 8 }}>Restaurant</label>
                  <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 8 }}>
                    {businesses.map(b => (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setForm(f => ({ ...f, business_id: b.id }))}
                        style={{
                          padding: '8px 14px', borderRadius: 8, fontSize: 13, cursor: 'pointer',
                          border: '1.5px solid',
                          borderColor: form.business_id === b.id ? '#1E2761' : '#ddd',
                          background:  form.business_id === b.id ? '#1E2761' : 'white',
                          color:       form.business_id === b.id ? 'white'   : '#333',
                          fontWeight:  form.business_id === b.id ? 600 : 400,
                        }}>
                        {b.name}{b.city ? ` (${b.city})` : ''}
                      </button>
                    ))}
                  </div>
                  {!form.business_id && (
                    <div style={{ fontSize: 11, color: '#e85b5b', marginTop: 4 }}>Please select a restaurant</div>
                  )}
                </div>
                {[
                  { key: 'vendor',         label: 'Vendor',             type: 'text',   required: true,  span: true  },
                  { key: 'amount',         label: 'Amount ex VAT (kr)', type: 'number', required: true,  span: false },
                  { key: 'vat_amount',     label: 'VAT amount (kr)',    type: 'number', required: false, span: false },
                  { key: 'invoice_date',   label: 'Invoice date',       type: 'date',   required: false, span: false },
                  { key: 'due_date',       label: 'Due date',           type: 'date',   required: false, span: false },
                  { key: 'invoice_number', label: 'Invoice number',     type: 'text',   required: false, span: false },
                ].map(field => (
                  <div key={field.key} style={{ gridColumn: field.span ? '1/-1' : undefined }}>
                    <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#999', marginBottom: 5 }}>{field.label}</label>
                    <input type={field.type} required={field.required}
                      min={field.type === 'number' ? 0 : undefined}
                      step={field.type === 'number' ? 'any' : undefined}
                      value={(form as any)[field.key]}
                      onChange={e => setForm(f => ({ ...f, [field.key]: e.target.value }))}
                      style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const }} />
                  </div>
                ))}
                <div>
                  <label style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, color: '#999', marginBottom: 5 }}>Category</label>
                  <select value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                    style={{ width: '100%', padding: '9px 12px', border: '1.5px solid #ddd', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const, background: 'white' }}>
                    {Object.keys(CAT_COLOURS).map(k => <option key={k} value={k}>{k.replace(/_/g,' ')}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button type="button" onClick={() => setShowForm(false)}
                  style={{ padding: '9px 18px', borderRadius: 8, border: '1.5px solid #ddd', background: 'white', cursor: 'pointer', fontSize: 13 }}>Cancel</button>
                <button type="submit" disabled={saving || extracting}
                  style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#1E2761', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                  {saving ? 'Saving...' : 'Save invoice'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {actionInv && (
        <>
          <div onClick={() => setActionInv(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100 }} />
          <div style={{ position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', background: 'white', borderRadius: 14, padding: 28, width: 360, zIndex: 101, boxShadow: '0 20px 60px rgba(0,0,0,.2)' }}>
            <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 18, fontStyle: 'italic', color: '#1E2761', margin: '0 0 6px' }}>{actionInv.vendor}</h2>
            <p style={{ fontSize: 13, color: '#666', margin: '0 0 20px' }}>{fmtKr(Number(actionInv.amount_inc_vat ?? actionInv.amount))}</p>
            <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
              <button onClick={() => doAction(actionInv.id, 'mark_paid')}
                style={{ padding: '10px 16px', borderRadius: 8, border: 'none', background: '#2D6A35', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600, textAlign: 'left' as const }}>
                Mark as paid
              </button>
              <button onClick={() => { const d = new Date(); d.setDate(d.getDate()+7); doAction(actionInv.id, 'snooze', { snoozed_until: d.toISOString().slice(0,10) }) }}
                style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontSize: 13, textAlign: 'left' as const }}>
                Snooze 7 days
              </button>
              <button onClick={() => { const d = new Date(); d.setDate(d.getDate()+30); doAction(actionInv.id, 'snooze', { snoozed_until: d.toISOString().slice(0,10) }) }}
                style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontSize: 13, textAlign: 'left' as const }}>
                Snooze 30 days
              </button>
              <button onClick={() => doAction(actionInv.id, 'cancel')}
                style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontSize: 13, textAlign: 'left' as const }}>
                Cancel invoice
              </button>
              <button onClick={() => setActionInv(null)}
                style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontSize: 13, color: '#666', textAlign: 'left' as const }}>
                Close
              </button>
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: 20 }}>
        <a href="/dashboard" style={{ fontSize: 12, color: '#666', textDecoration: 'none' }}>&lt;- Dashboard</a>
      </div>

      {/* Invoice detail panel */}
      {detailInv && (
        <>
          <div onClick={() => setDetailInv(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', zIndex: 100 }} />
          <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 580, maxWidth: '95vw', background: 'white', zIndex: 101, boxShadow: '-4px 0 30px rgba(0,0,0,.15)', display: 'flex', flexDirection: 'column' as const, overflowY: 'auto' as const }}>

            {/* Panel header */}
            <div style={{ padding: '20px 24px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexShrink: 0 }}>
              <div>
                <h2 style={{ fontFamily: 'Georgia,serif', fontSize: 20, fontStyle: 'italic', color: '#1E2761', margin: '0 0 4px' }}>{detailInv.vendor}</h2>
                <p style={{ fontSize: 12, color: '#999', margin: 0 }}>
                  {detailInv.businesses?.name}{detailInv.invoice_number ? ` · #${detailInv.invoice_number}` : ''}
                </p>
              </div>
              <button onClick={() => setDetailInv(null)}
                style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#999', padding: '0 4px' }}>x</button>
            </div>

            <div style={{ padding: 24, flex: 1 }}>

              {/* Key details */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 20 }}>
                {[
                  { label: 'Amount ex VAT', value: fmtKr(detailInv.amount) },
                  { label: 'Inc. VAT',      value: fmtKr(Number(detailInv.amount_inc_vat ?? detailInv.amount)) },
                  { label: 'Invoice date',  value: fmtDate(detailInv.invoice_date) },
                  { label: 'Due date',      value: fmtDate(detailInv.due_date) },
                  { label: 'Status',        value: detailInv.status.charAt(0).toUpperCase() + detailInv.status.slice(1) },
                  { label: 'Source',        value: detailInv.source },
                ].map(item => (
                  <div key={item.label} style={{ background: '#f9fafb', borderRadius: 8, padding: '10px 14px' }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af', marginBottom: 3 }}>{item.label}</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#111' }}>{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Line items */}
              {detailItems.length > 0 && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#999', marginBottom: 10 }}>
                    Line Items ({detailItems.length})
                  </div>
                  <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                          <th style={{ textAlign: 'left' as const, padding: '8px 10px', color: '#9ca3af', fontWeight: 600 }}>Item</th>
                          <th style={{ textAlign: 'right' as const, padding: '8px 10px', color: '#9ca3af', fontWeight: 600 }}>Qty</th>
                          <th style={{ textAlign: 'right' as const, padding: '8px 10px', color: '#9ca3af', fontWeight: 600 }}>Unit price</th>
                          <th style={{ textAlign: 'right' as const, padding: '8px 10px', color: '#9ca3af', fontWeight: 600 }}>Amount</th>
                          <th style={{ textAlign: 'right' as const, padding: '8px 10px', color: '#9ca3af', fontWeight: 600 }}>VAT%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailItems.map((item: any, i: number) => (
                          <tr key={i} style={{ borderBottom: i < detailItems.length-1 ? '1px solid #f3f4f6' : 'none' }}>
                            <td style={{ padding: '8px 10px', color: '#111' }}>{item.description}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' as const, color: '#666' }}>
                              {item.quantity != null ? `${item.quantity}${item.unit ? ' '+item.unit : ''}` : '--'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' as const, color: '#666' }}>
                              {item.unit_price != null ? Math.round(item.unit_price).toLocaleString('sv-SE')+' kr' : '--'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' as const, fontWeight: 600 }}>
                              {item.amount != null ? Math.round(item.amount).toLocaleString('sv-SE')+' kr' : '--'}
                            </td>
                            <td style={{ padding: '8px 10px', textAlign: 'right' as const, color: '#666' }}>
                              {item.vat_rate != null ? item.vat_rate+'%' : '--'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop: '2px solid #e5e7eb', background: '#f9fafb', fontWeight: 700 }}>
                          <td colSpan={3} style={{ padding: '8px 10px' }}>Total ex VAT</td>
                          <td style={{ padding: '8px 10px', textAlign: 'right' as const }}>
                            {Math.round(detailItems.reduce((s: number, i: any) => s + (i.amount ?? 0), 0)).toLocaleString('sv-SE')} kr
                          </td>
                          <td></td>
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              )}

              {/* Original document */}
              {docUrl && (
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#999', marginBottom: 10 }}>
                    Original Document
                  </div>
                  {docUrl.match(/\.(jpg|jpeg|png|webp)$/i) ? (
                    <img src={docUrl} alt="Invoice" style={{ width: '100%', borderRadius: 8, border: '1px solid #e5e7eb' }} />
                  ) : (
                    <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden', height: 500 }}>
                      <iframe src={docUrl} style={{ width: '100%', height: '100%', border: 'none' }} title="Invoice PDF" />
                    </div>
                  )}
                  <a href={docUrl} target="_blank" rel="noopener noreferrer"
                    style={{ display: 'inline-block', marginTop: 8, fontSize: 12, color: '#1E2761' }}>
                    Open in new tab
                  </a>
                </div>
              )}

              {!docUrl && (
                <div style={{ background: '#f9fafb', borderRadius: 8, padding: 20, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>
                  No document attached. Upload a PDF or image when adding an invoice to see it here.
                </div>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' as const }}>
                {detailInv.status !== 'paid' && detailInv.status !== 'cancelled' && (
                  <>
                    <button onClick={() => { doAction(detailInv.id, 'mark_paid'); setDetailInv(null) }}
                      style={{ flex: 1, padding: '10px', borderRadius: 8, border: 'none', background: '#2D6A35', color: 'white', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                      Mark as paid
                    </button>
                    <button onClick={() => { const d = new Date(); d.setDate(d.getDate()+7); doAction(detailInv.id, 'snooze', { snoozed_until: d.toISOString().slice(0,10) }); setDetailInv(null) }}
                      style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #ddd', background: 'white', cursor: 'pointer', fontSize: 13 }}>
                      Snooze 7d
                    </button>
                  </>
                )}
                <button onClick={() => deleteInvoice(detailInv.id)}
                  style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid #fca5a5', background: '#fef2f2', color: '#dc2626', cursor: 'pointer', fontSize: 13 }}>
                  Delete invoice
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

'@
[System.IO.File]::WriteAllText(
  (Join-Path (Get-Location) "app\invoices\page.tsx"),
  $content,
  [System.Text.Encoding]::UTF8
)
Write-Host "Done"
