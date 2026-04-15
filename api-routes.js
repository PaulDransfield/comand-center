/**
 * API ROUTES — copy each section to the correct Next.js path
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  pages/api/chat/index.js        — POST  main chat endpoint (streaming)
 *  pages/api/chat/usage.js        — GET   usage stats for current org
 *  pages/api/notebook/query.js    — POST  source-grounded notebook query
 *  pages/api/notebook/summarise.js— POST  document summarisation
 *  pages/api/notebook/audio.js    — POST  generate audio script
 *  pages/api/notebook/guide.js    — POST  generate study guide / briefing
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ══════════════════════════════════════════════════════════════════════════════
// pages/api/chat/index.js
// Main chat endpoint with SSE streaming
// ══════════════════════════════════════════════════════════════════════════════

import { chatStream, UsageLimitError } from '@/lib/ai/ai-service';
import { ragRetrieve }                  from '@/lib/ai/rag-service';
import { getAuthOrg }                   from '@/lib/auth/get-auth-org';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await getAuthOrg(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const { messages, notebookId, businessId } = req.body;
  if (!messages?.length) return res.status(400).json({ error: 'messages required' });

  // Set up SSE headers for streaming
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  const sendEvent = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Retrieve relevant context from RAG if notebook specified
    let context = null;
    let citations = [];
    if (notebookId || businessId) {
      const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
      if (lastUserMessage) {
        const retrieval = await ragRetrieve(
          auth.orgId,
          lastUserMessage.content || lastUserMessage.text,
          { notebookId, businessId, topK: 6 }
        );
        context   = retrieval.contextString;
        citations = retrieval.chunks;

        // Send citations before streaming the answer
        if (citations.length > 0) {
          sendEvent('citations', { chunks: citations.map(c => ({
            id:       c.id,
            docName:  c.docName,
            docId:    c.docId,
            text:     c.text.substring(0, 200) + '...',
            score:    c.score,
            page:     c.page,
          }))});
        }
      }
    }

    // Stream the AI response
    for await (const event of chatStream(auth.orgId, auth.userId, messages, { context, notebookId })) {
      if (event.type === 'delta') {
        sendEvent('delta', { text: event.text });
      }
      if (event.type === 'done') {
        sendEvent('done', { usage: event.usage });
      }
    }

  } catch (err) {
    if (err.code === 'USAGE_LIMIT') {
      sendEvent('error', {
        type:      'usage_limit',
        reason:    err.reason,
        plan:      err.plan,
        remaining: err.remaining,
        message:   err.message,
        upgrade_url: '/upgrade',
      });
    } else {
      console.error('Chat API error:', err);
      sendEvent('error', { type: 'server_error', message: 'AI service error. Please try again.' });
    }
  }

  res.end();
}


// ══════════════════════════════════════════════════════════════════════════════
// pages/api/chat/usage.js
// Returns usage stats for the current org — displayed in the UI
// ══════════════════════════════════════════════════════════════════════════════

import { checkUsageLimits } from '@/lib/ai/ai-service';
import { getAuthOrg }       from '@/lib/auth/get-auth-org';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const auth = await getAuthOrg(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const usage = await checkUsageLimits(auth.orgId);
  res.json(usage);
}


// ══════════════════════════════════════════════════════════════════════════════
// pages/api/notebook/query.js
// Source-grounded query — answers ONLY from uploaded documents
// ══════════════════════════════════════════════════════════════════════════════

import { chat }       from '@/lib/ai/ai-service';
import { ragRetrieve } from '@/lib/ai/rag-service';
import { getAuthOrg }  from '@/lib/auth/get-auth-org';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await getAuthOrg(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const { query, notebookId, topK = 6 } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });

  try {
    // Retrieve relevant chunks
    const { contextString, chunks } = await ragRetrieve(
      auth.orgId, query, { notebookId, topK }
    );

    if (!chunks.length) {
      return res.json({
        answer:    "I couldn't find relevant information in your uploaded documents for that question.",
        citations: [],
        usage:     null,
      });
    }

    // Get AI answer grounded in retrieved sources
    const response = await chat(
      auth.orgId,
      auth.userId,
      [{ role: 'user', content: query }],
      { context: contextString, notebookId }
    );

    res.json({
      answer:    response.content,
      citations: chunks.map(c => ({
        id:      c.id,
        docName: c.docName,
        docId:   c.docId,
        text:    c.text.substring(0, 300),
        page:    c.page,
        score:   Math.round(c.score * 100),
      })),
      usage: response.usage,
    });

  } catch (err) {
    if (err.code === 'USAGE_LIMIT') {
      return res.status(402).json({ error: err.message, reason: err.reason, plan: err.plan });
    }
    console.error('Notebook query error:', err);
    res.status(500).json({ error: 'Query failed. Please try again.' });
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// pages/api/notebook/audio.js
// Generates a podcast-style audio script, then converts with browser TTS
// or ElevenLabs
// ══════════════════════════════════════════════════════════════════════════════

import { generateAudioScript } from '@/lib/ai/ai-service';
import { getNotebookChunks }   from '@/lib/ai/rag-service';
import { getAuthOrg }          from '@/lib/auth/get-auth-org';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await getAuthOrg(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const { notebookId, format = 'deep_dive', focusPrompt } = req.body;
  if (!notebookId) return res.status(400).json({ error: 'notebookId required' });

  try {
    const chunks = await getNotebookChunks(auth.orgId, notebookId, { limit: 30 });
    if (!chunks.length) return res.status(400).json({ error: 'No documents in notebook' });

    const result = await generateAudioScript(auth.orgId, auth.userId, chunks, format);

    // Store the generated script
    const { data: saved } = await supabase.from('audio_overviews').insert({
      org_id:      auth.orgId,
      notebook_id: notebookId,
      format,
      script:      result.script,
      duration:    result.duration,
      created_at:  new Date().toISOString(),
    }).select().single();

    res.json({ ...result, id: saved.id });

  } catch (err) {
    if (err.code === 'USAGE_LIMIT') {
      return res.status(402).json({ error: err.message, reason: err.reason });
    }
    console.error('Audio script error:', err);
    res.status(500).json({ error: 'Failed to generate audio script' });
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// pages/api/notebook/guide.js
// Generates study guide / executive briefing from all sources
// ══════════════════════════════════════════════════════════════════════════════

import { generateStudyGuide } from '@/lib/ai/ai-service';
import { getNotebookChunks }  from '@/lib/ai/rag-service';
import { getAuthOrg }         from '@/lib/auth/get-auth-org';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const auth = await getAuthOrg(req);
  if (!auth) return res.status(401).json({ error: 'Not authenticated' });

  const { notebookId, topic } = req.body;

  try {
    const chunks  = await getNotebookChunks(auth.orgId, notebookId, { limit: 40 });
    const guide   = await generateStudyGuide(auth.orgId, auth.userId, chunks, topic);
    res.json({ guide });
  } catch (err) {
    if (err.code === 'USAGE_LIMIT') return res.status(402).json({ error: err.message });
    res.status(500).json({ error: 'Failed to generate guide' });
  }
}


// ══════════════════════════════════════════════════════════════════════════════
// lib/auth/get-auth-org.js
// Helper to extract org context from authenticated request
// ══════════════════════════════════════════════════════════════════════════════

import { createClient } from '@supabase/supabase-js';

export async function getAuthOrg(req) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return null;

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const { data: membership } = await supabase
    .from('organisation_members')
    .select('org_id, role')
    .eq('user_id', user.id)
    .single();

  if (!membership) return null;

  return { userId: user.id, orgId: membership.org_id, role: membership.role };
}
