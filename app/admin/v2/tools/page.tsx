'use client'
// app/admin/v2/tools/page.tsx
// PR 9 — Admin v2 Tools tab. Read-only SQL runner with sessionStorage history.
// PR 10 — adds Saved investigations (admin_saved_queries / M038).
// FIXES.md §0aj + §0ak.

import { useEffect, useState } from 'react'
import { adminFetch } from '@/lib/admin/v2/api-client'

interface SqlSuccess {
  columns:     string[]
  rows:        Array<Record<string, any>>
  row_count:   number
  duration_ms: number
  limit:       number
  truncated:   boolean
  network_ms:  number
}

interface HistoryEntry {
  query:    string
  ranAt:    string
  rowCount: number
  ms:       number
  ok:       boolean
}

interface SavedQuery {
  id:           string
  label:        string
  query:        string
  notes:        string | null
  org_id:       string | null
  org_name:     string | null
  created_by:   string
  created_at:   string
  last_used_at: string | null
  run_count:    number
}

interface SavedListResponse {
  items:         SavedQuery[]
  table_missing: boolean
  note?:         string
}

const HISTORY_KEY   = 'admin_v2_tools_sql_history'
const HISTORY_MAX   = 10
const DEFAULT_QUERY = `SELECT
  table_name, COUNT(*) AS column_count
FROM information_schema.columns
WHERE table_schema = 'public'
GROUP BY table_name
ORDER BY column_count DESC
LIMIT 20`

const SAMPLES = [
  { label: 'Tables in public', query: "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename" },
  { label: 'Org count + plan',  query: "SELECT subscription_plan, COUNT(*) AS n FROM organisations GROUP BY 1 ORDER BY n DESC" },
  { label: 'Recent audit',      query: "SELECT created_at, action, actor, org_id FROM admin_audit_log ORDER BY created_at DESC LIMIT 50" },
  { label: 'Slow Fortnox',      query: "SELECT id, period_year, period_month, status, created_at FROM fortnox_uploads ORDER BY created_at DESC LIMIT 20" },
  { label: 'AI 24h spend',      query: "SELECT date_trunc('hour', created_at) AS hour, COUNT(*) AS calls, ROUND(SUM(cost_usd)::numeric, 4) AS usd FROM ai_request_log WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1 DESC" },
]

