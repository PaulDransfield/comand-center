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
import { checkAiLimit, incrementAiUsage, logAiRequest } from '@/lib/ai/usage'
import { SCOPE_NOTE }                from '@/lib/ai/scope'

const SYSTEM_PROMPT = `You are an AI assistant built into CommandCenter, a business intelligence platform for restaurant groups in Sweden.

You help restaurant operators understand their data — staff costs, revenue, margins, department performance, and forecasts.

Guidelines:
- Answer in the same language as the question (Swedish or English)
- Be concise and direct — operators are busy
- When you see numbers, interpret them in restaurant industry context
- Typical healthy targets: food cost 28-35%, staff cost 30-40%, net margin 10-20%
- Flag anything that looks like a problem
- Never make up numbers not in the context provided
- If you cannot answer from the context, say so clearly

${SCOPE_NOTE}`

export async function POST(req: NextRequest) {
  // ── 1. Auth ────────────────────────────────────────────────────
  // Use the battle-tested cookie parser — the old getOrgFromRequest relied on
  // @supabase/ssr's createServerClient session getter which silently missed
  // some cookie formats and was returning 401 for valid sessions (2026-04-18).
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  // ── 2. Parse body ──────────────────────────────────────────────
  let question: string, context: string, page: string, tier: 'light' | 'full', businessId: string | null
  try {
    const body = await req.json()
    question   = (body.question ?? '').trim()
    context    = (body.context  ?? '').trim()
    page       = (body.page     ?? 'dashboard').trim()
    businessId = body.business_id ? String(body.business_id) : null
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

  // Cost-aware enrichment runs AFTER the truncation step below so the
  // line items fit inside their own reserved budget.
  const COST_KEYWORDS = /\b(cost|overhead|overheads|subscription|subscribe|bank|fees|fee|rent|software|saas|bokio|fortnox|insurance|utilit|electric|marketing|accounting|audit|margin|other[_\s]cost|line[_\s]item)s?\b/i

  // Hard cap on context size. Caps input tokens roughly at ~2 500 tokens (4 chars ≈ 1 token),
  // keeping a single call below ~$0.04 on Sonnet and ~$0.007 on Haiku.
  // Reserve the last 1500 chars for the cost enrichment (when relevant)
  // so Fortnox line items don't get cropped when the base context is big.
  const MAX_CONTEXT_CHARS = 6000
  const COST_BUDGET       = 1500
  const originalBudget    = MAX_CONTEXT_CHARS - COST_BUDGET
  if (context.length > originalBudget) {
    console.warn(`[ask] context truncated — was ${context.length} chars, capped at ${originalBudget}`)
    context = context.slice(0, originalBudget) + '\n\n[context truncated for cost]'
  }

  // Now append cost detail if the question asks for it.
  if (businessId && COST_KEYWORDS.test(question)) {
    try {
      const supabase = createAdminClient()
      const yearFrom = new Date().getFullYear() - 1
      const { data: lines } = await supabase
        .from('tracker_line_items')
        .select('period_year, period_month, category, subcategory, label_sv, amount')
        .eq('org_id', auth.orgId)
        .eq('business_id', businessId)
        .eq('category', 'other_cost')
        .gte('period_year', yearFrom)
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .order('amount', { ascending: false })
        .limit(60)

      if (lines && lines.length) {
        const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        const formatted = lines
          .map((l: any) => {
            const period = l.period_month && l.period_month > 0
              ? `${MONTHS[l.period_month - 1]} ${l.period_year}`
              : `${l.period_year} (annual)`
            const sub = l.subcategory ? ` [${l.subcategory}]` : ''
            return `  - ${period}: ${l.label_sv}${sub} — ${Math.round(l.amount).toLocaleString('en-GB').replace(/,/g, ' ')} kr`
          })
          .join('\n')
        // Flag the scope explicitly so Claude doesn't attribute these to a
        // single department when the user asks a dept-scoped question.
        // Fortnox P&L is always whole-business; any per-dept attribution
        // would be invented.
        const block = `\n\nOverhead line items (other_cost, from Fortnox PDFs — BUSINESS-WIDE, not split by department):\n${formatted}`
        context += block.length > COST_BUDGET ? block.slice(0, COST_BUDGET) + '\n[line items truncated]' : block
      }
    } catch (e: any) {
      console.warn('[ask] overhead enrichment failed:', e?.message)
    }
  }

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
  const startedAt = Date.now()
  try {
    const response = await claude.messages.create({
      model,
      max_tokens: maxTokens,
      system:     SYSTEM_PROMPT,
      messages:   [{ role: 'user', content: userMessage }],
    })
    answer = (response.content[0] as any).text ?? 'No response'

    // ── 5. Increment daily counter (gates the daily cap) ──────
    await incrementAiUsage(supabase, auth.orgId)

    // ── 6. Write full audit row — tokens, cost, user, duration ─
    // Non-fatal: the helper logs and swallows any error so a slow DB write
    // doesn't break the user's response.
    const inputTokens  = (response as any).usage?.input_tokens  ?? 0
    const outputTokens = (response as any).usage?.output_tokens ?? 0
    await logAiRequest(supabase, {
      org_id:           auth.orgId,
      user_id:          auth.userId,
      request_type:     'ask',
      model,
      tier,
      page,
      question_preview: question.slice(0, 100),
      input_tokens:     inputTokens,
      output_tokens:    outputTokens,
      duration_ms:      Date.now() - startedAt,
    })

  } catch (err: any) {
    console.error('Claude API error:', err)
    return NextResponse.json({ error: 'AI service unavailable. Please try again.' }, { status: 503 })
  }

  // Return the answer plus the approaching-limit warning if the gate set one.
  return NextResponse.json({
    answer,
    ...(gate.ok && gate.warning ? { warning: gate.warning } : {}),
  })
}
