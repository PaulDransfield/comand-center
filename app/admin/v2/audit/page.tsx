'use client'
// app/admin/v2/audit/page.tsx
// PR 8 — Admin v2 audit-log explorer.
// FIXES.md §0ai.
//
// Filter controls (action / org_id / actor / surface / date range), keyset
// "Load more" pagination, expandable per-row payload, CSV export of the
// active filter set.

import { useEffect, useMemo, useState } from 'react'
import { adminFetch, readAdminSecret } from '@/lib/admin/v2/api-client'
import { ADMIN_ACTIONS } from '@/lib/admin/audit'

interface AuditRow {
  id:             string
  created_at:     string
  actor:          string
  action:         string
  org_id:         string | null
  org_name:       string | null
  integration_id: string | null
  target_type:    string | null
  target_id:      string | null
  payload:        Record<string, any> | null
  ip_address:     string | null
  user_agent:     string | null
  surface:        string
}

interface AuditResponse {
  rows:          AuditRow[]
  has_more:      boolean
  next_cursor:   string | null
  page_size:     number
  table_missing: boolean
  note?:         string
}

const ACTION_OPTIONS = Object.values(ADMIN_ACTIONS).sort()

export default function AuditPage() {
  // Filter inputs (uncommitted — user edits, then clicks Apply).
  const [draftAction,  setDraftAction]  = useState<string>('')
  const [draftOrgId,   setDraftOrgId]   = useState<string>('')
  const [draftActor,   setDraftActor]   = useState<string>('')
  const [draftSurface, setDraftSurface] = useState<string>('')
  const [draftFrom,    setDraftFrom]    = useState<string>('')
  const [draftTo,      setDraftTo]      = useState<string>('')

  // Applied filters (the only thing that triggers a fetch).
  const [filters, setFilters] = useState<{
    action: string; org_id: string; actor: string; surface: string; from: string; to: string
  }>({ action: '', org_id: '', actor: '', surface: '', from: '', to: '' })

  // Data.
  const [rows,        setRows]        = useState<AuditRow[]>([])
  const [nextCursor,  setNextCursor]  = useState<string | null>(null)
  const [hasMore,     setHasMore]     = useState<boolean>(false)
  const [tableMissing, setTableMissing] = useState<boolean>(false)
  const [note,        setNote]        = useState<string | null>(null)
  const [loading,     setLoading]     = useState<boolean>(true)
  const [loadingMore, setLoadingMore] = useState<boolean>(false)
  const [error,       setError]       = useState<string | null>(null)
  const [exporting,   setExporting]   = useState<boolean>(false)
  const [openRowId,   setOpenRowId]   = useState<string | null>(null)

  // Build the query string from applied filters (no cursor — caller adds).
  const queryString = useMemo(() => {
    const p = new URLSearchParams()
    if (filters.action)  p.set('action',  filters.action)
    if (filters.org_id)  p.set('org_id',  filters.org_id)
    if (filters.actor)   p.set('actor',   filters.actor)
    if (filters.surface) p.set('surface', filters.surface)
    if (filters.from)    p.set('from',    filters.from)
    if (filters.to)      p.set('to',      filters.to)
    p.set('limit', '50')
    return p.toString()
  }, [filters])

  // Initial load + every applied-filter change.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setRows([])
    setNextCursor(null)
    setHasMore(false)
    setOpenRowId(null)
    adminFetch<AuditResponse>(`/api/admin/v2/audit?${queryString}`)
      .then(r => {
        if (cancelled) return
        setRows(r.rows)
        setHasMore(r.has_more)
        setNextCursor(r.next_cursor)
        setTableMissing(r.table_missing)
        setNote(r.note ?? null)
      })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Request failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [queryString])

  function applyDraftFilters() {
    setFilters({
      action:  draftAction,
      org_id:  draftOrgId.trim(),
      actor:   draftActor.trim(),
      surface: draftSurface,
      from:    draftFrom,
      to:      draftTo,
    })
  }

  function resetFilters() {
    setDraftAction('')
    setDraftOrgId('')
    setDraftActor('')
    setDraftSurface('')
    setDraftFrom('')
    setDraftTo('')
    setFilters({ action: '', org_id: '', actor: '', surface: '', from: '', to: '' })
  }

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const more = await adminFetch<AuditResponse>(`/api/admin/v2/audit?${queryString}&cursor=${encodeURIComponent(nextCursor)}`)
      setRows(prev => [...prev, ...more.rows])
      setHasMore(more.has_more)
      setNextCursor(more.next_cursor)
    } catch (e: any) {
      setError(e?.message ?? 'Load-more failed')
    } finally {
      setLoadingMore(false)
    }
  }

  async function exportCsv() {
    setExporting(true)
    setError(null)
    try {
      // Use a raw fetch (not adminFetch) so we can stream the response as a Blob
      // for download, instead of forcing JSON parsing.
      const secret = readAdminSecret()
      const res = await fetch(`/api/admin/v2/audit/export?${queryString}`, {
        headers: { 'x-admin-secret': secret },
        cache: 'no-store',
      })
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try { const j = await res.json(); msg = j?.error ?? msg } catch {}
        throw new Error(msg)
      }
      const blob = await res.blob()
      const filename = (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1]
                    ?? `admin-audit-${new Date().toISOString().slice(0, 10)}.csv`
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e: any) {
      setError(e?.message ?? 'Export failed')
    } finally {
      setExporting(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: 0 }}>Audit log</h1>
        <button
          onClick={exportCsv}
          disabled={exporting || tableMissing || loading}
          style={btnSecondary(exporting || tableMissing || loading)}
        >
          {exporting ? 'Exporting…' : 'Export CSV (current filters)'}
        </button>
      </div>

      <FilterBar
        action={draftAction}      setAction={setDraftAction}
        orgId={draftOrgId}        setOrgId={setDraftOrgId}
        actor={draftActor}        setActor={setDraftActor}
        surface={draftSurface}    setSurface={setDraftSurface}
        from={draftFrom}          setFrom={setDraftFrom}
        to={draftTo}              setTo={setDraftTo}
        onApply={applyDraftFilters}
        onReset={resetFilters}
        disabled={loading}
      />

      {error && <Banner tone="bad" text={error} />}

      {tableMissing && (
        <Banner
          tone="warn"
          text={note ?? 'admin_audit_log table missing — run sql/M010-admin-audit-log.sql in Supabase SQL Editor.'}
        />
      )}

      {loading && rows.length === 0 && <Empty text="Loading audit rows…" />}
      {!loading && !tableMissing && rows.length === 0 && (
        <Empty text="No audit rows match these filters." />
      )}

      {rows.length > 0 && (
        <Table
          rows={rows}
          openRowId={openRowId}
          onToggle={(id) => setOpenRowId(prev => prev === id ? null : id)}
        />
      )}

      {hasMore && (
        <div style={{ marginTop: 14, textAlign: 'center' as const }}>
          <button onClick={loadMore} disabled={loadingMore} style={btnSecondary(loadingMore)}>
            {loadingMore ? 'Loading more…' : 'Load 50 more'}
          </button>
        </div>
      )}

      {rows.length > 0 && !hasMore && (
        <div style={{ marginTop: 14, fontSize: 11, color: '#9ca3af', textAlign: 'center' as const }}>
          End of results · {rows.length} row{rows.length === 1 ? '' : 's'} loaded
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   FilterBar
// ────────────────────────────────────────────────────────────────────

function FilterBar(props: {
  action: string;  setAction:  (v: string) => void
  orgId:  string;  setOrgId:   (v: string) => void
  actor:  string;  setActor:   (v: string) => void
  surface: string; setSurface: (v: string) => void
  from:   string;  setFrom:    (v: string) => void
  to:     string;  setTo:      (v: string) => void
  onApply: () => void
  onReset: () => void
  disabled: boolean
}) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
        <Field label="Action">
          <select value={props.action} onChange={e => props.setAction(e.target.value)} style={inputStyle}>
            <option value="">Any</option>
            {ACTION_OPTIONS.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>

        <Field label="Surface">
          <select value={props.surface} onChange={e => props.setSurface(e.target.value)} style={inputStyle}>
            <option value="">Any</option>
            <option value="admin_v2">admin_v2</option>
            <option value="admin_v1">admin_v1</option>
          </select>
        </Field>

        <Field label="Org ID (UUID)">
          <input value={props.orgId} onChange={e => props.setOrgId(e.target.value)} placeholder="exact match" style={inputStyle} />
        </Field>

        <Field label="Actor (contains)">
          <input value={props.actor} onChange={e => props.setActor(e.target.value)} placeholder="e.g. admin" style={inputStyle} />
        </Field>

        <Field label="From">
          <input type="datetime-local" value={props.from} onChange={e => props.setFrom(e.target.value)} style={inputStyle} />
        </Field>

        <Field label="To">
          <input type="datetime-local" value={props.to} onChange={e => props.setTo(e.target.value)} style={inputStyle} />
        </Field>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button onClick={props.onReset} disabled={props.disabled} style={btnGhost(props.disabled)}>Reset</button>
        <button onClick={props.onApply} disabled={props.disabled} style={btnPrimary(props.disabled)}>Apply filters</button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>{label}</span>
      {children}
    </label>
  )
}

// ────────────────────────────────────────────────────────────────────
//   Table
// ────────────────────────────────────────────────────────────────────

function Table({ rows, openRowId, onToggle }: {
  rows: AuditRow[]; openRowId: string | null; onToggle: (id: string) => void
}) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
            <Th width={150}>When</Th>
            <Th width={140}>Action</Th>
            <Th width={70}>Surface</Th>
            <Th width={100}>Actor</Th>
            <Th>Org</Th>
            <Th width={100}>Target</Th>
            <Th width={80} align="right">Detail</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <RowPair
              key={r.id}
              row={r}
              expanded={openRowId === r.id}
              onToggle={() => onToggle(r.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RowPair({ row, expanded, onToggle }: { row: AuditRow; expanded: boolean; onToggle: () => void }) {
  return (
    <>
      <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
        <Td mono>{fmtDateTime(row.created_at)}</Td>
        <Td><ActionPill action={row.action} /></Td>
        <Td>
          <span style={surfacePill(row.surface)}>{row.surface}</span>
        </Td>
        <Td mono>{row.actor}</Td>
        <Td>
          {row.org_id
            ? <span title={row.org_id}>
                {row.org_name ?? <span style={{ color: '#9ca3af' }}>{row.org_id.slice(0, 8)}…</span>}
              </span>
            : <span style={{ color: '#d1d5db' }}>—</span>}
        </Td>
        <Td mono>
          {row.target_type
            ? <span style={{ color: '#6b7280' }}>{row.target_type}{row.target_id ? `:${String(row.target_id).slice(0, 8)}` : ''}</span>
            : <span style={{ color: '#d1d5db' }}>—</span>}
        </Td>
        <Td align="right">
          <button onClick={onToggle} style={btnRowDetail}>
            {expanded ? 'Hide' : 'View'}
          </button>
        </Td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} style={{ background: '#fafafa', borderBottom: '1px solid #f3f4f6', padding: '12px 14px' }}>
            <DetailPanel row={row} />
          </td>
        </tr>
      )}
    </>
  )
}

