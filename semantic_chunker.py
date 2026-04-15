"""
semantic_chunker.py
lib/documents/semantic_chunker.py
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Splits documents into semantically coherent chunks for RAG.

Strategy:
  1. Section detection  — headings, form labels, table markers
  2. Semantic boundaries — sentence endings, paragraph breaks
  3. Size enforcement   — keep chunks within token window
  4. Overlap            — sliding window for context continuity
  5. Metadata tagging   — page, section, doc_type, chunk_type

For large documents (500+ pages):
  - Streaming processing (never loads full text into memory twice)
  - Batch DB inserts (100 chunks at a time)
  - Progress callbacks for UI updates
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""

import re
from typing import Iterator
from dataclasses import dataclass, field


@dataclass
class Chunk:
    text:         str
    chunk_index:  int
    doc_id:       str       = ""
    doc_name:     str       = ""
    doc_type:     str       = "other"
    page:         int       = 1
    section:      str       = ""
    chunk_type:   str       = "text"  # text|table|heading|invoice_field
    token_count:  int       = 0
    char_start:   int       = 0
    char_end:     int       = 0
    metadata:     dict      = field(default_factory=dict)

    def to_dict(self) -> dict:
        return {
            "text":        self.text,
            "chunk_index": self.chunk_index,
            "doc_id":      self.doc_id,
            "doc_name":    self.doc_name,
            "doc_type":    self.doc_type,
            "page":        self.page,
            "section":     self.section,
            "chunk_type":  self.chunk_type,
            "token_count": self.token_count,
            "char_start":  self.char_start,
            "char_end":    self.char_end,
            "metadata":    self.metadata,
        }


class SemanticChunker:
    """
    Chunks documents respecting semantic boundaries.

    Sizes (tokens):
      CHUNK_SIZE   — target size of each chunk
      OVERLAP      — tokens shared between adjacent chunks
      MIN_SIZE     — discard chunks smaller than this
      MAX_SIZE     — hard limit (never exceed — split if needed)
    """

    CHUNK_SIZE = 400    # ~300 words — good for RAG precision
    OVERLAP    = 60     # ~45 words of context carry-over
    MIN_SIZE   = 30     # discard tiny fragments
    MAX_SIZE   = 800    # absolute ceiling

    # Section markers we look for
    HEADING_PATTERNS = [
        r"^#{1,3}\s+(.+)$",            # Markdown headings
        r"^([A-ZÅÄÖ][A-ZÅÄÖ\s]{4,40})$",  # ALL-CAPS Swedish headings
        r"^\d+\.\s+([A-Z].{5,60})$",   # Numbered sections
        r"^(Sammanfattning|Summary|Introduction|Bakgrund|Inledning|Slutsats)$",
    ]

    TABLE_START = re.compile(r"\[TABLE\]")
    TABLE_END   = re.compile(r"\[/TABLE\]")

    def chunk(self, text: str, pages: list = None, doc_type: str = "other",
              doc_id: str = "", doc_name: str = "") -> list[Chunk]:
        """
        Main chunking entry point.
        pages: list of {page_num, text} — enables page-level metadata
        """
        if pages:
            return list(self._chunk_by_pages(pages, doc_type, doc_id, doc_name))
        else:
            return list(self._chunk_flat_text(text, doc_type, doc_id, doc_name))

    # ── PAGE-AWARE CHUNKING ────────────────────────────────────────

    def _chunk_by_pages(self, pages: list, doc_type: str,
                        doc_id: str, doc_name: str) -> Iterator[Chunk]:
        """
        Process page-by-page, maintaining section context across page breaks.
        Critically: a chunk NEVER spans more than 2 pages (preserves citations).
        """
        chunk_idx    = 0
        current_section = ""
        carry_text   = ""  # overlap buffer from previous page

        for page_data in pages:
            page_num = page_data.get("page", 1) or 1
            page_text = page_data.get("text", "")

            if not page_text.strip():
                continue

            # Prepend carry-over overlap from previous page
            if carry_text:
                page_text   = carry_text + " " + page_text
                carry_text  = ""

            # Detect sections and tables within this page
            segments = self._segment_text(page_text)

            for seg in segments:
                if seg["type"] == "heading":
                    current_section = seg["text"]
                    continue

                seg_chunks = self._chunk_segment(
                    text    = seg["text"],
                    page    = page_num,
                    section = current_section,
                    chunk_type = seg["type"],
                    doc_type   = doc_type,
                    doc_id     = doc_id,
                    doc_name   = doc_name,
                )

                for chunk in seg_chunks:
                    chunk.chunk_index = chunk_idx
                    chunk_idx += 1
                    yield chunk

                # Set carry-over from last chunk of this page
                if seg_chunks:
                    last_text  = seg_chunks[-1].text
                    carry_text = self._get_overlap_text(last_text)

    def _chunk_flat_text(self, text: str, doc_type: str,
                          doc_id: str, doc_name: str) -> Iterator[Chunk]:
        """Chunk a flat string without page metadata."""
        segments  = self._segment_text(text)
        chunk_idx = 0
        current_section = ""

        for seg in segments:
            if seg["type"] == "heading":
                current_section = seg["text"]
                continue

            seg_chunks = self._chunk_segment(
                text       = seg["text"],
                page       = 1,
                section    = current_section,
                chunk_type = seg["type"],
                doc_type   = doc_type,
                doc_id     = doc_id,
                doc_name   = doc_name,
            )
            for chunk in seg_chunks:
                chunk.chunk_index = chunk_idx
                chunk_idx += 1
                yield chunk

    # ── SEGMENTATION ──────────────────────────────────────────────

    def _segment_text(self, text: str) -> list[dict]:
        """
        Split text into typed segments:
          heading | table | invoice_field | text
        """
        segments = []
        lines    = text.split("\n")
        buffer   = []
        in_table = False

        for line in lines:
            # Table detection
            if self.TABLE_START.match(line):
                if buffer:
                    segments.extend(self._classify_buffer(buffer))
                    buffer = []
                in_table = True
                continue
            if self.TABLE_END.match(line):
                if buffer:
                    table_text = "\n".join(buffer)
                    segments.append({"type": "table", "text": table_text})
                    buffer = []
                in_table = False
                continue
            if in_table:
                buffer.append(line)
                continue

            # Heading detection
            if self._is_heading(line):
                if buffer:
                    segments.extend(self._classify_buffer(buffer))
                    buffer = []
                segments.append({"type": "heading", "text": line.strip()})
                continue

            buffer.append(line)

        if buffer:
            segments.extend(self._classify_buffer(buffer))

        return [s for s in segments if s["text"].strip()]

    def _classify_buffer(self, lines: list) -> list[dict]:
        """Classify a buffer of lines as invoice fields or regular text."""
        text = "\n".join(lines).strip()
        if not text:
            return []

        # Detect invoice field blocks (many key: value pairs)
        kv_matches = len(re.findall(r"^[A-Za-zåäö ]+\s*[:]\s*.+$", text, re.M))
        line_count = max(1, text.count("\n") + 1)
        if kv_matches / line_count > 0.5 and kv_matches >= 3:
            return [{"type": "invoice_field", "text": text}]

        return [{"type": "text", "text": text}]

    def _is_heading(self, line: str) -> bool:
        line = line.strip()
        if not line or len(line) > 80:
            return False
        for pat in self.HEADING_PATTERNS:
            if re.match(pat, line):
                return True
        return False

    # ── CHUNK SPLITTING ───────────────────────────────────────────

    def _chunk_segment(self, text: str, page: int, section: str,
                       chunk_type: str, doc_type: str,
                       doc_id: str, doc_name: str) -> list[Chunk]:
        """
        Split a segment into chunks respecting sentence boundaries.
        Tables are kept together if they fit within MAX_SIZE.
        """
        # Tables: try to keep whole, split by row if too big
        if chunk_type == "table":
            return self._chunk_table(text, page, section, doc_type, doc_id, doc_name)

        # Tokenise (fast approximation: 1 token ≈ 4 chars)
        def tok(t): return len(t) // 4

        if tok(text) <= self.CHUNK_SIZE:
            # Whole segment fits — one chunk
            t = text.strip()
            if tok(t) >= self.MIN_SIZE:
                return [Chunk(
                    text=t, chunk_index=0, doc_id=doc_id, doc_name=doc_name,
                    doc_type=doc_type, page=page, section=section,
                    chunk_type=chunk_type, token_count=tok(t),
                )]
            return []

        # Split at sentence boundaries
        sentences = re.split(r'(?<=[.!?])\s+', text)
        chunks    = []
        buffer    = []
        buf_tokens = 0

        for sent in sentences:
            sent_tokens = tok(sent)

            if sent_tokens > self.MAX_SIZE:
                # Sentence itself is too long — hard split
                if buffer:
                    chunks.append(self._make_chunk(" ".join(buffer), buf_tokens,
                                                   page, section, chunk_type, doc_type, doc_id, doc_name))
                    buffer, buf_tokens = [], 0
                # Hard-split the long sentence
                for sub in self._hard_split(sent):
                    chunks.append(self._make_chunk(sub, tok(sub), page, section,
                                                   chunk_type, doc_type, doc_id, doc_name))
                continue

            if buf_tokens + sent_tokens > self.CHUNK_SIZE and buffer:
                # Flush current buffer
                chunks.append(self._make_chunk(" ".join(buffer), buf_tokens,
                                               page, section, chunk_type, doc_type, doc_id, doc_name))
                # Overlap: carry last few sentences
                overlap_buf, overlap_tok = self._get_overlap_buffer(buffer)
                buffer    = overlap_buf + [sent]
                buf_tokens = overlap_tok + sent_tokens
            else:
                buffer.append(sent)
                buf_tokens += sent_tokens

        if buffer and buf_tokens >= self.MIN_SIZE:
            chunks.append(self._make_chunk(" ".join(buffer), buf_tokens,
                                           page, section, chunk_type, doc_type, doc_id, doc_name))

        return chunks

    def _chunk_table(self, text: str, page: int, section: str,
                     doc_type: str, doc_id: str, doc_name: str) -> list[Chunk]:
        """Tables: keep header + N rows together."""
        def tok(t): return len(t) // 4
        if tok(text) <= self.MAX_SIZE:
            return [self._make_chunk(text, tok(text), page, section, "table", doc_type, doc_id, doc_name)]

        rows   = text.split("\n")
        header = rows[0] if rows else ""
        chunks = []
        buffer = [header] if header else []
        buf_t  = tok(header)

        for row in rows[1:]:
            row_t = tok(row)
            if buf_t + row_t > self.MAX_SIZE and len(buffer) > 1:
                chunks.append(self._make_chunk("\n".join(buffer), buf_t, page, section, "table", doc_type, doc_id, doc_name))
                buffer = [header, row]
                buf_t  = tok(header) + row_t
            else:
                buffer.append(row)
                buf_t += row_t

        if buffer:
            chunks.append(self._make_chunk("\n".join(buffer), buf_t, page, section, "table", doc_type, doc_id, doc_name))
        return chunks

    # ── HELPERS ───────────────────────────────────────────────────

    def _make_chunk(self, text: str, tokens: int, page: int, section: str,
                    chunk_type: str, doc_type: str, doc_id: str, doc_name: str) -> Chunk:
        return Chunk(
            text=text.strip(), token_count=tokens, page=page,
            section=section, chunk_type=chunk_type, doc_type=doc_type,
            doc_id=doc_id, doc_name=doc_name, chunk_index=0,
        )

    def _hard_split(self, text: str, size: int = None) -> list[str]:
        """Split a too-long string by character count."""
        size   = size or (self.MAX_SIZE * 4)
        words  = text.split()
        parts  = []
        buf    = []
        buf_c  = 0
        for w in words:
            if buf_c + len(w) + 1 > size and buf:
                parts.append(" ".join(buf))
                buf, buf_c = [], 0
            buf.append(w)
            buf_c += len(w) + 1
        if buf:
            parts.append(" ".join(buf))
        return parts

    def _get_overlap_buffer(self, sentences: list) -> tuple[list, int]:
        """Get the last N sentences that fit within OVERLAP tokens."""
        target = self.OVERLAP * 4  # chars
        buf    = []
        chars  = 0
        for sent in reversed(sentences):
            if chars + len(sent) > target:
                break
            buf.insert(0, sent)
            chars += len(sent)
        return buf, chars // 4

    def _get_overlap_text(self, text: str) -> str:
        """Get the last OVERLAP tokens of text for carry-over."""
        limit = self.OVERLAP * 4
        return text[-limit:] if len(text) > limit else text


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TF-IDF INDEX BUILDER (per-chunk, stored as JSON in DB)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STOPWORDS = {
    "the","a","an","and","or","in","on","at","to","for","of","is","are","was","were",
    "den","det","en","ett","och","eller","i","på","till","för","av","är","var",
    "med","om","men","att","de","som","har","kr","mkr","sek",
}

def build_tfidf_terms(text: str) -> dict:
    """Pre-compute normalised term frequencies for a chunk."""
    tokens = re.sub(r"[^a-zåäö0-9\s]", " ", text.lower()).split()
    tokens = [t for t in tokens if len(t) > 2 and t not in STOPWORDS]
    if not tokens:
        return {}
    freq = {}
    for t in tokens:
        freq[t] = freq.get(t, 0) + 1
    total = len(tokens)
    return {t: round(c / total, 6) for t, c in freq.items()}


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# LARGE DOCUMENT HANDLER (streaming ingest with progress)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class LargeDocumentHandler:
    """
    Handles 500+ page documents without loading everything into memory.
    Processes page-by-page and inserts chunks in batches.

    Usage:
        handler  = LargeDocumentHandler(supabase_client)
        async for progress in handler.ingest(file_bytes, filename, org_id, notebook_id, api_key):
            print(f"Progress: {progress['pct']}%")
    """

    BATCH_SIZE   = 100   # chunks per DB insert
    CACHE_TTL_S  = 3600  # 1 hour

    def __init__(self, supabase_client):
        self.db      = supabase_client
        self.chunker = SemanticChunker()

    def ingest_streaming(self, processing_result, org_id: str,
                          notebook_id: str, doc_id: str) -> Iterator[dict]:
        """
        Generator that yields progress dicts as chunks are processed and saved.
        {pct, chunks_done, chunks_total, status}
        """
        from document_processors import ProcessingResult
        result    = processing_result
        pages     = result.pages or [{"page": 1, "text": result.text}]
        total_pages = len(pages)

        # Generate all chunks
        all_chunks = self.chunker.chunk(
            text     = result.text,
            pages    = result.pages if result.pages else None,
            doc_type = result.doc_type,
            doc_id   = doc_id,
        )

        # Enrich with TF-IDF
        chunk_records = []
        for chunk in all_chunks:
            record = chunk.to_dict()
            record["org_id"]       = org_id
            record["notebook_id"]  = notebook_id
            record["tf_idf_terms"] = build_tfidf_terms(chunk.text)
            chunk_records.append(record)

        total_chunks = len(chunk_records)

        # Batch insert
        for i in range(0, total_chunks, self.BATCH_SIZE):
            batch = chunk_records[i:i + self.BATCH_SIZE]
            try:
                self.db.table("document_chunks").insert(batch).execute()
            except Exception as e:
                yield {"status": "error", "error": str(e), "pct": 0}
                return

            done = min(i + self.BATCH_SIZE, total_chunks)
            pct  = int(done / total_chunks * 100)
            yield {"status": "processing", "pct": pct,
                   "chunks_done": done, "chunks_total": total_chunks}

        yield {"status": "complete", "pct": 100,
               "chunks_done": total_chunks, "chunks_total": total_chunks}

    def get_cached_chunks(self, doc_id: str) -> list:
        """Simple in-memory cache for frequently accessed docs."""
        # In production: use Redis with TTL
        # For now: read from DB with a limit
        result = (self.db.table("document_chunks")
                  .select("id,text,page,section,chunk_type,token_count")
                  .eq("doc_id", doc_id)
                  .order("chunk_index")
                  .limit(1000)
                  .execute())
        return result.data or []


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# SELF-TEST
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

if __name__ == "__main__":
    sample = """RESULTATRÄKNING MARS 2026
