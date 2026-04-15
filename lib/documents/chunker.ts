// lib/documents/chunker.ts
//
// Splits extracted document text into chunks for RAG retrieval.
// Each chunk is ~400 words with 60-word overlap for context continuity.
//
// Think of it like cutting a book into overlapping sections:
//   Chapter 1: pages 1-20
//   Chapter 2: pages 18-38  (2-page overlap with chapter 1)
//   Chapter 3: pages 36-56  (2-page overlap with chapter 2)
//
// The overlap ensures that if an answer spans a chunk boundary,
// at least one chunk will contain enough context to answer correctly.

export interface Chunk {
  index:    number    // position in document (0-based)
  text:     string    // the actual chunk content
  page:     number    // estimated page number
  section:  string    // detected section heading (if any)
  tokens:   number    // approximate token count
}

const TARGET_TOKENS  = 400   // target size of each chunk
const OVERLAP_TOKENS = 60    // how much to repeat between chunks
const AVG_CHARS_PER_TOKEN = 4  // rough approximation

export function chunkText(text: string, docType: string): Chunk[] {
  if (!text?.trim()) return []

  // Split into paragraphs first (respect natural boundaries)
  const paragraphs = text
    .split(/\n{2,}/)
    .map(p => p.trim())
    .filter(p => p.length > 0)

  const chunks: Chunk[] = []
  let currentChunk  = ''
  let currentSection = detectSection(paragraphs[0] ?? '')
  let chunkIndex    = 0
  let charCount     = 0
  let pageEstimate  = 1

  const TARGET_CHARS  = TARGET_TOKENS  * AVG_CHARS_PER_TOKEN  // ~1600 chars
  const OVERLAP_CHARS = OVERLAP_TOKENS * AVG_CHARS_PER_TOKEN  // ~240 chars

  for (const paragraph of paragraphs) {
    // Detect section headings
    const heading = detectSection(paragraph)
    if (heading) currentSection = heading

    // Update page estimate (roughly 3000 chars per page)
    charCount += paragraph.length
    pageEstimate = Math.max(1, Math.ceil(charCount / 3000))

    // Add paragraph to current chunk
    currentChunk += (currentChunk ? '\n\n' : '') + paragraph

    // If we've hit the target size, save this chunk and start a new one
    if (currentChunk.length >= TARGET_CHARS) {
      chunks.push({
        index:   chunkIndex++,
        text:    currentChunk.slice(0, TARGET_CHARS * 1.2),  // allow 20% overflow
        page:    pageEstimate,
        section: currentSection,
        tokens:  Math.ceil(currentChunk.length / AVG_CHARS_PER_TOKEN),
      })

      // Start next chunk with the overlap (last N chars of current chunk)
      const overlap = currentChunk.slice(-OVERLAP_CHARS)
      currentChunk  = overlap
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim().length > 50) {
    chunks.push({
      index:   chunkIndex,
      text:    currentChunk,
      page:    pageEstimate,
      section: currentSection,
      tokens:  Math.ceil(currentChunk.length / AVG_CHARS_PER_TOKEN),
    })
  }

  return chunks
}

// ── TF-IDF term extraction ────────────────────────────────────────
// Extracts the most important terms from a chunk for keyword search.
// TF-IDF = Term Frequency × Inverse Document Frequency
// In practice: find words that appear often in THIS chunk but not in all chunks.

export function extractTerms(text: string): Record<string, number> {
  // Tokenise: lowercase, remove punctuation, split on whitespace
  const words = text
    .toLowerCase()
    .replace(/[^\w\s\u00C0-\u024F]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .filter(w => !STOP_WORDS.has(w))

  // Count word frequencies
  const freq: Record<string, number> = {}
  for (const word of words) {
    freq[word] = (freq[word] ?? 0) + 1
  }

  // Normalise by chunk length
  const total = words.length || 1
  const tf: Record<string, number> = {}
  for (const [word, count] of Object.entries(freq)) {
    tf[word] = count / total
  }

  return tf
}

// ── TF-IDF retrieval ──────────────────────────────────────────────
// Score chunks against a query using simple keyword overlap.
// Returns chunks sorted by relevance score (highest first).

export function scoreChunks(
  query:  string,
  chunks: Array<{ text: string; terms: Record<string, number> }>,
  topK = 5,
): number[] {
  const queryWords = new Set(
    query.toLowerCase()
      .replace(/[^\w\s\u00C0-\u024F]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .filter(w => !STOP_WORDS.has(w))
  )

  const scores = chunks.map((chunk, i) => {
    let score = 0
    for (const word of queryWords) {
      score += chunk.terms[word] ?? 0
      // Also check for partial matches (Swedish compound words etc.)
      for (const [term, tf] of Object.entries(chunk.terms)) {
        if (term.includes(word) || word.includes(term)) {
          score += tf * 0.5
        }
      }
    }
    return { index: i, score }
  })

  return scores
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(s => s.score > 0)
    .map(s => s.index)
}

// ── Helpers ───────────────────────────────────────────────────────

function detectSection(text: string): string {
  const line = text.split('\n')[0].trim()
  // Detect headings: ALL CAPS, or starts with #, or short line followed by content
  if (/^#+\s/.test(line)) return line.replace(/^#+\s*/, '')
  if (line === line.toUpperCase() && line.length > 3 && line.length < 80) return line
  if (/^\d+\.\s+[A-Z]/.test(line)) return line
  return ''
}

const STOP_WORDS = new Set([
  'the','and','for','are','but','not','you','all','can','had','her','was','one',
  'our','out','day','get','has','him','his','how','man','new','now','old','see',
  'two','way','who','boy','did','its','let','put','say','she','too','use',
  'att','och','som','det','den','ett','för','med','till','från','inte','ska',
  'har','var','sig','men','när','han','hon','vid','mot','utan','eller','över',
  'under','efter','innan','sedan','detta','dessa','denna',
])
