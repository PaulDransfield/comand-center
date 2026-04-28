'use client'
// components/admin/v2/CustomerNotes.tsx
// PR 10 — customer-detail Notes sub-tab. Threaded admin-only notes
// with pin / edit / soft-delete. FIXES.md §0ak.

import { useEffect, useMemo, useState } from 'react'
import { adminFetch } from '@/lib/admin/v2/api-client'

interface NoteRow {
  id:         string
  org_id:     string
  parent_id:  string | null
  body:       string
  created_by: string
  created_at: string
  updated_at: string
  pinned:     boolean
}

interface NotesResponse {
  notes:         NoteRow[]
  table_missing: boolean
  note?:         string
}

const MAX_BODY = 8_000

export function CustomerNotes({ orgId }: { orgId: string }) {
  const [notes,         setNotes]         = useState<NoteRow[]>([])
  const [tableMissing,  setTableMissing]  = useState<boolean>(false)
  const [missingHint,   setMissingHint]   = useState<string | null>(null)
  const [loading,       setLoading]       = useState<boolean>(true)
  const [error,         setError]         = useState<string | null>(null)
  const [composer,      setComposer]      = useState<string>('')
  const [posting,       setPosting]       = useState<boolean>(false)
  const [replyParentId, setReplyParentId] = useState<string | null>(null)
  const [replyBody,     setReplyBody]     = useState<string>('')
  const [editingId,     setEditingId]     = useState<string | null>(null)
  const [editBody,      setEditBody]      = useState<string>('')

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const r = await adminFetch<NotesResponse>(`/api/admin/v2/customers/${orgId}/notes`)
      setNotes(r.notes)
      setTableMissing(r.table_missing)
      setMissingHint(r.note ?? null)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load notes')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [orgId])

  const { roots, replies } = useMemo(() => {
    const r: NoteRow[] = []
    const m: Record<string, NoteRow[]> = {}
    for (const n of notes) {
      if (n.parent_id) {
        ;(m[n.parent_id] ||= []).push(n)
      } else {
        r.push(n)
      }
    }
    // Replies in oldest-first order so the conversation reads chronologically.
    for (const k of Object.keys(m)) {
      m[k].sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at))
    }
    return { roots: r, replies: m }
  }, [notes])

  async function postRoot() {
    const text = composer.trim()
    if (!text || posting) return
    setPosting(true)
    setError(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/notes`, {
        method: 'POST',
        body:   JSON.stringify({ body: text }),
      })
      setComposer('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to post')
    } finally {
      setPosting(false)
    }
  }

  async function postReply(parentId: string) {
    const text = replyBody.trim()
    if (!text) return
    setPosting(true)
    setError(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/notes`, {
        method: 'POST',
        body:   JSON.stringify({ body: text, parent_id: parentId }),
      })
      setReplyBody('')
      setReplyParentId(null)
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to reply')
    } finally {
      setPosting(false)
    }
  }

  async function saveEdit() {
    if (!editingId) return
    const text = editBody.trim()
    if (!text) return
    setPosting(true)
    setError(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/notes/${editingId}`, {
        method: 'POST',
        body:   JSON.stringify({ body: text }),
      })
      setEditingId(null)
      setEditBody('')
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save edit')
    } finally {
      setPosting(false)
    }
  }

  async function softDelete(noteId: string) {
    if (!confirm('Delete this note? It will be hidden from the list but retained for compliance.')) return
    setError(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/notes/${noteId}`, { method: 'DELETE' })
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to delete')
    }
  }

  async function togglePin(noteId: string, currentlyPinned: boolean) {
    setError(null)
    try {
      await adminFetch(`/api/admin/v2/customers/${orgId}/notes/${noteId}/pin`, {
        method: 'POST',
        body:   JSON.stringify({ pinned: !currentlyPinned }),
      })
      await load()
    } catch (e: any) {
      setError(e?.message ?? 'Failed to toggle pin')
    }
  }

  return (
    <div>
      {error && (
        <div style={bannerStyle('bad')}>
          {error}
        </div>
      )}
      {tableMissing && (
        <div style={bannerStyle('warn')}>
          {missingHint ?? 'admin_notes table missing — run M038.'}
        </div>
      )}

      {/* Composer */}
      <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 14 }}>
        <textarea
          value={composer}
          onChange={e => setComposer(e.target.value)}
          placeholder="Write a note about this customer… (admin-only, never visible to the customer)"
          rows={3}
          maxLength={MAX_BODY}
          style={textareaStyle}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{composer.length}/{MAX_BODY.toLocaleString()}</span>
          <button onClick={postRoot} disabled={posting || tableMissing || composer.trim().length === 0} style={btnPrimary(posting || tableMissing || composer.trim().length === 0)}>
            {posting ? 'Posting…' : 'Post note'}
          </button>
        </div>
      </div>

      {/* List */}
      {loading && notes.length === 0 && (
        <div style={emptyStyle}>Loading notes…</div>
      )}
      {!loading && !tableMissing && roots.length === 0 && (
        <div style={emptyStyle}>No notes yet. Write the first one above.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 10 }}>
        {roots.map(n => (
          <NoteCard
            key={n.id}
            note={n}
            replies={replies[n.id] ?? []}
            isEditing={editingId === n.id}
            isReplying={replyParentId === n.id}
            replyBody={replyBody}
            editBody={editBody}
            posting={posting}
            onStartEdit={() => { setEditingId(n.id); setEditBody(n.body); setReplyParentId(null) }}
            onCancelEdit={() => { setEditingId(null); setEditBody('') }}
            onSaveEdit={saveEdit}
            onChangeEdit={setEditBody}
            onStartReply={() => { setReplyParentId(n.id); setEditingId(null); setReplyBody('') }}
            onCancelReply={() => { setReplyParentId(null); setReplyBody('') }}
            onChangeReply={setReplyBody}
            onPostReply={() => postReply(n.id)}
            onPin={() => togglePin(n.id, n.pinned)}
            onDelete={() => softDelete(n.id)}
            onDeleteReply={(replyId) => softDelete(replyId)}
          />
        ))}
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   NoteCard
// ────────────────────────────────────────────────────────────────────