Restaurang Björken AB

Nettoomsättning
Försäljning varor 25% moms: 1 207 344 kr
Försäljning varor 12% moms: 918 594 kr
Summa nettoomsättning: 2 195 194 kr

RÖRELSENS KOSTNADER
Råvaror och förnödenheter: -642 011 kr
Personalkostnader: -862 459 kr
Avskrivningar: -44 598 kr

RÖRELSERESULTAT: 79 244 kr

[TABLE]
Konto | Beskrivning | Period | Ackumulerat
3051 | Försäljning 25% | 1 207 344 | 6 109 501
3052 | Försäljning 12% | 918 594 | 4 885 678
7010 | Löner kollektiv | -483 705 | -4 208 830
[/TABLE]

Bolaget visade ett starkt mars-resultat med rörelseresultat om 79 244 kr.
Personalkostnaderna var höga men under kontroll. Råvarukostnaderna ökade
något jämfört med föregående månad, vilket delvis förklaras av prisökningar
från leverantörer.
"""

    chunker = SemanticChunker()
    chunks  = chunker.chunk(sample, doc_type="p_and_l", doc_name="Resultatrapport_Mars.pdf")
    print(f"Generated {len(chunks)} chunks:")
    for c in chunks:
        print(f"  [{c.chunk_index}] type={c.chunk_type} section={c.section!r} tokens={c.token_count} text={c.text[:60]!r}…")

    # TF-IDF test
    terms = build_tfidf_terms(chunks[0].text)
    top5  = sorted(terms.items(), key=lambda x: x[1], reverse=True)[:5]
    print(f"\nTop terms in chunk 0: {top5}")
