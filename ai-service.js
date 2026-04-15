/**
 * ai-service.js
 * lib/ai/ai-service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Central AI service. All calls to Anthropic go through here.
 * Your key. Your costs. Users never see credentials.
 *
 * Handles:
 *   - Token usage tracking per org
 *   - Monthly limits by subscription tier
 *   - Cost calculation and alerts
 *   - Rate limiting
 *   - Streaming responses
 * ─────────────────────────────────────────────────────────────────────────────
 */

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

// ── ANTHROPIC CLIENT ─────────────────────────────────────────────────────────
// Key is loaded from environment — never in code, never sent to frontend
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const supabase  = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── TIER LIMITS ───────────────────────────────────────────────────────────────
// Monthly token limits per subscription tier.
// 1M tokens with Claude Sonnet ≈ ~$3.00 input + ~$15.00 output
// These limits balance cost vs usefulness.

export const TIER_LIMITS = {
  trial: {
    monthly_tokens:    500_000,     // ~500 average queries
    monthly_requests:  200,
    max_doc_size_mb:   10,
    max_docs:          50,
    audio_overviews:   3,           // per month
    model:             'claude-haiku-4-5-20251001',   // cheaper for trials
  },
  starter: {
    monthly_tokens:    2_000_000,
    monthly_requests:  1_000,
    max_doc_size_mb:   25,
    max_docs:          200,
    audio_overviews:   20,
    model:             'claude-sonnet-4-6',
  },
  pro: {
    monthly_tokens:    10_000_000,
    monthly_requests:  5_000,
    max_doc_size_mb:   50,
    max_docs:          1_000,
    audio_overviews:   100,
    model:             'claude-sonnet-4-6',
  },
  enterprise: {
    monthly_tokens:    Infinity,
    monthly_requests:  Infinity,
    max_doc_size_mb:   100,
    max_docs:          Infinity,
    audio_overviews:   Infinity,
    model:             'claude-sonnet-4-6',
  },
};

