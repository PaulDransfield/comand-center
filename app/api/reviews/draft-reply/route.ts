// app/api/reviews/draft-reply/route.ts
//
// Generate an AI reply to a Google review. Uses Haiku 4.5 (AGENT tier)
// — cheap, fast, plenty good enough for owner-curated review replies.
//
// Three tones:
//   - 'warm'         (default) — friendly, personal, thanks them by name,
//                                acknowledges a specific theme
//   - 'professional' — measured, brand-voice, courteous
//   - 'apologetic'   — for negative reviews; takes responsibility,
//                      promises action, no defensiveness
//
// Subject to the standard daily AI quota gate so an owner spamming
// "regenerate" on 50 reviews can't blow past the per-org limit.
//
// POST body:  { business_id, external_id, tone? }
// Response:   { draft: string, model: string, tokens_used: number }

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient, getRequestAuth } from '@/lib/supabase/server'
import { canAccessBusiness }                 from '@/lib/auth/permissions'
import { AI_MODELS }                         from '@/lib/ai/models'
import { checkAndIncrementAiLimit }          from '@/lib/ai/usage'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60   // Haiku 4.5 reply draft fits comfortably; explicit so plan changes don't silently shorten

type Tone = 'warm' | 'professional' | 'apologetic'
const ALLOWED_TONES: Tone[] = ['warm', 'professional', 'apologetic']

interface DraftBody {
  business_id?: string
  external_id?: string
  tone?:        Tone
}

const TONE_BRIEFS: Record<Tone, string> = {
  warm:
    'Warm, personal, friendly. Thank the reviewer by first name. Reference one specific positive theme they mentioned. ' +
    'End with a soft "see you again soon" or equivalent. 2–4 sentences. Never sound like a template.',
  professional:
    'Measured, brand-courteous tone. Thank the reviewer briefly. Acknowledge what they appreciated or noted. ' +
    'Maintain a polite, slightly formal voice. 2–3 sentences. Never sycophantic.',
  apologetic:
    'Take responsibility without defensiveness. Acknowledge their specific complaint. ' +
    'Briefly state what you will look into or how you handle similar feedback. Offer to make it right ' +
    '(invite them to email the manager or come back as a guest). No excuses, no blame on staff. 3–5 sentences.',
}

export async function POST(req: NextRequest) {
  noStore()

  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  const body: DraftBody = await req.json().catch(() => ({}))
  const businessId = String(body.business_id ?? '').trim()
  const externalId = String(body.external_id ?? '').trim()
  const tone: Tone = ALLOWED_TONES.includes(body.tone as Tone) ? (body.tone as Tone) : 'warm'

  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!externalId) return NextResponse.json({ error: 'external_id required' }, { status: 400 })

  const subject = {
    role:              auth.role as any,
    business_ids:      (auth as any).businessIds ?? null,
    can_view_finances: true,
  }
  if (!canAccessBusiness(subject, businessId)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const db = createAdminClient()

  // Quota gate (atomic increment — decrements on block so over-limit
  // rejects don't tick the counter).
  const quota = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!quota.ok) {
    return NextResponse.json(quota.body, { status: quota.status })
  }

  // Fetch the review (raw text + classified themes + business name for context)
  const [{ data: raw }, { data: themes }, { data: biz }] = await Promise.all([
    db.from('review_raw')
      .select('rating, text, author_name, language')
      .eq('business_id', businessId).eq('source', 'google_places').eq('external_id', externalId)
      .maybeSingle(),
    db.from('review_themes')
      .select('themes, sentiment, key_phrase, rating')
      .eq('business_id', businessId).eq('source', 'google_places').eq('external_id', externalId)
      .maybeSingle(),
    db.from('businesses')
      .select('name, city, country')
      .eq('id', businessId)
      .maybeSingle(),
  ])

  if (!raw && !themes) {
    return NextResponse.json({ error: 'Review not found or no longer cached' }, { status: 404 })
  }

  const reviewerName = raw?.author_name ?? 'guest'
  const rating       = raw?.rating ?? themes?.rating ?? null
  const reviewText   = raw?.text ?? '(review text expired from cache — write a polite generic reply that matches the rating)'
  const language     = raw?.language ?? 'en'
  const businessName = biz?.name ?? 'our restaurant'
  const themeSummary = themes?.key_phrase ?? null

  // Locale handling: reply in the reviewer's language when possible.
  // Owner-side UI language (aiLocaleFromRequest) is for fallback/legend
  // text, not the reply content itself — the reply goes back to the
  // reviewer on Google.
  const replyLang = (language === 'sv' || language === 'en') ? language : 'en'

  const systemPrompt = [
    `You are writing a public reply on behalf of "${businessName}" to a Google review.`,
    `Write in ${replyLang === 'sv' ? 'Swedish' : 'English'}.`,
    `Voice: ${TONE_BRIEFS[tone]}`,
    `Hard rules:`,
    `- Never invent specifics (don't promise a free meal, don't name staff, don't quote a dish you have no way to verify).`,
    `- Never repeat the review back verbatim.`,
    `- Never sign with "Best regards / The team at ${businessName}" or similar — just the message body.`,
    `- Max 4 sentences for warm/professional, 5 for apologetic.`,
  ].join('\n')

  const userMessage = [
    `Review by ${reviewerName} (rating: ${rating ?? 'unknown'} / 5):`,
    `"${reviewText}"`,
    themeSummary ? `\nAI-detected theme: ${themeSummary}` : '',
    `\nWrite the reply now. Plain text, no preamble, no quotation marks around the reply, no signature line.`,
  ].filter(Boolean).join('\n')

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'AI not configured' }, { status: 500 })

  let draft = ''
  let tokensUsed = 0
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:       AI_MODELS.AGENT,                // claude-haiku-4-5-20251001
        max_tokens:  400,
        system:      systemPrompt,
        messages:    [{ role: 'user', content: userMessage }],
      }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      return NextResponse.json({
        error:   'anthropic_call_failed',
        message: `HTTP ${res.status} — ${text.slice(0, 200)}`,
      }, { status: 502 })
    }
    const json: any = await res.json()
    draft = String(json?.content?.[0]?.text ?? '').trim()
    tokensUsed = (json?.usage?.input_tokens ?? 0) + (json?.usage?.output_tokens ?? 0)
  } catch (e: any) {
    return NextResponse.json({ error: 'anthropic_call_threw', message: String(e?.message ?? e) }, { status: 502 })
  }

  if (!draft) {
    return NextResponse.json({ error: 'empty_draft', message: 'AI returned no text. Try again.' }, { status: 502 })
  }

  return NextResponse.json({
    draft,
    tone,
    model:       AI_MODELS.AGENT,
    tokens_used: tokensUsed,
    quota_used:  quota.used,
    quota_limit: quota.limit,
  }, { headers: { 'Cache-Control': 'no-store, max-age=0, must-revalidate' } })
}
