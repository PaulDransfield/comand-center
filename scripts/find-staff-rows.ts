// Filter PDF rows to staff-cost related lines (account 7xxx + the
// surrounding context). Helps debug the staff_cost reconciliation diff.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

async function main() {
  const buf = readFileSync(resolve(process.argv[2]))
  const u8 = new Uint8Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))

  const pdfjs: any = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (pdfjs.GlobalWorkerOptions) {
    const { pathToFileURL } = await import('node:url')
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href
  }
  const doc = await pdfjs.getDocument({ data: u8, useSystemFonts: true, disableFontFace: true, isEvalSupported: false }).promise

  const items: any[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const it of content.items as any[]) {
      const tr = it.transform ?? [1, 0, 0, 1, 0, 0]
      items.push({ str: String(it.str ?? '').trim(), x: Number(tr[4]) || 0, y: Number(tr[5]) || 0, w: Number(it.width) || 0, page: p })
    }
  }
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

  console.log(`${rows.length} total rows. Staff-related rows + section headers:`)
  for (const r of rows) {
    const text = r.cells.map((c: any) => c.str).join(' | ')
    const isStaff = /\b(personalkost|löner|sociala\s+avgifter|pensions|arbetsgivar|7\d{3})\b/i.test(text)
                || /summa\s+personal/i.test(text)
                || /rörelsens\s+kostn/i.test(text)
    if (isStaff) {
      console.log(`  p${r.page} y${r.y.toFixed(0)}: ${text}`)
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
