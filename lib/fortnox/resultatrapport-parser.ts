// @ts-nocheck
// lib/fortnox/resultatrapport-parser.ts
//
// Deterministic parser for Fortnox Resultatrapport PDFs. Replaces Claude's
// LLM-based table extraction for this specific (well-structured, stable)
// document format. See FIXES.md §0q for context.
//
// Why deterministic > LLM here:
//   • Resultatrapport has a fixed tabular layout — BAS account in column 1,
//     Swedish label in column 2, monthly amounts in subsequent columns.
//   • Multi-column extraction is the worst LLM failure mode (column
//     boundaries shift; "Ack." gets confused with a monthly column).
//   • Per-month line items become REAL numbers instead of proportionally-
//     distributed estimates from the year total.
//   • ~100 ms vs Claude's ~30 s per PDF. ~0 SEK vs ~3 SEK per call.
//
// Output shape matches what the AI extractor produces (extracted_json), so
// /api/fortnox/apply and projectRollup don't need to change.
//
// Falls back to Claude when:
//   • The PDF doesn't look like a Resultatrapport (header detection fails)
//   • Math reconciliation fails (sum of line items doesn't match rollup
//     within tolerance)
//   • Any parser error throws

import { classifyByAccount, classifyLabel, classifyByVat } from './classify'

export interface ParsedRollup {
  revenue:          number
  dine_in_revenue:  number
  takeaway_revenue: number
  alcohol_revenue:  number
  food_cost:        number
  alcohol_cost:     number
  staff_cost:       number
  other_cost:       number
  depreciation:     number
  financial:        number
  net_profit:       number
}

export interface ParsedLineItem {
  account:     number       // BAS account number
  label:       string       // Swedish label as printed
  amount:      number       // SEK, full precision (signed for financial)
  category:    string       // revenue | food_cost | staff_cost | other_cost | depreciation | financial
  subcategory: string | null
}

export interface ParsedPeriod {
  year:   number
  month:  number             // 1-12, or 0 for annual-only
  rollup: ParsedRollup
  lines:  ParsedLineItem[]
}

export interface ParsedResultatrapport {
  doc_type:        'pnl_monthly' | 'pnl_annual' | 'pnl_multi_month'
  scale_detected:  'sek' | 'ksek' | 'msek'
  confidence:      'high' | 'medium' | 'low'
  warnings:        string[]
  periods:         ParsedPeriod[]
  // Annual line items (year totals) — populated for multi-month PDFs so the
  // owner can see the year-total breakdown alongside the per-month rows.
  annual_lines:    ParsedLineItem[]
}

export type ParseResult =
  | { ok: true;  extraction: ParsedResultatrapport }
  | { ok: false; reason: string; warnings?: string[] }

// ── PDF text extraction (server-side pdfjs-dist) ───────────────────────────
// pdfjs-dist's Node entry exposes getDocument; each page yields text items
// with positional info (transform matrix). We use the Y coordinate to group
// items into rows and the X coordinate to identify columns.

interface TextItem {
  str:  string
  x:    number
  y:    number
  w:    number
  page: number
}

