// app/api/admin/v2/customers/[orgId]/notes/route.ts
//
// Customer-detail Notes sub-tab. List + create.
//
// Notes used to live as `note_add` rows on admin_audit_log.payload.body
// — that made editing, deleting, threading, and pinning impossible.
// PR 10 promotes them to `admin_notes` (M038). Every mutation still
// lands in admin_audit_log for forensics; the source-of-truth row
// is in admin_notes.
//
// Soft-delete: deleted_at is filtered out at the SELECT level, so a
// deleted note vanishes from the UI but the row stays for compliance.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

const MAX_BODY_LENGTH = 8_000     // a comfortable essay; rejects accidental dumps.

const isMissingTable = (err: any) => {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
}

export async function GET(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  const db = createAdminClient()

  const { data: rows, error } = await db
    .from('admin_notes')
    .select('id, org_id, parent_id, body, created_by, created_at, updated_at, pinned')
    .eq('org_id', orgId)
    .is('deleted_at', null)
    .order('pinned',     { ascending: false })
    .order('created_at', { ascending: false })
    .limit(500)

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        notes: [], table_missing: true,
        note: 'admin_notes table missing — run M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql in Supabase SQL Editor.',
      }, { headers: { 'Cache-Control': 'no-store' } })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  return NextResponse.json({
    notes: rows ?? [], table_missing: false,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest, { params }: { params: { orgId: string } }) {
  const { orgId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }) }

  const text     = typeof body?.body === 'string' ? body.body.trim() : ''
  const parentId = typeof body?.parent_id === 'string' ? body.parent_id : null

  if (!text) return NextResponse.json({ error: 'body is required' }, { status: 400 })
  if (text.length > MAX_BODY_LENGTH) {
    return NextResponse.json({ error: `body exceeds ${MAX_BODY_LENGTH} characters` }, { status: 400 })
  }

  const db = createAdminClient()

  // If parent_id supplied, verify it belongs to this org (defence in depth
  // against thread-injection across customers).
  if (parentId) {
    const { data: parent, error: pErr } = await db
      .from('admin_notes')
      .select('id, org_id')
      .eq('id', parentId)
      .maybeSingle()
    if (pErr) return NextResponse.json({ error: pErr.message }, { status: 500 })
    if (!parent || parent.org_id !== orgId) {
      return NextResponse.json({ error: 'parent note not found in this org' }, { status: 400 })
    }
  }

  const { data: row, error } = await db
    .from('admin_notes')
    .insert({ org_id: orgId, parent_id: parentId, body: text })
    .select('id, org_id, parent_id, body, created_by, created_at, updated_at, pinned')
    .single()

  if (error) {
    if (isMissingTable(error)) {
      return NextResponse.json({
        error: 'admin_notes table missing — run M038-ADMIN-NOTES-AND-SAVED-QUERIES.sql.',
        kind:  'table_missing',
      }, { status: 503 })
    }
    return NextResponse.json({ error: error.message, code: error.code ?? null }, { status: 500 })
  }

  await recordAdminAction(db as any, {
    action:     ADMIN_ACTIONS.NOTE_ADD,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    { surface: 'admin_v2', note_id: row.id, parent_id: parentId, chars: text.length },
    req,
  })

  return NextResponse.json({ note: row }, { status: 201 })
}
