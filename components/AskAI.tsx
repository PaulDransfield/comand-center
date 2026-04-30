'use client'
// @ts-nocheck
// components/AskAI.tsx
//
// Floating "Ask AI" button that opens a slide-in panel.
// Each page passes its current data as a plain-text `context` string.
// The panel sends question + context to /api/ask and shows the answer.
//
// Usage:
//   <AskAI page="staff" context={`Total hours: 340h\nStaff cost: 45,000 kr\n...`} />

import { useState, useRef, useEffect }  from 'react'
import { useTranslations }              from 'next-intl'
import { createClient }                from '@/lib/supabase/client'
import AiLimitReached                  from '@/components/AiLimitReached'

interface Message {
  role:    'user' | 'assistant'
  content: string
}

// Suggestion KEYS — text resolved from askai.suggestions.<page>.{q1,q2,q3} at
// render time so suggestions render in the user's language. Pages outside
// this list fall through to `default`.
const SUGGESTION_PAGES = new Set([
  'dashboard', 'staff', 'tracker', 'revenue', 'forecast', 'departments',
])

interface Props {
  page:    string
  context: string             // plain-text summary of the page data built by the parent
  tier?:   'light' | 'full'   // 'light' routes through Haiku (cheap). Defaults to 'full' (Sonnet).
  /**
   * When true, do NOT scope server-side enrichments to the localStorage
   * business. Use on org-wide pages like /group where the question may
   * span every business in the org — pinning to one business causes
   * the forecast/comparison/trend enrichments to silently exclude the
   * other businesses' data. The `group` enrichment in contextBuilder is
   * org-scoped already and runs regardless. (FIXES §0kk.)
   */
  orgScope?: boolean
}

