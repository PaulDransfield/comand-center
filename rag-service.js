/**
 * rag-service.js
 * lib/ai/rag-service.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Retrieval-Augmented Generation pipeline.
 * Handles document ingestion, chunking, indexing, and retrieval.
 *
 * Architecture:
 *   1. Document upload → text extraction
 *   2. Text → chunks (500 tokens, 50 token overlap)
 *   3. Chunks → TF-IDF index (fast, free, no API needed)
 *   4. Query → retrieve top-K chunks → pass to AI
 *
 * Optionally upgrades to vector embeddings for better semantic search.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createClient } from '@supabase/supabase-js';
import { encode }       from 'gpt-tokenizer';    // npm install gpt-tokenizer
import pdfParse         from 'pdf-parse';          // npm install pdf-parse
import mammoth          from 'mammoth';             // npm install mammoth
import * as XLSX        from 'xlsx';               // npm install xlsx

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── DOCUMENT PROCESSING ───────────────────────────────────────────────────────

/**
 * ingestDocument(orgId, notebookId, file, metadata)
 * Full pipeline: file → text → chunks → stored in DB.
 */
export async function ingestDocument(orgId, notebookId, file, metadata = {}) {
  // Step 1: Extract text based on file type
  const text = await extractText(file);
  if (!text || text.trim().length < 10) {
    throw new Error('Could not extract text from document. Try uploading a text-based PDF.');
  }

  // Step 2: Save document record
  const { data: doc } = await supabase.from('notebook_documents').insert({
    org_id:       orgId,
    notebook_id:  notebookId,
    name:         file.name || metadata.name || 'Document',
    file_type:    getFileType(file.name),
    file_size:    file.size,
    word_count:   text.split(/\s+/).length,
    char_count:   text.length,
    extracted_text: text,
    is_pinned:    false,
    created_at:   new Date().toISOString(),
    metadata,
  }).select().single();

  // Step 3: Chunk the text
  const chunks = chunkText(text, {
    chunkSize:    500,   // tokens per chunk
    overlap:      50,    // overlap for context continuity
    docId:        doc.id,
    docName:      doc.name,
  });

  // Step 4: Store chunks with TF-IDF data
  const chunkRecords = chunks.map((chunk, idx) => ({
    org_id:      orgId,
    notebook_id: notebookId,
    doc_id:      doc.id,
    doc_name:    doc.name,
    chunk_index: idx,
    text:        chunk.text,
    token_count: chunk.tokens,
    page:        chunk.page || null,
    tf_idf_terms: buildTFIDFTerms(chunk.text),  // pre-computed term frequencies
    created_at:  new Date().toISOString(),
  }));

  // Batch insert chunks
  const BATCH = 100;
  for (let i = 0; i < chunkRecords.length; i += BATCH) {
    await supabase.from('document_chunks').insert(chunkRecords.slice(i, i + BATCH));
  }

  // Update doc chunk count
  await supabase.from('notebook_documents')
    .update({ chunk_count: chunks.length })
    .eq('id', doc.id);

  return { doc, chunkCount: chunks.length };
}

/**
 * extractText(file)
 * Extracts text from PDF, DOCX, XLSX, TXT, or image files.
 */
async function extractText(file) {
  const ext = file.name?.split('.').pop()?.toLowerCase() || '';

  // Get file buffer (works with both File objects and Express multer files)
  const buffer = file.buffer || Buffer.from(await file.arrayBuffer());

  switch (ext) {
    case 'pdf': {
      const result = await pdfParse(buffer);
      return result.text;
    }

    case 'docx':
    case 'doc': {
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    }

    case 'xlsx':
    case 'xls': {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      let text = '';
      workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        text += `\n=== Sheet: ${sheetName} ===\n`;
        text += XLSX.utils.sheet_to_csv(sheet);
      });
      return text;
    }

    case 'csv': {
      return buffer.toString('utf-8');
    }

    case 'txt':
    case 'md': {
      return buffer.toString('utf-8');
    }

    default:
      // Try as plain text
      const asText = buffer.toString('utf-8');
      if (asText.length > 10) return asText;
      throw new Error(`Unsupported file type: .${ext}`);
  }
}

// ── TEXT CHUNKING ─────────────────────────────────────────────────────────────

/**
 * chunkText(text, options)
 * Splits text into overlapping chunks for RAG retrieval.
 * Respects sentence boundaries for better coherence.
 */
