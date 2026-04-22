'use client'
// @ts-nocheck
// app/admin/diagnose-pk/page.tsx
// Tiny wrapper around /api/admin/diagnose-pk-sales so we can run the
// PK manual-vs-POS diagnostic from a button instead of a PowerShell
// incantation. Reuses the admin_auth secret already in sessionStorage
// from /admin/login — no retyping, no env vars, no clipboard juggling.

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

interface Biz { id: string; name: string; org_name?: string | null }

export default function DiagnosePkPage() {
  const router = useRouter()
  const [secret,  setSecret]  = useState<string | null>(null)
  const [bizList, setBizList] = useState<Biz[]>([])
  const [bizId,   setBizId]   = useState<string>('')
  const [days,    setDays]    = useState<number>(60)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const [result,  setResult]  = useState<any>(null)

  // Same auth pattern as the rest of /admin — sessionStorage admin_auth is
  // the ADMIN_SECRET value set by POST /api/admin/auth at login time.
  useEffect(() => {
    const s = sessionStorage.getItem('admin_auth')
    if (!s) { router.push('/admin/login?next=/admin/diagnose-pk'); return }
    setSecret(s)
  }, [router])

  // Load all businesses that have a connected PK integration. We hit the
  // existing /api/admin/customers list endpoint and flatten down to the
  // (biz_id, biz_name, org_name) rows that have `personalkollen` integrations.
  useEffect(() => {
    if (!secret) return
    fetch('/api/admin/customers', { headers: { 'x-admin-secret': secret }, cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        const out: Biz[] = []
        for (const c of (j?.customers ?? [])) {
          for (const b of (c.businesses ?? [])) {
            if ((b.integrations ?? []).some((i: any) => i.provider === 'personalkollen')) {
              out.push({ id: b.id, name: b.name, org_name: c.name })
            }
          }
        }
        setBizList(out)
        if (out.length && !bizId) setBizId(out[0].id)
      })
      .catch(e => setError(e.message))
  }, [secret])

  async function run() {
    if (!bizId || !secret) return
    setLoading(true); setError(null); setResult(null)
    try {
      const r = await fetch(`/api/admin/diagnose-pk-sales?business_id=${bizId}&days=${days}`, {
        headers: { 'x-admin-secret': secret },
        cache:   'no-store',
      })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setResult(j)
    } catch (e: any) { setError(e.message) }
    setLoading(false)
  }

  const rev = result?.revenue_reconciliation
  const manualLooking = result?.by_items_length?.['0'] ?? 0
  const dropped = rev?.revenue_potentially_dropped_kr ?? 0

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: 24, fontFamily: '-apple-system,sans-serif', color: '#1a1f2e' }}>
      <div style={{ marginBottom: 20 }}>
        <a href="/admin/customers" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>← Back to customers</a>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: '10px 0 4px' }}>Personalkollen — manual vs POS diagnostic</h1>
        <p style={{ fontSize: 13, color: '#6b7280', margin: 0 }}>
          Fetches raw PK <code style={{ background: '#f3f4f6', padding: '1px 5px', borderRadius: 4 }}>/sales/</code> rows for the selected business and buckets them so we can see what distinguishes manually-entered revenue from POS-synced sales.
        </p>
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, color: '#374151' }}>
          Business{' '}
          <select value={bizId} onChange={e => setBizId(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8, minWidth: 240 }}>
            <option value="">— select —</option>
            {bizList.map(b => (
              <option key={b.id} value={b.id}>{b.name}{b.org_name ? ` (${b.org_name})` : ''}</option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: 12, color: '#374151' }}>
          Days{' '}
          <input type="number" min={1} max={90} value={days} onChange={e => setDays(Number(e.target.value))}
                 style={{ width: 70, padding: '6px 10px', fontSize: 13, border: '1px solid #e5e7eb', borderRadius: 8 }} />
        </label>
        <button
          onClick={run}
          disabled={loading || !bizId}
          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: loading ? '#9ca3af' : '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, cursor: loading ? 'default' : 'pointer' }}
        >
          {loading ? 'Running…' : 'Run diagnostic'}
        </button>
      </div>

      {error && (
        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          {error}
        </div>
      )}

      {result && (
        <>
          {/* Headline summary — the answer in one line */}
          <div style={{ background: dropped > 0 ? '#fef3c7' : '#f0fdf4', border: `1px solid ${dropped > 0 ? '#fcd34d' : '#bbf7d0'}`, padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 14, color: dropped > 0 ? '#92400e' : '#15803d' }}>
            {dropped > 0
              ? <>Over the last {result.date_range.days} days, <strong>{manualLooking}</strong> of <strong>{result.total_sales}</strong> PK sale rows look manual (no line items) and the current extractor is dropping <strong>{dropped.toLocaleString('sv-SE')} kr</strong> of revenue on the floor.</>
              : <>Over the last {result.date_range.days} days, no manual-looking rows found — extractor isn't dropping revenue.</>}
          </div>

          {/* Numbers at a glance */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 18 }}>
            <Stat label="Total sale rows" value={result.total_sales} />
            <Stat label="Items = 0 (likely manual)" value={result.by_items_length['0']} />
            <Stat label="Items ≥ 1 (POS)" value={result.total_sales - (result.by_items_length['0'] ?? 0)} />
            <Stat label="Revenue dropped (kr)" value={dropped.toLocaleString('sv-SE')} warn={dropped > 0} />
          </div>

          {/* Buckets + payment methods side-by-side */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16, marginBottom: 18 }}>
            <Section title="By items length">
              <KeyCount obj={result.by_items_length} />
            </Section>
            <Section title="By payments length">
              <KeyCount obj={result.by_payments_length} />
            </Section>
            <Section title="Payment methods">
              <KeyCount obj={result.by_payment_method} />
            </Section>
          </div>

          {/* All top-level fields — what keys PK actually exposes */}
          <Section title="Every top-level field PK returned">
            <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, color: '#4b5563' }}>
              {(result.top_level_fields_seen ?? []).join(', ')}
            </div>
          </Section>

          {/* Samples: manual + POS side-by-side */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: 16, marginTop: 16 }}>
            <Section title={`Likely-manual samples (${result.samples.likely_manual_entries.length})`}>
              <Json v={result.samples.likely_manual_entries} />
            </Section>
            <Section title={`POS samples (${result.samples.pos_entries.length})`}>
              <Json v={result.samples.pos_entries} />
            </Section>
          </div>

          {/* Copy-all button — so paul can still paste the whole JSON to Claude in one click */}
          <div style={{ marginTop: 18 }}>
            <button
              onClick={() => { navigator.clipboard.writeText(JSON.stringify(result, null, 2)) }}
              style={{ padding: '8px 14px', fontSize: 12, background: '#f3f4f6', color: '#1a1f2e', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer' }}
            >
              Copy full JSON to clipboard
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: any; warn?: boolean }) {
  return (
    <div style={{ background: 'white', border: `1px solid ${warn ? '#fcd34d' : '#e5e7eb'}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: warn ? '#92400e' : '#1a1f2e', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 10, color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  )
}

function KeyCount({ obj }: { obj: Record<string, number> }) {
  const entries = Object.entries(obj ?? {})
  if (entries.length === 0) return <div style={{ fontSize: 12, color: '#9ca3af' }}>(none)</div>
  return (
    <div>
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, padding: '3px 0', borderBottom: '1px dashed #f3f4f6' }}>
          <span style={{ color: '#4b5563' }}>{k}</span>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{v.toLocaleString()}</span>
        </div>
      ))}
    </div>
  )
}

function Json({ v }: { v: any }) {
  return (
    <pre style={{ background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 6, padding: 10, fontSize: 10, overflowX: 'auto', maxHeight: 480, color: '#111' }}>
      {JSON.stringify(v, null, 2)}
    </pre>
  )
}
