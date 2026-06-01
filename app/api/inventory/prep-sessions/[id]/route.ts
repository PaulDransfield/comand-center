// app/api/inventory/prep-sessions/[id]/route.ts
//
// GET    — load a session + its lines
// PATCH  — rename, or set completed_at = NOW()
// DELETE — discard (only when not yet completed)
//
// All routes verify the caller owns the parent session's business.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess } from '@/lib/auth/require-role'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadSession(db: any, sessionId: string) {
  return db
    .from('prep_sessions')
    .select('id, business_id, name, inputs, created_at, completed_at')
    .eq('id', sessionId)
    .maybeSingle()
}

// ── GET ────────────────────────────────────────────────────────────────
export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: session, error } = await loadSession(db, params.id)
  if (error)   return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, session.business_id)
  if (forbidden) return forbidden

  const { data: lines } = await db
    .from('prep_session_lines')
    .select('id, kind, entity_id, name_snapshot, total_qty, unit, uncertain, uncertain_reason, source_recipe_ids, checked_at, checked_by, position')
    .eq('session_id', session.id)
    .order('position')

  return NextResponse.json({ session, lines: lines ?? [] }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

// ── PATCH ──────────────────────────────────────────────────────────────
interface PatchBody {
  name?:     string | null
  // 'now' = mark completed_at to NOW. Anything else ignored. Sending
  // completed_at: null would re-open a completed session, which we
  // deliberately don't expose at this layer — keep history immutable.
  complete?: 'now'
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: PatchBody
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const db = createAdminClient()
  const { data: session, error } = await loadSession(db, params.id)
  if (error)    return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, session.business_id)
  if (forbidden) return forbidden

  const patch: Record<string, any> = {}
  if (body.name !== undefined) patch.name = body.name?.toString().trim() || null
  if (body.complete === 'now' && !session.completed_at) {
    patch.completed_at = new Date().toISOString()
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ session }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const { data: updated, error: uErr } = await db
    .from('prep_sessions')
    .update(patch)
    .eq('id', session.id)
    .select('id, business_id, name, inputs, created_at, completed_at')
    .single()
  if (uErr) return NextResponse.json({ error: uErr.message }, { status: 500 })

  return NextResponse.json({ session: updated }, { headers: { 'Cache-Control': 'no-store' } })
}

// ── DELETE ─────────────────────────────────────────────────────────────
// Only allowed while the session is still active. Completed sessions
// are history — preserve them. CASCADE drops the lines automatically.
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data: session, error } = await loadSession(db, params.id)
  if (error)    return NextResponse.json({ error: error.message }, { status: 500 })
  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 })
  const forbidden = requireBusinessAccess(auth, session.business_id)
  if (forbidden) return forbidden
  if (session.completed_at) {
    return NextResponse.json({ error: 'Cannot delete a completed session — it is history' }, { status: 409 })
  }

  const { error: dErr } = await db.from('prep_sessions').delete().eq('id', session.id)
  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 })

  return NextResponse.json({ ok: true })
}