function chunkText(text, { chunkSize = 500, overlap = 50, docId, docName }) {
  const chunks  = [];
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);

  let currentChunk = [];
  let currentTokens = 0;
  let pageEstimate  = 1;
  let charCount     = 0;

  for (const sentence of sentences) {
    const tokens = encode(sentence).length;

    // Estimate page number (rough: ~3000 chars per page)
    charCount += sentence.length;
    pageEstimate = Math.ceil(charCount / 3000);

    if (currentTokens + tokens > chunkSize && currentChunk.length > 0) {
      // Save current chunk
      chunks.push({
        text:   currentChunk.join(' '),
        tokens: currentTokens,
        page:   pageEstimate,
        docId,
        docName,
      });

      // Start new chunk with overlap (keep last few sentences)
      const overlapSentences = [];
      let overlapTokens = 0;
      for (let i = currentChunk.length - 1; i >= 0 && overlapTokens < overlap; i--) {
        overlapSentences.unshift(currentChunk[i]);
        overlapTokens += encode(currentChunk[i]).length;
      }
      currentChunk  = overlapSentences;
      currentTokens = overlapTokens;
    }

    currentChunk.push(sentence);
    currentTokens += tokens;
  }

  // Don't forget the last chunk
  if (currentChunk.length > 0) {
    chunks.push({ text: currentChunk.join(' '), tokens: currentTokens, page: pageEstimate, docId, docName });
  }

  return chunks;
}

// ── TF-IDF INDEX ──────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the','a','an','and','or','in','on','at','to','for','of','is','are','was',
  'were','be','been','have','has','had','will','would','could','should',
  'den','det','en','ett','och','eller','i','på','till','för','av','är','var',
  'med','om','men','att','de','som','har','kr','mkr',
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[^a-zåäö0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function buildTFIDFTerms(text) {
  const tokens = tokenize(text);
  const freq   = {};
  tokens.forEach(t => freq[t] = (freq[t] || 0) + 1);
  // Normalise by document length
  const result = {};
  Object.entries(freq).forEach(([term, count]) => {
    result[term] = count / tokens.length;
  });
  return result;
}

// ── RETRIEVAL ─────────────────────────────────────────────────────────────────

/**
 * ragRetrieve(orgId, query, options)
 * Main retrieval function. Returns top-K most relevant chunks.
 *
 * options.notebookId — filter to specific notebook
 * options.businessId — filter to business documents
 * options.topK       — number of chunks to return (default 6)
 * options.minScore   — minimum relevance score (0-1, default 0.05)
 */
export async function ragRetrieve(orgId, query, options = {}) {
  const { notebookId, businessId, topK = 6, minScore = 0.02 } = options;

  // Fetch candidate chunks from DB
  let dbQuery = supabase
    .from('document_chunks')
    .select('id, doc_id, doc_name, chunk_index, text, token_count, page, tf_idf_terms')
    .eq('org_id', orgId)
    .limit(500);  // limit to manageable set

  if (notebookId) dbQuery = dbQuery.eq('notebook_id', notebookId);

  const { data: chunks, error } = await dbQuery;
  if (error || !chunks?.length) return { contextString: '', chunks: [] };

  // Score each chunk against query
  const queryTerms = tokenize(query);
  const N          = chunks.length;

  // Compute IDF from this result set
  const df = {};
  chunks.forEach(chunk => {
    const terms = chunk.tf_idf_terms || {};
    Object.keys(terms).forEach(term => { df[term] = (df[term] || 0) + 1; });
  });

  // Score each chunk
  const scored = chunks.map(chunk => {
    const terms = chunk.tf_idf_terms || {};
    let score   = 0;
    queryTerms.forEach(qTerm => {
      const tf  = terms[qTerm] || 0;
      const idf = df[qTerm] ? Math.log(N / df[qTerm]) + 1 : 0;
      score += tf * idf;

      // Boost exact phrase matches
      if (chunk.text.toLowerCase().includes(qTerm)) score += 0.1;
    });

    // Boost recent documents slightly (pinned docs get a bigger boost)
    if (chunk.is_pinned) score *= 1.5;

    return { ...chunk, score };
  });

  // Sort by score and take top-K above threshold
  const topChunks = scored
    .filter(c => c.score > minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  if (!topChunks.length) return { contextString: '', chunks: [] };

  // Build context string for the AI prompt
  const contextString = topChunks
    .map((c, i) => `[Source ${i + 1}: ${c.doc_name}${c.page ? `, page ${c.page}` : ''}]\n${c.text}`)
    .join('\n\n---\n\n');

  return {
    contextString,
    chunks: topChunks.map(c => ({
      id:      c.id,
      docId:   c.doc_id,
      docName: c.doc_name,
      text:    c.text,
      page:    c.page,
      score:   Math.round(c.score * 100) / 100,
    })),
  };
}

/**
 * getNotebookChunks(orgId, notebookId, options)
 * Returns all chunks from a notebook (for audio/guide generation).
 */
export async function getNotebookChunks(orgId, notebookId, { limit = 40 } = {}) {
  const { data } = await supabase
    .from('document_chunks')
    .select('id, doc_id, doc_name, chunk_index, text, page')
    .eq('org_id', orgId)
    .eq('notebook_id', notebookId)
    .order('doc_id')
    .order('chunk_index')
    .limit(limit);

  return data || [];
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function getFileType(filename) {
  if (!filename) return 'unknown';
  return filename.split('.').pop()?.toLowerCase() || 'unknown';
}
