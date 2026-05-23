// lib/ai/agent-runner.ts
//
// Single wrapper that EVERY non-/ask AI surface should use to call
// Anthropic. Bundles:
//   1. Business-state snapshot injection (always-on)
//   2. Optional tool catalogue + tool-use loop
//   3. Token usage accounting across loop iterations
//   4. Cache_control on the system prompt for KV reuse
//
// Why this exists:
//   Pre-2026-05-23 every surface (budgets/analyse, budgets/coach,
//   budgets/generate, tracker/narrative, etc.) called Anthropic
//   directly and was blind to setup health, balance sheet, momsrapport,
//   voucher detail. Wrapping the call here means a single change point
//   for every AI-aware surface — and any new surface gets snapshot +
//   tools for free.
//
// Usage:
//   const r = await runAgent({
//     db, orgId, businessId,
//     model:    AI_MODELS.AGENT,
//     maxTokens: 600,
//     system:    'You are the budget analyser…',  // your task-specific prompt
//     prompt:    `Current budget vs actual:\n${json}\n\nGenerate variance commentary.`,
//   })
//   console.log(r.answer)
//
// Soft-fails on tool calls; falls back to text-only on tool errors so
// budget AI never breaks because the snapshot or a tool returned 500.

import { AI_MODELS } from '@/lib/ai/models'
import { SCOPE_NOTE } from '@/lib/ai/scope'

export interface RunAgentOptions {
  db:           any
  orgId:        string
  businessId:   string | null         // null = no snapshot, no tools

  model:        string                // e.g. AI_MODELS.AGENT or .ASSISTANT
  maxTokens:    number
  /** Task-specific system prompt. We auto-prepend SCOPE_NOTE and the
   *  business snapshot. Cache_control attached to this combined block. */
  system:       string
  /** User-side prompt — the question / task. */
  prompt:       string
  /** Optional locale fragment (uncached). */
  localeFragment?: string

  /** Default true. Disables the snapshot injection (rare — only when
   *  the caller already builds equivalent context inline). */
  enableSnapshot?: boolean
  /** Default true when businessId present. Enables tool catalogue. */
  enableTools?:    boolean
  /** Limit the tool subset by name. Default = all tools. Useful for
   *  surfaces that should only have a narrow capability (e.g. anomaly
   *  detector only needs voucher search, not balance sheet). */
  toolsAllowList?: string[]
}

export interface RunAgentResult {
  answer:               string
  input_tokens:         number
  output_tokens:        number
  tool_iterations:      number
  tools_called:         Array<{ name: string; args: any; result_chars: number }>
  /** True when snapshot was successfully prepended. */
  snapshot_included:    boolean
  snapshot_chars:       number
  warnings:             string[]
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const warnings: string[] = []
  const enableSnapshot = opts.enableSnapshot !== false && !!opts.businessId
  const enableTools    = opts.enableTools    !== false && !!opts.businessId

  // ── 1. Build the snapshot (cache-only, soft-fails) ────────────────
  let snapshotBlock = ''
  if (enableSnapshot) {
    try {
      const { buildBusinessSnapshot } = await import('./snapshot')
      snapshotBlock = await buildBusinessSnapshot(opts.db, opts.orgId, opts.businessId!, {
        inventory: true,
        toolCatalogue: enableTools,
      })
    } catch (e: any) {
      warnings.push(`snapshot failed: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // ── 2. Build the system prompt with SCOPE_NOTE + snapshot + task ──
  // Order: SCOPE_NOTE first (most static, best cache hit rate),
  // snapshot second (varies per business, still benefits from cache
  // within a session), task prompt last.
  const systemBlocks: any[] = [
    { type: 'text', text: SCOPE_NOTE,    cache_control: { type: 'ephemeral' } },
  ]
  if (snapshotBlock) {
    systemBlocks.push({ type: 'text', text: snapshotBlock })
  }
  systemBlocks.push({ type: 'text', text: opts.system })
  if (opts.localeFragment) {
    systemBlocks.push({ type: 'text', text: opts.localeFragment })
  }

  // ── 3. Build the tool catalogue ───────────────────────────────────
  let toolsForApi: any[] | undefined
  if (enableTools) {
    try {
      const { TOOL_CATALOGUE } = await import('./tools')
      toolsForApi = opts.toolsAllowList
        ? TOOL_CATALOGUE.filter(t => opts.toolsAllowList!.includes(t.name))
        : TOOL_CATALOGUE
    } catch (e: any) {
      warnings.push(`tool catalogue load failed: ${String(e?.message ?? e).slice(0, 120)}`)
    }
  }

  // ── 4. Call Anthropic + run the tool loop ─────────────────────────
  const Anthropic = (await import('@anthropic-ai/sdk')).default
  const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

  const conversation: any[] = [{ role: 'user', content: opts.prompt }]
  const requestBuilder = async (msgs: any[]) => (claude as any).messages.create({
    model:      opts.model,
    max_tokens: opts.maxTokens,
    system:     systemBlocks,
    tools:      toolsForApi,
    messages:   msgs,
  })

  let answer = 'No response'
  let totalInput = 0
  let totalOutput = 0
  let toolIterations = 0
  let toolsCalled: any[] = []

  try {
    const response = await requestBuilder(conversation)
    totalInput  = (response as any).usage?.input_tokens  ?? 0
    totalOutput = (response as any).usage?.output_tokens ?? 0

    if (toolsForApi && toolsForApi.length > 0) {
      const { runToolLoop } = await import('./tools')
      const loop = await runToolLoop(
        { db: opts.db, orgId: opts.orgId, businessId: opts.businessId! },
        claude,
        response,
        requestBuilder,
        conversation,
      )
      answer         = loop.answer
      totalInput     = loop.total_input_tokens
      totalOutput    = loop.total_output_tokens
      toolIterations = loop.iterations
      toolsCalled    = loop.tools_called
    } else {
      const textBlock = (response.content ?? []).find((b: any) => b.type === 'text')
      answer = textBlock?.text ?? 'No response'
    }
  } catch (e: any) {
    warnings.push(`anthropic call failed: ${String(e?.message ?? e).slice(0, 200)}`)
    throw e   // let the caller decide retry / error response
  }

  return {
    answer,
    input_tokens:      totalInput,
    output_tokens:     totalOutput,
    tool_iterations:   toolIterations,
    tools_called:      toolsCalled,
    snapshot_included: !!snapshotBlock,
    snapshot_chars:    snapshotBlock.length,
    warnings,
  }
}

// Convenience re-exports so callers don't need separate imports.
export { AI_MODELS }
