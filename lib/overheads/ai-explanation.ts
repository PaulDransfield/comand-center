// lib/overheads/ai-explanation.ts
//
// Single Sonnet 4.6 call with extended thinking that takes the rule-based
// flags from review-worker.ts and adds a one-sentence "why this is worth a
// look" explanation per flag, plus a confidence score 0-1.
//
// Why a separate file from review-worker.ts: keeps the rule-engine cheap,
// fast, and AI-free for the inline /api/fortnox/apply path. The AI pass is
// purely additive — flags are usable without it (the rule reason is already
// human-readable). If the AI call fails or times out, the worker still
// returns success.
//
// Cost budget: ~$0.05 per business per period. Bounded by:
//   - Single batched call per business (not per flag)
//   - max_tokens 1500 (enough for ~30 flag explanations)
//   - 45 s timeout
//   - Skipped entirely when no flags are pending
//
// Tool use ensures the response is structured. Extended thinking gives the
// model 2 000 budget tokens to reason about each flag (was the price spike
// inflation-driven? is the supplier name suggestive? is the line label
// ambiguous?) before producing the user-facing explanation.

import { AI_MODELS } from '@/lib/ai/models'
import { logAiRequest } from '@/lib/ai/usage'
import { localePromptFragment } from '@/lib/ai/locale'
import type { Locale } from '@/lib/i18n/config'

interface FlagInput {
  id:                       string
  supplier_name:            string
  flag_type:                string
  reason:                   string | null
  amount_sek:               number
  prior_avg_sek:            number | null
  period_year:              number
  period_month:             number
}

interface BusinessContext {
  business_name:        string
  total_overheads_sek?: number
  benchmarks?:          Record<string, { median_kr: number; sample_size: number }>
}

export interface ExplainResult {
  flag_id:     string
  explanation: string
  confidence:  number   // 0-1
}

/** Failures on the explain pass attach a string here so callers can
 *  surface the real reason instead of a generic "try again" message. */
export const EXPLAIN_ERROR = Symbol.for('cc.overhead-ai.error')

export interface ExplainResultsWithDiag extends Array<ExplainResult> {
  [EXPLAIN_ERROR]?: string
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export async function explainOverheadFlags(args: {
  db:       any
  orgId:    string
  flags:    FlagInput[]
  business: BusinessContext
  /** Owner's UI locale — Claude's free-text `explanation` field renders
   *  in this language. Default 'en-GB' (background-worker callers without
   *  a request context). The user-clicked /api/overheads/explain route
   *  threads the cookie locale in. */
  locale?:  Locale
}): Promise<ExplainResult[]> {
  const { db, orgId, flags, business, locale = 'en-GB' } = args
  if (flags.length === 0) return []

  // Build the prompt. Compact, business-context-tagged, bullet list of flags.
  const flagsBlock = flags.map((f, i) => {
    const period = `${MONTHS[f.period_month - 1]} ${f.period_year}`
    const priorBit = f.prior_avg_sek != null
      ? ` (12-mo avg: ${Math.round(f.prior_avg_sek)} kr)`
      : ' (no prior history)'
    return `[${i + 1}] flag_id=${f.id} | type=${f.flag_type} | "${f.supplier_name}" | ${period} | ${Math.round(f.amount_sek)} kr${priorBit} | rule_reason: ${f.reason ?? '—'}`
  }).join('\n')

  const benchmarkBlock = business.benchmarks && Object.keys(business.benchmarks).length > 0
    ? '\n\nIndustry benchmarks (anonymised peer medians, kr/month):\n' +
      Object.entries(business.benchmarks)
        .map(([k, v]) => `  - ${k}: ${Math.round(v.median_kr)} kr (sample ${v.sample_size})`)
        .join('\n')
    : ''

  const totalBit = business.total_overheads_sek
    ? ` Monthly overheads run ~${Math.round(business.total_overheads_sek)} kr.`
    : ''

  const prompt = `You're helping the owner of "${business.business_name}" review flagged overhead costs.${totalBit} The rule engine has flagged the following supplier lines for review based on price changes, new appearances, or one-off charges.${benchmarkBlock}

Flags to explain (${flags.length}):
${flagsBlock}

For each flag, give a one-sentence explanation (max 140 chars) telling the owner what's interesting and what to consider. Be honest:
  - If the rule fired but the absolute amount is small, say so.
  - If the supplier name is generic (e.g. "Konsultarvoden") and could be many things, say "could be X, Y, Z — check the invoice to know".
  - If a price spike is plausibly seasonal (insurance annual renewal, year-end accounting fees), suggest the seasonal explanation as a likely cause.
  - For NEW lines that look like they could be a vendor swap (e.g. new IT supplier appearing same month an old one disappeared), flag the swap pattern.
  - If the rule_reason carries an "invoices: ..." block, those are the real Fortnox invoices for this supplier-period — you may cite specific dates, amounts, and account descriptions to identify the dominant driver (largest invoice, an unusual one, a swap pattern). Stay within 140 chars and lead with the insight, not a list dump.
  - If no "invoices: ..." block is present, you only see supplier-level totals — speak at the supplier-period granularity and tell the owner to click "Show invoices" on the flag if the call would benefit from invoice-level detail (generic supplier name, ambiguous spike, possible one-off vs trend).
  - NEVER fabricate invoice specifics. If the data isn't in rule_reason, don't say "the 950 kr invoice on the 11th" — that's a hallucination.
  - NEVER tell the owner "you should cut this" — they know their business better than you do. Just surface what's worth a closer look.

Confidence: 0.0-1.0. High (>0.8) when the explanation is concrete and supported by the data. Low (<0.5) when the line label is too generic to say anything specific.`

  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 45_000)

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

