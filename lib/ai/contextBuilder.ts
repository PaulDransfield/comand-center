// lib/ai/contextBuilder.ts
//
// Reusable context assembly for /api/ask and future AI surfaces that take a
// freeform question + structured data. Centralises two responsibilities that
// used to live inline in the ask route:
//
//   1. Truncate the caller's page-provided context to a sensible budget.
//   2. When the question asks about overheads/costs/subscriptions, enrich
//      with the last year of tracker_line_items (Fortnox-sourced) so Claude
//      can answer "why is rent high?" without every page having to prefetch
//      line items into its own summary.
//
// Returns the composed context string plus metadata about what was added
// and what was truncated, so the caller can log / surface that to the user
// if they want. Never throws — enrichment failures degrade to the base
// context unchanged.
//
// The dead lib/ai/buildContext.ts was an older, never-wired draft of this.
// This file replaces it. If you find buildContext.ts still lingering, it's
// safe to delete.

type Db = any

// Keywords that trigger overhead/cost enrichment. Matches both English and
// the Swedish file-label vocabulary Fortnox uses (lokalhyra, försäkring,
// prenumeration). Expand conservatively — false positives bloat the prompt.
export const COST_KEYWORDS = /\b(cost|overhead|overheads|subscription|subscribe|bank|fees|fee|rent|lokalhyra|software|saas|bokio|fortnox|insurance|försäkring|prenumeration|utilit|electric|marketing|accounting|audit|margin|other[_\s]cost|line[_\s]item)s?\b/i

export interface BuildContextOptions {
  /** Total prompt-context character budget. Default 6000 (~2 500 input tokens). */
  maxChars?: number
  /** How many of the maxChars to reserve for overhead enrichment. Default 1500. */
  enrichmentBudget?: number
  /** Pass the authorised orgId so we can filter line items by tenant. */
  orgId: string
  /** Business to scope line items to. Skip enrichment when null. */
  businessId: string | null
}

export interface BuiltContext {
  context: string
  baseTruncated: boolean
  enrichmentApplied: 'cost' | null
  enrichmentTruncated: boolean
  warnings: string[]
}

export async function buildAskContext(
  db: Db,
  rawContext: string,
  question: string,
  opts: BuildContextOptions,
): Promise<BuiltContext> {
  const maxChars        = opts.maxChars ?? 6000
  const enrichmentBudget = opts.enrichmentBudget ?? 1500
  const baseBudget      = maxChars - enrichmentBudget

  let context = (rawContext ?? '').trim()
  const warnings: string[] = []
  let baseTruncated = false

  if (context.length > baseBudget) {
    warnings.push(`context truncated — was ${context.length} chars, capped at ${baseBudget}`)
    context = context.slice(0, baseBudget) + '\n\n[context truncated for cost]'
    baseTruncated = true
  }

  let enrichmentApplied: 'cost' | null = null
  let enrichmentTruncated = false

  if (opts.businessId && COST_KEYWORDS.test(question)) {
    try {
      const yearFrom = new Date().getFullYear() - 1
      const { data: lines } = await db
        .from('tracker_line_items')
        .select('period_year, period_month, category, subcategory, label_sv, amount')
        .eq('org_id',      opts.orgId)
        .eq('business_id', opts.businessId)
        .eq('category',    'other_cost')
        .gte('period_year', yearFrom)
        .order('period_year', { ascending: false })
        .order('period_month', { ascending: false })
        .order('amount',      { ascending: false })
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
        // Flag the scope explicitly — Fortnox P&L is always business-wide.
        const block = `\n\nOverhead line items (other_cost, from Fortnox PDFs — BUSINESS-WIDE, not split by department):\n${formatted}`
        if (block.length > enrichmentBudget) {
          context += block.slice(0, enrichmentBudget) + '\n[line items truncated]'
          enrichmentTruncated = true
        } else {
          context += block
        }
        enrichmentApplied = 'cost'
      }
    } catch (e: any) {
      warnings.push('cost enrichment failed: ' + (e?.message ?? 'unknown'))
    }
  }

  return {
    context,
    baseTruncated,
    enrichmentApplied,
    enrichmentTruncated,
    warnings,
  }
}
