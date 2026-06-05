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
import { UXP }                         from '@/lib/constants/tokens'

interface Message {
  role:    'user' | 'assistant'
  content: string
  downloads?: Array<{ label: string; url: string }>   // generated-document links
}

// Client-side report-request detection was removed 2026-06-05. It conflated
// "top purchased items from supplier X" (per-product report) with "supplier
// spend rollup" (per-supplier report) because both questions contain the word
// "supplier"/"purchas". Now every report request goes through /api/ask and the
// server-side generate_report tool — the LLM picks the right report_type from
// the full question context, and the dispatcher coerces any residual 'supplier'
// choice to 'top-products'. Adds 2-3s latency vs the old fast path, but
// eliminates the wrong-report-type bug class entirely.
const DL_LABEL = { pdf: 'Download PDF', docx: 'Download Word', pptx: 'Download PowerPoint' } as const

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
  /**
   * When true, hide the floating bottom-right "Ask CC" button — the
   * toolbar pill is the only trigger. Used by AppShell's fallback
   * AskAI on pages that don't mount their own.
   */
  hideFloatingBtn?: boolean
  /**
   * Set by AppShell's fallback AskAI so the global event handler
   * registry prefers page-level (rich-context) instances over the
   * fallback when both are mounted. Pages should leave this unset.
   */
  isFallback?: boolean
}