function DetailPanel({ row }: { row: AuditRow }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, fontSize: 11 }}>
      <div>
        <DetailField label="ID"             value={row.id} mono />
        <DetailField label="Created"        value={fmtDateTime(row.created_at)} mono />
        <DetailField label="Actor"          value={row.actor} mono />
        <DetailField label="Action"         value={row.action} mono />
        <DetailField label="Surface"        value={row.surface} mono />
        <DetailField label="IP"             value={row.ip_address ?? '—'} mono />
      </div>
      <div>
        <DetailField label="Org ID"         value={row.org_id ?? '—'} mono />
        <DetailField label="Org name"       value={row.org_name ?? '—'} />
        <DetailField label="Integration"    value={row.integration_id ?? '—'} mono />
        <DetailField label="Target type"    value={row.target_type ?? '—'} mono />
        <DetailField label="Target ID"      value={row.target_id ?? '—'} mono />
        <DetailField label="User agent"     value={truncate(row.user_agent, 80)} />
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>Payload</div>
        <pre style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 7, padding: 10, fontSize: 11, lineHeight: 1.5, color: '#374151', overflowX: 'auto', margin: 0, fontFamily: 'ui-monospace, monospace' }}>
          {row.payload ? JSON.stringify(row.payload, null, 2) : '— (none)'}
        </pre>
      </div>
    </div>
  )
}

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
      <span style={{ minWidth: 90, color: '#9ca3af' }}>{label}</span>
      <span style={{ color: '#374151', fontFamily: mono ? 'ui-monospace, monospace' : undefined, wordBreak: 'break-all' as const }}>{value}</span>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   Banners + small UI
