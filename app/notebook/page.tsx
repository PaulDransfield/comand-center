'use client'
// @ts-nocheck
// app/notebook/page.tsx — AI Assistant (full-page chat interface)

import { useState, useRef, useEffect } from 'react'
import AppShell from '@/components/AppShell'
import { createClient } from '@/lib/supabase/client'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

export default function NotebookPage() {
  const [messages, setMessages] = useState<Message[]>([])
  const [input,    setInput]    = useState('')
  const [loading,  setLoading]  = useState(false)
  const [bizId,    setBizId]    = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Get the selected business from sessionStorage (set by sidebar switcher)
    const stored = sessionStorage.getItem('cc_selected_biz')
    if (stored) setBizId(stored)
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
      const params = new URLSearchParams({ page: 'assistant', context: '' })
      if (bizId) params.append('business_id', bizId)

      const res  = await fetch('/api/ask', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          question: q,
          page:     'assistant',
          context:  'General business intelligence assistant for this restaurant business.',
          ...(bizId ? { business_id: bizId } : {}),
        }),
      })
      const data = await res.json()
      setMessages([...updated, { role: 'assistant', content: data.answer ?? data.error ?? 'No response.' }])
    } catch {
      setMessages([...updated, { role: 'assistant', content: 'Something went wrong. Please try again.' }])
    }
    setLoading(false)
  }

  const STARTERS = [
    'How is revenue tracking this month?',
    'Which department has the best gross profit?',
    'Is my labour cost percentage healthy?',
    'What should I focus on to improve margin?',
    'Compare this month to last month',
  ]

  return (
    <AppShell>
      <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', maxWidth: 820, margin: '0 auto', padding: '24px 28px 0' }}>

        {/* Header */}
        <div style={{ marginBottom: 20 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, color: '#111827', margin: 0 }}>AI Assistant</h1>
          <p style={{ fontSize: 13, color: '#6b7280', marginTop: 4 }}>
            Ask anything about your restaurant data — revenue, staff costs, margins, and more.
          </p>
        </div>

        {/* Message thread */}
        <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 16 }}>
          {messages.length === 0 ? (
            <div style={{ padding: '40px 0 20px' }}>
              <div style={{ textAlign: 'center', marginBottom: 32, color: '#9ca3af', fontSize: 14 }}>
                Start a conversation — or try one of these:
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
                Thinking…
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '16px 0 24px', display: 'flex', gap: 10 }}>
          <input
            style={{ flex: 1, padding: '10px 14px', border: '1px solid #e5e7eb', borderRadius: 10, fontSize: 14, outline: 'none' }}
            placeholder="Ask about your restaurant data…"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            disabled={loading}
          />
          <button
            onClick={send}
            disabled={loading || !input.trim()}
            style={{ padding: '10px 20px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 600, cursor: 'pointer', opacity: loading || !input.trim() ? 0.5 : 1 }}>
            Send
          </button>
        </div>
      </div>
    </AppShell>
  )
}
