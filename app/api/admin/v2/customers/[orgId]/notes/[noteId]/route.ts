// app/api/admin/v2/customers/[orgId]/notes/[noteId]/route.ts
//
// Edit (POST) + soft-delete (DELETE) a single note.
// Both verify the note belongs to the claimed org before mutating.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const MAX_BODY_LENGTH = 8_000

async function loadAndScope(db: any, orgId: string, noteId: string) {
  const { data, error } = await db
    .from('admin_notes')
    .select('id, org_id, body, pinned, deleted_at')
    .eq('id', noteId)
    .maybeSingle()
  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) }
  if (!data || data.org_id !== orgId) {
    return { error: NextResponse.json({ error: 'note not found in this org' }, { status: 404 }) }
  }
  if (data.deleted_at) {
    return { error: NextResponse.json({ error: 'note is deleted' }, { status: 410 }) }
  }
  return { row: data }
}

export async function POST(req: NextRequest, { params }: { params: { orgId: string; noteId: string } }) {
  const { orgId, noteId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const text = typeof body?.body === 'string' ? body.body.trim() : ''
  if (!text)                           return NextResponse.json({ error: 'body is required' }, { status: 400 })
  if (text.length > MAX_BODY_LENGTH)   return NextResponse.json({ error: `body exceeds ${MAX_BODY_LENGTH} characters` }, { status: 400 })

  const db = createAdminClient()
  const scoped = await loadAndScope(db, orgId, noteId)
  if (scoped.error) return scoped.error

  const { data: updated, error } = await db
    .from('admin_notes')
    .update({ body: text, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .select('id, org_id, parent_id, body, created_by, created_at, updated_at, pinned')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db as any, {
    action:     ADMIN_ACTIONS.NOTE_EDIT,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    { surface: 'admin_v2', note_id: noteId, prev_chars: scoped.row.body.length, new_chars: text.length },
    req,
  })

  return NextResponse.json({ note: updated })
}

export async function DELETE(req: NextRequest, { params }: { params: { orgId: string; noteId: string } }) {
  const { orgId, noteId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()
  const scoped = await loadAndScope(db, orgId, noteId)
  if (scoped.error) return scoped.error

  const { error } = await db
    .from('admin_notes')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', noteId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db as any, {
    action:     ADMIN_ACTIONS.NOTE_DELETE,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    { surface: 'admin_v2', note_id: noteId, prev_chars: scoped.row.body.length },
    req,
  })

  return NextResponse.json({ ok: true })
}
