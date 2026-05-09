'use client'
// components/dashboard/RecentInvoicesFeed.tsx
//
// Live operational feed — renders the most recent supplier invoices
// regardless of period closure status. Pairs with the (M062) provisional-
// month tagging: P&L pages hide partial months, this widget shows what's
// actually flowing in day-to-day.
//
// Data: GET /api/integrations/fortnox/recent-invoices?business_id=&days=
// PDFs: GET /api/integrations/fortnox/file?business_id=&file_id=&filename=
//
// Groups invoices by date (Today / Yesterday / DD MMM). Click "View" to
// open the Fortnox PDF inline in a new tab. Click "Open" to jump to the
// invoice in Fortnox's web UI.

import { useEffect, useState, useMemo } from 'react'

interface RecentInvoice {
  supplier_name:    string
  given_number:     string
  invoice_number:   string
  invoice_date:     string
  total:            number | null
  currency:         string | null
  file_id:          string | null
  fortnox_url:      string
  voucher_series:   string | null
  voucher_number:   string | null
  comments:         string | null
}

interface RecentInvoicesPayload {
  invoices:    RecentInvoice[]
  fetched_at:  string
  days_window: number
}

interface Props {
  businessId: string | null
  days?:      number
  /** Max rows to render. Default 25. */
  maxRows?:   number
}

export default function RecentInvoicesFeed({ businessId, days = 14, maxRows = 25 }: Props) {
  const [data,    setData]    = useState<RecentInvoicesPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!businessId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/integrations/fortnox/recent-invoices?business_id=${encodeURIComponent(businessId)}&days=${days}`, {
      cache: 'no-store',
    })
      .then(async r => {
        const json = await r.json().catch(() => null)
        if (!r.ok) throw new Error(json?.message ?? json?.error ?? `HTTP ${r.status}`)
        return json as RecentInvoicesPayload
      })
      .then(payload => { if (!cancelled) setData(payload) })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [businessId, days])

  // Group by date (string) — invoices already sorted newest first by API
  const grouped = useMemo(() => {
    if (!data?.invoices) return [] as Array<{ date: string; label: string; invoices: RecentInvoice[] }>
    const today     = stockholmTodayIso()
    const yesterday = isoDaysAgo(today, 1)
    const out: Array<{ date: string; label: string; invoices: RecentInvoice[] }> = []
    let current: typeof out[number] | null = null
    for (const inv of data.invoices.slice(0, maxRows)) {
      if (!current || current.date !== inv.invoice_date) {
        const label =
          inv.invoice_date === today     ? 'Today'
          : inv.invoice_date === yesterday ? 'Yesterday'
          : formatLongDate(inv.invoice_date)
        current = { date: inv.invoice_date, label, invoices: [] }
        out.push(current)
      }
      current.invoices.push(inv)
    }
    return out
  }, [data, maxRows])

  if (!businessId) {
    return null
  }

  return (
    <section style={SECTION_STYLE}>
      <div style={HEADER_STYLE}>
        <h3 style={TITLE_STYLE}>Recent invoices</h3>
        <span style={SUBTITLE_STYLE}>
          Last {days} days · {data?.invoices.length ?? 0} invoices
        </span>
      </div>

      {loading && !data && (
        <div style={EMPTY_STYLE}>Loading…</div>
      )}

      {error && !loading && (
        <div style={ERROR_STYLE}>
          {error === 'Connect Fortnox to see recent invoices.' || /no_fortnox_connection/.test(error)
            ? 'Connect Fortnox to see recent invoices here.'
            : `Failed to load: ${error}`}
        </div>
      )}

      {!loading && !error && data && data.invoices.length === 0 && (
        <div style={EMPTY_STYLE}>No invoices in the last {days} days.</div>
      )}

      {grouped.length > 0 && (
        <div style={LIST_STYLE}>
          {grouped.map(group => (
            <div key={group.date}>
              <div style={GROUP_LABEL_STYLE}>{group.label}</div>
              {group.invoices.map(inv => (
                <InvoiceRow key={`${inv.given_number}_${inv.invoice_number}`} invoice={inv} businessId={businessId} />
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function InvoiceRow({ invoice, businessId }: { invoice: RecentInvoice; businessId: string }) {
  const pdfUrl = invoice.file_id
    ? `/api/integrations/fortnox/file?business_id=${encodeURIComponent(businessId)}&file_id=${encodeURIComponent(invoice.file_id)}&filename=${encodeURIComponent((invoice.invoice_number || invoice.given_number || 'invoice') + '.pdf')}`
    : null

  return (
    <div style={ROW_STYLE}>
      <div style={ROW_MAIN_STYLE}>
        <div style={SUPPLIER_STYLE}>{invoice.supplier_name}</div>
        <div style={META_STYLE}>
          {invoice.invoice_number}
          {invoice.comments && <span style={{ color: '#6b7280', marginLeft: 8 }}>· {invoice.comments.slice(0, 60)}</span>}
        </div>
      </div>
      <div style={ROW_AMOUNT_STYLE}>
        {invoice.total != null ? formatKr(invoice.total) : '—'}
        {invoice.currency && invoice.currency !== 'SEK' && (
          <span style={{ fontSize: 10, color: '#9ca3af', marginLeft: 4 }}>{invoice.currency}</span>
        )}
      </div>
      <div style={ROW_ACTIONS_STYLE}>
        {pdfUrl && (
          <a href={pdfUrl} target="_blank" rel="noopener noreferrer" style={LINK_STYLE} title="View invoice PDF">
            View
          </a>
        )}
        <a href={invoice.fortnox_url} target="_blank" rel="noopener noreferrer" style={LINK_STYLE} title="Open in Fortnox">
          Open
        </a>
      </div>
    </div>
  )
}

// ── Styles (inline; matches the rest of /dashboard's pattern) ────────────────

const SECTION_STYLE: React.CSSProperties = {
  background: 'white',
  border: '1px solid #e5e7eb',
  borderRadius: 12,
  padding: 20,
  marginBottom: 16,
}
const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  marginBottom: 14,
}
const TITLE_STYLE: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: '#1a1f2e',
  margin: 0,
}
const SUBTITLE_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: '#9ca3af',
}
const EMPTY_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: '#9ca3af',
  textAlign: 'center',
  padding: '14px 0',
}
const ERROR_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: '#9ca3af',
  textAlign: 'center',
  padding: '14px 0',
  fontStyle: 'italic',
}
const LIST_STYLE: React.CSSProperties = {
  maxHeight: 480,
  overflowY: 'auto',
}
const GROUP_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: '#9ca3af',
  margin: '14px 0 6px 0',
  padding: '0 4px',
}
const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '8px 4px',
  borderBottom: '1px solid #f3f4f6',
}
const ROW_MAIN_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
}
const SUPPLIER_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: '#1a1f2e',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const META_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: '#9ca3af',
  marginTop: 2,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
const ROW_AMOUNT_STYLE: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: '#1a1f2e',
  fontFamily: 'ui-monospace, monospace',
  whiteSpace: 'nowrap',
}
const ROW_ACTIONS_STYLE: React.CSSProperties = {
  display: 'flex',
  gap: 10,
}
const LINK_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: '#3b82f6',
  textDecoration: 'none',
  fontWeight: 500,
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function stockholmTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Stockholm' }).format(new Date())
}
function isoDaysAgo(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}
function formatLongDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(d)
}
function formatKr(n: number): string {
  return Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'
}
