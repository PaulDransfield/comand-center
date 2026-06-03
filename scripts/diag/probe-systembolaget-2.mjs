// Probe Systembolaget search page to understand what we can extract.
import { chromium } from 'playwright'
import fs from 'node:fs'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()

// Catch API responses
const apiResponses = []
page.on('response', async resp => {
  const u = resp.url()
  if (u.includes('api-extern') || u.includes('/api/')) {
    try {
      const ct = resp.headers()['content-type'] ?? ''
      if (ct.includes('json')) {
        const body = await resp.json().catch(() => null)
        apiResponses.push({ url: u, status: resp.status(), body })
      }
    } catch {}
  }
})

console.log('Loading search page for "tenuta frescobaldi"...')
await page.goto('https://www.systembolaget.se/sortiment/?q=tenuta%20frescobaldi', { waitUntil: 'domcontentloaded', timeout: 30000 })
// Handle the 20-years-old age gate
for (const sel of ['button:has-text("Jag är 20")', 'button:has-text("Ja, jag är")', '[data-test="age-gate-confirm"]', 'button:has-text("Ja")']) {
  try {
    const btn = await page.waitForSelector(sel, { timeout: 3000 })
    if (btn) { console.log(`  Clicking age gate: ${sel}`); await btn.click(); break }
  } catch {}
}
// Cookie banner
for (const sel of ['button:has-text("Acceptera")', 'button:has-text("Tillåt")', '[id*="accept"]']) {
  try {
    const btn = await page.waitForSelector(sel, { timeout: 2000 })
    if (btn) { console.log(`  Clicking cookie: ${sel}`); await btn.click(); break }
  } catch {}
}
await page.waitForTimeout(5000)

console.log(`\nAPI responses captured: ${apiResponses.length}`)
for (const r of apiResponses.slice(0, 5)) {
  console.log(`\n  ${r.status} ${r.url.slice(0, 100)}`)
  if (r.body) {
    const str = JSON.stringify(r.body)
    console.log(`    body size: ${str.length}, keys: ${Object.keys(r.body).slice(0, 10).join(',')}`)
    // Find first product-shaped item
    if (Array.isArray(r.body.products)) console.log(`    products: ${r.body.products.length}`)
    if (Array.isArray(r.body.results)) console.log(`    results: ${r.body.results.length}`)
    if (Array.isArray(r.body.items)) console.log(`    items: ${r.body.items.length}`)
    // First product
    const first = r.body.products?.[0] ?? r.body.results?.[0] ?? r.body.items?.[0] ?? null
    if (first) {
      console.log(`    sample item keys: ${Object.keys(first).slice(0, 15).join(', ')}`)
      console.log(`    sample item: ${JSON.stringify(first).slice(0, 300)}`)
    }
  }
}

// Inspect product cards on page
const products = await page.$$eval('[data-test*="product"], [class*="ProductCard"], a[href*="/produkt/"]', els =>
  els.slice(0, 5).map(el => ({
    tag: el.tagName,
    href: el.href ?? null,
    text: el.textContent?.slice(0, 100) ?? '',
    img: el.querySelector('img')?.src ?? null,
  }))
)
console.log(`\nProduct cards on page: ${products.length}`)
for (const p of products) console.log(`  ${p.tag} href=${p.href?.slice(0, 80)} img=${p.img?.slice(0, 80)} text="${p.text}"`)

// Save HTML
fs.writeFileSync('scripts/diag/systembolaget-search.html', await page.content())
console.log('\nSaved rendered HTML')

await browser.close()
