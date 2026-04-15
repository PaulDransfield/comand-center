// @ts-nocheck
// app/api/chat/route.ts
// Streaming AI chat with real TF-IDF chunk retrieval from Supabase.

import { NextRequest }        from 'next/server'
import Anthropic              from '@anthropic-ai/sdk'
import { createAdminClient }  from '@/lib/supabase/server'
import { PLANS }              from '@/lib/stripe/config'

export const dynamic = 'force-dynamic'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

export async function POST(req: NextRequest) {
  const cookieName  = 'sb-llzmixkrysduztsvmfzi-auth-token'
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return new Response('Not authenticated', { status: 401 })

  let userId = '', orgId = '', plan = 'trial'
  try {
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(accessToken)
    if (!user) return new Response('Invalid session', { status: 401 })
    userId = user.id
    const { data: m } = await db.from('organisation_members')
      .select('org_id, organisations(plan)').eq('user_id', userId).single()
    if (!m) return new Response('No org', { status: 401 })
    orgId = m.org_id
    plan  = (m.organisations as any)?.plan ?? 'trial'
  } catch { return new Response('Auth failed', { status: 401 }) }

  const { messages, documentIds } = await req.json()
  if (!messages?.length) return new Response('No messages', { status: 400 })

  const query   = messages[messages.length - 1]?.content ?? ''
  const model   = (PLANS[plan] ?? PLANS.trial).model
  const adminDb = createAdminClient()

  // Retrieve chunks from database
  let context = ''
  try {
    console.log('Fetching chunks for org:', orgId)
    const { data: chunks, error: chunkError } = await adminDb
      .from('document_chunks')
      .select('content, page_number, document_id')
      .eq('org_id', orgId)
      .not('content', 'is', null)
      .limit(10)

    console.log('Chunks found:', chunks?.length, 'error:', chunkError?.message)

    if (chunks?.length) {
      // Simple keyword scoring
      const queryWords = query.toLowerCase().split(/\s+/).filter((w: string) => w.length > 3)
      const scored = chunks.map((c, i) => {
        const text = (c.content ?? '').toLowerCase()
        const score = queryWords.reduce((s: number, w: string) => s + (text.includes(w) ? 1 : 0), 0)
        return { i, score }
      }).sort((a: any, b: any) => b.score - a.score).slice(0, 5)

      const top = scored.map((s: any) => chunks[s.i])
      context = top.map((c: any, i: number) =>
        '[Source: Document, page ' + (c.page_number ?? i+1) + ']\n' + c.content
      ).join('\n\n---\n\n')

      console.log('Context built, chars:', context.length)
    }
  } catch (e: any) { console.error('Chunk retrieval error:', e.message) }

  const systemPrompt = context
    ? 'You are a business intelligence assistant for a Swedish restaurant management platform.\n\nAnswer questions based ONLY on the provided source documents. Always cite sources using [Source: filename, page N]. Format numbers Swedish style: 224 978 kr.\n\nSOURCE DOCUMENTS:\n' + context
    : 'You are a business intelligence assistant for a Swedish restaurant management platform. No documents uploaded yet. Suggest uploading invoices, P&L reports, or bank statements to get started.'

  const encoder = new TextEncoder()
  const stream  = new ReadableStream({
    async start(controller) {
      const send = (d: object) =>
        controller.enqueue(encoder.encode('data: ' + JSON.stringify(d) + '\n\n'))

      let i = 0, o = 0
      try {
        const s = anthropic.messages.stream({
          model,
          max_tokens: 2048,
          system: systemPrompt,
          messages: messages.map((m: { role: string; content: string }) => ({
            role:    m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content,
          })),
        })

        for await (const e of s) {
          if (e.type === 'content_block_delta') send({ type: 'delta', text: e.delta.text })
          if (e.type === 'message_start')       i = e.message.usage?.input_tokens  ?? 0
          if (e.type === 'message_delta')        o = e.usage?.output_tokens ?? 0
        }

        send({ type: 'done', usage: { inputTokens: i, outputTokens: o } })

        // Usage tracking disabled temporarily
      } catch (err: any) {
        send({ type: 'error', message: err.message })
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    },
  })
}