export default function AskAI({ page, context, tier = 'full', orgScope = false, hideFloatingBtn = false, isFallback = false }: Props) {
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

  // Listen for the toolbar's "Ask CC" pill click. Registry pattern:
  // every AskAI mount pushes itself into a global stack so multiple
  // simultaneous mounts don't all open at once. The TOP of the stack
  // wins, with page-level instances ranked above the AppShell fallback.
  useEffect(() => {
    const w = window as any
    w.__cc_askai_handlers ??= [] as Array<{ open: () => void; isFallback: boolean }>
    const entry = { open: () => setOpen(true), isFallback }
    w.__cc_askai_handlers.push(entry)
    const onEvent = () => {
      const handlers = w.__cc_askai_handlers as Array<{ open: () => void; isFallback: boolean }>
      // Prefer most-recent non-fallback; fall back to most-recent overall.
      const nonFb = [...handlers].reverse().find(h => !h.isFallback)
      const target = nonFb ?? handlers[handlers.length - 1]
      target?.open()
    }
    window.addEventListener('cc-open-askai', onEvent)
    return () => {
      window.removeEventListener('cc-open-askai', onEvent)
      const idx = w.__cc_askai_handlers.indexOf(entry)
      if (idx >= 0) w.__cc_askai_handlers.splice(idx, 1)
    }
  }, [isFallback])

  async function send(question: string) {
    if (!question.trim() || loading) return
    setError('')
    setUpgrade(false)
    setLimitInfo(null)

    const userMsg: Message = { role: 'user', content: question }
    setMessages(prev => [...prev, userMsg])
    setInput('')
    setLoading(true)

    // Document generation now goes entirely through /api/ask + the
    // server-side generate_report tool. The /api/ask response carries
    // a `downloads` array when the LLM called generate_report, and the
    // tool dispatcher picks the right report_type from the full context
    // (top-products vs margin vs cost) instead of a brittle client regex.

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

      setMessages(prev => [...prev, { role: 'assistant', content: data.answer, ...(Array.isArray(data.downloads) && data.downloads.length ? { downloads: data.downloads } : {}) }])
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
  // UXP redesign — the floating button now matches the toolbar's
  // "Ask CC" pill (lavender + sparkle + white text). Panel + overlay
  // re-tinted to the pastel palette so the slide-in feels like part of
  // the same product surface.
  const FAB: React.CSSProperties = {
    position:     'fixed',
    bottom:       28,
    right:        28,
    zIndex:       1000,
    display:      'inline-flex',
    alignItems:   'center',
    gap:          7,
    padding:      '11px 20px',
    background:   UXP.lav,
    color:        '#fff',
    border:       'none',
    borderRadius: 999,
    fontSize:     12,
    fontWeight:   500,
    letterSpacing: '0.02em',
    cursor:       'pointer',
    boxShadow:    '0 10px 28px -10px rgba(125,108,201,0.55), 0 2px 6px rgba(58,53,80,0.10)',
    transition:   'transform 0.15s, box-shadow 0.15s',
    fontFamily:   'inherit',
  }

  const PANEL: React.CSSProperties = {
    position:        'fixed',
    top:             0,
    right:           0,
    bottom:          0,
    zIndex:          1001,
    width:           400,
    maxWidth:        '95vw',
    background:      UXP.cardBg,
    borderLeft:      `0.5px solid ${UXP.border}`,
    boxShadow:       '-8px 0 32px rgba(58,53,80,0.12)',
    display:         'flex',
    flexDirection:   'column',
    transform:       open ? 'translateX(0)' : 'translateX(100%)',
    transition:      'transform 0.25s cubic-bezier(.4,0,.2,1)',
  }

  const OVERLAY: React.CSSProperties = {
    position:   'fixed',
    inset:      0,
    zIndex:     1000,
    background: 'rgba(58,53,80,0.28)',
    opacity:    open ? 1 : 0,
    pointerEvents: open ? 'auto' : 'none',
    transition: 'opacity 0.25s',
  }

  return (
    <>
      {/* Floating button — UXP "Ask CC" pill. Hidden when the AskAI is
          mounted as the AppShell fallback (toolbar pill is the trigger). */}
      {!hideFloatingBtn && (
        <button
          className="ai-fab"
          style={FAB}
          onClick={() => setOpen(o => !o)}
          title={t('fabTitle')}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'none' }}
        >
          <span aria-hidden style={{ fontSize: 12 }}>✦</span>
          Ask CC
        </button>
      )}

      {/* Backdrop */}
      <div style={OVERLAY} onClick={() => setOpen(false)} />

      {/* Slide-in panel */}
      <div style={PANEL}>

        {/* Header */}
        <div style={{
          padding:        '16px 20px',
          borderBottom:   `0.5px solid ${UXP.borderSoft}`,
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'space-between',
          flexShrink:     0,
        }}>
          <div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
              <span aria-hidden style={{ color: UXP.lav, fontSize: 13 }}>✦</span>
              <div style={{ fontSize: 14, fontWeight: 500, color: UXP.ink1 }}>{t('header.title')}</div>
            </div>
            <div style={{ fontSize: 10, color: UXP.ink4 }}>{t('header.subtitle')}</div>
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: UXP.ink3, lineHeight: 1, padding: '0 4px', fontFamily: 'inherit' }}
          >×</button>
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Empty state — show suggestions */}
          {messages.length === 0 && (
            <div>
              <div style={{
                fontSize:      9,
                color:         UXP.ink4,
                marginBottom:  10,
                fontWeight:    600,
                textTransform: 'uppercase' as const,
                letterSpacing: '0.05em',
              }}>
                {t('suggestionsHeader')}
              </div>
              {suggestions.map(s => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  style={{
                    display:       'block',
                    width:         '100%',
                    textAlign:     'left' as const,
                    padding:       '10px 12px',
                    marginBottom:  8,
                    background:    UXP.subtleBg,
                    border:        `0.5px solid ${UXP.border}`,
                    borderRadius:  UXP.r_md,
                    fontSize:      12,
                    color:         UXP.ink2,
                    cursor:        'pointer',
                    lineHeight:    1.45,
                    fontFamily:    'inherit',
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
                  display:       'inline-flex',
                  alignItems:    'center',
                  gap:           3,
                  padding:       '1px 6px',
                  background:    UXP.lavFill,
                  color:         UXP.lavText,
                  borderRadius:  6,
                  fontSize:      9,
                  fontWeight:    600,
                  letterSpacing: '0.04em',
                  alignSelf:     'flex-start' as const,
                }}>
                  <span aria-hidden="true">✦</span>
                  <span>AI</span>
                </div>
              )}
              <div style={{
                padding:      '10px 14px',
                borderRadius: msg.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                background:   msg.role === 'user' ? UXP.lavDeep : UXP.subtleBg,
                color:        msg.role === 'user' ? '#fff' : UXP.ink1,
                fontSize:     12.5,
                lineHeight:   1.55,
                whiteSpace:   'pre-wrap' as const,
              }}>
                {msg.content}
              </div>
              {msg.downloads && msg.downloads.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const, marginTop: 2 }}>
                  {msg.downloads.map((d, j) => (
                    <a key={j} href={d.url} target="_blank" rel="noopener noreferrer"
                      style={{
                        padding: '6px 12px', fontSize: 11.5, fontWeight: 600,
                        background: UXP.lavDeep, color: '#fff', borderRadius: 7,
                        textDecoration: 'none', fontFamily: 'inherit',
                      }}>
                      {d.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Loading indicator */}
          {loading && (
            <div style={{
              alignSelf:    'flex-start' as const,
              padding:      '10px 14px',
              background:   UXP.subtleBg,
              borderRadius: '14px 14px 14px 4px',
              fontSize:     12,
              color:        UXP.ink3,
              fontStyle:    'italic' as const,
            }}>
              {t('thinking')}
            </div>
          )}

          {/* Soft warning — 80 % of daily quota used. */}
          {warning && !upgrade && (
            <div style={{
              padding:      '10px 12px',
              background:   warning.severity === 'info' ? UXP.lavFill : UXP.lavFill,
              border:       `0.5px solid ${UXP.lavMid}`,
              borderRadius: UXP.r_md,
              fontSize:     11,
              color:        warning.severity === 'info' ? UXP.lavText : UXP.coral,
              display:      'flex',
              justifyContent: 'space-between',
              alignItems:   'center',
              gap:          10,
            }}>
              <span>{t('warning.body', { percent: warning.percent, used: warning.used, limit: warning.limit })}</span>
              <a href="/upgrade?focus=ai" style={{
                fontSize:       10,
                color:          UXP.lavText,
                fontWeight:     500,
                textDecoration: 'underline',
                whiteSpace:     'nowrap' as const,
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
            <div style={{
              padding:      '10px 14px',
              background:   UXP.roseFill,
              border:       `0.5px solid ${UXP.rose}`,
              borderRadius: UXP.r_md,
              fontSize:     11,
              color:        UXP.roseText,
            }}>{error}</div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{
          padding:    '12px 16px',
          borderTop:  `0.5px solid ${UXP.borderSoft}`,
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder={t('input.placeholder')}
              rows={2}
              style={{
                flex:         1,
                padding:      '10px 12px',
                background:   UXP.subtleBg,
                color:        UXP.ink1,
                border:       `0.5px solid ${UXP.border}`,
                borderRadius: UXP.r_md,
                fontSize:     12.5,
                resize:       'none' as const,
                outline:      'none',
                lineHeight:   1.45,
                fontFamily:   'inherit',
              }}
            />
            <button
              type="button"
              onClick={() => send(input)}
              disabled={!input.trim() || loading}
              style={{
                padding:      '10px 14px',
                background:   !input.trim() || loading ? UXP.subtleBg : UXP.lavDeep,
                color:        !input.trim() || loading ? UXP.ink4    : '#fff',
                border:       'none',
                borderRadius: 999,
                fontSize:     12,
                fontWeight:   500,
                cursor:       !input.trim() || loading ? 'not-allowed' : 'pointer',
                flexShrink:   0,
                alignSelf:    'flex-end' as const,
                fontFamily:   'inherit',
              }}
            >
              {t('input.send')}
            </button>
          </div>
          <div style={{ fontSize: 9, color: UXP.ink4, marginTop: 6, textAlign: 'center' as const }}>
            {t('input.hint')}
          </div>
        </div>

      </div>
    </>
  )
}
