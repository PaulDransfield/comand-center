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
import { checkAndIncrementAiLimit, logAiRequest } from '@/lib/ai/usage'
import { SCOPE_NOTE }                from '@/lib/ai/scope'
import { INDUSTRY_BENCHMARKS, VOICE, DATA_GAPS } from '@/lib/ai/rules'
import { buildAskContext }           from '@/lib/ai/contextBuilder'
import { aiLocaleFromRequest }       from '@/lib/ai/locale'
import { log }                       from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
// Claude Sonnet 4.6 assistant calls run 20–40 s on a large context.
// Declare the ceiling explicitly so behaviour matches on Hobby (60 s
// default) and Pro (300 s default) — no surprise 504s on plan changes.
export const maxDuration = 60

// Built once from the shared rule modules. Identical across every /api/ask
// call, so we send it as a cache_control ephemeral system block — cuts input
// token cost by ~80% on this endpoint, which is the hottest Claude surface
// in the app.
// Static block — identical across every call regardless of locale, so it
// stays in the prompt cache. The "respond in language X" instruction is
// appended as a second tiny block at request time (see localeFragment
// usage below) so we can support en-GB / sv / nb without busting the
// cache for the static rules.
const SYSTEM_PROMPT = `You are an AI assistant built into CommandCenter, a business intelligence platform for restaurant groups in Sweden.

You help restaurant operators understand their data — staff costs, revenue, margins, department performance, and forecasts.

Never invent numbers that aren't in the context provided. If you cannot answer from the context, say so clearly and explain what data would be needed.

${INDUSTRY_BENCHMARKS}

${VOICE}

${DATA_GAPS}

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

  // Verify the supplied business_id belongs to the caller's org before we
  // use it for anything (context enrichment, tool lookups). Without this
  // check a user could pass another org's business_id and — via prompt
  // injection in the returned label text — make the model treat it as
  // their own. eq('org_id', auth.orgId) on data queries protects rows but
  // not control-flow decisions that depend on `businessId`.
  if (businessId) {
    const supabase = createAdminClient()
    const { data: biz } = await supabase
      .from('businesses')
      .select('id')
      .eq('id', businessId)
      .eq('org_id', auth.orgId)
      .maybeSingle()
    if (!biz) {
      return NextResponse.json({ error: 'Business not found in your organisation' }, { status: 403 })
    }
  }

  // Centralised context assembly — truncation + optional cost enrichment.
  // Replaces the inline logic that used to live here; see lib/ai/contextBuilder.ts.
  const supabaseForCtx = createAdminClient()
  const built = await buildAskContext(supabaseForCtx, context, question, {
    orgId:       auth.orgId,
    businessId:  businessId,
  })
  context = built.context
  for (const w of built.warnings) console.warn('[ask]', w)
  if (built.enrichmentsApplied.length) {
    console.log('[ask] enrichments fired:', built.enrichmentsApplied.join(','))
  }

  // ── 3. Atomic check + increment of daily query limit (M033, FIXES §0w) ──
  // Increment happens HERE — before Claude is called — so 100 parallel tabs
  // can't all pass the gate before the counter ticks. On Claude failure the
  // attempt still counts; that's the desired behaviour for rate limiting.
  const supabase = createAdminClient()
  const gate = await checkAndIncrementAiLimit(supabase, auth.orgId, auth.plan)
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
    // Prompt caching: SYSTEM_PROMPT is identical across every call, so
    // marking it as cache_control ephemeral lets Anthropic reuse the KV
    // cache for 5 minutes and bill the cached tokens at ~10% of normal.
    // Typical hot-path saving: ~80% of input token cost.
    //
    // Locale fragment is a second, uncached block (~80 tokens, 3 distinct
    // values across all users). Splitting it lets the static rules cache
    // hit even when users query in different languages — without this
    // the cache would bust on every locale switch.
    const { promptFragment: localeFragment } = aiLocaleFromRequest(req)
    const response = await (claude as any).messages.create({
      model,
      max_tokens: maxTokens,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: localeFragment },
      ],
      messages:   [{ role: 'user', content: userMessage }],
    })
    answer = (response.content[0] as any).text ?? 'No response'

    // ── 5. (Counter was already incremented atomically in step 3.) ────
    // ── 6. Write full audit row — tokens, cost, user, duration ─
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

    log.info('ask answered', {
      route:         'api/ask',
      duration_ms:   Date.now() - startedAt,
      org_id:        auth.orgId,
      user_id:       auth.userId,
      page,
      tier,
      model,
      input_tokens:  inputTokens,
      output_tokens: outputTokens,
      status:        'success',
    })

  } catch (err: any) {
    log.error('ask claude failed', {
      route:       'api/ask',
      duration_ms: Date.now() - startedAt,
      org_id:      auth.orgId,
      user_id:     auth.userId,
      page,
      tier,
      model,
      error:       err?.message ?? String(err),
      status:      'error',
    })
    return NextResponse.json({ error: 'AI service unavailable. Please try again.' }, { status: 503 })
  }

  // Return the answer plus the approaching-limit warning if the gate set one.
  return NextResponse.json({
    answer,
    ...(gate.ok && gate.warning ? { warning: gate.warning } : {}),
  })
}
