// app/api/admin/v2/customers/[orgId]/notes/[noteId]/pin/route.ts
//
// Toggle the pinned flag on a note. Body { pinned: boolean } is
// optional — if omitted, server flips the current value.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'
import { recordAdminAction, ADMIN_ACTIONS } from '@/lib/admin/audit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest, { params }: { params: { orgId: string; noteId: string } }) {
  const { orgId, noteId } = params
  const guard = await requireAdmin(req, { orgId })
  if ('ok' in guard === false) return guard as NextResponse

  let body: any = {}
  try { body = await req.json() } catch {}

  const db = createAdminClient()

  const { data: existing, error: loadErr } = await db
    .from('admin_notes')
    .select('id, org_id, pinned, deleted_at')
    .eq('id', noteId)
    .maybeSingle()
  if (loadErr)                              return NextResponse.json({ error: loadErr.message }, { status: 500 })
  if (!existing || existing.org_id !== orgId) return NextResponse.json({ error: 'note not found in this org' }, { status: 404 })
  if (existing.deleted_at)                  return NextResponse.json({ error: 'note is deleted' }, { status: 410 })

  const next = typeof body?.pinned === 'boolean' ? body.pinned : !existing.pinned

  const { data: updated, error } = await db
    .from('admin_notes')
    .update({ pinned: next, updated_at: new Date().toISOString() })
    .eq('id', noteId)
    .select('id, org_id, parent_id, body, created_by, created_at, updated_at, pinned')
    .single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  await recordAdminAction(db as any, {
    action:     ADMIN_ACTIONS.NOTE_PIN,
    orgId,
    targetType: 'org',
    targetId:   orgId,
    payload:    { surface: 'admin_v2', note_id: noteId, was_pinned: existing.pinned, now_pinned: next },
    req,
  })

  return NextResponse.json({ note: updated })
}
