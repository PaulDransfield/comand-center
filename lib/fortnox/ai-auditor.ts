// lib/fortnox/ai-auditor.ts
//
// Cheap Haiku second-opinion on a Fortnox extraction. Sits alongside
// the rule-based validators (lib/fortnox/validators.ts) and catches the
// "passes the rules but feels off" class — patterns the rule engine
// can't easily express.
//
// Cost budget: ~$0.0005 per apply (Haiku, ~600 input tokens, ~150 output).
// Single tool-use call so the response is structured.
//
// Failure model: this is a SIGNAL, not a gate. If the Anthropic API is
// down, slow, or returns garbage, we return a degraded "no audit
// available" verdict and the apply proceeds based on rule-based
// validation alone. Never blocks the apply on AI failures.

import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { logAiRequest }          from '@/lib/ai/usage'
import { SCOPE_NOTE }            from '@/lib/ai/scope'
import type { ExtractionForValidation } from '@/lib/fortnox/validators'

export type AiAuditConfidence = 'high' | 'medium' | 'low' | 'unavailable'

export interface AiAuditResult {
  confidence: AiAuditConfidence
  /** One-sentence verdict suitable for the review UI. */
  summary:    string
  /** Specific concerns the auditor flagged (may be empty). */
  concerns:   string[]
  /** Cost + duration for ops monitoring. */
  meta?: {
    duration_ms:   number
    input_tokens?: number
    output_tokens?: number
  }
}

export interface AiAuditContext {
  db:          any                 // SupabaseAdminClient — for cost logging
  orgId:       string
  businessName: string
  /** Up to 12 months of prior history for comparison. Oldest first. */
  history?: Array<{
    year:       number
    month:      number
    revenue:    number
    staff_cost: number
    food_cost:  number
  }>
}

const TIMEOUT_MS = 20_000

export async function auditExtraction(
  extraction: ExtractionForValidation,
  ctx:        AiAuditContext,
): Promise<AiAuditResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { confidence: 'unavailable', summary: 'AI auditor not configured (ANTHROPIC_API_KEY missing).', concerns: [] }
  }

  const started = Date.now()
  const abort   = new AbortController()
  const timeout = setTimeout(() => abort.abort(), TIMEOUT_MS)

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const tool = {
      name: 'submit_audit_verdict',
      description: 'Return a confidence verdict on the Fortnox extraction.',
      input_schema: {
        type: 'object',
        properties: {
          confidence: { enum: ['high', 'medium', 'low'] },
          summary:    { type: 'string', description: 'One sentence, ≤140 chars, plain English.' },
          concerns:   { type: 'array', items: { type: 'string' }, description: 'Specific concerns; empty array if none.' },
        },
        required: ['confidence', 'summary', 'concerns'],
      },
    }

    const prompt = buildPrompt(extraction, ctx)
    const response: any = await (client as any).messages.create({
      model:       AI_MODELS.AGENT,
      max_tokens:  MAX_TOKENS.AGENT_RECOMMENDATION,
      tools:       [tool],
      tool_choice: { type: 'tool', name: 'submit_audit_verdict' },
      messages:    [{ role: 'user', content: prompt }],
    }, { signal: abort.signal as any })

    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed  = toolUse?.input as { confidence?: string; summary?: string; concerns?: string[] } | undefined

    // Best-effort cost log; never throw on logging.
    try {
      await logAiRequest(ctx.db, {
        org_id:        ctx.orgId,
        request_type:  'fortnox_audit',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens  ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch {}

    if (!parsed?.confidence || !parsed?.summary) {
      return { confidence: 'unavailable', summary: 'AI auditor returned an unparseable response.', concerns: [], meta: { duration_ms: Date.now() - started } }
    }

    const confidence = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence as AiAuditConfidence : 'low'
    return {
      confidence,
      summary:  String(parsed.summary).slice(0, 240),
      concerns: Array.isArray(parsed.concerns) ? parsed.concerns.slice(0, 6).map(String) : [],
      meta: {
        duration_ms:   Date.now() - started,
        input_tokens:  response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens,
      },
    }
  } catch (e: any) {
    return {
      confidence: 'unavailable',
      summary:   `AI auditor unavailable: ${abort.signal.aborted ? 'timeout' : e?.message ?? 'unknown'}`,
      concerns:  [],
      meta:      { duration_ms: Date.now() - started },
    }
  } finally {
    clearTimeout(timeout)
  }
}

function buildPrompt(extraction: ExtractionForValidation, ctx: AiAuditContext): string {
  const fmt = (n?: number) => n == null ? '—' : Math.round(n).toLocaleString('en-GB').replace(/,/g, ' ') + ' kr'

  const periodsBlock = extraction.periods.map(p => {
    const r = p.rollup ?? {}
    return `  ${p.year}-${String(p.month).padStart(2,'0')}  rev=${fmt(r.revenue)}  food=${fmt(r.food_cost)}  staff=${fmt(r.staff_cost)}  alc_cost=${fmt(r.alcohol_cost)}  other=${fmt(r.other_cost)}  net=${fmt(r.net_profit)}`
  }).join('\n')

  const histBlock = (ctx.history ?? []).map(h =>
    `  ${h.year}-${String(h.month).padStart(2,'0')}  rev=${fmt(h.revenue)}  staff=${fmt(h.staff_cost)}  food=${fmt(h.food_cost)}`
  ).join('\n') || '  (no prior history available)'

  return `You are auditing a Fortnox Resultatrapport extraction before it gets written to "${ctx.businessName}"'s ledger. Your job: spot-check whether the numbers look RIGHT given the business's history. You are the second opinion AFTER the rule-based validators have already passed.

${SCOPE_NOTE}

EXTRACTION (${extraction.doc_type ?? 'unknown'}, scale: ${extraction.scale_detected ?? 'sek'})
${periodsBlock}

PRIOR HISTORY (last 12 months, oldest first)
${histBlock}

YOUR JOB:
- Compare the extraction to history. Are the numbers in the same ballpark as recent months?
- Flag scale errors: a 10× jump or 10× drop is almost always a SEK/kSEK confusion.
- Flag pattern oddities: identical numbers across multiple months, all-zero rows, suspiciously round numbers (like exactly 1 000 000 kr).
- Flag impossible relationships: food_cost > revenue, alcohol_cost > food_cost, etc.
- "high" confidence = numbers consistent with history, no concerns.
- "medium" = some concerns but not blocking (e.g. unusually quiet month, but plausible).
- "low" = something is clearly wrong; the owner should not apply without checking.

Be DIRECT. Don't pad. The owner is a busy restaurant operator who needs to know in one sentence whether to trust this PDF.

Call submit_audit_verdict with your verdict.`
}
