// lib/reviews/classifier.ts
//
// LLM classification of restaurant reviews into structured themes +
// sentiment. Uses Haiku 4.5 with tool-use for guaranteed-shape output —
// regex-JSON parsing is not robust enough across Swedish/English mixed
// reviews.

import { AI_MODELS } from '@/lib/ai/models'
//
// Input  : verbatim review text + star rating + language code
// Output : per-category polarity + confidence + pull-quote, overall
//          sentiment score, and one key_phrase for the surface UI
//
// Categories are FIXED — the model picks from this list, anything not
// mentioned is omitted from the output. This keeps the rollup queries
// simple (count(*) where themes ? 'food.negative' etc.).

const CATEGORIES = [
  'food',         // taste / quality / consistency / specific dishes
  'service',      // staff attentiveness, speed, professionalism
  'atmosphere',   // ambience, decor, lighting, music
  'value',        // price vs experience
  'wait',         // wait for table / drinks / food / bill
  'cleanliness',  // restaurant + bathroom cleanliness
  'noise',        // ambient noise level when explicitly mentioned
  'booking',      // reservation issues
  'staff',        // attitude, friendliness, knowledge (vs 'service' = speed)
] as const

export type ReviewCategory = typeof CATEGORIES[number]

export interface ClassifiedTheme {
  polarity:   '+' | '-' | '~'   // ~ = mixed / neutral mention
  confidence: number             // 0..1, model's stated certainty
  phrase:     string             // short pull quote (≤ 120 chars), translated to English
}

export interface ReviewClassification {
  themes:     Partial<Record<ReviewCategory, ClassifiedTheme>>
  sentiment:  number            // -1..1, overall
  key_phrase: string            // one-sentence English summary suitable for UI chip
  language:   string            // detected language code (sv/en/de/...)
  // For telemetry / cost tracking
  input_tokens:  number
  output_tokens: number
  model:         string
  ms:            number
}

const MODEL = AI_MODELS.AGENT
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'

const SYSTEM_PROMPT = `You classify restaurant reviews into structured themes for an operator dashboard.

Categories (use only these):
${CATEGORIES.map(c => `  - ${c}`).join('\n')}

Rules:
- Only include categories the review actually mentions. Omit silent ones.
- polarity: "+" = positive mention, "-" = negative mention, "~" = mixed.
- confidence: how clear the mention is (0.5 = ambiguous, 0.9 = explicit).
- phrase: ≤ 120 chars, ENGLISH translation if review is in another language, ≤ 1 sentence, capture the specific complaint or praise. Strip personal names.
- sentiment: overall -1 (very bad) to 1 (very good). Anchor on rating but adjust for tone.
- key_phrase: one-sentence ENGLISH summary an operator can paste into a meeting. ≤ 140 chars.
- language: detected ISO-639-1 code of the original review.

Swedish operators read reviews in Swedish, English, German, Norwegian — translate phrases/key_phrase to English so they're comparable across languages.

If the review is empty, very short, or only a rating with no text, return empty themes and sentiment based on the star rating alone (1=-0.8, 2=-0.4, 3=0, 4=0.4, 5=0.8).`

const TOOL_SCHEMA = {
  name: 'classify_review',
  description: 'Emit structured classification for a single restaurant review.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['themes', 'sentiment', 'key_phrase', 'language'],
    properties: {
      themes: {
        type: 'object',
        description: 'One entry per category the review mentions. Omit silent categories.',
        additionalProperties: false,
        properties: CATEGORIES.reduce((acc, c) => {
          acc[c] = {
            type: 'object',
            additionalProperties: false,
            required: ['polarity', 'confidence', 'phrase'],
            properties: {
              polarity:   { type: 'string', enum: ['+', '-', '~'] },
              confidence: { type: 'number', minimum: 0, maximum: 1 },
              phrase:     { type: 'string', maxLength: 120 },
            },
          }
          return acc
        }, {} as Record<string, any>),
      },
      sentiment:  { type: 'number', minimum: -1, maximum: 1 },
      key_phrase: { type: 'string', maxLength: 140 },
      language:   { type: 'string', minLength: 2, maxLength: 5 },
    },
  },
}

export async function classifyReview(input: {
  text:         string | null
  rating:       number | null
  language?:    string | null
  business_name?: string
}): Promise<ReviewClassification | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.warn('[reviews/classifier] ANTHROPIC_API_KEY missing — skip')
    return null
  }

  const text = (input.text ?? '').trim()
  // Short-circuit empty reviews — synthesise from rating, save a token spend
  if (text.length < 5) {
    const r = input.rating ?? 3
    const sentiment = r === 5 ? 0.8 : r === 4 ? 0.4 : r === 3 ? 0 : r === 2 ? -0.4 : -0.8
    return {
      themes:        {},
      sentiment,
      key_phrase:    `Rating only (${r}★)`,
      language:      input.language ?? 'unknown',
      input_tokens:  0,
      output_tokens: 0,
      model:         'rating-only',
      ms:            0,
    }
  }

  const userMessage = [
    input.business_name ? `Restaurant: ${input.business_name}` : null,
    input.rating != null ? `Rating: ${input.rating}/5` : null,
    input.language ? `Reported language: ${input.language}` : null,
    'Review:',
    text,
  ].filter(Boolean).join('\n')

  const t0 = Date.now()
  let r: Response
  try {
    r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type':       'application/json',
        'x-api-key':          apiKey,
        'anthropic-version':  '2023-06-01',
      },
      body: JSON.stringify({
        model:       MODEL,
        max_tokens:  800,
        system:      SYSTEM_PROMPT,
        tools:       [TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'classify_review' },
        messages:    [{ role: 'user', content: userMessage }],
      }),
    })
  } catch (e: any) {
    console.warn('[reviews/classifier] fetch error:', e?.message ?? e)
    return null
  }

  const ms = Date.now() - t0
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    console.warn(`[reviews/classifier] ${r.status}: ${body.slice(0, 200)}`)
    return null
  }

  const json = await r.json().catch(() => null) as any
  if (!json) return null

  const toolUse = (json.content ?? []).find((c: any) => c.type === 'tool_use')
  if (!toolUse?.input) {
    console.warn('[reviews/classifier] no tool_use block in response')
    return null
  }

  const parsed = toolUse.input
  // Defence-in-depth — re-validate types we depend on
  const themes: Partial<Record<ReviewCategory, ClassifiedTheme>> = {}
  if (parsed.themes && typeof parsed.themes === 'object') {
    for (const cat of CATEGORIES) {
      const t = parsed.themes[cat]
      if (!t) continue
      if (!['+', '-', '~'].includes(t.polarity)) continue
      const conf = Number(t.confidence)
      if (!Number.isFinite(conf) || conf < 0 || conf > 1) continue
      themes[cat] = {
        polarity:   t.polarity,
        confidence: conf,
        phrase:     String(t.phrase ?? '').slice(0, 120),
      }
    }
  }
  const sentiment = clamp(Number(parsed.sentiment ?? 0), -1, 1)

  return {
    themes,
    sentiment,
    key_phrase:    String(parsed.key_phrase ?? '').slice(0, 140),
    language:      String(parsed.language ?? input.language ?? 'unknown'),
    input_tokens:  json.usage?.input_tokens  ?? 0,
    output_tokens: json.usage?.output_tokens ?? 0,
    model:         MODEL,
    ms,
  }
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.min(hi, Math.max(lo, n))
}

export { CATEGORIES }