    const submitTool = {
      name: 'submit_flag_explanations',
      description: 'Return one explanation per flag with confidence.',
      input_schema: {
        type: 'object',
        properties: {
          explanations: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                flag_id:     { type: 'string' },
                explanation: { type: 'string', description: 'one sentence, max 140 chars' },
                confidence:  { type: 'number', description: '0.0-1.0' },
              },
              required: ['flag_id', 'explanation', 'confidence'],
            },
          },
        },
        required: ['explanations'],
      },
    }

    // Anthropic API constraint: extended thinking and forced tool_choice
    // are mutually exclusive ("Thinking may not be enabled when tool_choice
    // forces tool use"). Dropping `thinking` — a one-sentence-per-flag
    // explanation doesn't benefit from 2000 thinking tokens anyway, and
    // forced tool_choice is the higher-value lever (guarantees structured
    // output rather than free-form text we'd have to regex-parse).
    const response: any = await (client as any).messages.create({
      model:      AI_MODELS.ANALYSIS,   // Sonnet 4.6 — same model as cost-intel and budget AI
      max_tokens: 1500,
      tools:      [submitTool],
      tool_choice:{ type: 'tool', name: 'submit_flag_explanations' },
      // Locale fragment ensures the per-flag `explanation` strings are
      // rendered in the owner's language. Other tool fields (flag_id,
      // confidence) are locale-neutral.
      system:     localePromptFragment(locale),
      messages:   [{ role: 'user', content: prompt }],
    }, { signal: abort.signal as any })

    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed  = toolUse?.input as { explanations?: any[] } | undefined
    if (!parsed?.explanations || !Array.isArray(parsed.explanations)) {
      console.warn('[overhead-ai] tool_use missing or malformed', {
        stop_reason: response?.stop_reason,
        content_types: (response?.content ?? []).map((b: any) => b?.type),
      })
      const out: ExplainResultsWithDiag = []
      out[EXPLAIN_ERROR] = `Sonnet returned no tool_use block (stop_reason: ${response?.stop_reason ?? 'unknown'}). Content types received: ${(response?.content ?? []).map((b: any) => b?.type).join(', ') || 'none'}`
      return out
    }

    // Best-effort cost log. Don't fail the worker on logging error.
    try {
      await logAiRequest(db, {
        org_id:        orgId,
        request_type:  'overhead_review_explanation',
        model:         AI_MODELS.ANALYSIS,
        input_tokens:  response.usage?.input_tokens  ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
      })
    } catch {}

    return parsed.explanations
      .filter((e: any) => e?.flag_id && typeof e.explanation === 'string')
      .map((e: any) => ({
        flag_id:     String(e.flag_id),
        explanation: String(e.explanation).slice(0, 200),
        confidence:  Math.max(0, Math.min(1, Number(e.confidence ?? 0.5))),
      }))
  } catch (e: any) {
    console.warn('[overhead-ai] explain failed:', e?.message ?? e)
    const out: ExplainResultsWithDiag = []
    // Surface the real reason so the caller can show a useful error.
    // Common causes: ANTHROPIC_API_KEY missing, rate limit, abort timeout (45s),
    // 5xx from Anthropic, malformed prompt rejected.
    out[EXPLAIN_ERROR] = e?.message
      || (e?.name ? `${e.name}${e?.code ? ` (${e.code})` : ''}` : '')
      || 'unknown error from Anthropic SDK'
    return out
  } finally {
    clearTimeout(timeout)
  }
}
