'use client'
// app/suppliers/page.tsx
//
// Phase 5 — supplier cost intelligence. Sits under the Insights area
// (it's analytics, not bookkeeping) — see lib/nav/areas.ts. Reads
// /api/suppliers/rollup which calls Fortnox /supplierinvoices over a
// 6-month window and groups by supplier.
//
// Surfaces:
//   - 3 KpiCardUX cards (Suppliers · Spend · Flagged for price rise)
//   - BreakdownTable: supplier · spend · last invoice · Δ vs trailing · 6-mo trend
//   - Flagged rows tinted rose via row-level border accent
//
// Real data only — no mock fallbacks. The page shows an empty-state when
// the business isn't connected to Fortnox or the rollup is still cold.

export const dynamic = 'force-dynamic'

import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/AppShell'
import BreakdownTable, { DeltaChip } from '@/components/ux/BreakdownTable'
import KpiCardUX from '@/components/ux/KpiCard'
import Sparkline from '@/components/ui/Sparkline'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'
import type { SuppliersRollupPayload, SupplierRollupRow } from '@/app/api/suppliers/rollup/route'

export default function SuppliersPage() {
  const [bizId,   setBizId]   = useState<string | null>(null)
  const [data,    setData]    = useState<SuppliersRollupPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  // Subscribe to the shared business picker.
  useEffect(() => {
    const read = () => { try { setBizId(localStorage.getItem('cc_selected_biz')) } catch {} }
    read()
    window.addEventListener('storage', read)
    return () => window.removeEventListener('storage', read)
  }, [])

  useEffect(() => {
    if (!bizId) { setLoading(false); return }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/suppliers/rollup?business_id=${bizId}`, { cache: 'no-store' })
      .then(async r => {
        if (!r.ok) {
          const j = await r.json().catch(() => ({}))
          throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`)
        }
        return r.json() as Promise<SuppliersRollupPayload>
      })
      .then(j => { if (!cancelled) setData(j) })
      .catch(e => { if (!cancelled) setError(String(e?.message ?? e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bizId])

  const rows = data?.suppliers ?? []
  const flagged = useMemo(() => rows.filter(r => r.flag_price_rise), [rows])
  const totalSpend = useMemo(() => rows.reduce((s, r) => s + r.spend_total, 0), [rows])

  return (
    <AppShell>
      <div style={{ maxWidth: 1100 }}>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Suppliers</h1>
            <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
              Cost intelligence from Fortnox supplier invoices — last 6 months.
            </p>
          </div>
          {data?.window && (
            <span style={{ fontSize: 10, color: UXP.ink4, letterSpacing: '0.04em' }}>
              {data.window.from} → {data.window.to}
            </span>
          )}
        </div>

        {/* KPI strip */}
        {!loading && data && rows.length > 0 && (
          <div style={{
            display:             'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap:                 12,
            marginBottom:        14,
          }}>
            <KpiCardUX
              title="Suppliers"
              value={String(rows.length)}
              microLabel="6-month window"
            />
            <KpiCardUX
              title="Total spend"
              value={fmtKr(totalSpend)}
              microLabel={`${rows.reduce((s, r) => s + r.invoice_count, 0)} invoices`}
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

        {/* Breakdown table */}
        {loading && (
          <Empty text="Loading supplier rollup…" />
        )}
        {error && (
          <Banner tone="bad" text={error} />
        )}
        {!loading && !error && rows.length === 0 && bizId && (
          <Empty text="No supplier invoices in the last 6 months. Connect Fortnox or wait for the next sync." />
        )}
        {!loading && !error && !bizId && (
          <Empty text="Pick a business in the top toolbar to view supplier intelligence." />
        )}

        {rows.length > 0 && (
          <BreakdownTable
        columns={[
          {
            key: 'supplier', header: 'Supplier', align: 'left',
            render: (row: SupplierRollupRow) => (
              <span style={{
                display:    'inline-flex',
                alignItems: 'center',
                gap:        8,
                color:      UXP.ink1,
                fontWeight: 500,
              }}>
                {row.flag_price_rise && (
                  <span
                    aria-hidden
                    style={{ width: 6, height: 6, borderRadius: '50%', background: UXP.rose, display: 'inline-block' }}
                  />
                )}
                {row.supplier_name}
                {row.invoice_count > 1 && (
                  <span style={{ fontSize: 9, color: UXP.ink4 }}>· {row.invoice_count}×</span>
                )}
              </span>
            ),
          },
          {
            key: 'spend', header: 'Spend', align: 'right',
            render: (row: SupplierRollupRow) => fmtKr(row.spend_total),
          },
          {
            key: 'last_invoice', header: 'Last invoice', align: 'right',
            render: (row: SupplierRollupRow) => (
              <span>
                <span>{row.last_invoice_kr != null ? fmtKr(row.last_invoice_kr) : '—'}</span>
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
        ]}
        sections={[{
          rows: rows.map(r => ({ ...r, id: r.supplier_name })),
        }]}
        footer={{
          label: 'Total',
          cells: {
            supplier:     '',
            spend:        fmtKr(totalSpend),
            last_invoice: '',
            delta:        '',
            trend:        '',
          },
        }}
        rowKey={(row: SupplierRollupRow) => row.supplier_name}
      />
        )}
      </div>
    </AppShell>
  )
}

function Banner({ tone, text }: { tone: 'bad' | 'good'; text: string }) {
  const T = tone === 'bad'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#b91c1c' }
    : { bg: '#f0fdf4', border: '#bbf7d0', fg: '#15803d' }
  return (
    <div style={{
      background:   T.bg,
      border:       `1px solid ${T.border}`,
      borderRadius: 8,
      padding:      '10px 14px',
      fontSize:     12,
      color:        T.fg,
      marginBottom: 12,
    }}>
      {text}
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div style={{
      padding:       40,
      textAlign:     'center' as const,
      color:         UXP.ink4,
      fontSize:      12,
      background:    UXP.cardBg,
      borderRadius:  UXP.r_lg,
      border:        `0.5px solid ${UXP.border}`,
    }}>
      {text}
    </div>
  )
}
