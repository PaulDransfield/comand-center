// Probe www.spendrups.se/hitta-dryck/ to see if the JS-rendered search
// results expose the 7-digit Spendrups article codes that match what's
// on invoices. If yes, Approach B is viable. If no, fall back to
// Approach A (Systembolaget name-match).
import { chromium } from 'playwright'

const KNOWN_CODES = ['2512514', '2580114', '2582314', '2566721', '2113911']
const KNOWN_NAMES = [
  'Tenuta Frescobaldi',
  'Delapierre',
  'Terre More Maremma',
  'Moscato d Asti',
  'Menabrea',
]

console.log('Launching Chromium...')
const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()

// 1. Open the search page
console.log('\n=== 1. /hitta-dryck/ ===')
await page.goto('https://www.spendrups.se/hitta-dryck/', { waitUntil: 'networkidle', timeout: 30000 })
const html1 = await page.content()
console.log(`Page size: ${html1.length} bytes`)
console.log(`Contains "produkt":      ${html1.includes('produkt')}`)
console.log(`Contains "artikelnummer":${html1.includes('artikelnummer')}`)
console.log(`Contains 7-digit codes: ${KNOWN_CODES.filter(c => html1.includes(c)).length}/${KNOWN_CODES.length}`)
console.log(`Contains known names:   ${KNOWN_NAMES.filter(n => html1.toLowerCase().includes(n.toLowerCase())).length}/${KNOWN_NAMES.length}`)

// 2. Try search for a known product
console.log('\n=== 2. Search for "Menabrea" ===')
await page.goto('https://www.spendrups.se/hitta-dryck/?search=Menabrea', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)
const html2 = await page.content()
console.log(`Page size: ${html2.length} bytes`)
// Look for product cards or links
const links = await page.$$eval('a', as => as.map(a => a.href).filter(h => h && h.includes('spendrups.se') && !h.includes('javascript')))
console.log(`Links found: ${links.length}`)
const productLinks = links.filter(l => /\/dryck\/|\/produkt\/|\/p\/|\/varumarken\//.test(l))
console.log(`Possible product links: ${productLinks.length}`)
for (const l of productLinks.slice(0, 10)) console.log(`  ${l}`)

// 3. Save HTML to disk for inspection
fs.writeFileSync('scripts/diag/spendrups-search-rendered.html', html2)
console.log('\nSaved rendered HTML to scripts/diag/spendrups-search-rendered.html')

// 4. Try a direct product URL with one of our codes
console.log('\n=== 3. Direct /artikel/2512514 ===')
const resp = await page.goto('https://www.spendrups.se/artikel/2512514', { waitUntil: 'networkidle', timeout: 30000 }).catch(e => null)
if (resp) {
  console.log(`Status: ${resp.status()}`)
  const html3 = await page.content()
  console.log(`Page size: ${html3.length}`)
  console.log(`Contains "2512514":     ${html3.includes('2512514')}`)
  console.log(`Contains "TENUTA":      ${html3.toUpperCase().includes('TENUTA')}`)
}

await browser.close()
console.log('\nDone.')

import fs from 'node:fs'