export default function ToolsPage() {
  const [query,     setQuery]     = useState<string>(DEFAULT_QUERY)
  const [limit,     setLimit]     = useState<number>(100)
  const [running,   setRunning]   = useState<boolean>(false)
  const [error,     setError]     = useState<string | null>(null)
  const [errorKind, setErrorKind] = useState<string | null>(null)
  const [result,    setResult]    = useState<SqlSuccess | null>(null)
  const [history,   setHistory]   = useState<HistoryEntry[]>([])
  const [saved,         setSaved]         = useState<SavedQuery[]>([])
  const [savedMissing,  setSavedMissing]  = useState<boolean>(false)
  const [showSaveModal, setShowSaveModal] = useState<boolean>(false)
  const [saveLabel,     setSaveLabel]     = useState<string>('')
  const [saveOrgId,     setSaveOrgId]     = useState<string>('')
  const [saveNotes,     setSaveNotes]     = useState<string>('')
  const [saving,        setSaving]        = useState<boolean>(false)
  const [saveError,     setSaveError]     = useState<string | null>(null)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.sessionStorage.getItem(HISTORY_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) setHistory(parsed.slice(0, HISTORY_MAX))
      }
    } catch {}
  }, [])

  async function loadSaved() {
    try {
      const r = await adminFetch<SavedListResponse>('/api/admin/v2/tools/saved')
      setSaved(r.items)
      setSavedMissing(r.table_missing)
      return r
    } catch (e: any) {
      // Silent — saved investigations are optional context, not blocking.
      console.warn('[tools] load saved failed:', e?.message)
      return null
    }
  }

  useEffect(() => { loadSaved() }, [])

  // Deep-link from the command palette: /admin/v2/tools?saved=<id>
  // pre-loads that saved query into the editor on mount. Strips the
  // query param from the URL after loading so the user can run / edit
  // without the deep-link sticking around.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    const id  = url.searchParams.get('saved')
    if (!id) return
    ;(async () => {
      const list = await loadSaved()
      const hit  = list?.items.find(s => s.id === id)
      if (hit) {
        setQuery(hit.query)
        // Clean the URL so reloads don't reload the deep link.
        url.searchParams.delete('saved')
        window.history.replaceState({}, '', url.toString())
      }
    })()
  }, [])

  function pushHistory(entry: HistoryEntry) {
    setHistory(prev => {
      const next = [entry, ...prev.filter(e => e.query !== entry.query)].slice(0, HISTORY_MAX)
      try { window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  async function run() {
    if (running) return
    setRunning(true)
    setError(null)
    setErrorKind(null)
    setResult(null)
    const startedAt = new Date().toISOString()
    try {
      const r = await adminFetch<SqlSuccess>('/api/admin/v2/tools/sql', {
        method: 'POST',
        body:   JSON.stringify({ query, limit }),
      })
      setResult(r)
      pushHistory({ query, ranAt: startedAt, rowCount: r.row_count, ms: r.duration_ms, ok: true })
    } catch (e: any) {
      const msg = e?.message ?? 'Run failed'
      setError(msg)
      if (/forbidden keyword|multi-statement|empty|are allowed|exceeds/i.test(msg)) {
        setErrorKind('validation')
      } else if (/RPC missing|M037/i.test(msg)) {
        setErrorKind('rpc_missing')
      } else {
        setErrorKind('execution')
      }
      pushHistory({ query, ranAt: startedAt, rowCount: 0, ms: 0, ok: false })
    } finally {
      setRunning(false)
    }
  }

  function clearHistory() {
    setHistory([])
    try { window.sessionStorage.removeItem(HISTORY_KEY) } catch {}
  }

  // ── Operations: Fortnox backfill kick ─────────────────────────────────
  // One-click "kick the worker" for stuck/failed Fortnox backfills.
  // Bypasses the owner-side button's gates (status filters, fire-and-forget
  // unreliability) and AWAITS the worker's response so the admin sees the
  // exact result (months_written / error). Posts to:
  //   /api/admin/fortnox/kick-backfill { business_id }
  const [opsBizId,    setOpsBizId]    = useState<string>('')
  const [opsRunning,  setOpsRunning]  = useState<boolean>(false)
  const [opsResult,   setOpsResult]   = useState<any>(null)
  const [opsError,    setOpsError]    = useState<string | null>(null)

  async function kickFortnoxBackfill() {
    if (opsRunning || !opsBizId.trim()) return
    setOpsRunning(true)
    setOpsResult(null)
    setOpsError(null)
    try {
      const r = await adminFetch<any>('/api/admin/fortnox/kick-backfill', {
        method: 'POST',
        body:   JSON.stringify({ business_id: opsBizId.trim() }),
      })
      setOpsResult(r)
    } catch (e: any) {
      setOpsError(e?.message ?? 'Kick failed')
    } finally {
      setOpsRunning(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      run()
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: '#111', margin: 0 }}>Tools — SQL runner</h1>
      </div>

      <Banner
        tone="warn"
        text="Service-role context — RLS bypassed. Read-only enforced (SELECT / WITH / TABLE / VALUES / EXPLAIN only). Every run is recorded in admin_audit_log."
      />

      {/* ── Operations panel ─────────────────────────────────────────────
          One-click admin actions that don't fit a SQL editor. Add new
          rows here as we build them. */}
      <div style={{ marginTop: 14, marginBottom: 14, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
        <h2 style={{ fontSize: 13, fontWeight: 600, color: '#111', margin: 0, marginBottom: 10 }}>Operations</h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#374151', minWidth: 220 }}>
            Kick Fortnox backfill (business_id):
          </label>
          <input
            type="text"
            value={opsBizId}
            onChange={e => setOpsBizId(e.target.value)}
            placeholder="0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99 (Vero Italiano)"
            style={{
              flex: 1, minWidth: 360, padding: '6px 10px',
              border: '1px solid #d1d5db', borderRadius: 6,
              fontSize: 12, fontFamily: 'ui-monospace, monospace',
            }}
          />
          <button
            onClick={kickFortnoxBackfill}
            disabled={opsRunning || !opsBizId.trim()}
            style={btnPrimary(opsRunning || !opsBizId.trim())}
            title="Resets backfill_status to pending and synchronously calls the worker. Returns the worker's response."
          >
            {opsRunning ? 'Running…' : 'Kick worker'}
          </button>
        </div>

        {(opsResult || opsError) && (
          <div style={{
            marginTop: 10, padding: 10,
            background: opsError ? '#fef2f2' : (opsResult?.ok ? '#f0fdf4' : '#fef3c7'),
            border:     `1px solid ${opsError ? '#fecaca' : (opsResult?.ok ? '#bbf7d0' : '#fde68a')}`,
            borderRadius: 6,
            fontSize: 11, fontFamily: 'ui-monospace, monospace',
            color:    opsError ? '#991b1b' : '#111',
            whiteSpace: 'pre-wrap' as const,
            wordBreak: 'break-word' as const,
          }}>
            {opsError
              ? opsError
              : JSON.stringify(opsResult, null, 2)}
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 280px', gap: 14 }}>
        <div>
          <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              spellCheck={false}
              style={{
                width: '100%', minHeight: 200, padding: 12, border: 'none', outline: 'none',
                fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.5, color: '#111',
                resize: 'vertical' as const, boxSizing: 'border-box' as const,
              }}
              placeholder="SELECT … FROM …"
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderTop: '1px solid #e5e7eb', background: '#f9fafb' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#374151' }}>
                Limit
                <input
                  type="number"
                  value={limit}
                  onChange={e => setLimit(Math.max(1, Math.min(parseInt(e.target.value || '100', 10) || 100, 1000)))}
                  min={1}
                  max={1000}
                  style={{ width: 70, padding: '4px 8px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12, fontFamily: 'ui-monospace, monospace' }}
                />
              </label>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>{query.length.toLocaleString()} chars · ⌘/Ctrl-Enter to run</span>
              <div style={{ flex: 1 }} />
              <button
                onClick={() => { setSaveLabel(''); setSaveOrgId(''); setSaveNotes(''); setSaveError(null); setShowSaveModal(true) }}
                disabled={query.trim().length === 0}
                style={btnSecondary(query.trim().length === 0)}
              >
                Save…
              </button>
              <button onClick={run} disabled={running || query.trim().length === 0} style={btnPrimary(running || query.trim().length === 0)}>
                {running ? 'Running…' : 'Run query'}
              </button>
            </div>
          </div>

          {error && (
            <div style={{ marginTop: 14 }}>
              <Banner
                tone={errorKind === 'rpc_missing' ? 'warn' : 'bad'}
                text={`${errorKind === 'validation' ? 'Validation: '
                       : errorKind === 'rpc_missing' ? 'Setup: '
                       : 'Database: '}${error}`}
              />
            </div>
          )}

          {result && <ResultPanel result={result} />}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 14 }}>
          <SidebarCard
            title={`Saved (${saved.length})`}
            action={savedMissing ? <span style={{ fontSize: 10, color: '#92400e' }} title="Run M038">M038?</span> : null}
          >
            {savedMissing && (
              <div style={{ fontSize: 11, color: '#92400e', padding: '4px 4px' }}>Run M038 to enable saving.</div>
            )}
            {!savedMissing && saved.length === 0 && (
              <div style={{ fontSize: 11, color: '#9ca3af', padding: '8px 4px' }}>No saved investigations yet. Use "Save…" after writing a query.</div>
            )}
            {saved.map(s => (
              <SavedRow
                key={s.id}
                item={s}
                onLoad={() => setQuery(s.query)}
                onDelete={async () => {
                  if (!confirm(`Delete saved query "${s.label}"?`)) return
                  try {
                    await adminFetch(`/api/admin/v2/tools/saved/${s.id}`, { method: 'DELETE' })
                    await loadSaved()
                  } catch (e: any) {
                    alert(e?.message ?? 'Failed to delete')
                  }
                }}
              />
            ))}
          </SidebarCard>

          <SidebarCard title="Sample queries">
            {SAMPLES.map(s => (
              <button key={s.label} onClick={() => setQuery(s.query)} style={sidebarItemBtn} title={s.query}>
                <span>{s.label}</span>
              </button>
            ))}
          </SidebarCard>

          <SidebarCard
            title={`History (${history.length})`}
            action={history.length > 0 ? <button onClick={clearHistory} style={btnLink}>Clear</button> : null}
          >
            {history.length === 0 && (
              <div style={{ fontSize: 11, color: '#9ca3af', padding: '8px 4px' }}>Empty — runs from this tab session land here.</div>
            )}
            {history.map((h, i) => (
              <button
                key={`${h.ranAt}_${i}`}
                onClick={() => setQuery(h.query)}
                style={{ ...sidebarItemBtn, alignItems: 'flex-start' as const, flexDirection: 'column' as const }}
                title={h.query}
              >
                <span style={{ fontSize: 11, fontFamily: 'ui-monospace, monospace', color: h.ok ? '#374151' : '#991b1b', display: 'block', whiteSpace: 'nowrap' as const, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, width: '100%', textAlign: 'left' as const }}>
                  {firstLine(h.query)}
                </span>
                <span style={{ fontSize: 10, color: '#9ca3af' }}>
                  {h.ok ? `${h.rowCount} row${h.rowCount === 1 ? '' : 's'} · ${h.ms} ms` : 'failed'} · {fmtTime(h.ranAt)}
                </span>
              </button>
            ))}
          </SidebarCard>
        </div>
      </div>

      {showSaveModal && (
        <SaveModal
          query={query}
          label={saveLabel} setLabel={setSaveLabel}
          orgId={saveOrgId} setOrgId={setSaveOrgId}
          notes={saveNotes} setNotes={setSaveNotes}
          saving={saving}
          error={saveError}
          onCancel={() => setShowSaveModal(false)}
          onConfirm={async () => {
            const labelTrim = saveLabel.trim()
            if (!labelTrim) { setSaveError('Label is required'); return }
            setSaving(true)
            setSaveError(null)
            try {
              await adminFetch('/api/admin/v2/tools/saved', {
                method: 'POST',
                body:   JSON.stringify({
                  label:  labelTrim,
                  query,
                  notes:  saveNotes.trim() || null,
                  org_id: saveOrgId.trim() || null,
                }),
              })
              setShowSaveModal(false)
              await loadSaved()
            } catch (e: any) {
              setSaveError(e?.message ?? 'Save failed')
            } finally {
              setSaving(false)
            }
          }}
        />
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   SavedRow + SaveModal
// ────────────────────────────────────────────────────────────────────

function SavedRow({ item, onLoad, onDelete }: { item: SavedQuery; onLoad: () => void; onDelete: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' as const, padding: '6px 8px', borderRadius: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button onClick={onLoad} style={{ ...sidebarItemBtn, padding: 0, flex: 1, color: '#374151', fontWeight: 500 }} title={item.query}>
          <span style={{ overflow: 'hidden' as const, textOverflow: 'ellipsis' as const, whiteSpace: 'nowrap' as const }}>{item.label}</span>
        </button>
        <button onClick={onDelete} style={{ background: 'transparent', border: 'none', color: '#d1d5db', cursor: 'pointer', fontSize: 14, padding: '0 4px' }} title="Delete">×</button>
      </div>
      <div style={{ fontSize: 10, color: '#9ca3af', display: 'flex', gap: 6, marginTop: 2 }}>
        {item.org_name && <span title={item.org_id ?? ''} style={{ color: '#1e40af' }}>{item.org_name}</span>}
        {item.run_count > 0 && <span>{item.run_count} run{item.run_count === 1 ? '' : 's'}</span>}
        {item.last_used_at && <span>· last {fmtTime(item.last_used_at)}</span>}
      </div>
    </div>
  )
}

function SaveModal(props: {
  query:  string
  label:  string;  setLabel:  (s: string) => void
  orgId:  string;  setOrgId:  (s: string) => void
  notes:  string;  setNotes:  (s: string) => void
  saving: boolean
  error:  string | null
  onCancel:  () => void
  onConfirm: () => void
}) {
  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) props.onCancel() }}
      style={{
        position: 'fixed' as const, inset: 0, background: 'rgba(17, 24, 39, 0.5)', backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100, padding: 20,
      }}
    >
      <div style={{ background: 'white', borderRadius: 12, padding: 20, width: 480, maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto' as const }}>
        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#111', margin: '0 0 4px 0' }}>Save investigation</h2>
        <p style={{ fontSize: 12, color: '#6b7280', margin: '0 0 16px 0' }}>Saves the current query to admin_saved_queries. Optional org tag ties it to a specific customer.</p>

        <Field label="Label" required>
          <input
            value={props.label}
            onChange={e => props.setLabel(e.target.value)}
            placeholder="e.g. investigate Sept revenue gap"
            maxLength={120}
            style={inputStyle}
            autoFocus
          />
        </Field>

        <Field label="Org ID (optional)" hint="UUID — leaves the query global if blank">
          <input
            value={props.orgId}
            onChange={e => props.setOrgId(e.target.value)}
            placeholder="e917d4b8-…"
            style={{ ...inputStyle, fontFamily: 'ui-monospace, monospace' }}
          />
        </Field>

        <Field label="Notes (optional)" hint="What were you investigating? Leave a hint for future-you.">
          <textarea
            value={props.notes}
            onChange={e => props.setNotes(e.target.value)}
            rows={3}
            maxLength={4000}
            style={{ ...inputStyle, resize: 'vertical' as const, lineHeight: 1.5 }}
          />
        </Field>

        <Field label="Query preview">
          <pre style={{
            background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 7, padding: 10,
            fontSize: 11, fontFamily: 'ui-monospace, monospace', color: '#374151', maxHeight: 140, overflow: 'auto' as const,
            margin: 0, whiteSpace: 'pre-wrap' as const,
          }}>
            {props.query}
          </pre>
        </Field>

        {props.error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 7, padding: '6px 10px', fontSize: 12, marginTop: 8 }}>
            {props.error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={props.onCancel} disabled={props.saving} style={btnSecondary(props.saving)}>Cancel</button>
          <button onClick={props.onConfirm} disabled={props.saving || props.label.trim().length === 0} style={btnPrimary(props.saving || props.label.trim().length === 0)}>
            {props.saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, required, hint, children }: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
        {label}{required && <span style={{ color: '#dc2626', marginLeft: 2 }}>*</span>}
      </label>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 4 }}>{hint}</div>}
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 7,
  fontSize: 13, color: '#111', boxSizing: 'border-box' as const,
}

// ────────────────────────────────────────────────────────────────────
//   Result panel
// ────────────────────────────────────────────────────────────────────

function ResultPanel({ result }: { result: SqlSuccess }) {
  return (
    <div style={{ marginTop: 14, background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', gap: 14, fontSize: 12, color: '#374151' }}>
        <span><strong>{result.row_count.toLocaleString()}</strong> row{result.row_count === 1 ? '' : 's'}</span>
        <span style={{ color: '#9ca3af' }}>·</span>
        <span>{result.duration_ms} ms (db) · {result.network_ms} ms (round-trip)</span>
        {result.truncated && (
          <>
            <span style={{ color: '#9ca3af' }}>·</span>
            <span style={{ color: '#92400e', background: '#fef3c7', padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500 }}>
              truncated at limit ({result.limit})
            </span>
          </>
        )}
      </div>

      {result.row_count === 0 ? (
        <div style={{ padding: 30, textAlign: 'center' as const, color: '#9ca3af', fontSize: 12 }}>0 rows</div>
      ) : (
        <div style={{ overflowX: 'auto' as const, maxHeight: 600, overflowY: 'auto' as const }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 600 }}>
            <thead style={{ position: 'sticky' as const, top: 0, background: '#f9fafb', zIndex: 1 }}>
              <tr>
                {result.columns.map(c => (
                  <th key={c} style={{ padding: '8px 12px', textAlign: 'left' as const, fontSize: 10, color: '#6b7280', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, borderBottom: '1px solid #e5e7eb', whiteSpace: 'nowrap' as const, fontFamily: 'ui-monospace, monospace' }}>{c}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, i) => (
                <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                  {result.columns.map(c => (
                    <td key={c} style={{ padding: '6px 12px', fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#374151', verticalAlign: 'top' as const, maxWidth: 400, overflow: 'hidden' as const, textOverflow: 'ellipsis' as const }}>
                      <CellValue value={row[c]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function CellValue({ value }: { value: any }) {
  if (value === null || value === undefined) return <span style={{ color: '#d1d5db' }}>NULL</span>
  if (typeof value === 'boolean') return <span style={{ color: value ? '#065f46' : '#991b1b' }}>{String(value)}</span>
  if (typeof value === 'number') return <span style={{ color: '#1e40af' }}>{value}</span>
  if (typeof value === 'object') {
    const s = JSON.stringify(value)
    return <span title={s} style={{ color: '#6b21a8' }}>{s.length > 120 ? s.slice(0, 120) + '…' : s}</span>
  }
  const s = String(value)
  return <span title={s.length > 120 ? s : undefined}>{s.length > 120 ? s.slice(0, 120) + '…' : s}</span>
}

// ────────────────────────────────────────────────────────────────────
//   Sidebar
// ────────────────────────────────────────────────────────────────────

function SidebarCard({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280', letterSpacing: '0.06em', textTransform: 'uppercase' as const }}>{title}</span>
        {action}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 4 }}>
        {children}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   Banners + buttons
// ────────────────────────────────────────────────────────────────────

function Banner({ tone, text }: { tone: 'bad' | 'warn' | 'ok'; text: string }) {
  const palette = tone === 'bad'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' }
    : tone === 'warn'
    ? { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' }
    : { bg: '#ecfdf5', border: '#a7f3d0', fg: '#065f46' }
  return (
    <div style={{ background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg, borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12 }}>
      {text}
    </div>
  )
}

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

const btnLink: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: 0, fontSize: 11, color: '#6b7280', cursor: 'pointer', textDecoration: 'underline' as const,
}

const sidebarItemBtn: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: '6px 8px', borderRadius: 6,
  textAlign: 'left' as const, fontSize: 12, color: '#374151', cursor: 'pointer',
  display: 'flex', gap: 4, width: '100%',
}

// ────────────────────────────────────────────────────────────────────
//   helpers
// ────────────────────────────────────────────────────────────────────

function firstLine(q: string): string {
  const line = q.split('\n').find(l => l.trim().length > 0)?.trim() ?? q
  return line.length > 60 ? line.slice(0, 60) + '…' : line
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('sv-SE', { hour12: false })
  } catch { return iso }
}
