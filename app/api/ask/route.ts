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
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS }     from '@/lib/ai/models'
import { checkAiLimit, incrementAiUsage } from '@/lib/ai/usage'

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
  // Use the battle-tested cookie parser — the old getOrgFromRequest relied on
  // @supabase/ssr's createServerClient session getter which silently missed
  // some cookie formats and was returning 401 for valid sessions (2026-04-18).
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── 2. Parse body ──────────────────────────────────────────────
  let question: string, context: string, page: string, tier: 'light' | 'full'
  try {
    const body = await req.json()
    question   = (body.question ?? '').trim()
    context    = (body.context  ?? '').trim()
    page       = (body.page     ?? 'dashboard').trim()
    // Tier selects model + token budget. 'light' = Haiku + shorter output,
    // used by /notebook and other low-stakes surfaces to keep cost per query
    // to ~$0.002 instead of Sonnet's ~$0.012. 'full' is the default for
    // page-level AskAI where context is richer and nuance matters.
    tier       = body.tier === 'light' ? 'light' : 'full'
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (!question) return NextResponse.json({ error: 'No question provided' }, { status: 400 })
  if (question.length > 1000) return NextResponse.json({ error: 'Question too long' }, { status: 400 })

  // ── 3. Check daily query limit (shared helper in lib/ai/usage.ts) ────────
  const supabase = createAdminClient()
  const gate = await checkAiLimit(supabase, auth.orgId, auth.plan)
  if (!gate.ok) return NextResponse.json(gate.body, { status: gate.status })

  // ── 4. Call Claude ─────────────────────────────────────────────
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const userMessage = context
    ? `Current page: ${page}\n\nData context:\n${context}\n\nQuestion: ${question}`
    : `Question: ${question}`

  const model     = tier === 'light' ? AI_MODELS.AGENT                : AI_MODELS.ASSISTANT
  const maxTokens = tier === 'light' ? MAX_TOKENS.AGENT_RECOMMENDATION : MAX_TOKENS.ASSISTANT

  let answer: string
  try {
    const response = await claude.messages.create({
      model,
      max_tokens: maxTokens,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    })
    answer = (response.content[0] as any).text ?? 'No response'

    // ── 5. Increment daily counter ─────────────────────────────
    await incrementAiUsage(supabase, auth.orgId)

  } catch (err: any) {
    console.error('Claude API error:', err)
    return NextResponse.json({ error: 'AI service unavailable. Please try again.' }, { status: 503 })
  }

  return NextResponse.json({ answer })
}
