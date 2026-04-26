// scripts/test-fortnox-parser.ts
//
// Test-drive the deterministic Fortnox Resultatrapport parser.
//
// Usage:
//   npx tsx scripts/test-fortnox-parser.ts tests/fortnox-fixtures/annual-2025.pdf
//   npx tsx scripts/test-fortnox-parser.ts <path>.pdf --json     # full JSON
//   npx tsx scripts/test-fortnox-parser.ts <path>.pdf --month=11 # one month
//
// Prints a human-readable per-month rollup table + reconciliation report.
// Compare against the source PDF to verify accuracy.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseResultatrapport } from '../lib/fortnox/resultatrapport-parser'

async function main() {
const args = process.argv.slice(2)
if (!args.length) {
  console.error('Usage: npx tsx scripts/test-fortnox-parser.ts <path-to-pdf> [--json] [--month=N]')
  process.exit(1)
}
const pdfPath = resolve(args[0])
const wantJson = args.includes('--json')
const monthArg = args.find(a => a.startsWith('--month='))
const onlyMonth = monthArg ? parseInt(monthArg.slice(8), 10) : null

let pdfBuffer: Buffer
try {
  pdfBuffer = readFileSync(pdfPath)
} catch (e: any) {
  console.error(`Could not read ${pdfPath}: ${e.message}`)
  process.exit(2)
}

console.log(`Parsing ${pdfPath} (${(pdfBuffer.length / 1024).toFixed(1)} KB)…`)
const t0 = Date.now()
const result = await parseResultatrapport(pdfBuffer)
const elapsed = Date.now() - t0

if (!result.ok) {
  console.error(`\n❌ Parse FAILED in ${elapsed}ms: ${result.reason}`)
  if ((result as any).warnings?.length) {
    console.error('Warnings:')
    for (const w of (result as any).warnings) console.error(`  • ${w}`)
  }
  process.exit(4)
}

const ext = result.extraction
console.log(`\n✓ Parsed in ${elapsed}ms`)
console.log(`  doc_type:       ${ext.doc_type}`)
console.log(`  scale_detected: ${ext.scale_detected}`)
console.log(`  confidence:     ${ext.confidence}`)
console.log(`  periods:        ${ext.periods.length}`)
console.log(`  annual_lines:   ${ext.annual_lines.length}`)
if (ext.warnings.length) {
  console.log('\n⚠  Warnings:')
  for (const w of ext.warnings) console.log(`    • ${w}`)
}

const fmt = (n: number) => Math.round(n).toLocaleString('sv-SE').replace(/,/g, ' ')

console.log('\nPER-MONTH ROLLUPS:')
console.log('Month         Revenue      Dine-in     Takeaway     Alcohol    Food cost     (alc)      Staff      Other     Deprec    Fin    Net profit')
console.log('-'.repeat(160))
for (const p of ext.periods) {
  if (onlyMonth && p.month !== onlyMonth) continue
  const r = p.rollup
  const cells = [
    `${p.year}-${String(p.month).padStart(2, '0')}  `,
    fmt(r.revenue).padStart(12),
    fmt(r.dine_in_revenue).padStart(11),
    fmt(r.takeaway_revenue).padStart(11),
    fmt(r.alcohol_revenue).padStart(10),
    fmt(r.food_cost).padStart(11),
    `(${fmt(r.alcohol_cost)})`.padStart(10),
    fmt(r.staff_cost).padStart(10),
    fmt(r.other_cost).padStart(10),
    fmt(r.depreciation).padStart(9),
    fmt(r.financial).padStart(7),
    fmt(r.net_profit).padStart(12),
  ]
  console.log(cells.join(' '))
}

if (onlyMonth) {
  const p = ext.periods.find((x: any) => x.month === onlyMonth)
  if (p) {
    console.log(`\nLINE ITEMS for ${p.year}-${String(p.month).padStart(2, '0')}:`)
    console.log('Account  Category        Subcat              Amount  Label')
    console.log('-'.repeat(120))
    for (const l of p.lines) {
      console.log([
        String(l.account).padStart(7),
        l.category.padEnd(15),
        String(l.subcategory ?? '—').padEnd(17),
        fmt(l.amount).padStart(10),
        '  ' + l.label,
      ].join(' '))
    }
  }
}

if (wantJson) {
  console.log('\nFULL EXTRACTION JSON:')
  console.log(JSON.stringify(ext, null, 2))
}

// Sanity reconciliation — does sum-of-months equal annual_lines totals?
if (ext.periods.length > 1 && ext.annual_lines.length > 0) {
  console.log('\nRECONCILIATION (sum of monthly rollups vs annual line items):')
  const monthSum: Record<string, number> = {}
  for (const p of ext.periods) {
    for (const k of ['revenue','food_cost','staff_cost','other_cost','depreciation','financial']) {
      monthSum[k] = (monthSum[k] ?? 0) + (p.rollup as any)[k]
    }
  }
  const annualByCategory: Record<string, number> = {}
  for (const l of ext.annual_lines) {
    annualByCategory[l.category] = (annualByCategory[l.category] ?? 0) + l.amount
  }
  for (const k of ['revenue','food_cost','staff_cost','other_cost','depreciation','financial']) {
    const m = monthSum[k] ?? 0
    const a = annualByCategory[k] ?? 0
    const diff = m - a
    const pct = a !== 0 ? Math.abs(diff / a) * 100 : 0
    const flag = pct > 2 ? '⚠ ' : '✓ '
    console.log(`  ${flag}${k.padEnd(15)} months: ${fmt(m).padStart(12)}  annual: ${fmt(a).padStart(12)}  diff: ${fmt(diff).padStart(10)} (${pct.toFixed(1)}%)`)
  }
}

}
main().catch(e => { console.error(e); process.exit(99) })

