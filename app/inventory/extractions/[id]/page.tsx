'use client'
// app/inventory/extractions/[id]/page.tsx
//
// Phase B.4 detail view — owner curates the rows the extractor produced.
// Layout: header (supplier / invoice / totals / validation warnings)
//         + editable row grid
//         + actions: Re-extract · Approve & apply.
//
// Apply calls POST /api/inventory/extractions/[id] { action: 'apply', rows }
// Re-extract calls POST /api/inventory/extractions/[id] { action: 'reextract' }

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface ExtractedRow {
  row_number:     number
  description:    string
  article_number: string | null
  quantity:       number | null
  unit:           string | null
  price_per_unit: number | null
  total_excl_vat: number | null
  vat_rate:       number | null
}
interface Detail {
  id:                       string
  business_id:              string
  status:                   string
  supplier:                 string
  supplier_number:          string | null
  invoice_number:           string
  invoice_date:             string
  pdf_file_id:              string | null
  rows_extracted:           number | null
  total_extracted:          number | null
  total_header:             number | null
  total_delta_pct:          number | null
  validation_warnings:      Array<{ code: string; message: string; severity: string }>
  extracted_rows:           ExtractedRow[] | null
  ai_model:                 string | null
  cost_usd:                 number | null
  completed_at:             string | null
  fortnox_url:              string
  pdf_proxy_url:            string | null
}

