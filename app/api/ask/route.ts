// @ts-nocheck
// app/api/ask/route.ts
//
// AI question answering with page context.
//
// Flow:
//   Page sends { question, context, page }
//   → We check daily query limit for this org's plan
//   → We call Claude with the context + question
//   → We increment the usage counter
//   → We return { answer }
//
// The "context" is a plain-text summary built by each page from its live data.
// Claude never hits the DB directly — the page does the data fetching.

import { NextRequest, NextResponse } from 'next/server'
import { getOrgFromRequest }         from '@/lib/auth/get-org'
import { createAdminClient }         from '@/lib/supabase/server'
import { getPlan }                   from '@/lib/stripe/config'
import { AI_MODELS, MAX_TOKENS }     from '@/lib/ai/models'

const SYSTEM_PROMPT = `You are an AI assistant built into CommandCenter, a business intelligence platform for restaurant groups in Sweden.

You help restaurant operators understand their data — staff costs, revenue, margins, department performance, and forecasts.

Guidelines:
- Answer in the same language as the question (Swedish or English)
- Be concise and direct — operators are busy
- When you see numbers, interpret them in restaurant industry context
- Typical healthy targets: food cost 28-35%, staff cost 30-40%, net margin 10-20%
- Flag anything that looks like a problem
- Never make up numbers not in the context provided
- If you cannot answer from the context, say so clearly`

export async function POST(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────
  const auth = await getOrgFromRequest(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── 2. Parse body ──────────────────────────────────────────────
  let question: string, context: string, page: string
  try {
    const body = await req.json()
    question   = (body.question ?? '').trim()
    context    = (body.context  ?? '').trim()
    page       = (body.page     ?? 'dashboard').trim()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!question) return NextResponse.json({ error: 'No question provided' }, { status: 400 })
  if (question.length > 1000) return NextResponse.json({ error: 'Question too long' }, { status: 400 })

  // ── 3. Check daily query limit ────────────────────────────────
  const supabase = createAdminClient()
  const plan     = getPlan(auth.plan)
  const limit    = plan.ai_queries_per_day

  if (limit !== Infinity) {
    const today = new Date().toISOString().slice(0, 10)

    const { data: usage } = await supabase
      .from('ai_usage_daily')
      .select('query_count')
      .eq('org_id', auth.orgId)
      .eq('date', today)
      .maybeSingle()

    const count = usage?.query_count ?? 0

    if (count >= limit) {
      return NextResponse.json({
        error:   'Daily AI query limit reached',
        limit,
        used:    count,
        upgrade: true,   // frontend shows upgrade prompt when this is true
      }, { status: 429 })
    }
  }

  // ── 4. Call Claude ─────────────────────────────────────────────
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const userMessage = context
    ? `Current page: ${page}\n\nData context:\n${context}\n\nQuestion: ${question}`
    : `Question: ${question}`

  let answer: string
  try {
    const response = await claude.messages.create({
      model:      AI_MODELS.ASSISTANT,
      max_tokens: MAX_TOKENS.ASSISTANT,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    })
    answer = (response.content[0] as any).text ?? 'No response'

    // ── 5. Increment daily counter ─────────────────────────────
    // Upsert: create row if first query today, otherwise increment
    const today = new Date().toISOString().slice(0, 10)
    await supabase.rpc('increment_ai_usage', { p_org_id: auth.orgId, p_date: today })
      .then(({ error }: any) => {
        // If RPC doesn't exist yet, fall back to manual upsert
        if (error) {
          return supabase.from('ai_usage_daily').upsert(
            { org_id: auth.orgId, date: today, query_count: 1 },
            { onConflict: 'org_id,date', ignoreDuplicates: false }
          )
        }
      })

  } catch (err: any) {
    console.error('Claude API error:', err)
    return NextResponse.json({ error: 'AI service unavailable. Please try again.' }, { status: 503 })
  }

  return NextResponse.json({ answer })
}