// pdfjs-dist uses browser DOM APIs (DOMMatrix, DOMRect, Path2D) for
// transformation matrices and shape operations. None of them exist in
// Node.js. We do TEXT extraction only (no rendering) so a minimal stub
// of DOMMatrix is enough — the methods are called but their results
// don't drive any output we care about. Without this stub pdfjs throws
// "DOMMatrix is not defined" on getTextContent and the parser fails
// silently in production. Diagnosed via the [parser-debug] markers we
// wrote into extraction_jobs.error_message after Vercel logs proved
// uninformative. See FIXES.md §0q.
function ensureDomMatrixPolyfill() {
  const g = globalThis as any
  if (typeof g.DOMMatrix !== 'undefined') return
  class DOMMatrixPolyfill {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
    constructor(init?: any) {
      if (Array.isArray(init) && init.length === 6) {
        [this.a, this.b, this.c, this.d, this.e, this.f] = init as any
      } else if (init && typeof init === 'object') {
        Object.assign(this, init)
      }
    }
    multiply(o: any) {
      const r = new DOMMatrixPolyfill()
      r.a = this.a * o.a + this.c * o.b
      r.b = this.b * o.a + this.d * o.b
      r.c = this.a * o.c + this.c * o.d
      r.d = this.b * o.c + this.d * o.d
      r.e = this.a * o.e + this.c * o.f + this.e
      r.f = this.b * o.e + this.d * o.f + this.f
      return r
    }
    translate(tx: number, ty: number) { return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty }) }
    scale(sx: number, sy = sx)        { return this.multiply({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 }) }
    inverse() {
      const det = this.a * this.d - this.b * this.c
      if (det === 0) throw new Error('non-invertible matrix')
      const r = new DOMMatrixPolyfill()
      r.a =  this.d / det
      r.b = -this.b / det
      r.c = -this.c / det
      r.d =  this.a / det
      r.e = (this.c * this.f - this.d * this.e) / det
      r.f = (this.b * this.e - this.a * this.f) / det
      return r
    }
  }
  g.DOMMatrix = DOMMatrixPolyfill
  // Some pdfjs internals also poke at these; minimal stubs prevent throws.
  if (typeof g.DOMRect === 'undefined') {
    g.DOMRect = class DOMRect {
      x = 0; y = 0; width = 0; height = 0
      constructor(x = 0, y = 0, width = 0, height = 0) {
        this.x = x; this.y = y; this.width = width; this.height = height
      }
    }
  }
  if (typeof g.Path2D === 'undefined') {
    g.Path2D = class Path2D { addPath() {} closePath() {} moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {} arcTo() {} ellipse() {} rect() {} }
  }
}

async function extractTextItems(pdfBuffer: Uint8Array): Promise<TextItem[]> {
  ensureDomMatrixPolyfill()
  // Dynamic import — pdfjs-dist's legacy build is the Node-compatible one.
  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')

  // Two ways pdfjs can run in Node:
  // 1. Spawn a worker process from pdf.worker.mjs — fast for big PDFs but
  //    requires the worker file to be discoverable on disk. On Vercel /
  //    Next.js this is unreliable: webpack bundles the function code but
  //    often not the sibling worker file, so require.resolve('.../pdf.worker.mjs')
  //    throws and the entire parser falls through to the Claude path
  //    silently. That's what was happening in production.
  // 2. Run inline (no worker process). Slower for huge PDFs but bulletproof
  //    in serverless environments. Our Resultatrapports are small (~100 KB)
  //    so inline is plenty fast — ~1 s end-to-end.
  //
  // We unconditionally disable the worker to take path #2. Reliability beats
  // theoretical speedup for our payload sizes.
  // pdfjs validates workerSrc as a string, so we set it to an empty string
  // when running inline. Combined with disableWorker:true below, pdfjs
  // skips the worker setup entirely and runs in-process.
  if (pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = ''
  }

  const loadingTask = pdfjs.getDocument({
    data: pdfBuffer,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    // disableWorker: true is the canonical way to force inline parsing.
    // Combined with workerSrc=false above, pdfjs uses its built-in fake
    // worker that runs everything in the same thread.
    disableWorker: true,
  })
  const doc = await loadingTask.promise

  const items: TextItem[] = []
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const content = await page.getTextContent()
    for (const it of content.items as any[]) {
      // transform = [a, b, c, d, e, f] — e and f are x and y in PDF coords
      const tr = it.transform ?? [1, 0, 0, 1, 0, 0]
      const str = String(it.str ?? '').trim()
      if (!str) continue
      items.push({
        str,
        x:    Number(tr[4]) || 0,
        y:    Number(tr[5]) || 0,
        w:    Number(it.width) || 0,
        page: pageNum,
      })
    }
  }
  return items
}

// ── Row grouping ───────────────────────────────────────────────────────────
// Items within ±2pt vertical tolerance belong to the same visual row.
// Group, then sort by X within each row.

const ROW_TOL = 2.5

interface Row {
  y:     number
  page:  number
  cells: TextItem[]
}

function groupIntoRows(items: TextItem[]): Row[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y)
  const rows: Row[] = []
  let current: Row | null = null
  for (const it of sorted) {
    if (!current || it.page !== current.page || Math.abs(current.y - it.y) > ROW_TOL) {
      current = { y: it.y, page: it.page, cells: [] }
      rows.push(current)
    }
    current.cells.push(it)
  }
  for (const r of rows) r.cells.sort((a, b) => a.x - b.x)
  return rows
}

