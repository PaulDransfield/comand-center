'use client'
// @ts-nocheck
// app/notebook/page.tsx — Ask CC (full-page chat) on UXP
//
// The floating <AskAI> button in the rail opens a side panel for quick
// asks; this page is the dedicated chat surface for longer sessions.
// Same /api/ask endpoint, same 'light' (Haiku) tier, same compact-context
// pre-fetch — only the chrome was rebuilt on UXP tokens (lavender user
// bubbles + lavFill assistant bubbles + sparkle send pill matching the
// rail toolbar).

import { useState, useRef, useEffect } from 'react'
import { useTranslations } from 'next-intl'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { fmtKr } from '@/lib/format'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const MONTHS_EN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

// Compact summary — one line per business per month. <800 tokens total
// keeps per-query Haiku cost around $0.002.
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
  const [messages,   setMessages]   = useState<Message[]>([])
  const [input,      setInput]      = useState('')
  const [loading,    setLoading]    = useState(false)
  const [bizId,      setBizId]      = useState<string | null>(null)
  const [ctx,        setCtx]        = useState<string>('')
  const [ctxLoading, setCtxLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const stored = sessionStorage.getItem('cc_selected_biz')
    if (stored) setBizId(stored)
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
          tier:     'light',
          context:  ctx || 'General business intelligence assistant for this restaurant business.',
          ...(bizId ? { business_id: bizId } : {}),
        }),
      })
      const data = await res.json()
      setMessages([...updated, { role: 'assistant', content: data.answer ?? data.error ?? t('noResponse') }])
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
      <div style={{
        display:        'flex',
        flexDirection:  'column',
        height:         'calc(100vh - 64px)',
        maxWidth:       820,
        margin:         '0 auto',
        padding:        '8px 8px 0',
      }}>

        {/* Header */}
        <div style={{ marginBottom: 16 }}>
          <div style={{
            fontSize:      10,
            fontWeight:    600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color:         UXP.lavText,
            marginBottom:  4,
          }}>
            Ask CC
          </div>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1, letterSpacing: '-0.01em' }}>
            {t('title')}
          </h1>
          <p style={{ margin: '4px 0 0', fontSize: 12, color: UXP.ink3 }}>
            {t('subtitle')}
          </p>
          <p style={{ margin: '6px 0 0', fontSize: 10, color: UXP.ink4 }}>
            {ctxLoading ? t('contextLoading') : t('contextReady')}
          </p>
        </div>

        {/* Message thread */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
          {messages.length === 0 ? (
            <div style={{ padding: '32px 0 12px' }}>
              <div style={{ textAlign: 'center', marginBottom: 24, color: UXP.ink4, fontSize: 12 }}>
                {t('startersIntro')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
                {STARTERS.map(s => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    style={{
                      padding:      '8px 14px',
                      background:   UXP.cardBg,
                      border:       `0.5px solid ${UXP.border}`,
                      borderRadius: 999,
                      fontSize:     12,
                      color:        UXP.ink2,
                      cursor:       'pointer',
                      fontFamily:   'inherit',
                    }}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m, i) => (
              <div key={i} style={{
                marginBottom:   12,
                display:        'flex',
                justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
              }}>
                <div style={{
                  maxWidth:     '80%',
                  padding:      '10px 14px',
                  borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                  background:   m.role === 'user' ? UXP.lavDeep : UXP.subtleBg,
                  color:        m.role === 'user' ? 'white' : UXP.ink1,
                  border:       m.role === 'user' ? 'none' : `0.5px solid ${UXP.borderSoft}`,
                  fontSize:     13,
                  lineHeight:   1.55,
                  whiteSpace:   'pre-wrap',
                }}>
                  {m.content}
                </div>
              </div>
            ))
          )}
          {loading && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
              <div style={{
                padding:      '10px 14px',
                background:   UXP.subtleBg,
                border:       `0.5px solid ${UXP.borderSoft}`,
                borderRadius: '14px 14px 14px 4px',
                fontSize:     12,
                color:        UXP.ink3,
                fontStyle:    'italic',
              }}>
                {t('thinking')}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={{
          borderTop:  `0.5px solid ${UXP.border}`,
          padding:    '14px 0 20px',
          display:    'flex',
          gap:        8,
        }}>
          <input
            style={{
              flex:         1,
              padding:      '10px 14px',
              border:       `0.5px solid ${UXP.border}`,
              borderRadius: 10,
              fontSize:     13,
              fontFamily:   'inherit',
              color:        UXP.ink1,
              background:   UXP.cardBg,
              outline:      'none',
            }}
            placeholder={t('inputPlaceholder')}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            disabled={loading}
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            style={{
              padding:        '10px 18px',
              background:     UXP.lavDeep,
              color:          'white',
              border:         'none',
              borderRadius:   10,
              fontSize:       13,
              fontWeight:     600,
              fontFamily:     'inherit',
              cursor:         loading || !input.trim() ? 'not-allowed' : 'pointer',
              opacity:        loading || !input.trim() ? 0.5 : 1,
              display:        'inline-flex',
              alignItems:     'center',
              gap:            6,
            }}
          >
            <span aria-hidden style={{ fontSize: 12 }}>✦</span>
            {t('send')}
          </button>
        </div>
      </div>
    </AppShell>
  )
}
