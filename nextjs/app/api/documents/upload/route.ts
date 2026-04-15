// @ts-nocheck
// app/api/documents/upload/route.ts
// Simplified upload: extract text â†’ chunk â†’ store in DB (no Storage for now)

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'

const ALLOWED = new Set(['pdf','docx','xlsx','csv','txt','md'])

export async function POST(req: NextRequest) {
  console.log('Upload route called')

  // Auth
  const cookieName  = 'sb-llzmixkrysduztsvmfzi-auth-token'
  const cookieValue = req.cookies.get(cookieName)?.value
  if (!cookieValue) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let userId = '', orgId = ''
  try {
    // Handle both old eyJ (JWT array) and new sb_ cookie formats
    let accessToken = cookieValue
    if (cookieValue.startsWith('[') || cookieValue.startsWith('{')) {
      const parsed = JSON.parse(cookieValue)
      accessToken  = Array.isArray(parsed) ? parsed[0] : parsed.access_token
    }
    const db = createAdminClient()
    const { data: { user } } = await db.auth.getUser(accessToken)
    if (!user) return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
    userId = user.id
    const { data: m } = await db.from('organisation_members').select('org_id').eq('user_id', userId).single()
    if (!m) return NextResponse.json({ error: 'No org' }, { status: 404 })
    orgId = m.org_id
    console.log('Auth ok, orgId:', orgId)
  } catch (err: any) {
    console.error('Auth error:', err.message)
    return NextResponse.json({ error: 'Auth failed: ' + err.message }, { status: 401 })
  }

  // Parse form
  let formData: FormData
  try { formData = await req.formData() }
  catch (err: any) {
    console.error('FormData error:', err.message)
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }

  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file' }, { status: 400 })

  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  console.log('File:', file.name, 'ext:', ext, 'size:', file.size)

  if (!ALLOWED.has(ext)) return NextResponse.json({ error: 'File type not supported' }, { status: 400 })

  // Read buffer
  let buffer: Buffer
  try {
    const ab = await file.arrayBuffer()
    buffer   = Buffer.from(ab)
    console.log('Buffer read ok, bytes:', buffer.length)
  } catch (err: any) {
    console.error('Buffer error:', err.message)
    return NextResponse.json({ error: 'Read failed' }, { status: 500 })
  }

  // Extract text
  let text = '', docType = 'other'
  try {
    const result = await extractSimple(buffer, file.name, ext)
    text    = result.text.replace(/\u0000/g, '').replace(/\x00/g, '')  // strip null bytes PostgreSQL rejects
    docType = result.docType
    console.log('Extracted', text.length, 'chars, docType:', docType)
  } catch (err: any) {
    console.error('Extraction error:', err.message)
    text = '[Text extraction failed: ' + err.message + ']'
  }

  // Chunk the text
  const chunks = simpleChunk(text)
  console.log('Created', chunks.length, 'chunks')

  // Save document record
  const adminDb = createAdminClient()
  let docId = ''
  try {
    const { data: doc, error } = await adminDb
      .from('notebook_documents')
      .insert({
        org_id:         orgId,
        name:           file.name,
        file_type:      ext,
        file_size:      file.size,
        storage_path:   'pending',
        extracted_text: text.slice(0, 50000),
        chunk_count:    0,
        doc_type:       docType,
        is_pinned:      true,
      })
      .select('id')
      .single()

    if (error) {
      console.error('DB insert error:', error.message, error.details, error.hint)
      return NextResponse.json({ error: 'DB error: ' + error.message }, { status: 500 })
    }
    docId = doc.id
    console.log('Doc saved, id:', docId)
  } catch (err: any) {
    console.error('Save error:', err.message)
    return NextResponse.json({ error: 'Save failed: ' + err.message }, { status: 500 })
  }

  // Save chunks
  if (chunks.length > 0 && docId) {
    try {
      const rows = chunks.map((c, i) => ({
        org_id:      orgId,
        document_id: docId,
        chunk_index: i,
        content:     c.text,
        page_number: c.page,
        tfidf_terms: buildTerms(c.text),
      }))

      const { error } = await adminDb.from('document_chunks').insert(rows)
      if (error) {
        console.error('Chunk insert error:', error.message, error.details)
      } else {
        await adminDb.from('notebook_documents')
          .update({ chunk_count: chunks.length, indexed_at: new Date().toISOString() })
          .eq('id', docId)
        console.log('Chunks saved:', chunks.length)
      }
    } catch (err: any) {
      console.error('Chunk save error:', err.message)
    }
  }

  return NextResponse.json({
    id:       docId,
    name:     file.name,
    ext,
    size:     file.size,
    chunks:   chunks.length,
    pages:    Math.max(1, Math.ceil(text.length / 3000)),
    pinned:   true,
    doc_type: docType,
    summary:  text.slice(0, 200),
    processing: false,
  })
}

