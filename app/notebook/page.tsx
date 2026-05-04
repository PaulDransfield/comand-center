'use client'
// @ts-nocheck
// app/notebook/page.tsx — AI Assistant (full-page chat interface)

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { createClient } from '@/lib/supabase/client'
import { fmtKr } from '@/lib/format'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const MONTHS_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Compact summary — one line per business per month. Aim for <800 tokens total
// so the per-query cost on Haiku stays around $0.002.
async function buildContext(): Promise<string> {
  try {
    const bizRes = await fetch('/api/businesses', { cache: 'no-store' })
    const businesses: any[] = bizRes.ok ? await bizRes.json() : []
    if (!Array.isArray(businesses) || businesses.length === 0) {
      return 'No business data loaded — the user has not set up any restaurants yet.'
    }

    const year  = new Date().getFullYear()
    const lines: string[] = [`Business overview — ${year} (last 6 months of synced data):`, '']

    for (const biz of businesses.slice(0, 5)) {
      const mRes = await fetch(`/api/metrics/monthly?business_id=${biz.id}&year=${year}`, { cache: 'no-store' })
      const data = mRes.ok ? await mRes.json() : { rows: [] }
      const rows = (data.rows ?? []).slice(-6)
      lines.push(`### ${biz.name || biz.id}${biz.city ? ` (${biz.city})` : ''}`)
      if (rows.length === 0) {
        lines.push('  No synced data yet.')
      } else {
        for (const r of rows) {
          const rev   = fmtKr(Number(r.revenue ?? 0))
          const staff = fmtKr(Number(r.staff_cost ?? 0))
          const food  = fmtKr(Number(r.food_cost ?? 0))
          const net   = fmtKr(Number(r.net_profit ?? 0))
          const mpct  = r.margin_pct != null ? `${r.margin_pct}%` : '—'
          const lpct  = r.labour_pct != null ? `${r.labour_pct}%` : '—'
          lines.push(`  ${MONTHS_EN[(r.month ?? 1) - 1]}: revenue ${rev}, staff ${staff} (${lpct}), food ${food}, net ${net} (${mpct})`)
        }
      }
      lines.push('')
    }
    return lines.join('\n')
  } catch (e: any) {
    return `Context fetch failed: ${e?.message || 'unknown'}`
  }
}

export default function NotebookPage() {
  const t = useTranslations('notebook.assistant')
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [bizId,    setBizId]    = useState<string | null>(null)
  const [ctx,      setCtx]      = useState<string>('')
  const [ctxLoading, setCtxLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Get the selected business from sessionStorage (set by sidebar switcher)
    const stored = sessionStorage.getItem('cc_selected_biz')
    if (stored) setBizId(stored)

    // Fetch the compact business-summary context once on mount.
    // Every question reuses this context — saves re-fetching per query and
    // keeps input tokens predictable (~500) so Haiku cost stays <$0.003/query.
    buildContext().then(c => { setCtx(c); setCtxLoading(false) })
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const q = input.trim()
    if (!q || loading) return
    setInput('')
    const updated: Message[] = [...messages, { role: 'user', content: q }]
    setMessages(updated)
    setLoading(true)

    try {
      const res  = await fetch('/api/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          question: q,
          page:     'assistant',
          // tier 'light' routes through Haiku for ~$0.002/query vs Sonnet's ~$0.012.
          // Every query still counts against the org's daily AI limit.
          tier:     'light',
          context:  ctx || 'General business intelligence assistant for this restaurant business.',
          ...(bizId ? { business_id: bizId } : {}),
        }),
      })
      const data = await res.json()
      setMessages([...updated, { role: 'assistant', content: data.answer ?? data.error ?? t('noResponse') }])
      // Poke the sidebar meter so the counter updates immediately.
      if (res.ok) { try { window.dispatchEvent(new Event('cc_ai_used')) } catch {} }
    } catch {
      setMessages([...updated, { role: 'assistant', content: t('genericError') }])
    }
    setLoading(false)
  }

  const STARTERS = [
    t('starters.0'),
    t('starters.1'),
    t('starters.2'),
    t('starters.3'),
    t('starters.4'),
  ]

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', maxWidth: 820, margin: '0 auto', padding: '24px 28px 0' }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>{t('title')}</h1>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
            {t('subtitle')}
          </p>
          <p style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
            {ctxLoading ? t('contextLoading') : t('contextReady')}
          </p>
        </div>

        {/* Message thread */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
          {messages.length === 0 ? (
            <div style={{ padding: '40px 0 20px' }}>
              <div style={{ textAlign: 'center', marginBottom: 32, color: '#9ca3af', fontSize: 14 }}>
                {t('startersIntro')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {STARTERS.map(s => (
                  <button key={s} onClick={() => { setInput(s); }}
                    style={{ padding: '8px 14px', background: '#f3f4f6', border: '1px solid #e5e7eb', borderRadius: 20, fontSize: 13, color: '#374151', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 16, display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
                <div style={{
                  maxWidth: '80%',
                  padding: '10px 14px',
                  borderRadius: m.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                  background: m.role === 'user' ? '#1a1f2e' : '#f3f4f6',
                  color: m.role === 'user' ? 'white' : '#111827',
                  fontSize: 14,
                  lineHeight: '1.5',
                  whiteSpace: 'pre-wrap',
                }}>
                  {m.content}
                </div>
              </div>
            ))
          )}
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 16 }}>
              <div style={{ padding: '10px 16px', background: '#f3f4f6', borderRadius: '16px 16px 16px 4px', fontSize: 13, color: '#6b7280' }}>
                {t('thinking')}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '16px 0 24px', display: 'flex', gap: 10 }}>
          <input
            style={{ flex: 1, padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, outline: 'none' }}
            placeholder={t('inputPlaceholder')}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            disabled={loading}
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            style={{ padding: '10px 20px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading || !input.trim() ? 0.5 : 1 }}>
            {t('send')}
          </button>
        </div>
      </div>
    </AppShell>
  )
}
