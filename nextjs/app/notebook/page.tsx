// @ts-nocheck
// app/notebook/page.tsx
//
// THE NOTEBOOK PAGE â€” the AI document intelligence interface.
// This is the NotebookLM-equivalent: upload sources, ask questions,
// get answers with citations, generate audio overviews.
//
// Architecture:
//   - Sources panel (left):  lists uploaded documents for the current notebook
//   - Chat panel (middle):   streaming AI chat grounded in those documents
//   - Studio panel (right):  pinned answers, audio overview, suggested questions

'use client'

import { useState, useRef, useEffect, useCallback } from 'react'


// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface Source {
  id:       string
  name:     string
  ext:      string
  size:     number
  chunks:   number
  pinned:   boolean
  doc_type: string
  summary:  string | null
}

interface Citation {
  docId:   string
  docName: string
  page:    number
  text:    string
  score:   number
}

interface Message {
  id:         string
  role:       'user' | 'assistant'
  content:    string
  citations?: Citation[]
  confidence?: number
  pinned:     boolean
}

// â”€â”€ Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export default function NotebookPage() {


  const [sources,      setSources]      = useState<Source[]>([])
  const [messages,     setMessages]     = useState<Message[]>([])
  const [input,        setInput]        = useState('')
  const [streaming,    setStreaming]     = useState(false)
  const [uploading,    setUploading]    = useState(false)
  const [citeSidebar,  setCiteSidebar]  = useState<Citation | null>(null)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const taRef      = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // â”€â”€ SEND MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return

    setInput('')
    if (taRef.current) taRef.current.style.height = 'auto'

    // Add user message immediately
    const userMsg: Message = {
      id:      `u_${Date.now()}`,
      role:    'user',
      content: text,
      pinned:  false,
    }
    setMessages(prev => [...prev, userMsg])
    setStreaming(true)

    // Create empty assistant message that we'll fill as tokens stream in
    const aiMsgId = `a_${Date.now()}`
    setMessages(prev => [...prev, {
      id:      aiMsgId,
      role:    'assistant',
      content: '',
      pinned:  false,
    }])

    try {
      // Get auth token from Supabase
      const { createClient } = await import('@/lib/supabase/client')
      const supabase = createClient()
      const { data: { session } } = await supabase.auth.getSession()
      const token = session?.access_token

      // Build context from pinned/selected sources
      const context = sources
        .filter(s => s.pinned)
        .map(s => `[Document: ${s.name}]\n${s.summary ?? '(no summary)'}`)
        .join('\n\n')

      // POST to our streaming chat endpoint
      const res = await fetch('/api/chat', {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          messages: [
            // Include last 10 messages for conversation context
            ...messages.slice(-10).map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: text },
          ],
          context: context || undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Request failed' }))
        throw new Error(err.error || `HTTP ${res.status}`)
      }

      // Read the SSE stream
      const reader  = res.body!.getReader()
      const decoder = new TextDecoder()
      let   buffer  = ''
      let   fullText = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE events are separated by double newlines
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))

            if (event.type === 'delta') {
              // Append each token to the message as it arrives
              fullText += event.text
              setMessages(prev => prev.map(m =>
                m.id === aiMsgId ? { ...m, content: fullText } : m
              ))
            }

            if (event.type === 'error') {
              throw new Error(event.message)
            }
          } catch (e) {
            if (e instanceof SyntaxError) continue  // incomplete JSON fragment
            throw e
          }
        }
      }

    } catch (err) {
      // Replace the empty AI message with an error
      setMessages(prev => prev.map(m =>
        m.id === aiMsgId
          ? { ...m, content: `Sorry, something went wrong: ${(err as Error).message}` }
          : m
      ))
    } finally {
      setStreaming(false)
    }
  }, [input, streaming, messages, sources])

  // â”€â”€ UPLOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async function handleUpload(files: FileList | null) {
    if (!files?.length) return
    setUploading(true)

    // Real upload pipeline: Storage â†’ text extraction â†’ chunking â†’ TF-IDF index
    const uploaded: Source[] = []

    for (const file of Array.from(files)) {
      try {
        const form = new FormData()
        form.append('file', file)

        const res  = await fetch('/api/documents/upload', { method: 'POST', body: form })

        if (res.ok) {
          const data = await res.json()
          uploaded.push({
            id:       data.id,
            name:     data.name,
            ext:      data.ext,
            size:     data.size,
            chunks:   data.chunks,
            pinned:   true,
            doc_type: data.doc_type,
            summary:  data.summary ?? null,
          })
        } else {
          // Fallback: add locally so user sees file, but no AI grounding
          uploaded.push({
            id:       `local_${Date.now()}`,
            name:     file.name,
            ext:      file.name.split('.').pop()?.toLowerCase() ?? 'file',
            size:     file.size,
            chunks:   0,
            pinned:   true,
            doc_type: guessDocType(file.name),
            summary:  null,
          })
        }
      } catch (err) {
        console.error('Upload error:', err)
      }
    }

    setSources(prev => [...prev, ...uploaded])
    setUploading(false)
  }

  function guessDocType(name: string): string {
    const n = name.toLowerCase()
    if (/resultat|p.l|income/.test(n))    return 'p_and_l'
    if (/faktura|invoice/.test(n))         return 'invoice'
    if (/bank|kontoutdrag/.test(n))        return 'bank_statement'
    if (/budget|prognos/.test(n))          return 'budget'
    if (/avtal|kontrakt|contract/.test(n)) return 'contract'
    return 'other'
  }

  function togglePin(id: string) {
    setSources(prev => prev.map(s => s.id === id ? { ...s, pinned: !s.pinned } : s))
  }

  function removeSource(id: string) {
    setSources(prev => prev.filter(s => s.id !== id))
  }

  function pinMessage(id: string) {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, pinned: !m.pinned } : m))
  }

  function autoResize(e: React.ChangeEvent<HTMLTextAreaElement>) {
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
  }

  // â”€â”€ RENDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  return (
    <div style={S.shell}>

      {/* â”€â”€ LEFT: SOURCES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div style={S.sourcesPanel}>
        <div style={S.panelHeader}>
          <span style={S.panelTitle}>Sources</span>
          <span style={{ fontSize: 10, color: 'var(--ink-4)', fontFamily: 'var(--mono)' }}>
            {sources.length} doc{sources.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Upload zone */}
        <label style={S.uploadZone}>
          <input
            type="file"
            multiple
            accept=".pdf,.docx,.xlsx,.csv,.txt,.md"
            style={{ display: 'none' }}
            onChange={e => handleUpload(e.target.files)}
          />
          <span style={{ fontSize: 20 }}>{uploading ? 'âŸ³' : '+'}</span>
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink-3)', marginTop: 2 }}>
            {uploading ? 'Indexingâ€¦' : 'Add sources'}
          </span>
          <span style={{ fontSize: 10, color: 'var(--ink-4)' }}>PDF Â· DOCX Â· XLSX Â· CSV</span>
        </label>

        {/* Source list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {sources.length === 0 && (
            <div style={{ padding: '16px 12px', fontSize: 11, color: 'var(--ink-4)', textAlign: 'center' }}>
              Upload documents above to get started
            </div>
          )}
          {sources.map(src => (
            <SourceItem
              key={src.id}
              src={src}
              onTogglePin={() => togglePin(src.id)}
              onRemove={() => removeSource(src.id)}
            />
          ))}
        </div>
      </div>

      {/* â”€â”€ MIDDLE: CHAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div style={S.chatPanel}>

        {/* Chat messages */}
        <div style={S.chatMsgs}>
          {messages.length === 0 && (
            <div style={S.emptyState}>
              <div style={{ fontSize: 40, opacity: .25, marginBottom: 8 }}>ðŸ“š</div>
              <p style={{ fontFamily: 'var(--display)', fontSize: 18, fontStyle: 'italic', color: 'var(--ink-2)' }}>
                Ask about your sources
              </p>
              <p style={{ fontSize: 12, color: 'var(--ink-4)', maxWidth: 300, textAlign: 'center', lineHeight: 1.6 }}>
                Upload documents on the left. Every answer will be grounded in your sources with confidence scores.
              </p>
              {/* Suggested questions */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 16, justifyContent: 'center' }}>
                {[
                  'What is our current profit margin?',
                  'Which cost is furthest from target?',
                  'Summarise all uploaded sources',
                  'Are there any invoices due soon?',
                ].map(q => (
                  <button
                    key={q}
                    style={S.suggPill}
                    onClick={() => { setInput(q); taRef.current?.focus() }}
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} style={msg.role === 'user' ? S.userMsgWrap : S.aiMsgWrap}>
              {msg.role === 'user' ? (
                <div style={S.userBubble}>{msg.content}</div>
              ) : (
                <div style={{ maxWidth: '80%' }}>
                  <div style={S.aiBubble}>
                    {/* Streaming cursor while response is incomplete */}
                    {msg.content || (streaming && <span style={S.cursor} />)}
                    {streaming && !msg.content && <span style={S.cursor} />}
                    {msg.content}
                    {streaming && messages[messages.length - 1]?.id === msg.id && msg.content && (
                      <span style={S.cursor} />
                    )}
                  </div>
                  {/* Citations row */}
                  {msg.citations?.map((c, i) => (
                    <button
                      key={i}
                      style={S.citeChip}
                      onClick={() => setCiteSidebar(c)}
                    >
                      <span style={S.citeNum}>{i + 1}</span>
                      {c.docName.split('.')[0].slice(0, 24)}, p.{c.page}
                    </button>
                  ))}
                  {/* Pin + copy actions */}
                  {!streaming && msg.content && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
                      <button
                        style={{ ...S.metaBtn, ...(msg.pinned ? { color: 'var(--amber)' } : {}) }}
                        onClick={() => pinMessage(msg.id)}
                      >
                        ðŸ“Œ {msg.pinned ? 'Pinned' : 'Pin'}
                      </button>
                      <button
                        style={S.metaBtn}
                        onClick={() => navigator.clipboard?.writeText(msg.content)}
                      >
                        âŽ˜ Copy
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Chat input */}
        <div style={S.inputArea}>
          <div style={S.inputWrap}>
            <textarea
              ref={taRef}
              style={S.textarea}
              rows={1}
              placeholder={
                sources.length === 0
                  ? 'Upload sources firstâ€¦'
                  : 'Ask anything about your sourcesâ€¦'
              }
              value={input}
              onChange={e => { setInput(e.target.value); autoResize(e) }}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
              }}
            />
            <button
              style={{ ...S.sendBtn, ...(streaming || !input.trim() ? { opacity: .4 } : {}) }}
              disabled={streaming || !input.trim()}
              onClick={sendMessage}
            >
              {streaming ? <span className="spin">âŸ³</span> : 'â†’'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 5 }}>
            {sources.filter(s => s.pinned).length} source{sources.filter(s => s.pinned).length !== 1 ? 's' : ''} active Â·{' '}
            Answers grounded in your documents Â· Enter to send
          </div>
        </div>
      </div>

      {/* â”€â”€ RIGHT: STUDIO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div style={S.studioPanel}>
        <div style={S.panelHeader}>
          <span style={S.panelTitle}>Studio</span>
        </div>

        <div style={{ padding: '10px', overflowY: 'auto', flex: 1 }}>

          {/* Pinned answers */}
          <div style={S.studioSection}>
            <div style={S.studioLabel}>ðŸ“Œ Pinned Answers</div>
            {messages.filter(m => m.pinned && m.role === 'assistant').length === 0 ? (
              <p style={S.studioEmpty}>Click ðŸ“Œ on any answer to pin it here.</p>
            ) : (
              messages.filter(m => m.pinned && m.role === 'assistant').map(m => (
                <div key={m.id} style={S.pinnedItem}>
                  {m.content.slice(0, 180)}{m.content.length > 180 ? 'â€¦' : ''}
                </div>
              ))
            )}
          </div>

          {/* Suggested questions */}
          <div style={S.studioSection}>
            <div style={S.studioLabel}>ðŸ’¡ Suggested Questions</div>
            {sources.length === 0 ? (
              <p style={S.studioEmpty}>Upload sources to see suggestions.</p>
            ) : (
              [
                'What is our profit margin this month?',
                'Which costs are above target?',
                'Summarise key findings across all documents',
                'Are there any payment due dates coming up?',
                'Compare this month to last month',
              ].map(q => (
                <button
                  key={q}
                  style={S.sqItem}
                  onClick={() => { setInput(q); taRef.current?.focus() }}
                >
                  {q} <span style={{ marginLeft: 'auto', color: 'var(--ink-4)', flexShrink: 0 }}>â†’</span>
                </button>
              ))
            )}
          </div>

        </div>
      </div>

      {/* â”€â”€ CITATION SIDEBAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      {citeSidebar && (
        <>
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 199 }}
            onClick={() => setCiteSidebar(null)}
          />
          <div style={S.citeSidebar}>
            <div style={S.citeHeader}>
              <span style={{ fontFamily: 'var(--display)', fontSize: 14, color: 'var(--navy)' }}>
                {citeSidebar.docName}
              </span>
              <button
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--ink-4)' }}
                onClick={() => setCiteSidebar(null)}
              >Ã—</button>
            </div>
            <div style={{ padding: '14px' }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: 'var(--ink-4)', marginBottom: 8, fontFamily: 'var(--mono)' }}>
                Page {citeSidebar.page} Â· {citeSidebar.score}% relevance
              </div>
              <div style={{ fontStyle: 'italic', fontSize: 13, lineHeight: 1.75, color: 'var(--ink)', background: 'var(--parchment)', borderLeft: '3px solid var(--blue)', borderRadius: 8, padding: '11px 13px' }}>
                {citeSidebar.text}
              </div>
            </div>
          </div>
        </>
      )}

    </div>
  )
}

// â”€â”€ SOURCE ITEM COMPONENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function SourceItem({ src, onTogglePin, onRemove }: {
  src:          Source
  onTogglePin:  () => void
  onRemove:     () => void
}) {
  const EXT_COLOUR: Record<string, string> = {
    pdf:  '#B71C1C', xlsx: '#1B5E20', xls: '#1B5E20',
    docx: '#0D47A1', csv:  '#00695C', txt: '#4A148C',
  }
  const colour = EXT_COLOUR[src.ext] ?? '#4A4844'

  return (
    <div style={{ ...S.srcItem, ...(src.pinned ? { borderLeft: '2.5px solid var(--blue)' } : {}) }}>
      <div style={{ ...S.srcIcon, background: colour + '18', color: colour }}>
        {src.ext.toUpperCase().slice(0, 3)}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {src.name}
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-4)', marginTop: 2, fontFamily: 'var(--mono)' }}>
          {src.chunks} chunks Â· {Math.round(src.size / 1024)}KB
        </div>
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        <button style={S.srcBtn} onClick={onTogglePin} title={src.pinned ? 'Unpin' : 'Pin'}>
          {src.pinned ? 'ðŸ“Œ' : 'â—‹'}
        </button>
        <button style={S.srcBtn} onClick={onRemove} title="Remove">Ã—</button>
      </div>
    </div>
  )
}

// â”€â”€ Styles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const S: Record<string, React.CSSProperties> = {
  shell: {
    display:  'grid',
    gridTemplateColumns: '260px 1fr 272px',
    height:   '100%',
    overflow: 'hidden',
  },
  sourcesPanel: {
    borderRight:   '1px solid var(--border)',
    display:       'flex',
    flexDirection: 'column',
    background:    'var(--off-white)',
    overflow:      'hidden',
  },
  chatPanel: {
    display:       'flex',
    flexDirection: 'column',
    background:    'var(--parchment)',
    overflow:      'hidden',
  },
  studioPanel: {
    borderLeft:    '1px solid var(--border)',
    display:       'flex',
    flexDirection: 'column',
    background:    'var(--off-white)',
    overflow:      'hidden',
  },
  panelHeader: {
    height:        '44px',
    borderBottom:  '1px solid var(--border)',
    display:       'flex',
    alignItems:    'center',
    padding:       '0 14px',
    gap:           '8px',
    flexShrink:    0,
    background:    'var(--white)',
  },
  panelTitle: {
    fontSize:  12,
    fontWeight: 600,
    color:     'var(--ink-2)',
    flex:      1,
    letterSpacing: '.01em',
  },
  uploadZone: {
    margin:        '10px',
    border:        '1.5px dashed var(--border-d)',
    borderRadius:  '9px',
    padding:       '12px',
    textAlign:     'center' as const,
    cursor:        'pointer',
    display:       'flex',
    flexDirection: 'column' as const,
    alignItems:    'center',
    gap:           '2px',
    transition:    'all .14s',
  },
  srcItem: {
    padding:       '8px 12px',
    display:       'flex',
    alignItems:    'flex-start',
    gap:           '8px',
    borderLeft:    '2.5px solid transparent',
    transition:    'background .08s',
    cursor:        'default',
  },
  srcIcon: {
    width:        '28px',
    height:       '28px',
    borderRadius: '6px',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'center',
    fontSize:     '10px',
    fontWeight:   700,
    fontFamily:   'var(--mono)',
    flexShrink:   0,
  },
  srcBtn: {
    width:          '22px',
    height:         '22px',
    borderRadius:   '5px',
    border:         'none',
    background:     'none',
    cursor:         'pointer',
    fontSize:       '12px',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    color:          'var(--ink-4)',
  },
  chatMsgs: {
    flex:      1,
    overflowY: 'auto',
    padding:   '16px',
    display:   'flex',
    flexDirection: 'column',
    gap:       '12px',
  },
  emptyState: {
    flex:           1,
    display:        'flex',
    flexDirection:  'column',
    alignItems:     'center',
    justifyContent: 'center',
    textAlign:      'center' as const,
    padding:        '32px',
    gap:            '6px',
    marginTop:      '10vh',
  },
  suggPill: {
    padding:      '6px 12px',
    border:       '1px solid var(--border-d)',
    borderRadius: '16px',
    background:   'var(--white)',
    fontSize:     '11px',
    fontWeight:   500,
    color:        'var(--ink-2)',
    cursor:       'pointer',
    fontFamily:   'var(--font)',
  },
  userMsgWrap: {
    display:        'flex',
    justifyContent: 'flex-end',
  },
  userBubble: {
    background:   'var(--navy)',
    color:        'white',
    borderRadius: '16px 16px 3px 16px',
    padding:      '9px 14px',
    maxWidth:     '75%',
    fontSize:     '13px',
    lineHeight:   '1.6',
  },
  aiMsgWrap: {
    display:    'flex',
    gap:        '9px',
    alignItems: 'flex-start',
  },
  aiBubble: {
    background:   'var(--white)',
    border:       '1px solid var(--border)',
    borderRadius: '3px 14px 14px 14px',
    padding:      '11px 14px',
    fontSize:     '13px',
    lineHeight:   '1.7',
    color:        'var(--ink)',
    minHeight:    '44px',
    whiteSpace:   'pre-wrap' as const,
  },
  cursor: {
    display:        'inline-block',
    width:          '2px',
    height:         '13px',
    background:     'var(--blue)',
    marginLeft:     '1px',
    verticalAlign:  'middle',
    animation:      'blink .7s step-end infinite',
  },
  citeChip: {
    display:        'inline-flex',
    alignItems:     'center',
    gap:            '4px',
    background:     'var(--blue-lt)',
    border:         '1px solid var(--blue-mid)',
    color:          'var(--blue)',
    fontSize:       '10px',
    fontWeight:     600,
    padding:        '3px 8px',
    borderRadius:   '10px',
    cursor:         'pointer',
    marginRight:    '4px',
    marginTop:      '6px',
    fontFamily:     'var(--font)',
  },
  citeNum: {
    width:          '13px',
    height:         '13px',
    background:     'var(--blue)',
    color:          'white',
    borderRadius:   '50%',
    fontSize:       '8px',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    flexShrink:     0,
  },
  metaBtn: {
    fontSize:     '10px',
    color:        'var(--ink-4)',
    cursor:       'pointer',
    background:   'none',
    border:       'none',
    fontFamily:   'var(--font)',
    padding:      '2px 6px',
    borderRadius: '5px',
  },
  inputArea: {
    padding:     '10px 14px',
    borderTop:   '1px solid var(--border)',
    flexShrink:  0,
    background:  'var(--white)',
  },
  inputWrap: {
    display:      'flex',
    alignItems:   'flex-end',
    gap:          '8px',
    border:       '1.5px solid var(--border-d)',
    borderRadius: '11px',
    padding:      '8px 10px',
    background:   'var(--parchment)',
  },
  textarea: {
    flex:       1,
    border:     'none',
    background: 'none',
    fontFamily: 'var(--font)',
    fontSize:   '13px',
    color:      'var(--ink)',
    resize:     'none' as const,
    outline:    'none',
    maxHeight:  '120px',
    minHeight:  '21px',
    lineHeight: '1.5',
  },
  sendBtn: {
    width:          '32px',
    height:         '32px',
    borderRadius:   '8px',
    background:     'var(--navy)',
    border:         'none',
    cursor:         'pointer',
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'center',
    fontSize:       '15px',
    color:          'white',
    flexShrink:     0,
    transition:     'opacity .12s',
  },
  studioSection: {
    marginBottom: '16px',
  },
  studioLabel: {
    fontSize:      '11px',
    fontWeight:    700,
    color:         'var(--ink-3)',
    marginBottom:  '7px',
  },
  studioEmpty: {
    fontSize:    '11px',
    color:       'var(--ink-4)',
    fontStyle:   'italic',
  },
  pinnedItem: {
    background:   'var(--parchment)',
    border:       '1px solid var(--border)',
    borderRadius: '8px',
    padding:      '9px 11px',
    fontSize:     '11px',
    lineHeight:   '1.6',
    color:        'var(--ink-2)',
    marginBottom: '6px',
  },
  sqItem: {
    background:   'var(--parchment)',
    border:       '1px solid var(--border)',
    borderRadius: '8px',
    padding:      '8px 11px',
    fontSize:     '11px',
    color:        'var(--ink-2)',
    cursor:       'pointer',
    width:        '100%',
    textAlign:    'left' as const,
    fontFamily:   'var(--font)',
    display:      'flex',
    alignItems:   'center',
    gap:          '6px',
    marginBottom: '5px',
    transition:   'all .1s',
  },
  citeSidebar: {
    position:     'fixed',
    right:        0,
    top:          'var(--nav-h)',
    bottom:       0,
    width:        '320px',
    background:   'var(--white)',
    borderLeft:   '1px solid var(--border-d)',
    boxShadow:    '-6px 0 24px rgba(0,0,0,.08)',
    zIndex:       200,
    display:      'flex',
    flexDirection:'column',
  },
  citeHeader: {
    padding:      '12px 14px',
    borderBottom: '1px solid var(--border)',
    display:      'flex',
    alignItems:   'center',
    justifyContent: 'space-between',
  },
}