// Simple text extraction without external imports
async function extractSimple(buffer: Buffer, filename: string, ext: string) {
  let text = ''

  if (['txt','csv','md'].includes(ext)) {
    text = buffer.toString('utf8')
  } else if (ext === 'pdf') {
    // Use Claude Vision to extract text from PDF
    // This handles Swedish PDFs with custom font encoding that confuses text parsers
    try {
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      const client    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

      const base64 = buffer.toString('base64')

      const response = await client.messages.create({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: [
            {
              type:   'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            },
            {
              type: 'text',
              text: 'Extract ALL text from this document exactly as it appears. Preserve all numbers, account codes, Swedish text, and formatting. Output only the raw extracted text with no commentary.',
            },
          ],
        }],
      })

      text = response.content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')

      console.log('Claude Vision extracted', text.length, 'chars')
    } catch (visionErr: any) {
      console.error('Claude Vision extraction failed:', visionErr.message)
      // Fallback to pdf-parse
      try {
        const pdfParse = (await import('pdf-parse')).default
        const result   = await pdfParse(buffer)
        text = result.text ?? ''
      } catch { text = '[PDF extraction failed]' }
    }
  } else if (ext === 'docx') {
    const raw = buffer.toString('binary')
    const matches = raw.match(/<w:t[^>]*>([^<]+)<\/w:t>/g) ?? []
    text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ')
  } else if (ext === 'xlsx') {
    // Basic XLSX: extract shared strings
    const raw = buffer.toString('binary')
    const matches = raw.match(/<t[^>]*>([^<]+)<\/t>/g) ?? []
    text = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ')
  }

  const docType = classifyDoc(filename, text)
  return { text: text || `[${filename}]`, docType }
}

function classifyDoc(name: string, text: string): string {
  const s = (name + ' ' + text.slice(0, 500)).toLowerCase()
  if (/resultat|p.l|income|profit/.test(s)) return 'p_and_l'
  if (/faktura|invoice/.test(s))            return 'invoice'
  if (/bank|kontoutdrag/.test(s))           return 'bank_statement'
  if (/budget|prognos/.test(s))             return 'budget'
  return 'other'
}

function simpleChunk(text: string): Array<{ text: string; page: number }> {
  if (!text || text.length < 50) return []
  const TARGET = 1600  // ~400 tokens
  const chunks: Array<{ text: string; page: number }> = []
  let pos = 0, page = 1

  while (pos < text.length) {
    const end   = Math.min(pos + TARGET, text.length)
    const chunk = text.slice(pos, end).trim()
    if (chunk.length > 50) chunks.push({ text: chunk, page })
    pos  += TARGET - 240  // 60-token overlap
    page  = Math.ceil(pos / 3000) + 1
  }

  return chunks
}

function buildTerms(text: string): Record<string, number> {
  const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length > 3)
  const freq: Record<string, number> = {}
  for (const w of words) freq[w] = (freq[w] ?? 0) + 1
  const total = words.length || 1
  const result: Record<string, number> = {}
  for (const [w, c] of Object.entries(freq)) result[w] = c / total
  return result
}