export default function ExtractionDetailPage() {
  const params = useParams() as { id: string }
  const router = useRouter()

  const [data,    setData]    = useState<Detail | null>(null)
  const [rows,    setRows]    = useState<ExtractedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [busy,    setBusy]    = useState<'apply' | 'reextract' | null>(null)
  const [toast,   setToast]   = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch(`/api/inventory/extractions/${params.id}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      const j: Detail = await r.json()
      setData(j)
      setRows((j.extracted_rows ?? []).map((r, idx) => ({ ...r, row_number: idx + 1 })))
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [params.id])

  useEffect(() => { load() }, [load])

  const updateRow = (idx: number, patch: Partial<ExtractedRow>) => {
    setRows(prev => {
      const next = [...prev]
      next[idx] = { ...next[idx], ...patch }
      return next
    })
  }
  const removeRow = (idx: number) => setRows(prev => prev.filter((_, i) => i !== idx))
  const addRow = () => setRows(prev => [...prev, {
    row_number: prev.length + 1, description: '', article_number: null, quantity: null,
    unit: null, price_per_unit: null, total_excl_vat: 0, vat_rate: 12,
  }])

  const newTotalExtracted = rows.reduce((s, r) => s + (Number(r.total_excl_vat) || 0), 0)
  const headerTotal = data?.total_header ?? null
  const newDeltaPct = headerTotal && Math.abs(headerTotal) > 0.01
    ? Math.abs(newTotalExtracted - headerTotal) / Math.abs(headerTotal)
    : null

  const doAction = async (action: 'apply' | 'reextract') => {
    setBusy(action)
    setToast(null)
    try {
      const body: any = { action }
      if (action === 'apply') body.rows = rows
      const r = await fetch(`/api/inventory/extractions/${params.id}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error + (j.detail ? `: ${j.detail}` : ''))
      setToast(action === 'apply'
        ? `Godkänd. ${j.rows_persisted} rader sparade${j.matcher_kicked ? ' · matcher startad i bakgrund' : ''}.`
        : `Re-extraherad. Ny status: ${j.new_status}, ${j.rows_extracted} rader.`)
      await load()
    } catch (e: any) {
      setToast(`Fel: ${e.message}`)
    } finally {
      setBusy(null)
    }
  }

  if (loading || !data) return (
    <AppShell>
      <div style={{ padding: 30, color: UXP.ink3, fontSize: 13 }}>
        {error ? <span style={{ color: UXP.roseText }}>{error}</span> : 'Hämtar extraktion…'}
      </div>
    </AppShell>
  )

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, padding: '20px 24px' }}>
        {/* Back + title row */}
        <button
          onClick={() => router.push('/inventory/extractions')}
          style={{ background: 'transparent', border: 'none', color: UXP.ink3,
                   fontSize: 12, cursor: 'pointer', marginBottom: 14, padding: 0 }}
        >← Tillbaka till granskningskön</button>

        <div style={{ marginBottom: 18 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
            {data.supplier} <span style={{ color: UXP.ink3, fontWeight: 400 }}>· #{data.invoice_number}</span>
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            {data.invoice_date}
            {' · '}
            <a href={data.fortnox_url} target="_blank" rel="noopener noreferrer" style={{ color: UXP.lavText, textDecoration: 'none' }}>
              Öppna i Fortnox →
            </a>
            {data.pdf_proxy_url && (
              <>
                {' · '}
                <a href={data.pdf_proxy_url} target="_blank" rel="noopener noreferrer" style={{ color: UXP.lavText, textDecoration: 'none' }}>
                  PDF →
                </a>
              </>
            )}
          </p>
        </div>

        {/* Toast */}
        {toast && (
          <div style={{
            padding: '10px 14px', marginBottom: 14,
            background: toast.startsWith('Fel:') ? UXP.roseFill : UXP.greenFill,
            border:     `0.5px solid ${toast.startsWith('Fel:') ? UXP.rose : UXP.green}`,
            color:      toast.startsWith('Fel:') ? UXP.roseText : UXP.greenDeep,
            borderRadius: 8, fontSize: 12,
          }}>{toast}</div>
        )}

        {/* Headline totals */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
          <Stat label="Fortnox header" value={fmtKr(data.total_header)} tone="ink" />
          <Stat label="AI-extraherat" value={fmtKr(data.total_extracted)} tone="ink" />
          <Stat label="Efter dina ändringar" value={fmtKr(newTotalExtracted)}
                tone={newDeltaPct != null && newDeltaPct < 0.02 ? 'green' : 'coral'} />
          <Stat label="Avvikelse mot Fortnox" value={newDeltaPct != null ? `${(newDeltaPct * 100).toFixed(2)} %` : '—'}
                tone={newDeltaPct != null && newDeltaPct < 0.02 ? 'green' : 'coral'} />
        </div>

        {/* Validation warnings */}
        {data.validation_warnings.length > 0 && (
          <div style={{
            background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8,
            padding: 14, marginBottom: 16,
          }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink3, marginBottom: 8,
                          letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
              Validatorvarningar
            </div>
            {data.validation_warnings.map((w, i) => (
              <div key={i} style={{
                display: 'flex', gap: 8, fontSize: 12, padding: '4px 0',
                color: w.severity === 'block' ? UXP.roseText : UXP.coral,
              }}>
                <span style={{ width: 14 }}>{w.severity === 'block' ? '✕' : '!'}</span>
                <span><strong>{w.code}</strong> — {w.message}</span>
              </div>
            ))}
          </div>
        )}

        {/* Row grid */}
        <div style={{
          background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8,
          overflow: 'hidden', marginBottom: 16,
        }}>
          {rows.length === 0 ? (
            <div style={{ padding: 30, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13 }}>
              Inga rader cachelagrade. Klicka <strong>Re-extrahera</strong> nedan för att köra Claude på PDF:en igen.
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 11 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <th style={{ ...thS(), width: 30 }}>#</th>
                  <th style={thS()}>Beskrivning</th>
                  <th style={{ ...thS(), width: 90 }}>Art.nr</th>
                  <th style={{ ...thS(), width: 70, textAlign: 'right' as const }}>Antal</th>
                  <th style={{ ...thS(), width: 60 }}>Enhet</th>
                  <th style={{ ...thS(), width: 90, textAlign: 'right' as const }}>À-pris</th>
                  <th style={{ ...thS(), width: 110, textAlign: 'right' as const }}>Summa (exkl. moms)</th>
                  <th style={{ ...thS(), width: 60, textAlign: 'right' as const }}>Moms %</th>
                  <th style={{ ...thS(), width: 30 }}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={idx} style={{ borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                    <td style={{ ...tdS(), color: UXP.ink4 }}>{idx + 1}</td>
                    <td style={tdS()}>
                      <input type="text" value={r.description ?? ''}
                             onChange={e => updateRow(idx, { description: e.target.value })}
                             style={cellInput()} />
                    </td>
                    <td style={tdS()}>
                      <input type="text" value={r.article_number ?? ''}
                             onChange={e => updateRow(idx, { article_number: e.target.value || null })}
                             style={{ ...cellInput(), fontFamily: 'ui-monospace, monospace' as const }} />
                    </td>
                    <td style={{ ...tdS(), textAlign: 'right' as const }}>
                      <input type="number" step="0.001" value={r.quantity ?? ''}
                             onChange={e => updateRow(idx, { quantity: e.target.value === '' ? null : Number(e.target.value) })}
                             style={{ ...cellInput(), textAlign: 'right' as const }} />
                    </td>
                    <td style={tdS()}>
                      <input type="text" value={r.unit ?? ''}
                             onChange={e => updateRow(idx, { unit: e.target.value || null })}
                             style={cellInput()} />
                    </td>
                    <td style={{ ...tdS(), textAlign: 'right' as const }}>
                      <input type="number" step="0.01" value={r.price_per_unit ?? ''}
                             onChange={e => updateRow(idx, { price_per_unit: e.target.value === '' ? null : Number(e.target.value) })}
                             style={{ ...cellInput(), textAlign: 'right' as const }} />
                    </td>
                    <td style={{ ...tdS(), textAlign: 'right' as const }}>
                      <input type="number" step="0.01" value={r.total_excl_vat ?? ''}
                             onChange={e => updateRow(idx, { total_excl_vat: e.target.value === '' ? null : Number(e.target.value) })}
                             style={{ ...cellInput(), textAlign: 'right' as const, fontWeight: 500 }} />
                    </td>
                    <td style={{ ...tdS(), textAlign: 'right' as const }}>
                      <input type="number" step="1" value={r.vat_rate ?? ''}
                             onChange={e => updateRow(idx, { vat_rate: e.target.value === '' ? null : Number(e.target.value) })}
                             style={{ ...cellInput(), textAlign: 'right' as const, width: 50 }} />
                    </td>
                    <td style={tdS()}>
                      <button onClick={() => removeRow(idx)} title="Ta bort rad"
                              style={{ background: 'transparent', border: 'none', cursor: 'pointer',
                                       color: UXP.roseText, fontSize: 14, padding: '0 6px' }}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div style={{ padding: '8px 12px', borderTop: `0.5px solid ${UXP.borderSoft}`, background: UXP.subtleBg }}>
            <button onClick={addRow} style={{
              padding: '4px 10px', fontSize: 11, background: 'transparent',
              border: `0.5px dashed ${UXP.border}`, borderRadius: 6, color: UXP.ink3,
              cursor: 'pointer', fontFamily: 'inherit',
            }}>+ Lägg till rad</button>
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={() => doAction('apply')} disabled={busy !== null || rows.length === 0}
                  style={btnPrimary(busy === 'apply')}>
            {busy === 'apply' ? 'Sparar…' : `Godkänn & spara ${rows.length} rader`}
          </button>
          <button onClick={() => doAction('reextract')} disabled={busy !== null || !data.pdf_file_id}
                  style={btnSecondary(busy === 'reextract')}
                  title={!data.pdf_file_id ? 'Ingen PDF kopplad — kan inte re-extrahera' : 'Kör Claude på PDF:en igen'}>
            {busy === 'reextract' ? 'Kör Claude…' : 'Re-extrahera från PDF'}
          </button>
        </div>

        {/* Meta */}
        {data.completed_at && (
          <div style={{ marginTop: 14, fontSize: 11, color: UXP.ink4 }}>
            Senast bearbetad {new Date(data.completed_at).toLocaleString('sv-SE')}
            {data.ai_model && <> · {data.ai_model}</>}
            {data.cost_usd != null && <> · ${data.cost_usd.toFixed(4)} USD</>}
          </div>
        )}
      </div>
    </AppShell>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone: 'ink' | 'green' | 'coral' }) {
  const color = tone === 'green' ? UXP.greenDeep : tone === 'coral' ? UXP.coral : UXP.ink1
  return (
    <div style={{
      background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8,
      padding: '10px 14px',
    }}>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600,
                    letterSpacing: '0.04em', textTransform: 'uppercase' as const }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color, marginTop: 4,
                    fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}

function cellInput(): React.CSSProperties {
  return {
    width: '100%', padding: '3px 6px', fontSize: 11,
    background: 'transparent', border: '0.5px solid transparent',
    borderRadius: 4, color: UXP.ink1, fontFamily: 'inherit', boxSizing: 'border-box' as const,
  }
}

function thS(): React.CSSProperties {
  return {
    padding: '6px 8px', fontSize: 10, fontWeight: 600, color: UXP.ink4,
    letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: 'left' as const,
  }
}
function tdS(): React.CSSProperties {
  return { padding: '4px 4px', fontSize: 11, color: UXP.ink2, verticalAlign: 'middle' as const }
}

function btnPrimary(busy: boolean): React.CSSProperties {
  return {
    padding: '9px 18px', fontSize: 13, fontWeight: 500,
    background: UXP.ink1, color: UXP.cardBg, border: 'none', borderRadius: 8,
    cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
  }
}
function btnSecondary(busy: boolean): React.CSSProperties {
  return {
    padding: '9px 18px', fontSize: 13, fontWeight: 500,
    background: 'transparent', color: UXP.ink2, border: `0.5px solid ${UXP.border}`,
    borderRadius: 8, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
  }
}