// Cost per million tokens (USD) — update when Anthropic changes pricing
const TOKEN_COST = {
  'claude-haiku-4-5-20251001': { input: 0.25,  output: 1.25  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

// ── USAGE CHECK ───────────────────────────────────────────────────────────────

/**
 * checkUsageLimits(orgId)
 * Returns current usage and whether the org can make more requests.
 */
export async function checkUsageLimits(orgId) {
  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Get org plan
  const { data: org } = await supabase
    .from('organisations')
    .select('plan, is_active')
    .eq('id', orgId)
    .single();

  if (!org?.is_active) return { allowed: false, reason: 'account_inactive' };

  const limits = TIER_LIMITS[org.plan] || TIER_LIMITS.trial;

  // Get usage for current month
  const { data: usage } = await supabase
    .from('ai_usage')
    .select('total_tokens, total_requests')
    .eq('org_id', orgId)
    .eq('month', month)
    .maybeSingle();

  const usedTokens   = usage?.total_tokens   || 0;
  const usedRequests = usage?.total_requests || 0;

  const tokensRemaining   = limits.monthly_tokens   === Infinity
    ? Infinity : Math.max(0, limits.monthly_tokens   - usedTokens);
  const requestsRemaining = limits.monthly_requests === Infinity
    ? Infinity : Math.max(0, limits.monthly_requests - usedRequests);

  return {
    allowed:            tokensRemaining > 0 && requestsRemaining > 0,
    reason:             tokensRemaining === 0 ? 'token_limit' : requestsRemaining === 0 ? 'request_limit' : null,
    plan:               org.plan,
    limits,
    usage: {
      tokens:   usedTokens,
      requests: usedRequests,
      month,
    },
    remaining: {
      tokens:   tokensRemaining,
      requests: requestsRemaining,
      pct_used: limits.monthly_tokens === Infinity ? 0
        : Math.round(usedTokens / limits.monthly_tokens * 100),
    },
    model: limits.model,
  };
}

/**
 * recordUsage(orgId, userId, tokens, model, requestType)
 * Records token usage after a successful API call.
 */
export async function recordUsage(orgId, userId, { inputTokens, outputTokens, model, requestType = 'chat' }) {
  const now        = new Date();
  const month      = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const totalTokens = inputTokens + outputTokens;
  const costUsd    = calculateCost(inputTokens, outputTokens, model);

  // Upsert monthly aggregate
  await supabase.rpc('increment_ai_usage', {
    p_org_id:       orgId,
    p_month:        month,
    p_tokens:       totalTokens,
    p_input_tokens: inputTokens,
    p_output_tokens:outputTokens,
    p_requests:     1,
    p_cost_usd:     costUsd,
  });

  // Log individual request
  await supabase.from('ai_request_log').insert({
    org_id:        orgId,
    user_id:       userId,
    request_type:  requestType,
    model,
    input_tokens:  inputTokens,
    output_tokens: outputTokens,
    total_tokens:  totalTokens,
    cost_usd:      costUsd,
    created_at:    now.toISOString(),
  });

  // Check if usage spike alert needed (>80% of monthly limit in first 2 weeks)
  await checkSpikeAlert(orgId, month);
}

function calculateCost(inputTokens, outputTokens, model) {
  const rates = TOKEN_COST[model] || TOKEN_COST['claude-sonnet-4-6'];
  return (inputTokens / 1_000_000 * rates.input) + (outputTokens / 1_000_000 * rates.output);
}

async function checkSpikeAlert(orgId, month) {
  const { data: usage } = await supabase
    .from('ai_usage')
    .select('total_tokens, alerted_spike')
    .eq('org_id', orgId)
    .eq('month', month)
    .maybeSingle();

  if (!usage || usage.alerted_spike) return;

  const { data: org } = await supabase.from('organisations').select('plan').eq('id', orgId).single();
  const limits = TIER_LIMITS[org?.plan] || TIER_LIMITS.trial;
  if (limits.monthly_tokens === Infinity) return;

  const day     = new Date().getDate();
  const usagePct = usage.total_tokens / limits.monthly_tokens;

  // Alert if >80% used in first 2 weeks, or >95% at any time
  if ((day <= 14 && usagePct > 0.8) || usagePct > 0.95) {
    // Mark as alerted to avoid spam
    await supabase.from('ai_usage').update({ alerted_spike: true }).eq('org_id', orgId).eq('month', month);
    // In production: send email to admin
    console.warn(`USAGE SPIKE ALERT: org ${orgId} at ${Math.round(usagePct * 100)}% of monthly limit`);
    // TODO: await sendAdminAlert('usage_spike', { orgId, usagePct, plan: org.plan });
  }
}


// ── CORE AI CHAT ──────────────────────────────────────────────────────────────

/**
 * chat(orgId, userId, messages, options)
 * The main chat function. Returns a streaming response.
 *
 * options.context  — RAG context to inject (retrieved document chunks)
 * options.system   — override system prompt
 * options.notebook — notebook ID for source-grounding
 */
export async function chat(orgId, userId, messages, options = {}) {
  // Check limits before calling API
  const usageCheck = await checkUsageLimits(orgId);
  if (!usageCheck.allowed) {
    throw new UsageLimitError(usageCheck.reason, usageCheck.remaining, usageCheck.plan);
  }

  const model = usageCheck.model;

  // Build system prompt
  const systemPrompt = options.system || buildSystemPrompt(options.context, options.notebook);

  // Call Anthropic API
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4096,
    system:     systemPrompt,
    messages:   messages.map(m => ({
      role:    m.role === 'ai' || m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || m.text || '',
    })),
  });

  const { input_tokens, output_tokens } = response.usage;

  // Record usage asynchronously (don't block response)
  recordUsage(orgId, userId, {
    inputTokens:  input_tokens,
    outputTokens: output_tokens,
    model,
    requestType:  'chat',
  }).catch(console.error);

  return {
    content:      response.content[0].text,
    usage:        response.usage,
    model,
    stop_reason:  response.stop_reason,
  };
}

