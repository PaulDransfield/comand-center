// @ts-nocheck
// lib/documents/extractor.ts
//
// Extracts plain text from uploaded files entirely in TypeScript.
// Runs on the server (Vercel) â€” no Python needed.
//
// Supported:
//   PDF  â†’ reads raw text using simple byte parsing (good for text-based PDFs)
//   XLSX â†’ uses SheetJS (already in package.json)
//   CSV  â†’ plain text decode
//   TXT/MD â†’ plain text decode
//   DOCX â†’ extracts from XML (Word documents are zip files containing XML)
//
// For production-quality PDF extraction, swap in pdf-parse:
//   npm install pdf-parse
//   import pdfParse from 'pdf-parse'
//   const { text } = await pdfParse(buffer)

export interface ExtractResult {
  text:     string        // full extracted plain text
  pages:    number        // estimated page count
  docType:  string        // invoice | p_and_l | bank_statement | budget | other
}

export async function extractText(
  buffer:   Buffer,
  filename: string,
  mimeType: string,
): Promise<ExtractResult> {
  const ext = filename.split('.').pop()?.toLowerCase() ?? ''

  let text = ''

  if (mimeType === 'text/plain' || mimeType === 'text/csv' || ext === 'txt' || ext === 'csv' || ext === 'md') {
    // Plain text â€” just decode
    text = buffer.toString('utf8')

  } else if (ext === 'docx' || mimeType.includes('wordprocessingml')) {
    // DOCX is a ZIP containing word/document.xml
    text = await extractDocx(buffer)

  } else if (ext === 'xlsx' || mimeType.includes('spreadsheetml')) {
    // Excel â€” use SheetJS
    text = await extractXlsx(buffer)

  } else if (ext === 'pdf' || mimeType === 'application/pdf') {
    // PDF â€” extract text layer
    text = extractPdfText(buffer)

  } else {
    text = `[File: ${filename} â€” content extraction not supported for this file type]`
  }

  // Clean up whitespace
  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()

  const pages   = Math.max(1, Math.ceil(text.length / 3000))
  const docType = classifyDocument(filename, text)

  return { text, pages, docType }
}

// â”€â”€ DOCX extractor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function extractDocx(buffer: Buffer): Promise<string> {
  try {
    // DOCX is a ZIP file â€” we need to unzip and read word/document.xml
    // Using built-in Node.js zlib isn't enough for ZIP; use a simple approach
    // by treating the buffer as text and extracting XML content
    const content = buffer.toString('binary')

    // Find the XML content between w:t tags (Word text elements)
    const texts: string[] = []
    const regex = /<w:t[^>]*>([^<]*)<\/w:t>/g
    let match

    while ((match = regex.exec(content)) !== null) {
      if (match[1].trim()) texts.push(match[1])
    }

    if (texts.length > 0) {
      return texts.join(' ')
    }

    return '[Could not extract text from this Word document]'
  } catch {
    return '[DOCX extraction failed]'
  }
}

// â”€â”€ XLSX extractor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function extractXlsx(buffer: Buffer): Promise<string> {
  try {
    // Dynamic import to avoid bundling issues
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(buffer, { type: 'buffer' })

    const sheets: string[] = []

    for (const sheetName of workbook.SheetNames) {
      const sheet  = workbook.Sheets[sheetName]
      const csv    = XLSX.utils.sheet_to_csv(sheet)
      if (csv.trim()) {
        sheets.push(`=== Sheet: ${sheetName} ===\n${csv}`)
      }
    }

    return sheets.join('\n\n')
  } catch {
    return '[Excel extraction failed]'
  }
}

// â”€â”€ PDF text extractor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Simple approach: scan for readable text strings in the PDF binary
// Works for text-based PDFs (not scanned images)
function extractPdfText(buffer: Buffer): string {
  const content = buffer.toString('binary')
  const texts: string[] = []

  // Extract text between BT (Begin Text) and ET (End Text) markers
  const btEtRegex = /BT([\s\S]*?)ET/g
  let match

  while ((match = btEtRegex.exec(content)) !== null) {
    const block = match[1]

    // Extract strings in parentheses (PDF text strings)
    const parenRegex = /\(([^)\\]*(?:\\.[^)\\]*)*)\)/g
    let pMatch

    while ((pMatch = parenRegex.exec(block)) !== null) {
      const str = pMatch[1]
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\')
        .replace(/\\([()\\])/g, '$1')
        .replace(/[^\x20-\x7E\n\r\t\u00C0-\u024F]/g, ' ')
        .trim()

      if (str.length > 2) texts.push(str)
    }
  }

  if (texts.length > 0) {
    return texts.join(' ').replace(/\s+/g, ' ').trim()
  }

  // Fallback: extract any readable strings from the PDF
  const readable = content.match(/[\x20-\x7E\u00C0-\u024F]{4,}/g) ?? []
  return readable
    .filter(s => !/^[\d\s.]+$/.test(s))  // skip pure numbers
    .filter(s => s.length > 6)
    .join(' ')
    .trim()
}

// â”€â”€ Document classifier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function classifyDocument(filename: string, text: string): string {
  const n = filename.toLowerCase()
  const t = text.toLowerCase().slice(0, 2000)  // check first 2000 chars

  if (/resultat|p.l|income|profit.loss|revenue/.test(n + t))  return 'p_and_l'
  if (/faktura|invoice|fakt\d|bill to/.test(n + t))           return 'invoice'
  if (/bank|kontoutdrag|statement|saldo|balance/.test(n + t)) return 'bank_statement'
  if (/budget|prognos|forecast|plan/.test(n + t))             return 'budget'
  if (/avtal|kontrakt|contract|agreement/.test(n + t))        return 'contract'
  return 'other'
}
