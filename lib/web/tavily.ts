// lib/web/tavily.ts
//
// Thin client for the Tavily search API. Tavily is LLM-tuned web search
// — it returns clean text snippets ready for prompt inclusion instead
// of raw HTML. Used by the classification cascade as source #5 when
// OpenFoodFacts didn't find the GTIN and we need richer context than
// the product name alone.
//
// Pricing: ~$0.001 per search at the "basic" depth tier (where the
// classification cascade lives). A one-shot catalogue sweep on a
// 1000-product business runs ~$1 worst-case if every product needs
// web context; in practice most are already classified by the earlier
// cascade sources so the bill is closer to $0.10-0.30 per business.
//
// Key from process.env.TAVILY_API_KEY. Soft-fails (returns null) when
// the key is missing or the API errors — caller falls through to the
// name_llm last-resort source.

export interface TavilySearchResult {
  title:   string
  url:     string
  content: string                       // pre-cleaned snippet, ~200-400 chars
  score:   number                       // 0-1 relevance
}

export interface TavilyResponse {
  answer?:  string                      // when include_answer=true, a synthesised one-liner
  results:  TavilySearchResult[]
  query:    string
}

export interface TavilyOptions {
  search_depth?:   'basic' | 'advanced' // basic = cheaper + faster
  max_results?:    number               // default 5; cap at 10 for cost
  include_answer?: boolean              // default true — synthesised summary helps LLM
  topic?:          'general' | 'news'   // default 'general'
  signal?:         AbortSignal
}

const ENDPOINT = 'https://api.tavily.com/search'

/**
 * Run one Tavily search. Returns null when the API key isn't configured
 * or the request fails — the cascade caller treats null as "no signal"
 * and moves to the next source.
 */
export async function searchTavily(
  query: string,
  opts:  TavilyOptions = {},
): Promise<TavilyResponse | null> {
  const apiKey = process.env.TAVILY_API_KEY
  if (!apiKey) return null
  if (!query || !query.trim()) return null

  try {
    const res = await fetch(ENDPOINT, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query:          query.trim().slice(0, 400),
        search_depth:   opts.search_depth   ?? 'basic',
        max_results:    Math.min(opts.max_results ?? 5, 10),
        include_answer: opts.include_answer ?? true,
        topic:          opts.topic          ?? 'general',
      }),
      signal: opts.signal ?? AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const j: any = await res.json()
    return {
      answer:  j?.answer ?? undefined,
      results: Array.isArray(j?.results) ? j.results.map((r: any) => ({
        title:   String(r.title ?? '').slice(0, 200),
        url:     String(r.url   ?? ''),
        content: String(r.content ?? '').slice(0, 500),
        score:   Number(r.score   ?? 0),
      })) : [],
      query:   j?.query ?? query,
    }
  } catch {
    return null
  }
}

/**
 * Build a search query targeted at restaurant-product classification.
 * Includes brand when known and Sweden context to bias toward
 * Swedish-language sources.
 */
export function buildClassificationQuery(
  productName: string,
  brand?:      string | null,
): string {
  const parts = [productName.trim()]
  if (brand && !productName.toLowerCase().includes(brand.toLowerCase())) {
    parts.push(brand.trim())
  }
  parts.push('Sweden grocery food category')
  return parts.join(' ')
}
