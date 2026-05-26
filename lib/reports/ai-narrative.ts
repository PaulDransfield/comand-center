// lib/reports/ai-narrative.ts
//
// One shared AI call for every report type: given the report's figures +
// report-specific guidance, produce an executive summary + recommendations.
// Grounded in the numbers, soft-fails to null so the builder can template.

import { AI_MODELS }      from '@/lib/ai/models'
import { anthropicFetch } from '@/lib/ai/anthropic-fetch'
import { SCOPE_NOTE }     from '@/lib/ai/scope'

export interface ReportNarrative {
  summary:         string
  recommendations: Array<{ title: string; detail: string }>
}

export async function generateReportNarrative(opts: {
  reportKind:   string   // "margin report" | "cost breakdown" | "supplier spend report"
  businessName: string
  dataBlock:    string   // the figures, one per line
  guidance:     string   // report-specific benchmarks / instructions
}): Promise<ReportNarrative | null> {
  const SYSTEM = `You are a restaurant-group CFO advisor writing a short ${opts.reportKind} for an owner. ${SCOPE_NOTE}

Rules:
- Ground EVERY claim in the figures provided. Never invent a number.
- For labour, only recommend reducing or optimising hours — never speculatively adding cover.
- Recommendations must be concrete and actionable for a restaurant operator.
${opts.guidance}

Return JSON only:
{ "executive_summary": "2-3 sentences", "recommendations": [ { "title": "short imperative", "detail": "1-2 specific sentences" } ] }
(3-5 recommendations)`

  const result = await anthropicFetch({
    body: {
      model:      AI_MODELS.ANALYSIS,
      max_tokens: 2200,
      system:     SYSTEM,
      messages:   [{ role: 'user', content: `Business: ${opts.businessName}\n\n${opts.dataBlock}\n\nWrite the ${opts.reportKind}. JSON only.` }],
    },
  })
  if (!result.ok) return null
  try {
    const t = result.json?.content?.[0]?.text ?? ''
    const p = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1))
    if (!p.executive_summary) return null
    const recommendations = Array.isArray(p.recommendations)
      ? p.recommendations.filter((r: any) => r?.title).map((r: any) => ({ title: String(r.title).slice(0, 120), detail: String(r.detail ?? '').slice(0, 400) }))
      : []
    return { summary: String(p.executive_summary).slice(0, 900), recommendations }
  } catch {
    return null
  }
}
