// @ts-nocheck
// app/api/settings/ai-privacy/route.ts
//
// Customer-facing privacy toggle for AI question logging.
//
//   GET  /api/settings/ai-privacy       → { log_ai_questions: boolean }
//   POST /api/settings/ai-privacy       { log_ai_questions: boolean }  → saves
//
// When false, ai_request_log.question_preview stays null — we keep the
// cost/tokens/model metadata, not the question text.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { unstable_noStore as noStore } from 'next/cache'

export const dynamic    = 'force-dynamic'
export const revalidate = 0

export async function GET(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const db = createAdminClient()
  const { data, error } = await db
    .from('organisations')
    .select('log_ai_questions')
    .eq('id', auth.orgId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ log_ai_questions: data?.log_ai_questions !== false })
}

export async function POST(req: NextRequest) {
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  if (typeof body.log_ai_questions !== 'boolean') {
    return NextResponse.json({ error: 'log_ai_questions boolean required' }, { status: 400 })
  }

  const db = createAdminClient()
  const { error } = await db
    .from('organisations')
    .update({ log_ai_questions: body.log_ai_questions })
    .eq('id', auth.orgId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true, log_ai_questions: body.log_ai_questions })
}
