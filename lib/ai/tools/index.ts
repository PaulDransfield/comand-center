// lib/ai/tools/index.ts
//
// Phase 2 of the AI-awareness work — Anthropic tool catalogue.
//
// Each tool wraps an existing lib function (computeBalanceSheet, etc.)
// so the LLM can drill into specific periods / accounts / supplier
// invoices when the snapshot summary isn't enough.
//
// Hard rules:
//   1. Tools wrap existing lib functions — never re-implement business logic.
//   2. Tools are cache-friendly: reads either hit Postgres directly or
//      lib functions that read warm caches. Cold Fortnox calls are OK
//      (e.g. computeBalanceSheet on a fresh period) — the user asked
//      for that period explicitly.
//   3. Every tool soft-fails — return an error object the LLM can read,
//      never throw out of the runner.
//   4. Output is JSON-stringified and capped at MAX_TOOL_OUTPUT_CHARS so
//      a balance sheet with 1000 line items can't blow the prompt budget.

import { runRevisorTool, REVISOR_TOOLS }   from './revisor'
import { runVoucherTool,  VOUCHER_TOOLS }  from './vouchers'

const MAX_TOOL_OUTPUT_CHARS = 12_000

// Anthropic tool schema shape (matches @anthropic-ai/sdk types).
export interface AnthropicToolDef {
  name:         string
  description:  string
  input_schema: {
    type:       'object'
    properties: Record<string, any>
    required?:  string[]
  }
}

// Context passed to every tool execution. The dispatcher injects db /
// orgId / businessId so tool implementations only see their own args.
export interface ToolContext {
  db:         any
  orgId:      string
  businessId: string
}

export type ToolName =
  | 'get_balance_sheet'
  | 'get_momsrapport'
  | 'get_account_balance'
  | 'search_vouchers'
  | 'search_supplier_invoices'

/** Full catalogue exposed to the LLM via the Anthropic API `tools` field. */
export const TOOL_CATALOGUE: AnthropicToolDef[] = [
  ...REVISOR_TOOLS,
  ...VOUCHER_TOOLS,
]

/**
 * Execute a single tool by name. Returns a string the caller appends
 * as a tool_result block. NEVER throws — error paths return a JSON
 * error object so the LLM can read it and explain to the user.
 */
export async function runTool(
  ctx:  ToolContext,
  name: string,
  args: any,
): Promise<string> {
  try {
    let result: any
    switch (name as ToolName) {
      case 'get_balance_sheet':
      case 'get_momsrapport':
      case 'get_account_balance':
        result = await runRevisorTool(ctx, name as any, args ?? {})
        break
      case 'search_vouchers':
      case 'search_supplier_invoices':
        result = await runVoucherTool(ctx, name as any, args ?? {})
        break
      default:
        return JSON.stringify({ error: 'unknown_tool', name })
    }
    const out = JSON.stringify(result)
    if (out.length > MAX_TOOL_OUTPUT_CHARS) {
      // Truncate the array fields rather than dropping them entirely so
      // the LLM still gets the headline numbers + a marker that more
      // detail exists. Cheaper than re-prompting for narrower args.
      return JSON.stringify({
        ...result,
        _truncated: true,
        _truncated_note: `Output capped at ${MAX_TOOL_OUTPUT_CHARS} chars — call with narrower filters for more detail.`,
        _original_size: out.length,
      }).slice(0, MAX_TOOL_OUTPUT_CHARS - 200) + '"}'
    }
    return out
  } catch (e: any) {
    return JSON.stringify({
      error:   'tool_execution_failed',
      tool:    name,
      message: String(e?.message ?? e).slice(0, 300),
    })
  }
}

/**
 * Run the Anthropic tool-use loop. Pass the initial API response; if
 * it contains tool_use blocks, execute them, append tool_result blocks,
 * call Anthropic again. Repeat until the response has only text or we
 * hit the iteration cap.
 *
 * Returns the final text answer + usage totals across all loop steps.
 */
export interface ToolLoopResult {
  answer:           string
  iterations:       number
  tools_called:     Array<{ name: string; args: any; result_chars: number }>
  total_input_tokens:  number
  total_output_tokens: number
  cache_hits?:         number
}

const MAX_LOOP_ITERATIONS = 5

export async function runToolLoop(
  ctx:        ToolContext,
  claude:     any,                       // Anthropic SDK client
  initialResponse: any,                  // first messages.create response
  requestBuilder:  (msgs: any[]) => Promise<any>, // rebuilds the next request with the conversation
  conversation:    any[],                // running messages array (mutated)
): Promise<ToolLoopResult> {
  const toolsCalled: ToolLoopResult['tools_called'] = []
  let totalInput  = (initialResponse.usage?.input_tokens  ?? 0)
  let totalOutput = (initialResponse.usage?.output_tokens ?? 0)

  let resp = initialResponse
  let iterations = 0

  while (iterations < MAX_LOOP_ITERATIONS) {
    const toolUseBlocks = (resp.content ?? []).filter((b: any) => b.type === 'tool_use')
    if (toolUseBlocks.length === 0) break

    iterations++

    // Append the assistant's message (which contains the tool_use blocks)
    conversation.push({ role: 'assistant', content: resp.content })

    // Execute each tool, build a single user message with tool_result blocks.
    const resultBlocks: any[] = []
    for (const block of toolUseBlocks) {
      const out = await runTool(ctx, block.name, block.input)
      toolsCalled.push({ name: block.name, args: block.input, result_chars: out.length })
      resultBlocks.push({
        type:        'tool_result',
        tool_use_id: block.id,
        content:     out,
      })
    }
    conversation.push({ role: 'user', content: resultBlocks })

    // Call Anthropic again with the augmented conversation
    resp = await requestBuilder(conversation)
    totalInput  += (resp.usage?.input_tokens  ?? 0)
    totalOutput += (resp.usage?.output_tokens ?? 0)
  }

  // Final answer = the text blocks of the last response
  const textBlocks = (resp.content ?? []).filter((b: any) => b.type === 'text')
  const answer = textBlocks.map((b: any) => b.text).join('\n').trim() || 'No response'

  return {
    answer,
    iterations,
    tools_called: toolsCalled,
    total_input_tokens:  totalInput,
    total_output_tokens: totalOutput,
  }
}
