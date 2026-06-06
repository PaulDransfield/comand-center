// lib/pdf/highlight-article.ts
//
// Phase 1 of the in-app PDF highlight feature (2026-06-06).
//
// Given a PDF and an article number, find every page+coord where the
// article number appears and overlay a translucent lavender rectangle.
// Used by /api/inventory/invoice-pdf when the caller passes &article=X
// so the viewer can spot the line they're verifying without scrolling.
//
// Phase 1 scope:
//   • Article-number-only search (exact, case-insensitive). Most reliable
//     because article numbers are unique tokens, unlike fuzzy descriptions.
//   • Single lavender rectangle per match, full row width on the page.
//   • Multi-page support (rare for short invoices but doesn't hurt).
//   • Brand lavender (UXP.lavMid 196/184/236) with 0.35 alpha so the
//     underlying text stays readable.
//
// Phase 2 (parked): fuzzy description fallback, owner-facing on/off toggle,
// per-match severity colors, tooltips on the highlight.

import { PDFDocument, rgb } from 'pdf-lib'

// UXP.lavMid = #c4b8ec → 196/184/236
const HL_R = 196 / 255
const HL_G = 184 / 255
const HL_B = 236 / 255
const HL_ALPHA = 0.35
// Pad the matched glyph bbox to fit the line. Most invoice rows are
// ~14pt tall; a single token's bbox only covers its own height, so we
// inflate vertically to span the whole line. Horizontal inflation
// stretches across the full content width.
const Y_PAD_PT = 4
const X_FULL_ROW = true

export interface HighlightResult {
  ok:           boolean
  bytes?:       Uint8Array
  pageMatches?: Array<{ page: number; rect: [number, number, number, number] }>
  reason?:      string
}

/**
 * Annotate a PDF in place: lavender highlight rectangles wherever
 * `articleNumber` appears. Returns the new bytes or — on failure — the
 * original bytes plus a `reason` so the caller can serve the unmodified
 * PDF instead of a broken highlight attempt.
 */
export async function highlightArticleInPdf(
  pdfBytes: Uint8Array,
  articleNumber: string,
): Promise<HighlightResult> {
  if (!articleNumber || articleNumber.trim().length < 3) {
    return { ok: false, bytes: pdfBytes, reason: 'article_too_short' }
  }
  const needle = articleNumber.trim().toLowerCase()

  // ── Step 1 — Text extraction with bboxes via pdfjs-dist ─────────
  // pdfjs-dist's legacy build is the Node-compatible one and matches the
  // pattern used by lib/fortnox/resultatrapport-parser.ts.
  // We have to map pdfjs's per-item transform → page-space rect.
  let pdfjs: any
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  } catch (e: any) {
    return { ok: false, bytes: pdfBytes, reason: `pdfjs_import_failed:${e?.message ?? e}` }
  }
  pdfjs.GlobalWorkerOptions.workerSrc = ''

  let pdfjsDoc: any
  try {
    const loadingTask = pdfjs.getDocument({ data: pdfBytes, disableWorker: true, isEvalSupported: false })
    pdfjsDoc = await loadingTask.promise
  } catch (e: any) {
    return { ok: false, bytes: pdfBytes, reason: `pdfjs_parse_failed:${e?.message ?? e}` }
  }

  const matches: Array<{ page: number; rect: [number, number, number, number] }> = []
  const pageRects: Array<{ width: number; height: number }> = []

  for (let p = 1; p <= pdfjsDoc.numPages; p++) {
    const page = await pdfjsDoc.getPage(p)
    const viewport = page.getViewport({ scale: 1 })
    pageRects.push({ width: viewport.width, height: viewport.height })

    const textContent = await page.getTextContent()
    // pdfjs returns items with `str` + `transform = [a, b, c, d, e, f]`
    // where (e, f) is the baseline origin in PDF coords. Width is on
    // item.width; height on item.height.
    for (const item of textContent.items as any[]) {
      const s = String(item.str ?? '').toLowerCase()
      if (!s.includes(needle)) continue
      const x = item.transform[4]
      const y = item.transform[5]
      const w = item.width  ?? 0
      const h = item.height ?? 12
      const x0 = X_FULL_ROW ? 24 : Math.max(0, x - 2)
      const x1 = X_FULL_ROW ? viewport.width - 24 : x + w + 2
      const y0 = Math.max(0, y - Y_PAD_PT)
      const y1 = y + h + Y_PAD_PT
      matches.push({ page: p, rect: [x0, y0, x1, y1] })
    }
  }

  if (matches.length === 0) {
    return { ok: false, bytes: pdfBytes, reason: 'no_match' }
  }

  // ── Step 2 — Annotate via pdf-lib ──────────────────────────────
  let pdfDoc: PDFDocument
  try {
    pdfDoc = await PDFDocument.load(pdfBytes)
  } catch (e: any) {
    return { ok: false, bytes: pdfBytes, reason: `pdflib_load_failed:${e?.message ?? e}` }
  }

  for (const m of matches) {
    const page = pdfDoc.getPage(m.page - 1)
    const [x0, y0, x1, y1] = m.rect
    page.drawRectangle({
      x:      x0,
      y:      y0,
      width:  x1 - x0,
      height: y1 - y0,
      color:  rgb(HL_R, HL_G, HL_B),
      opacity: HL_ALPHA,
      borderColor: rgb(125 / 255, 108 / 255, 201 / 255),     // lavDeep stroke
      borderWidth: 0.75,
      borderOpacity: 0.8,
    })
  }

  const bytes = await pdfDoc.save()
  return { ok: true, bytes, pageMatches: matches }
}