/**
 * chatStream(orgId, userId, messages, options)
 * Streaming version of chat. Returns an async generator.
 * Use with Server-Sent Events for real-time streaming to the UI.
 */
export async function* chatStream(orgId, userId, messages, options = {}) {
  const usageCheck = await checkUsageLimits(orgId);
  if (!usageCheck.allowed) throw new UsageLimitError(usageCheck.reason, usageCheck.remaining, usageCheck.plan);

  const model = usageCheck.model;
  const systemPrompt = options.system || buildSystemPrompt(options.context, options.notebook);

  const stream = anthropic.messages.stream({
    model,
    max_tokens: 4096,
    system:     systemPrompt,
    messages:   messages.map(m => ({
      role:    m.role === 'ai' || m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content || m.text || '',
    })),
  });

  let inputTokens = 0, outputTokens = 0;

  for await (const event of stream) {
    if (event.type === 'content_block_delta') {
      yield { type: 'delta', text: event.delta.text };
    }
    if (event.type === 'message_delta') {
      outputTokens = event.usage?.output_tokens || 0;
    }
    if (event.type === 'message_start') {
      inputTokens = event.message.usage?.input_tokens || 0;
    }
  }

  // Record usage after stream completes
  recordUsage(orgId, userId, { inputTokens, outputTokens, model, requestType: 'chat' }).catch(console.error);

  yield { type: 'done', usage: { inputTokens, outputTokens } };
}

function buildSystemPrompt(context, notebookId) {
  const base = `You are a business intelligence assistant for a restaurant management platform.
You have access to the user's uploaded documents and financial data.

CRITICAL RULES:
1. Only answer from the provided sources. Do not use external knowledge for specific financial figures.
2. Always cite your sources using [Source: filename, page/section].
3. If the answer is not in the sources, say "I don't have that information in your uploaded documents."
4. Format numbers in Swedish style (e.g. 505 900 kr, not $505,900).
5. Be specific and data-driven. Quote exact figures when available.`;

  if (!context) return base;

  return `${base}

SOURCES AVAILABLE FOR THIS QUERY:
═══════════════════════════════════════════════════════════
${context}
═══════════════════════════════════════════════════════════

Base your answer ONLY on the sources above. Cite each source you use.`;
}


// ── DOCUMENT PROCESSING ───────────────────────────────────────────────────────

/**
 * summariseDocument(orgId, userId, documentText, docName)
 * Generates a structured summary of a document.
 */
export async function summariseDocument(orgId, userId, documentText, docName) {
  const usageCheck = await checkUsageLimits(orgId);
  if (!usageCheck.allowed) throw new UsageLimitError(usageCheck.reason, usageCheck.remaining, usageCheck.plan);

  const prompt = `Summarise this document in Swedish for a restaurant manager.

Document: ${docName}
Content:
${documentText.substring(0, 100000)}  // limit to 100k chars

Provide:
1. A 2-3 sentence executive summary
2. 5 key figures or facts (bullet points)
3. 3 action items or recommendations based on this document

Format as JSON:
{
  "summary": "...",
  "key_facts": ["...", "..."],
  "actions": ["...", "..."]
}`;

  const response = await anthropic.messages.create({
    model:      usageCheck.model,
    max_tokens: 1024,
    messages:   [{ role: 'user', content: prompt }],
  });

  recordUsage(orgId, userId, {
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model:        usageCheck.model,
    requestType:  'summarise',
  }).catch(console.error);

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { summary: response.content[0].text, key_facts: [], actions: [] };
  }
}

/**
 * generateStudyGuide(orgId, userId, chunks, topic)
 * Creates a structured study guide / briefing document from source material.
 */
