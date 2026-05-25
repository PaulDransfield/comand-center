'use client'
// app/inventory/skipped/page.tsx
//
// Admin view for every supplier the owner has classified as not-inventory
// via the "Skip ALL from supplier" button on /inventory/review. One row
// per rule, with the count of lines currently hidden because of it. The
// Restore button removes the rule AND flips every matching line back to
// needs_review so they re-appear in the queue on next reload.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

interface SkippedRow {
  id:                      string
  supplier_fortnox_number: string
  supplier_name:           string | null
  classification:          string
  classified_at:           string
  line_count:              number
}

export default function SkippedSuppliersPage() {
  const t = useTranslations('operations.inventory.skipped')
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [rows,    setRows]    = useState<SkippedRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [busyId,  setBusyId]  = useState<string | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/skipped-suppliers?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      const j = await r.json()
      setRows(j.classifications ?? [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => { if (bizId) load() }, [bizId, load])

  async function restore(row: SkippedRow) {
    if (!confirm(t('restoreConfirm', { supplier: row.supplier_name ?? `#${row.supplier_fortnox_number}`, count: String(row.line_count) }))) return
    setBusyId(row.id)
    try {
      const r = await fetch(`/api/inventory/skipped-suppliers/${row.id}`, { method: 'DELETE', cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
      load()
    } catch (e: any) {
      alert(e.message)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <AppShell>
      <div style={{ maxWidth: 1100, padding: '20px 24px' }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, color: UXP.ink1, letterSpacing: '-0.01em' }}>
          {t('title')}
        </h1>
        <p style={{ margin: '4px 0 18px', fontSize: 12, color: UXP.ink3, maxWidth: 720, lineHeight: 1.5 }}>
          {t('subtitle')}
        </p>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}
        {loading && <Empty label={t('loading')} />}
        {!loading && rows.length === 0 && !error && <Empty label={t('empty')} />}

        {!loading && rows.length > 0 && (
          <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }}>
              <thead>
                <tr style={{ background: UXP.subtleBg }}>
                  <Th label={t('colSupplier')} />
                  <Th label={t('colLines')} align="right" />
                  <Th label={t('colSince')} />
                  <Th label="" />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} style={{ borderTop: `0.5px solid ${UXP.borderSoft}` }}>
                    <td style={{ ...td(), fontWeight: 500, color: UXP.ink1 }}>
                      {r.supplier_name ?? `#${r.supplier_fortnox_number}`}
                      <div style={{ fontSize: 10, color: UXP.ink4 }}>#{r.supplier_fortnox_number}</div>
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const, color: UXP.ink2, fontVariantNumeric: 'tabular-nums' as const }}>
                      {r.line_count}
                    </td>
                    <td style={{ ...td(), color: UXP.ink3, fontSize: 11 }}>
                      {r.classified_at?.slice(0, 10) ?? '—'}
                    </td>
                    <td style={{ ...td(), textAlign: 'right' as const }}>
                      <button onClick={() => restore(r)} disabled={busyId === r.id}
                        style={{
                          padding: '4px 12px', fontSize: 11, fontWeight: 500,
                          background: 'transparent', color: UXP.lavText,
                          border: `0.5px solid ${UXP.lavMid}`, borderRadius: 5,
                          cursor: busyId === r.id ? 'wait' : 'pointer', fontFamily: 'inherit',
                        }}>
                        {busyId === r.id ? t('restoring') : t('restore')}
                      </button>
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

function Empty({ label }: { label: string }) {
  return (
    <div style={{ padding: 36, textAlign: 'center' as const, color: UXP.ink3, fontSize: 13,
                  background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8 }}>
      {label}
    </div>
  )
}
function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return (
    <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600,
                 color: UXP.ink4, letterSpacing: '0.04em',
                 textTransform: 'uppercase' as const, textAlign: align }}>{label}</th>
  )
}
function td(): React.CSSProperties { return { padding: '10px 12px', fontSize: 12, color: UXP.ink2 } }
