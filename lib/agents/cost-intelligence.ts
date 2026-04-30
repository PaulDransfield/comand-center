// lib/agents/cost-intelligence.ts
//
// Cost-intel agent — scans the last 6 months of tracker_line_items for a
// business and writes insight rows into cost_insights.  Haiku (cheap), one
// call per business run, ~$0.002/run.
//
// Categories of insight:
//   duplicate     — multiple overlapping tools (Bokio + Fortnox + Visma)
//   creep         — same vendor rising MoM >10% for 3+ months
//   outlier       — subcategory % of other_cost outside industry norms
//   renegotiation — stable monthly amount worth putting out to tender
//   one_off       — single-month spike that may be miscategorised

import { AI_MODELS, MAX_TOKENS }           from '@/lib/ai/models'
import { logAiRequest, checkAiLimit }      from '@/lib/ai/usage'
import { SCOPE_NOTE }                      from '@/lib/ai/scope'
import { localePromptFragment, resolveLocaleForOrg } from '@/lib/ai/locale'

export interface CostIntelInput {
  orgId:      string
  businessId: string
  db:         any    // SupabaseClient
}

export async function runCostIntel({ orgId, businessId, db }: CostIntelInput) {
  // Gate against the org's AI quota before burning tokens. Previously
  // this agent fired unconditionally after every Fortnox apply — a
  // batch-apply of 50 PDFs would burn 50 Haiku calls with no
  // per-org visibility or budget check.
  const gate = await checkAiLimit(db, orgId)
  if (!gate.ok) return { insights: [], reason: 'ai_limit_blocked' }

  // Pull the last 6 months of OTHER_COST line items
  const now = new Date()
  const sixMonthsAgoYear  = now.getFullYear()
  const sixMonthsAgoMonth = now.getMonth() - 5   // inclusive of current
  let yearFrom, monthFrom
  if (sixMonthsAgoMonth <= 0) {
    yearFrom  = sixMonthsAgoYear - 1
    monthFrom = sixMonthsAgoMonth + 12
  } else {
    yearFrom  = sixMonthsAgoYear
    monthFrom = sixMonthsAgoMonth
  }

  // Fetch all other_cost line items for the business from yearFrom onwards,
  // then filter in memory (keeps the SQL simple).
  const { data: lines } = await db
    .from('tracker_line_items')
    .select('period_year, period_month, subcategory, label_sv, amount, fortnox_account')
    .eq('org_id', orgId)
    .eq('business_id', businessId)
    .eq('category', 'other_cost')
    .gte('period_year', yearFrom)
    .order('period_year', { ascending: true })
    .order('period_month', { ascending: true })

  if (!lines?.length) return { insights: [], reason: 'no_data' }

  // Filter to the last-6-months window, AND exclude any line whose BAS
  // account sits in the 4000-series (cost of goods / food) or 7000-series
  // (staff) — older extractions could classify those as 'other_cost' by
  // mistake, which would make the cost-intel agent shout "subscription
  // creep!" about actual food purchases. See FIXES.md §0k.
  const recent = lines.filter((l: any) => {
    const acct = Number(l.fortnox_account ?? 0)
    if (acct >= 3000 && acct <= 4999) return false
    if (acct >= 7000 && acct <= 7999) return false
    if (l.period_year > yearFrom) return true
    if (l.period_year < yearFrom) return false
    return l.period_month >= monthFrom
  })
  if (!recent.length) return { insights: [], reason: 'no_recent' }

  // Roll up by label + month to feed the AI compact structured data
  const byLabelMonth: Record<string, Record<string, number>> = {}
  const bySub: Record<string, { label: string; total: number }> = {}
  for (const l of recent) {
    const key   = l.label_sv ?? 'unknown'
    const mkey  = `${l.period_year}-${String(l.period_month).padStart(2, '0')}`
    if (!byLabelMonth[key]) byLabelMonth[key] = {}
    byLabelMonth[key][mkey] = (byLabelMonth[key][mkey] ?? 0) + Number(l.amount ?? 0)
    const subKey = l.subcategory ?? 'other'
    if (!bySub[subKey]) bySub[subKey] = { label: subKey, total: 0 }
    bySub[subKey].total += Number(l.amount ?? 0)
  }

  const monthsInWindow = Array.from(new Set(recent.map((l: any) => `${l.period_year}-${String(l.period_month).padStart(2,'0')}`))).sort()
  const subcatSummary = Object.entries(bySub)
    .map(([k, v]) => ({ subcategory: k, total_kr: Math.round(v.total) }))
    .sort((a, b) => b.total_kr - a.total_kr)
  const totalOther = subcatSummary.reduce((s, x) => s + x.total_kr, 0)

  // Compact per-label MoM table (cap to 40 labels to keep input short)
  const labelRows = Object.entries(byLabelMonth)
    .slice(0, 40)
    .map(([label, months]) => {
      const row: Record<string, any> = { label }
      const monthMap = months as Record<string, number>
      for (const m of monthsInWindow) row[m as string] = Math.round(monthMap[m as string] ?? 0)
      return row
    })

  const prompt = `You are analysing 6 months of Swedish restaurant overhead line items to find cost-saving opportunities.

${SCOPE_NOTE}

Data window: ${monthsInWindow.join(', ')}
Business overhead total across window: ${totalOther} kr
Top subcategories: ${subcatSummary.slice(0, 8).map(s => `${s.subcategory}=${s.total_kr}`).join(', ')}

Per-label by month (kr):
${JSON.stringify(labelRows, null, 2)}

Return ONLY a JSON object with this exact shape and nothing else:

{
  "insights": [
    {
      "kind": "duplicate" | "creep" | "outlier" | "renegotiation" | "one_off",
      "tone": "bad" | "warning" | "good",
      "entity": "<what the insight is about — usually a label or subcategory name>",
      "message": "<≤120 chars, plain English, actionable — what + what to do>",
      "estimated_saving_kr_annual": 12000,   // rough SEK/year the owner could save if they act
      "evidence_labels": ["label1","label2"] // the Swedish label(s) the insight refers to
    }
  ]
}

Rules:
- Max 5 insights. Rank by biggest actionable saving first.
- "duplicate": two or more labels with overlapping function in the same period (e.g. two accounting tools).
- "creep": the same label has risen >10% over the 6-month window.
- "outlier": a subcategory is >2× an industry norm.  Software subs >2% of other_cost = outlier.  Bank fees >0.5% = outlier.
- "renegotiation": a label appears every month with near-identical amount — worth getting a quote.
- "one_off": one-month spike >3× the other months for the same label.
- Messages must be specific ("Bokio at 790 kr/mo since July"), not generic ("review your costs").
- If there's nothing actionable, return an empty insights array.

Output ONLY the JSON object.`

  const started = Date.now()
  // Hard cap on the Claude call — if it hangs, don't keep the parent
  // Vercel invocation alive.  AbortController is honoured by the SDK.
  const abort = new AbortController()
  const timeout = setTimeout(() => abort.abort(), 45_000)
  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const submitInsightsTool = {
      name: 'submit_cost_insights',
      description: 'Submit cost-intelligence findings.',
      input_schema: {
        type: 'object',
        properties: {
          insights: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                kind:        { type: 'string', description: 'e.g. "subscription_creep", "duplicate", "outlier"' },
                title:       { type: 'string' },
                description: { type: 'string' },
                impact_kr:   { type: 'number' },
                confidence:  { enum: ['low', 'medium', 'high'] },
              },
              required: ['kind', 'title', 'description'],
            },
          },
        },
        required: ['insights'],
      },
    }
    // Background-worker context: no request cookie. Look up the org
    // owner's saved locale so insight `title` + `description` strings
    // appear in the right language when surfaced.
    const ownerLocale = await resolveLocaleForOrg(db, orgId)
    const response  = await (client as any).messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: MAX_TOKENS.AGENT_RECOMMENDATION,
      tools:      [submitInsightsTool],
      tool_choice: { type: 'tool', name: 'submit_cost_insights' },
      system:     localePromptFragment(ownerLocale),
      messages:   [{ role: 'user', content: prompt }],
    }, { signal: abort.signal as any })
    const toolUse = (response.content ?? []).find((b: any) => b.type === 'tool_use')
    const parsed  = toolUse?.input

    if (!parsed) {
      console.warn('[cost-intel] tool_use missing from Haiku response')
      return { insights: [], reason: 'parse_error' }
    }

    const items = Array.isArray(parsed?.insights) ? parsed.insights : []
    if (!items.length) {
      // Clear any stale insights for this business if Claude now sees nothing actionable.
      await db.from('cost_insights').update({ dismissed_at: new Date().toISOString() })
        .eq('org_id', orgId).eq('business_id', businessId)
        .is('dismissed_at', null)
    } else {
      // Replace policy: dismiss existing, insert fresh. Keeps the UI crisp
      // and the agent idempotent — re-running doesn't stack up old rows.
      await db.from('cost_insights').update({ dismissed_at: new Date().toISOString() })
        .eq('org_id', orgId).eq('business_id', businessId)
        .is('dismissed_at', null)

      const rows = items.slice(0, 5).map((it: any) => ({
        org_id:                     orgId,
        business_id:                businessId,
        kind:                       ['duplicate','creep','outlier','renegotiation','one_off'].includes(it.kind) ? it.kind : 'outlier',
        tone:                       ['good','warning','bad'].includes(it.tone) ? it.tone : 'warning',
        entity:                     String(it.entity ?? '').slice(0, 80),
        message:                    String(it.message ?? '').slice(0, 240),
        estimated_saving_kr_annual: Number.isFinite(Number(it.estimated_saving_kr_annual)) ? Number(it.estimated_saving_kr_annual) : null,
        evidence:                   { labels: Array.isArray(it.evidence_labels) ? it.evidence_labels.slice(0, 10) : [], months: monthsInWindow },
      }))
      await db.from('cost_insights').insert(rows)
    }

    try {
      await logAiRequest(db, {
        org_id:        orgId,
        request_type:  'cost_intelligence',
        model:         AI_MODELS.AGENT,
        input_tokens:  response.usage?.input_tokens  ?? 0,
        output_tokens: response.usage?.output_tokens ?? 0,
        duration_ms:   Date.now() - started,
      })
    } catch {}

    return { insights: items, reason: 'ok' }
  } catch (e: any) {
    const aborted = abort.signal.aborted
    console.error('[cost-intel] Claude call failed:', aborted ? 'aborted (45s timeout)' : e?.message)
    return { insights: [], reason: aborted ? 'timeout' : 'error', error: e?.message }
  } finally {
    clearTimeout(timeout)
  }
}