// ── Number parsing (Swedish format) ────────────────────────────────────────
// "1 234 567" → 1234567
// "1 234,56"  → 1234.56
// "-1 234,56" → -1234.56
// "(1 234,56)" → -1234.56  (rare accountant style)
// ""           → 0 (empty cell)

// Split a string that pdfjs merged into one cell back into individual
// number tokens. The tricky part: Swedish numbers contain whitespace as
// thousands separator ("1 820,9"), so we can't just split on /\s+/. The
// right rule is: a new number starts after a space WHEN the next non-space
// char is a sign or digit AND the previous token already has a decimal
// comma (meaning it's complete) OR the previous token ends with a digit
// followed by an explicit minus.
//
// Examples:
//   "−112,8 −1 820,9"  → ["−112,8", "−1 820,9"]
//   "1 820,9"          → ["1 820,9"]
//   "0,0"              → ["0,0"]
//   "−2 276,3"         → ["−2 276,3"]
//   "12 -3"            → ["12", "-3"]   (pathological but supported)
function splitMergedNumbers(s: string): string[] {
  const trimmed = s.trim()
  if (!trimmed) return []
  // Quick path: doesn't contain a sign mid-string → single number
  // (allowing leading − or - which sits at index 0).
  const inner = trimmed.slice(1)
  if (!/[−-]/.test(inner)) return [trimmed]
  // Split on whitespace immediately followed by a sign.
  const parts: string[] = []
  let i = 0
  let cur = ''
  while (i < trimmed.length) {
    const ch = trimmed[i]
    // Look for boundary: space + sign (where current token already has a digit)
    if (/\s/.test(ch) && /[−-]/.test(trimmed[i + 1] ?? '') && /\d/.test(cur)) {
      parts.push(cur.trim())
      cur = ''
      i++  // consume the space
      continue
    }
    cur += ch
    i++
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts.length ? parts : [trimmed]
}

function parseSwedishNumber(s: string): number | null {
  if (!s) return null
  // Normalise unicode minus (U+2212) → ASCII hyphen, NBSP → space.
  let str = s.trim().replace(/−/g, '-').replace(/ /g, ' ').replace(/\s+/g, '')
  let negative = false
  // Parens convention for negative (rare in Fortnox but seen elsewhere)
  if (str.startsWith('(') && str.endsWith(')')) {
    negative = true
    str = str.slice(1, -1)
  }
  if (str.startsWith('-')) {
    negative = true
    str = str.slice(1)
  }
  // Decimal comma → dot
  str = str.replace(/,/g, '.')
  if (!/^\d+(\.\d+)?$/.test(str)) return null
  const n = parseFloat(str)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

// ── Subtotal detection ─────────────────────────────────────────────────────
// Skip rows whose label clearly marks a subtotal — including them as line
// items would double-count when summed into the rollup.

const SUBTOTAL_PATTERNS = [
  /^summa\b/i,
  /^s:?a\b/i,
  /^totalt?\b/i,
  /^bruttovinst\b/i,
  /^bruttoresultat\b/i,
  /^rörelseresultat\b/i,
  /^resultat\s+(före|efter|f[öo]re)\b/i,
  /^periodens\s+resultat\b/i,
  /^årets\s+resultat\b/i,
  /^nettoomsättning\b/i,           // header line, not a leaf
]

function isSubtotalLabel(label: string): boolean {
  const trimmed = label.trim()
  return SUBTOTAL_PATTERNS.some(re => re.test(trimmed))
}

// ── Header detection ───────────────────────────────────────────────────────
// Find the row containing the column headers. The Swedish months we look
// for in any combination of full names, three-letter abbreviations, or
// "Period N" labels. Also detect "Ack." / "Ackumulerat" (year-to-date).

const MONTH_NAMES_SV = [
  ['januari',   'jan'],
  ['februari',  'feb'],
  ['mars',      'mar'],
  ['april',     'apr'],
  ['maj',       'maj'],
  ['juni',      'jun'],
  ['juli',      'jul'],
  ['augusti',   'aug'],
  ['september', 'sep'],
  ['oktober',   'okt'],
  ['november',  'nov'],
  ['december',  'dec'],
]

interface ColumnHeader {
  x:        number
  month:    number | null   // 1-12, or null for "Ack."/year-total
  isAckumulerat: boolean
  text:     string
}

function detectHeaderRow(rows: Row[]): { headerRow: Row; columns: ColumnHeader[] } | null {
  let best: { headerRow: Row; columns: ColumnHeader[]; score: number } | null = null
  for (const row of rows) {
    const cells = row.cells
    const matches: ColumnHeader[] = []
    let hasPeriodMarker = false
    for (const c of cells) {
      const raw = c.str
      const lower = raw.toLowerCase()
      let found = false
      // (a) Full or three-letter Swedish month names: "januari", "jan", "Jan."
      for (let i = 0; i < MONTH_NAMES_SV.length; i++) {
        const [full, abbr] = MONTH_NAMES_SV[i]
        if (lower === full || lower === abbr || lower.startsWith(full) || lower === abbr + '.') {
          matches.push({ x: c.x, month: i + 1, isAckumulerat: false, text: raw })
          found = true
          break
        }
      }
      // (b) Fortnox compact YYMM header: "2501" = Jan 2025, "2512" = Dec 2025.
      // Tight YY range (20-29 = 2020-2029) so account numbers like 3010
      // (which would otherwise parse as YYMM yy=30 mm=10) don't false-match.
      // Modern Resultatrapports won't span outside this range and accounts
      // 3xxx-4xxx (revenue + COGS) sit comfortably above.
      if (!found && /^\d{4}$/.test(raw)) {
        const yy = parseInt(raw.slice(0, 2), 10)
        const mm = parseInt(raw.slice(2, 4), 10)
        if (yy >= 20 && yy <= 29 && mm >= 1 && mm <= 12) {
          matches.push({ x: c.x, month: mm, isAckumulerat: false, text: raw })
          found = true
        }
      }
      // (c) Ack / Ackumulerat / year-total column.
      if (!found && /^(ack|ackumulerat|totalt|år(et)?|total|year|ytd)$/i.test(lower)) {
        matches.push({ x: c.x, month: null, isAckumulerat: true, text: raw })
        found = true
      }
      // (d) Single-month report headers — "Period", "Period fg år" /
      // "Period föregående". The current-period column is what we treat as
      // "month 1" for downstream code (which doesn't care about the actual
      // calendar month here — it's stored under the period detected from
      // the date range elsewhere). Comparison columns ("fg år" / "föregående")
      // are recorded as Ack so they don't pollute the rollup.
      if (!found) {
        if (lower === 'period') {
          // Tag with month=null + a special marker; we'll set the actual
          // month from the period date range in main parse.
          matches.push({ x: c.x, month: 0, isAckumulerat: false, text: raw })
          hasPeriodMarker = true
          found = true
        } else if (/^period\s+(fg|föregående)/i.test(lower)) {
          // Comparison column — treat as Ack so it doesn't get rolled up
          // as the current period.
          matches.push({ x: c.x, month: null, isAckumulerat: true, text: raw })
          found = true
        }
      }
    }
    // Header qualification: must have AT LEAST 2 matches in a single row,
    // OR exactly 1 match plus a "Period" marker (single-month layouts have
    // few headers). Stops account numbers in data rows from being picked
    // as headers (a row like "3010 | Avdrag mat personal | 8 299,09 | …"
    // has 1 YYMM-style match for "3010" but no Ack and no Period).
    const monthlyCount = matches.filter(m => m.month != null && m.month !== 0 && !m.isAckumulerat).length
    const ackCount     = matches.filter(m => m.isAckumulerat).length
    const periodCount  = matches.filter(m => m.month === 0).length
    const totalMatches = matches.length
    if (totalMatches < 2 && !hasPeriodMarker) continue
    const score = monthlyCount + ackCount * 0.5 + periodCount
    if (score > 0 && (!best || score > best.score)) {
      best = { headerRow: row, columns: matches, score }
    }
    if (monthlyCount >= 3 && ackCount >= 1) {
      return { headerRow: row, columns: matches }
    }
  }
  return best
}

// Helper for single-month layouts: extract the period's actual month from
// "Period 2026-02-01 - 2026-02-28" lines.
function detectSingleMonthFromPeriodRow(rows: Row[]): number | null {
  for (const row of rows.slice(0, 30)) {
    const text = row.cells.map(c => c.str).join(' ')
    const m = text.match(/period\s+\d{4}-(\d{2})-\d{2}\s*[-–]\s*\d{4}-\d{2}-\d{2}/i)
    if (m) {
      const mm = parseInt(m[1], 10)
      if (mm >= 1 && mm <= 12) return mm
    }
  }
  return null
}

// ── Year detection ─────────────────────────────────────────────────────────
// Look for a 4-digit year in the first 30 rows. Resultatrapport headers
// usually contain "Räkenskapsår 2025-01-01 — 2025-12-31" or similar.

function detectYear(rows: Row[]): number | null {
  // Prefer the fiscal-year/period line — Resultatrapports always include
  // "Räkenskapsår 2025-01-01 - 2025-12-31" or "Period 2025-01-01 -
  // 2025-12-31" in the header. Without this preference we'd pick the
  // print date ("Utskrivet 2026-04-22") which sits earlier on the page.
  for (const row of rows.slice(0, 30)) {
    const text = row.cells.map(c => c.str).join(' ')
    const m = text.match(/(?:räkenskapsår|period)\s+(20\d{2})-\d{2}-\d{2}/i)
    if (m) return parseInt(m[1], 10)
  }
  // Fallback: first plain "YYYY-MM-DD - YYYY-MM-DD" date range.
  for (const row of rows.slice(0, 30)) {
    const text = row.cells.map(c => c.str).join(' ')
    const m = text.match(/\b(20\d{2})-\d{2}-\d{2}\s*[-–]\s*20\d{2}-\d{2}-\d{2}\b/)
    if (m) return parseInt(m[1], 10)
  }
  // Last resort: first 4-digit 20xx year anywhere in the first 30 rows.
  for (const row of rows.slice(0, 30)) {
    const text = row.cells.map(c => c.str).join(' ')
    const m = text.match(/\b(20\d{2})\b/)
    if (m) return parseInt(m[1], 10)
  }
  return null
}

// ── Scale detection ────────────────────────────────────────────────────────
// "Belopp i kkr" / "tkr" / "MSEK" / "mkr" in the first 30 rows.

function detectScale(rows: Row[]): 'sek' | 'ksek' | 'msek' {
  const sample = rows.slice(0, 30).map(r => r.cells.map(c => c.str).join(' ')).join(' ').toLowerCase()
  if (/\b(msek|mkr|miljoner)\b/.test(sample)) return 'msek'
  if (/\b(ksek|tkr|tusental?)\b/.test(sample)) return 'ksek'
  if (/\bbelopp\s+i\s+kkr\b/.test(sample)) return 'ksek'
  // Fortnox's standard phrasing: "Belopp uttrycks i tusentals kronor"
  if (/tusentals?\s+kronor/.test(sample)) return 'ksek'
  if (/miljoner?\s+kronor/.test(sample)) return 'msek'
  return 'sek'
}

// ── Main parse ─────────────────────────────────────────────────────────────

export async function parseResultatrapport(pdfBuffer: Uint8Array | Buffer): Promise<ParseResult> {
  // pdfjs-dist enforces a strict Uint8Array check that REJECTS Buffer
  // (even though Buffer extends Uint8Array). Always make a fresh copy as a
  // plain Uint8Array via the underlying ArrayBuffer.
  const src = pdfBuffer as any
  const buf = new Uint8Array(
    src.buffer ? src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) : src,
  )
  let items: TextItem[]
  try {
    items = await extractTextItems(buf)
  } catch (e: any) {
    return { ok: false, reason: `pdfjs failed: ${e?.message ?? String(e)}` }
  }
  if (items.length < 20) {
    return { ok: false, reason: 'too few text items — PDF may be scanned/image-based, not text' }
  }

  const rows = groupIntoRows(items)
  const year = detectYear(rows)
  if (!year) {
    return { ok: false, reason: 'could not detect year from PDF header' }
  }

  const headerInfo = detectHeaderRow(rows)
  if (!headerInfo) {
    return { ok: false, reason: 'could not detect month-column headers — not a recognisable Resultatrapport' }
  }
  const { headerRow, columns } = headerInfo
  const scale = detectScale(rows)
  const scaleMultiplier = scale === 'msek' ? 1_000_000 : scale === 'ksek' ? 1_000 : 1

  // Resolve the special "month=0" marker (single-month "Period" header)
  // to the actual calendar month from the period date-range row.
  const periodMonth = detectSingleMonthFromPeriodRow(rows)
  for (const c of columns) {
    if (c.month === 0) c.month = periodMonth ?? 1
  }

  const monthColumns = columns.filter(c => c.month != null && !c.isAckumulerat)
  const ackColumn    = columns.find(c => c.isAckumulerat) ?? null

  // Determine doc_type from how many months we found.
  const docType: ParsedResultatrapport['doc_type'] =
    monthColumns.length >= 6 ? 'pnl_multi_month' :
    monthColumns.length === 1 ? 'pnl_monthly' :
    monthColumns.length === 0 && ackColumn ? 'pnl_annual' :
    'pnl_monthly'

  // Per-month line items + per-month rollups built up below.
  const periodRollups = new Map<number, ParsedRollup>()
  const periodLines   = new Map<number, ParsedLineItem[]>()
  for (const c of monthColumns) {
    periodRollups.set(c.month!, emptyRollup())
    periodLines.set(c.month!,   [])
  }
  // Annual line items collected from the Ack. column (or single-period column).
  const annualLines: ParsedLineItem[] = []

  // Walk data rows below the header. For each row, locate the BAS account
  // (a 4-digit integer in column 1 or 2) and the label, then read amounts
  // at each month column's X position.
  const headerRowIdx = rows.indexOf(headerRow)
  if (headerRowIdx < 0) return { ok: false, reason: 'header row index not found' }
  const dataRows = rows.slice(headerRowIdx + 1)

  // Match data cells to column headers using center-of-cell matching.
  // Data cells are right-aligned to a column edge that sits a few px past
  // the header's left edge; the cell's center therefore lines up roughly
  // with the column header's center.
  //
  // For each column we pick the cell whose CENTER is closest to the
  // header's center (header.x + header.w/2), within a tolerance that's
  // half the gap to the nearest neighbouring column. This guarantees a
  // cell can't be claimed by two columns at once because the tolerance
  // shrinks where columns are tightly packed.
  const allCols = [...columns].sort((a, b) => a.x - b.x)
  const colTolerances = new Map<ColumnHeader, number>()
  for (let i = 0; i < allCols.length; i++) {
    const col = allCols[i]
    const prevGap = i > 0 ? col.x - allCols[i - 1].x : 80
    const nextGap = i < allCols.length - 1 ? allCols[i + 1].x - col.x : 80
    const tol = Math.min(prevGap, nextGap) / 2
    colTolerances.set(col, tol)
  }

  function cellAtCol(row: Row, col: ColumnHeader): { str: string } | null {
    // Header centre. Header text is left-aligned, so centre = x + w/2.
    // We don't have header.w in the type; approximate as col.x + 12 which
    // matches a typical 4-char header like "2501" at 10pt font.
    const headerCentre = col.x + 12
    const tol = colTolerances.get(col) ?? 25
    let best: { str: string; dist: number } | null = null
    for (const c of row.cells) {
      // Skip the label column entirely (way left of any data column).
      if (c.x < allCols[0].x - 40) continue
      // Whole-cell center match
      const cellCentre = c.x + c.w / 2
      const dist = Math.abs(cellCentre - headerCentre)
      if (dist <= tol && (!best || dist < best.dist)) {
        best = { str: c.str, dist }
      }
      // Sub-part match for merged number cells (e.g. "−112,8 −1 820,9").
      const parts = splitMergedNumbers(c.str)
      if (parts.length > 1) {
        const totalLen = c.str.length || 1
        let cursorX = c.x
        for (const p of parts) {
          const partW = c.w * (p.length / totalLen)
          const partCentre = cursorX + partW / 2
          const d = Math.abs(partCentre - headerCentre)
          if (d <= tol && (!best || d < best.dist)) {
            best = { str: p, dist: d }
          }
          cursorX += partW
        }
      }
    }
    return best ? { str: best.str } : null
  }

  const warnings: string[] = []
  let rowsParsed = 0
  let rowsSkipped = 0

  for (const row of dataRows) {
    if (row.cells.length < 2) continue
    // First cell — could be the BAS account (4-digit int) or a label
    const first = row.cells[0]
    const account = parseInt(first.str, 10)
    let label: string
    let labelStartX: number
    if (Number.isInteger(account) && account >= 1000 && account <= 9999) {
      // Account in col 1; label is the next cell(s) until we hit numbers
      const labelCells = []
      for (let i = 1; i < row.cells.length; i++) {
        const c = row.cells[i]
        if (parseSwedishNumber(c.str) != null && c.str.length > 0) break
        labelCells.push(c.str)
        labelStartX = c.x
        if (labelCells.length > 6) break  // safety
      }
      label = labelCells.join(' ').trim()
    } else {
      // First cell looks like a label (subtotal, header, etc.)
      label = first.str
      // Try to find a 4-digit account elsewhere in the row
      const acctMatch = row.cells.find(c => /^\d{4}$/.test(c.str))
      if (acctMatch) {
        const a = parseInt(acctMatch.str, 10)
        if (a >= 1000 && a <= 9999) {
          // promote
          // (rare layout where account isn't in col 1)
        }
      }
    }
    if (!label) { rowsSkipped++; continue }
    if (isSubtotalLabel(label)) { rowsSkipped++; continue }

    // Read amounts at each month column. Each column owns a non-overlapping
    // X range so a cell can't be claimed by two columns at once.
    const monthAmounts: Array<{ month: number; amount: number }> = []
    for (const col of monthColumns) {
      const cell = cellAtCol(row, col)
      if (!cell) continue
      const amt = parseSwedishNumber(cell.str)
      if (amt == null) continue
      monthAmounts.push({ month: col.month!, amount: amt * scaleMultiplier })
    }
    let ackAmount: number | null = null
    if (ackColumn) {
      const cell = cellAtCol(row, ackColumn)
      if (cell) ackAmount = (parseSwedishNumber(cell.str) ?? 0) * scaleMultiplier
    }

    // If we got nothing numeric, skip (probably a header/subheader row)
    if (monthAmounts.length === 0 && ackAmount == null) { rowsSkipped++; continue }

    // Classify the line. Account number is authoritative; label is fallback.
    if (!Number.isInteger(account)) {
      // No account number — skip; we don't trust label-only rows for line items
      rowsSkipped++; continue
    }
    const accountClass = classifyByAccount(account)
    const labelClass   = classifyLabel(label)
    const category     = accountClass?.category ?? labelClass.category
    // Subcategory: VAT-rate hint on revenue/food, else label, else account
    const vatHint      = (category === 'revenue' || category === 'food_cost') ? classifyByVat(label) : null
    const subcategory  = vatHint?.subcategory ?? labelClass.subcategory ?? accountClass?.subcategory ?? null

    // Sign convention. Resultatrapport prints expenses as NEGATIVE numbers
    // in cost sections (-307,4 for a salary). Credits / reversals (e.g.
    // "Förändring av semesterlöneskuld" when vacation liability decreases)
    // print as POSITIVE on the same cost line. Storage convention: costs
    // are positive, credits to a cost line subtract from the rollup.
    //
    // Therefore: NEGATE all cost values (-X → +X expense, +X → -X credit).
    // Pre-fix used Math.abs which turned credits into additional expenses
    // and inflated staff_cost by ~8% on annual reports with vacation
    // liability adjustments.
    //
    // Revenue stays as-is (PDF positive = sale, negative = credit memo).
    // Financial stays signed (interest expense negative, income positive).
    const normaliseSign = (n: number) => {
      if (category === 'financial') return n
      if (category === 'revenue')   return n
      return -n  // negate cost lines so credits subtract correctly
    }

    // Add to per-month aggregates and per-month line items
    for (const { month, amount } of monthAmounts) {
      const signed = normaliseSign(amount)
      const r = periodRollups.get(month)!
      addToRollup(r, category, subcategory, signed)
      const lines = periodLines.get(month)!
      if (signed !== 0) {
        lines.push({ account, label, amount: signed, category, subcategory })
      }
    }
    if (ackAmount != null) {
      const signed = normaliseSign(ackAmount)
      if (signed !== 0) {
        annualLines.push({ account, label, amount: signed, category, subcategory })
      }
    }
    rowsParsed++
  }

  // Compute net_profit per period using the canonical formula.
  for (const r of periodRollups.values()) {
    r.net_profit = r.revenue - r.food_cost - r.staff_cost - r.other_cost - r.depreciation + r.financial
  }

  // Build periods array
  const periods: ParsedPeriod[] = [...periodRollups.entries()].map(([month, rollup]) => ({
    year, month, rollup, lines: periodLines.get(month) ?? [],
  })).sort((a, b) => a.month - b.month)

  // Confidence: drop to 'medium' if we parsed very few rows or the
  // revenue subset sums look off.
  let confidence: 'high' | 'medium' | 'low' = 'high'
  if (rowsParsed < 5) {
    confidence = 'low'
    warnings.push(`Only ${rowsParsed} data rows parsed — extraction may be incomplete`)
  } else if (rowsParsed < 10) {
    confidence = 'medium'
    warnings.push(`Only ${rowsParsed} data rows parsed — review carefully`)
  }
  for (const p of periods) {
    const subsetSum = p.rollup.dine_in_revenue + p.rollup.takeaway_revenue + p.rollup.alcohol_revenue
    if (subsetSum > p.rollup.revenue * 1.02 + 100) {
      warnings.push(`${p.year}-${String(p.month).padStart(2,'0')}: revenue subsets sum (${Math.round(subsetSum)}) exceeds total (${Math.round(p.rollup.revenue)})`)
      confidence = 'medium'
    }
    if (p.rollup.alcohol_cost > p.rollup.food_cost + 1) {
      // alcohol_cost is a SUBSET of food_cost in our schema, but the source
      // PDF can legitimately have alcohol-purchase amount > total food cost
      // when a stock-change credit (account 4990 +Y) reduces general food
      // without affecting alcohol purchases. This is faithful extraction of
      // an unusual but real accounting situation, not an extraction error.
      // Warn but don't drop confidence — projectRollup clamps the displayed
      // value at write time. See FIXES.md §0q.
      warnings.push(`${p.year}-${String(p.month).padStart(2,'0')}: alcohol_cost > food_cost (likely stock-change credit on 4990; clamp will apply on write)`)
    }
  }

  return {
    ok: true,
    extraction: {
      doc_type:       docType,
      scale_detected: scale,
      confidence,
      warnings,
      periods,
      annual_lines:   annualLines,
    },
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function emptyRollup(): ParsedRollup {
  return {
    revenue: 0, dine_in_revenue: 0, takeaway_revenue: 0, alcohol_revenue: 0,
    food_cost: 0, alcohol_cost: 0,
    staff_cost: 0, other_cost: 0,
    depreciation: 0, financial: 0,
    net_profit: 0,
  }
}

function addToRollup(r: ParsedRollup, category: string, subcategory: string | null, amount: number) {
  switch (category) {
    case 'revenue':
      r.revenue += amount
      // VAT-derived subset
      if (subcategory === 'alcohol' || subcategory === 'beverage' || subcategory === 'drinks') {
        r.alcohol_revenue += amount
      } else if (subcategory === 'takeaway') {
        r.takeaway_revenue += amount
      } else if (subcategory === 'food' || subcategory === 'dine_in') {
        r.dine_in_revenue += amount
      }
      break
    case 'food_cost':
      r.food_cost += amount
      if (subcategory === 'alcohol' || subcategory === 'beverage' || subcategory === 'beverages' || subcategory === 'drinks') {
        r.alcohol_cost += amount
      }
      break
    case 'staff_cost':
      r.staff_cost += amount
      break
    case 'other_cost':
      r.other_cost += amount
      break
    case 'depreciation':
      r.depreciation += amount
      break
    case 'financial':
      r.financial += amount
      break
  }
}
