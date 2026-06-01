// app/api/inventory/prep-sessions/[id]/lines/[lineId]/toggle/route.ts
//
// POST — flip a line between checked and unchecked. Idempotent in the
// sense that re-toggling restores the previous state; the body's
// `checked` field optionally pins the target state so concurrent
// devices don't race into surprising states.
//
// Body: { checked?: boolean }  (default = invert current)
// 200 { line }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface Body { checked?: boolean }

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string; lineId: string } },
) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: Body = {}
  try { body = await req.json() } catch { /* missing body is fine — fall back to invert */ }

  const db = createAdminClient()

  // Verify the line belongs to the session AND the session belongs to a
  // business the caller can access. One query — pull the parent through
  // the FK so we don't have to make two round-trips.
  const { data: line, error } = await db
    .from('prep_session_lines')
    .select('id, session_id, checked_at, prep_sessions(business_id, completed_at)')
    .eq('id', params.lineId)
    .eq('session_id', params.id)
    .maybeSingle()
  if (error)  return NextResponse.json({ error: error.message }, { status: 500 })
  if (!line)  return NextResponse.json({ error: 'Line not found' }, { status: 404 })

  const parent = (line as any).prep_sessions
  if (!parent)   return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, parent.business_id)
  if (forbidden) return forbidden
  if (parent.completed_at) {
    return NextResponse.json({ error: 'Session is completed — lines are read-only' }, { status: 409 })
  }

  // Resolve target state. Explicit > invert.
  const targetChecked =
    typeof body.checked === 'boolean' ? body.checked
                                      : line.checked_at == null
  const now = new Date().toISOString()

  const patch = targetChecked
    ? { checked_at: now, checked_by: (auth as any).userId ?? null }
    : { checked_at: null, checked_by: null }

  const { data: updated, error: uErr } = await db
    .from('prep_session_lines')
    .update(patch)
    .eq('id', line.id)
    .select('id, kind, entity_id, name_snapshot, total_qty, unit, uncertain, uncertain_reason, source_recipe_ids, checked_at, checked_by, position')
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ line: updated }, { headers: { 'Cache-Control': 'no-store' } })
}
