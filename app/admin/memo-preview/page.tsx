'use client'
// @ts-nocheck
// app/admin/memo-preview/page.tsx
//
// Preview a customer's latest Monday memo email, including the live thumbs
// feedback buttons. Useful for demos, QA of the memo template, and checking
// the feedback flow end-to-end without waiting for Monday's cron.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AdminNav } from '@/components/admin/AdminNav'

export default function MemoPreview() {
  const router   = useRouter()
  const params   = useSearchParams()
  const [html,    setHtml]    = useState('')
  const [error,   setError]   = useState('')
  const [loading, setLoading] = useState(false)
  const [bizId,   setBizId]   = useState(params.get('business_id') ?? '')
  const [orgs,    setOrgs]    = useState<any[]>([])

  const secret = typeof window !== 'undefined' ? (sessionStorage.getItem('admin_auth') ?? '') : ''

  useEffect(() => {
    if (!secret) { router.push('/admin/login?next=/admin/memo-preview'); return }
    loadOrgs()
  }, [])

  useEffect(() => {
    if (bizId) loadPreview(bizId)
  }, [bizId])

  async function loadOrgs() {
    try {
      const r = await fetch('/api/admin', { headers: { 'x-admin-secret': secret } })
      if (!r.ok) return
      const j = await r.json()
      setOrgs(j.orgs ?? [])
    } catch {}
  }

  async function loadPreview(id: string) {
    setLoading(true); setError(''); setHtml('')
    try {
      const r = await fetch(`/api/admin/memo-preview?business_id=${encodeURIComponent(id)}`, {
        headers: { 'x-admin-secret': secret },
      })
      if (!r.ok) {
        setError(`HTTP ${r.status}`)
      } else {
        setHtml(await r.text())
      }
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }

  const businesses = orgs.flatMap((o: any) =>
    (o.businesses ?? []).map((b: any) => ({ ...b, org_name: o.name })))

  return (
    <div style={{ background: '#f5f6f8', minHeight: '100vh' }}>
      <AdminNav />
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '24px 32px' }}>
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Monday memo preview</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Renders the most recent briefing as an email. Feedback buttons are live — clicks write to <code>memo_feedback</code>.</p>
        </div>

        <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase' as const, color: '#6b7280', marginBottom: 6 }}>Business</label>
          <select
            value={bizId}
            onChange={e => {
              setBizId(e.target.value)
              const url = new URL(window.location.href)
              if (e.target.value) url.searchParams.set('business_id', e.target.value)
              else url.searchParams.delete('business_id')
              window.history.replaceState({}, '', url.toString())
            }}
            style={{ width: '100%', padding: '8px 10px', fontSize: 14, border: '1px solid #d4d4d0', borderRadius: 8, background: '#fff' }}
          >
            <option value="">— pick a business —</option>
            {businesses.map((b: any) => (
              <option key={b.id} value={b.id}>{b.org_name} › {b.name}</option>
            ))}
          </select>
        </div>

        {error && <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#dc2626', marginBottom: 16 }}>{error}</div>}

        {loading ? (
          <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af' }}>Loading…</div>
        ) : html ? (
          <iframe
            srcDoc={html}
            style={{ width: '100%', minHeight: 700, border: '1px solid #e5e7eb', borderRadius: 12, background: '#fff' }}
          />
        ) : bizId ? null : (
          <div style={{ padding: 40, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13 }}>Pick a business to preview its latest memo.</div>
        )}
      </div>
    </div>
  )
}
