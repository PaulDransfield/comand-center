'use client'
// components/ContactSupport.tsx
//
// Drop-in "Contact us" button + modal. A reliable in-app alternative to
// mailto: links (which silently fail for webmail users). Posts to
// /api/support, which emails the right inbox (support@ / security@ /
// billing@) with the user's identity + context auto-attached and logs a
// support_tickets row.
//
// Usage: <ContactSupport /> or <ContactSupport defaultCategory="security"
//        label="Report a security issue" />

import { useEffect, useState } from 'react'
import { UXP } from '@/lib/constants/tokens'

type Category = 'support' | 'security' | 'billing'

const CATEGORIES: { value: Category; label: string; hint: string }[] = [
  { value: 'support',  label: 'Support',  hint: 'A question or problem with the app.' },
  { value: 'security', label: 'Security', hint: 'Report a security or privacy concern.' },
  { value: 'billing',  label: 'Billing',  hint: 'Invoices, plan, or payment questions.' },
]

export default function ContactSupport({
  defaultCategory = 'support',
  label = 'Contact support',
  style,
  open,
  onClose,
}: {
  defaultCategory?: Category
  label?: string
  style?: React.CSSProperties
  /** Controlled mode: when `open` is provided the component renders NO trigger
   *  button and is driven by the parent (e.g. a menu item). Omit for the
   *  self-contained button + modal. */
  open?: boolean
  onClose?: () => void
}) {
  const isControlled = open !== undefined
  const [internalOpen, setInternalOpen] = useState(false)
  const isOpen = isControlled ? !!open : internalOpen
  const [category, setCategory] = useState<Category>(defaultCategory)
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy]       = useState(false)
  const [done, setDone]       = useState(false)
  const [error, setError]     = useState<string | null>(null)

  function close() { if (isControlled) onClose?.(); else setInternalOpen(false) }

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
    if (isOpen) document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  function reset() {
    setCategory(defaultCategory); setSubject(''); setMessage('')
    setBusy(false); setDone(false); setError(null)
  }

  // Reset the form whenever it (re)opens — covers controlled opens from a menu.
  useEffect(() => { if (isOpen) reset() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  async function submit() {
    if (!message.trim() || busy) return
    setBusy(true); setError(null)
    try {
      const businessId = (() => { try { return localStorage.getItem('cc_selected_biz') } catch { return null } })()
      const page = typeof window !== 'undefined' ? window.location.pathname : null
      const r = await fetch('/api/support', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, subject: subject.trim() || null, message: message.trim(), business_id: businessId, page }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) { setError(j.error ?? `Something went wrong (${r.status})`); return }
      setDone(true)
    } catch (e: any) {
      setError(e?.message ?? 'Network error')
    } finally { setBusy(false) }
  }

  const inp: React.CSSProperties = {
    width: '100%', padding: '9px 12px', border: `1px solid ${UXP.border}`, borderRadius: 8,
    fontSize: 13, boxSizing: 'border-box', fontFamily: 'inherit', background: '#fff', color: UXP.ink1,
  }
  const lbl: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 600, color: UXP.ink2, margin: '12px 0 5px' }

  return (
    <>
      {!isControlled && (
        <button
          type="button"
          onClick={() => setInternalOpen(true)}
          style={style ?? {
            padding: '9px 16px', background: UXP.lavDeep, color: '#fff', border: 'none',
            borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
          }}>
          {label}
        </button>
      )}

      {isOpen && (
        <div onClick={close} style={{
          position: 'fixed', inset: 0, background: 'rgba(20,18,40,0.5)', zIndex: 200,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <div onClick={e => e.stopPropagation()} style={{
            background: '#fff', borderRadius: 14, width: 480, maxWidth: '94vw', maxHeight: '90vh',
            overflowY: 'auto', padding: 24, border: `1px solid ${UXP.border}`,
            boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
          }}>
            {done ? (
              <div style={{ textAlign: 'center', padding: '12px 0' }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: UXP.ink1, marginBottom: 6 }}>Message sent</div>
                <div style={{ fontSize: 13, color: UXP.ink3, lineHeight: 1.6, marginBottom: 18 }}>
                  Thanks — we've got it and sent a confirmation to your email. We'll reply there.
                </div>
                <button onClick={close} style={{ padding: '9px 18px', background: UXP.ink1, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>Close</button>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 700, color: UXP.ink1, marginBottom: 2 }}>Contact us</div>
                <div style={{ fontSize: 12, color: UXP.ink3, marginBottom: 8 }}>
                  We'll reply to your account email. Your business + current page are attached automatically.
                </div>

                <label style={lbl}>Topic</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' as const }}>
                  {CATEGORIES.map(c => (
                    <button key={c.value} type="button" onClick={() => setCategory(c.value)}
                      style={{
                        padding: '6px 12px', fontSize: 12, fontWeight: 500, borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                        background: category === c.value ? UXP.lavFill : 'transparent',
                        color:      category === c.value ? UXP.lavText : UXP.ink2,
                        border:     `0.5px solid ${category === c.value ? UXP.lav : UXP.border}`,
                      }}>
                      {c.label}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 5 }}>{CATEGORIES.find(c => c.value === category)?.hint}</div>

                <label style={lbl}>Subject (optional)</label>
                <input value={subject} onChange={e => setSubject(e.target.value)} maxLength={200}
                  placeholder="Short summary" style={inp} />

                <label style={lbl}>Message</label>
                <textarea value={message} onChange={e => setMessage(e.target.value)} maxLength={5000}
                  placeholder={category === 'security' ? 'Describe the security concern. Avoid sharing secrets here — we can arrange a secure channel.' : 'How can we help?'}
                  rows={6} style={{ ...inp, resize: 'vertical' as const, minHeight: 120 }} />

                {error && (
                  <div style={{ marginTop: 10, fontSize: 12, color: UXP.roseText, background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`, borderRadius: 8, padding: '8px 12px' }}>{error}</div>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                  <button type="button" onClick={close} disabled={busy}
                    style={{ padding: '9px 16px', background: 'transparent', color: UXP.ink2, border: `0.5px solid ${UXP.border}`, borderRadius: 8, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>
                  <button type="button" onClick={submit} disabled={busy || !message.trim()}
                    style={{ padding: '9px 18px', background: UXP.lavDeep, color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: busy || !message.trim() ? 'not-allowed' : 'pointer', opacity: busy || !message.trim() ? 0.5 : 1, fontFamily: 'inherit' }}>
                    {busy ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