function NoteCard(props: {
  note:        NoteRow
  replies:     NoteRow[]
  isEditing:   boolean
  isReplying:  boolean
  editBody:    string
  replyBody:   string
  posting:     boolean
  onStartEdit:    () => void
  onCancelEdit:   () => void
  onSaveEdit:     () => void
  onChangeEdit:   (s: string) => void
  onStartReply:   () => void
  onCancelReply:  () => void
  onChangeReply:  (s: string) => void
  onPostReply:    () => void
  onPin:          () => void
  onDelete:       () => void
  onDeleteReply:  (replyId: string) => void
}) {
  const { note } = props
  return (
    <div style={{
      background: 'white',
      border: note.pinned ? '1px solid #fde68a' : '1px solid #e5e7eb',
      borderRadius: 10,
      padding: 12,
      boxShadow: note.pinned ? '0 0 0 3px #fffbeb' : 'none',
    }}>
      <div style={noteHeaderStyle}>
        <span style={{ fontSize: 11, color: '#6b7280' }}>
          <strong style={{ color: '#374151' }}>{note.created_by}</strong> · {fmtDateTime(note.created_at)}
          {note.updated_at !== note.created_at && <span style={{ color: '#9ca3af' }}> · edited {fmtDateTime(note.updated_at)}</span>}
          {note.pinned && <span style={{ marginLeft: 6, color: '#92400e', background: '#fef3c7', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 600 }}>PINNED</span>}
        </span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={props.onPin} style={btnGhost} title={note.pinned ? 'Unpin' : 'Pin'}>{note.pinned ? 'Unpin' : 'Pin'}</button>
          <button onClick={props.onStartEdit} style={btnGhost}>Edit</button>
          <button onClick={props.onStartReply} style={btnGhost}>Reply</button>
          <button onClick={props.onDelete} style={btnGhostDanger}>Delete</button>
        </div>
      </div>

      {props.isEditing ? (
        <div style={{ marginTop: 8 }}>
          <textarea value={props.editBody} onChange={e => props.onChangeEdit(e.target.value)} maxLength={MAX_BODY} rows={3} style={textareaStyle} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button onClick={props.onCancelEdit} style={btnSecondary(false)}>Cancel</button>
            <button onClick={props.onSaveEdit} disabled={props.posting || props.editBody.trim().length === 0} style={btnPrimary(props.posting || props.editBody.trim().length === 0)}>Save</button>
          </div>
        </div>
      ) : (
        <div style={bodyStyle}>{note.body}</div>
      )}

      {props.replies.length > 0 && (
        <div style={{ marginTop: 10, paddingLeft: 14, borderLeft: '2px solid #f3f4f6' }}>
          {props.replies.map(r => (
            <div key={r.id} style={{ paddingTop: 8, paddingBottom: 8 }}>
              <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                <span><strong style={{ color: '#374151' }}>{r.created_by}</strong> · {fmtDateTime(r.created_at)}</span>
                <button onClick={() => props.onDeleteReply(r.id)} style={btnGhostDanger}>Delete</button>
              </div>
              <div style={replyBodyStyle}>{r.body}</div>
            </div>
          ))}
        </div>
      )}

      {props.isReplying && (
        <div style={{ marginTop: 10, paddingLeft: 14, borderLeft: '2px solid #f3f4f6' }}>
          <textarea value={props.replyBody} onChange={e => props.onChangeReply(e.target.value)} placeholder="Reply…" rows={2} maxLength={MAX_BODY} style={textareaStyle} />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button onClick={props.onCancelReply} style={btnSecondary(false)}>Cancel</button>
            <button onClick={props.onPostReply} disabled={props.posting || props.replyBody.trim().length === 0} style={btnPrimary(props.posting || props.replyBody.trim().length === 0)}>Reply</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────
//   styles + helpers
// ────────────────────────────────────────────────────────────────────

function bannerStyle(tone: 'bad' | 'warn'): React.CSSProperties {
  const palette = tone === 'bad'
    ? { bg: '#fef2f2', border: '#fecaca', fg: '#991b1b' }
    : { bg: '#fffbeb', border: '#fde68a', fg: '#92400e' }
  return { background: palette.bg, border: `1px solid ${palette.border}`, color: palette.fg, borderRadius: 8, padding: '8px 12px', fontSize: 12, marginBottom: 12 }
}

const emptyStyle: React.CSSProperties = {
  background: 'white', border: '1px solid #e5e7eb', borderRadius: 10,
  padding: 30, textAlign: 'center' as const, color: '#9ca3af', fontSize: 13,
}

const textareaStyle: React.CSSProperties = {
  width: '100%', padding: 10, border: '1px solid #d1d5db', borderRadius: 7,
  fontSize: 13, fontFamily: 'inherit', color: '#111', resize: 'vertical' as const,
  boxSizing: 'border-box' as const, lineHeight: 1.5,
}

const bodyStyle: React.CSSProperties = {
  marginTop: 6, fontSize: 13, color: '#374151', lineHeight: 1.55, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
}

const replyBodyStyle: React.CSSProperties = {
  fontSize: 12, color: '#374151', lineHeight: 1.5, whiteSpace: 'pre-wrap' as const, wordBreak: 'break-word' as const,
}

const noteHeaderStyle: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
}

function btnPrimary(disabled: boolean): React.CSSProperties {
  return { padding: '6px 12px', background: disabled ? '#d1d5db' : '#111827', color: 'white', border: 'none', borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: disabled ? 'not-allowed' : 'pointer' }
}

function btnSecondary(disabled: boolean): React.CSSProperties {
  return { padding: '6px 12px', background: 'white', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 12, fontWeight: 500, color: '#374151', cursor: disabled ? 'not-allowed' : 'pointer' }
}

const btnGhost: React.CSSProperties = {
  padding: '4px 8px', background: 'transparent', border: 'none', fontSize: 11, fontWeight: 500, color: '#6b7280', cursor: 'pointer',
}

const btnGhostDanger: React.CSSProperties = {
  padding: '4px 8px', background: 'transparent', border: 'none', fontSize: 11, fontWeight: 500, color: '#b91c1c', cursor: 'pointer',
}

function fmtDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('sv-SE', { hour12: false }).replace('T', ' ')
  } catch { return iso }
}
