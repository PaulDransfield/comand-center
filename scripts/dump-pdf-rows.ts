// Dumps the first ~40 rows of a PDF as positional text so I can see what
// the header layout actually looks like.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main() {
  const pdfPath = resolve(process.argv[2])
  const buf = readFileSync(pdfPath)
  const u8 = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (pdfjs.GlobalWorkerOptions) {
    const { pathToFileURL } = await import('node:url')
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  }
  const doc = await pdfjs.getDocument({ data: u8, useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise

  const items: any[] = []
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum)
    const content = await page.getTextContent()
    for (const it of content.items as any[]) {
      const tr = it.transform ?? [1, 0, 0, 1, 0, 0]
      items.push({ str: String(it.str ?? '').trim(), x: Number(tr[4]) || 0, y: Number(tr[5]) || 0, w: Number(it.width) || 0, page: pageNum })
    }
  }
  // Group by Y
  const sorted = [...items].filter(i => i.str).sort((a, b) => a.page - b.page || b.y - a.y)
  const rows: any[] = []
  let cur: any = null
  for (const it of sorted) {
    if (!cur || it.page !== cur.page || Math.abs(cur.y - it.y) > 2.5) {
      cur = { y: it.y, page: it.page, cells: [] }
      rows.push(cur)
    }
    cur.cells.push(it)
  }
  for (const r of rows) r.cells.sort((a: any, b: any) => a.x - b.x)
  console.log(`${doc.numPages} pages, ${items.length} items, ${rows.length} rows`)
  console.log(`\nFirst 40 rows (cells separated by ' | '):`)
  for (const r of rows.slice(0, 40)) {
    const cellStrs = r.cells.map((c: any) => `${c.str}@x${c.x.toFixed(0)}`).join(' | ')
    console.log(`  p${r.page} y${r.y.toFixed(0)}: ${cellStrs}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