export async function generateStudyGuide(orgId, userId, chunks, topic = '') {
  const usageCheck = await checkUsageLimits(orgId);
  if (!usageCheck.allowed) throw new UsageLimitError(usageCheck.reason, usageCheck.remaining, usageCheck.plan);

  const context = chunks.map(c => `[${c.docName}]\n${c.text}`).join('\n\n---\n\n');

  const response = await anthropic.messages.create({
    model:  usageCheck.model,
    max_tokens: 3000,
    messages: [{
      role: 'user',
      content: `Create a comprehensive briefing document from these sources.
${topic ? `Focus on: ${topic}` : ''}

SOURCES:
${context}

Structure the briefing as:
# Executive Briefing: [Topic]

## Key Themes
[3-5 main themes from the sources]

## Critical Numbers
[All important financial figures with source citations]

## Analysis
[Synthesis of what the data means]

## Recommendations
[3-5 actionable recommendations]

## Sources Consulted
[List all source documents used]

Use [Source: filename] citations throughout.`,
    }],
  });

  recordUsage(orgId, userId, {
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model:        usageCheck.model,
    requestType:  'study_guide',
  }).catch(console.error);

  return response.content[0].text;
}

/**
 * generateAudioScript(orgId, userId, chunks, format)
 * Generates a podcast-style script from document sources.
 * format: 'deep_dive' | 'brief' | 'debate' | 'critique'
 *
 * The script is then passed to a TTS API (e.g. ElevenLabs or browser TTS).
 */
export async function generateAudioScript(orgId, userId, chunks, format = 'deep_dive') {
  const usageCheck = await checkUsageLimits(orgId);
  if (!usageCheck.allowed) throw new UsageLimitError(usageCheck.reason, usageCheck.remaining, usageCheck.plan);

  // Check audio overview limits
  const { data: audioCount } = await supabase
    .from('ai_request_log')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('request_type', 'audio_script')
    .gte('created_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString());

  const limits = TIER_LIMITS[usageCheck.plan];
  if ((audioCount || 0) >= limits.audio_overviews) {
    throw new UsageLimitError('audio_limit', { audio_overviews: 0 }, usageCheck.plan);
  }

  const formatInstructions = {
    deep_dive: 'Write a 10-15 minute deep-dive conversation between two hosts (Alex and Sam) who discuss the key insights. Include banter, examples, and connections between topics.',
    brief:     'Write a 90-second briefing from a single presenter covering only the most critical numbers and one key action.',
    debate:    'Write a structured debate between two hosts who take opposite views on the key findings and implications.',
    critique:  'Write a critical analysis from one host who questions the assumptions and highlights risks in the data.',
  };

  const context = chunks.slice(0, 20).map(c => `[${c.docName}]\n${c.text.substring(0, 2000)}`).join('\n\n---\n\n');

  const response = await anthropic.messages.create({
    model:      usageCheck.model,
    max_tokens: format === 'deep_dive' ? 3000 : 800,
    messages: [{
      role: 'user',
      content: `${formatInstructions[format]}

This is for a restaurant business intelligence platform. The audience is the restaurant owner.
Speak naturally, as if on a podcast. Use specific numbers from the sources.

SOURCES:
${context}

Format as a script with speaker labels:
ALEX: ...
SAM: ...

(or just HOST: ... for single-host formats)`,
    }],
  });

  recordUsage(orgId, userId, {
    inputTokens:  response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    model:        usageCheck.model,
    requestType:  'audio_script',
  }).catch(console.error);

  return {
    script:   response.content[0].text,
    format,
    duration: format === 'deep_dive' ? '10-15 min' : format === 'brief' ? '90 sec' : '5-8 min',
  };
}


// ── ERROR TYPES ───────────────────────────────────────────────────────────────

export class UsageLimitError extends Error {
  constructor(reason, remaining, plan) {
    const messages = {
      token_limit:   'Monthly AI token limit reached',
      request_limit: 'Monthly request limit reached',
      audio_limit:   'Monthly audio overview limit reached',
      account_inactive: 'Account is inactive',
    };
    super(messages[reason] || 'Usage limit reached');
    this.reason    = reason;
    this.remaining = remaining;
    this.plan      = plan;
    this.code      = 'USAGE_LIMIT';
  }
}