export default function AskAI({ page, context, tier = 'full', orgScope = false }: Props) {
  const t          = useTranslations('askai')
  const suggKey    = SUGGESTION_PAGES.has(page) ? page : 'default'
  const suggestions = [
    t(`suggestions.${suggKey}.q1`),
    t(`suggestions.${suggKey}.q2`),
    t(`suggestions.${suggKey}.q3`),
  ]
  const [open,     setOpen]     = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')
  const [upgrade,  setUpgrade]  = useState(false)
  const [limitInfo, setLimitInfo] = useState<{ used: number; limit: number; plan: string; reason?: string } | null>(null)
  const [warning,  setWarning]  = useState<{ percent: number; used: number; limit: number; severity?: 'info' | 'warn' } | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef  = useRef<HTMLTextAreaElement>(null)

  // (suggestions are now built from translations at the top of the
  // component — see the t(`suggestions.${suggKey}.q1`) line above.)

  // Scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Focus input when panel opens
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100)
  }, [open])

  async function send(question: string) {
    if (!question.trim() || loading) return
    setError('')
    setUpgrade(false)
    setLimitInfo(null)

    const userMsg: Message = { role: 'user', content: question }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    try {
      // Get the session token so the API route can authenticate the request
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()

      // Pass the currently-selected business so the server can enrich
      // the context with Fortnox line items when the question is about
      // costs / overheads / subscriptions / etc.
      // orgScope=true overrides this — used on /group so org-wide
      // enrichments fire instead of being silently scoped to a single
      // business in localStorage.
      const bizId = orgScope
        ? null
        : (typeof window !== 'undefined' ? localStorage.getItem('cc_selected_biz') : null)
      const res  = await fetch('/api/ask', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${session?.access_token ?? ''}`,
        },
        body:    JSON.stringify({ question, context, page, tier, business_id: bizId }),
      })
      const data = await res.json()

      if (!res.ok) {
        // Three distinct block reasons — surface the right CTA for each.
        // daily_cap      → upgrade plan or buy AI Booster
        // monthly_ceiling → contact support
        // global_kill_switch → try later (company-wide pause)
        if (data.reason === 'global_kill_switch') {
          setError(data.error || 'AI is temporarily paused. Please try again shortly.')
        } else if (data.reason === 'monthly_ceiling') {
          setError(data.error || 'Monthly AI cost ceiling reached. Please contact support@comandcenter.se to review.')
        } else if (data.upgrade || data.reason === 'daily_cap') {
          setUpgrade(true)
          setLimitInfo({
            used:  data.used ?? data.limit ?? 0,
            limit: data.limit ?? 0,
            plan:  data.plan ?? 'trial',
            reason: data.reason,
          })
        } else {
          setError(data.error ?? 'Something went wrong')
        }
        return
      }

      setMessages(prev => [...prev, { role: 'assistant', content: data.answer }])
      // Surface the 80 %-used warning if returned; clears when under threshold.
      setWarning(data.warning ?? null)
      // Poke the sidebar meter to refresh immediately.
      try { window.dispatchEvent(new Event('cc_ai_used')) } catch {}
    } catch {
      setError('Connection error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(input)
    }
  }

  // ── Styles ───────────────────────────────────────────────────────
  const FAB: React.CSSProperties = {
    position:     'fixed',
    bottom:       28,
    right:        28,
    zIndex:       1000,
    display:      'flex',
    alignItems:   'center',
    gap:          8,
    padding:      '11px 18px',
    background:   '#1a1f2e',
    color:        'white',
    border:       'none',
    borderRadius: 24,
    fontSize:     13,
    fontWeight:   600,
    cursor:       'pointer',
    boxShadow:    '0 4px 16px rgba(0,0,0,0.20)',
    transition:   'transform 0.15s, box-shadow 0.15s',
  }

  const PANEL: React.CSSProperties = {
    position:        'fixed',
    top:             0,
    right:           0,
    bottom:          0,
    zIndex:          1001,
    width:           380,
    maxWidth:        '95vw',
    background:      'white',
    boxShadow:       '-4px 0 32px rgba(0,0,0,0.12)',
    display:         'flex',
    flexDirection:   'column',
    transform:       open ? 'translateX(0)' : 'translateX(100%)',
    transition:      'transform 0.25s cubic-bezier(.4,0,.2,1)',
  }

  const OVERLAY: React.CSSProperties = {
    position:   'fixed',
    inset:      0,
    zIndex:     1000,
    background: 'rgba(0,0,0,0.2)',
    opacity:    open ? 1 : 0,
    pointerEvents: open ? 'auto' : 'none',
    transition: 'opacity 0.25s',
  }

  return (
    <>
      {/* Floating button */}
      <button
        className="ai-fab"
        style={FAB}
        onClick={() => setOpen(o => !o)}
        title={t('fabTitle')}
      >
        <span style={{ fontSize: 16 }}>✦</span>
        {t('fab')}
      </button>

      {/* Backdrop */}
      <div style={OVERLAY} onClick={() => setOpen(false)} />

      {/* Slide-in panel */}
      <div style={PANEL}>

        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#111' }}>{t('header.title')}</div>
            <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{t('header.subtitle')}</div>
          </div>
          <button
            onClick={() => setOpen(false)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#9ca3af', lineHeight: 1, padding: '0 4px' }}
          >
            ×
          </button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Empty state — show suggestions */}
          {messages.length === 0 && (
            <div>
              <div style={{ fontSize: 12, color: '#9ca3af', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                {t('suggestionsHeader')}
              </div>
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => send(s)}
                  style={{
                    display:       'block',
                    width:         '100%',
                    textAlign:     'left',
                    padding:       '10px 12px',
                    marginBottom:  8,
                    background:    '#f9fafb',
                    border:        '1px solid #f3f4f6',
                    borderRadius:  8,
                    fontSize:      13,
                    color:         '#374151',
                    cursor:        'pointer',
                    lineHeight:    1.4,
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          )}

          {/* Conversation */}
          {messages.map((msg, i) => (
            <div key={i} style={{
              alignSelf:    msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth:     '88%',
              display:      'flex',
              flexDirection:'column' as const,
              gap:          6,
            }}>
              {msg.role === 'assistant' && (
                // EU AI Act Art. 52 — users must know they are looking at AI output.
                <div title={t('aiBadgeTitle')} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                  padding: '1px 6px', background: '#ede9fe', color: '#6d28d9',
                  borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: '.04em',
                  alignSelf: 'flex-start',
                }}>
                  <span aria-hidden="true">✦</span>
                  <span>AI</span>
                </div>
              )}
              <div style={{
                padding:      '10px 14px',
                borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                background:   msg.role === 'user' ? '#1a1f2e' : '#f3f4f6',
                color:        msg.role === 'user' ? 'white' : '#111',
                fontSize:     13,
                lineHeight:   1.55,
                whiteSpace:   'pre-wrap' as const,
              }}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Loading indicator */}
          {loading && (
            <div style={{ alignSelf: 'flex-start', padding: '10px 14px', background: '#f3f4f6', borderRadius: '14px 14px 14px 4px', fontSize: 13, color: '#9ca3af' }}>
              {t('thinking')}
            </div>
          )}

          {/* Soft warning — 80 % of daily quota used. Shown once then persists
              for the session until the next question confirms it's gone. */}
          {warning && !upgrade && (
            <div style={{
              padding: '10px 12px',
              background: warning.severity === 'info' ? '#eef2ff' : '#fffbeb',
              border:     warning.severity === 'info' ? '1px solid #c7d2fe' : '1px solid #fde68a',
              borderRadius: 8, fontSize: 12,
              color:      warning.severity === 'info' ? '#3730a3' : '#78350f',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10,
            }}>
              <span>{t('warning.body', { percent: warning.percent, used: warning.used, limit: warning.limit })}</span>
              <a href="/upgrade?focus=ai" style={{
                fontSize: 11,
                color: warning.severity === 'info' ? '#4338ca' : '#b45309',
                fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
              }}>
                {t('warning.upgrade')}
              </a>
            </div>
          )}

          {/* AI limit reached — prominent upsell card */}
          {upgrade && limitInfo && (
            <AiLimitReached used={limitInfo.used} limit={limitInfo.limit} plan={limitInfo.plan} />
          )}

          {/* Regular error (non-limit) */}
          {error && !upgrade && (
            <div style={{ padding: '10px 14px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, fontSize: 12, color: '#dc2626' }}>
              {error}
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{ padding: '12px 16px', borderTop: '1px solid #f3f4f6', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={t('input.placeholder')}
              rows={2}
              style={{
                flex:        1,
                padding:     '10px 12px',
                border:      '1px solid #e5e7eb',
                borderRadius: 10,
                fontSize:    13,
                resize:      'none',
                outline:     'none',
                lineHeight:  1.4,
                color:       '#111',
                background:  'white',
              }}
            />
            <button
              onClick={() => send(input)}
              disabled={!input.trim() || loading}
              style={{
                padding:      '10px 14px',
                background:   !input.trim() || loading ? '#e5e7eb' : '#1a1f2e',
                color:        !input.trim() || loading ? '#9ca3af' : 'white',
                border:       'none',
                borderRadius: 10,
                fontSize:     13,
                fontWeight:   600,
                cursor:       !input.trim() || loading ? 'not-allowed' : 'pointer',
                flexShrink:   0,
                alignSelf:    'flex-end',
              }}
            >
              {t('input.send')}
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#d1d5db', marginTop: 6, textAlign: 'center' }}>
            {t('input.hint')}
          </div>
        </div>

      </div>
    </>
  )
}