// ────────────────────────────────────────────────────────────────────

function Banner({ tone, text }: { tone: 'bad' | 'warn' | 'ok'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' }
    : tone === 'warn'
    ? { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' }
    : { bg: '#ecfdf5', border: '#a7f3d0', fg: '#065f46' }
  return (
    <div style={{
      background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg,
      borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12,
    }}>
      {text}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>
      {text}
    </div>
  )
}

function Th({ children, width, align = 'left' as const }: { children: React.ReactNode; width?: number; align?: 'left' | 'right' }) {
  return (
    <th style={{
      padding: '10px 12px', fontWeight: 600, fontSize: 10, color: '#6b7280',
      textAlign: align, letterSpacing: '0.04em', textTransform: 'uppercase' as const,
      width, whiteSpace: 'nowrap' as const,
    }}>
      {children}
    </th>
  )
}

function Td({ children, mono, align = 'left' as const }: { children: React.ReactNode; mono?: boolean; align?: 'left' | 'right' }) {
  return (
    <td style={{
      padding: '8px 12px', fontSize: 12, color: '#374151',
      fontFamily: mono ? 'ui-monospace, monospace' : undefined,
      textAlign: align, verticalAlign: 'top' as const, whiteSpace: 'nowrap' as const,
    }}>
      {children}
    </td>
  )
}

function ActionPill({ action }: { action: string }) {
  const dangerous = ['hard_delete', 'integration_delete'].includes(action)
  const elevated  = ['impersonate', 'agent_toggle', 'extend_trial'].includes(action)
  const palette = dangerous
    ? { bg: '#fee2e2', fg: '#991b1b' }
    : elevated
    ? { bg: '#fef3c7', fg: '#92400e' }
    : { bg: '#eff6ff', fg: '#1e40af' }
  return (
    <span style={{ background: palette.bg, color: palette.fg, padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, fontFamily: 'ui-monospace, monospace' }}>
      {action}
    </span>
  )
}

function surfacePill(surface: string): React.CSSProperties {
  if (surface === 'admin_v2') {
    return { background: '#ecfdf5', color: '#065f46', padding: '2px 6px', borderRadius: 999, fontSize: 10, fontWeight: 500 }
  }
  return { background: '#f3f4f6', color: '#6b7280', padding: '2px 6px', borderRadius: 999, fontSize: 10, fontWeight: 500 }
}

// ────────────────────────────────────────────────────────────────────
//   Buttons
// ────────────────────────────────────────────────────────────────────

function btnPrimary(disabled: boolean): React.CSSProperties {
  return {
    padding: '7px 14px', background: disabled ? '#d1d5db' : '#111827', color: 'white',
    border: 'none', borderRadius: 7, fontSize: 12, fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

function btnSecondary(disabled: boolean): React.CSSProperties {
  return {
    padding: '6px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 7,
    fontSize: 12, fontWeight: 500, color: '#374151',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  }
}

function btnGhost(disabled: boolean): React.CSSProperties {
  return {
    padding: '7px 14px', background: 'transparent', border: 'none',
    fontSize: 12, fontWeight: 500, color: '#6b7280',
    cursor: disabled ? 'not-allowed' : 'pointer',
  }
}

const btnRowDetail: React.CSSProperties = {
  padding: '4px 10px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 6,
  fontSize: 11, fontWeight: 500, color: '#374151', cursor: 'pointer',
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6,
  fontSize: 12, color: '#111', background: 'white', width: '100%', boxSizing: 'border-box' as const,
}

// ────────────────────────────────────────────────────────────────────
//   Helpers
// ────────────────────────────────────────────────────────────────────

function fmtDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')
  } catch { return iso }
}

function truncate(s: string | null, n: number): string {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}
