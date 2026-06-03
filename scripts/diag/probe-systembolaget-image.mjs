// Find the real image URL for a Systembolaget product.
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()

const hits = []
page.on('response', async resp => {
  try {
    const ct = resp.headers()['content-type'] ?? ''
    if (!ct.includes('json')) return
    const body = await resp.json().catch(() => null)
    if (body?.products && Array.isArray(body.products) && body.products.length > 0) {
      hits.push(body.products[0])
    }
  } catch {}
})

await page.goto('https://www.systembolaget.se/sortiment/?q=baileys', { waitUntil: 'domcontentloaded', timeout: 30000 })
for (const sel of ['button:has-text("Jag är 20")']) {
  try { const b = await page.waitForSelector(sel, { timeout: 2000 }); if (b) await b.click() } catch {}
}
await page.waitForTimeout(6000)

console.log(`Hits: ${hits.length}`)
for (const p of hits.slice(0, 1)) {
  console.log(`\nProductNumber: ${p.productNumber}`)
  console.log(`Name: ${p.productNameBold} ${p.productNameThin}`)
  console.log(`\nimages: ${JSON.stringify(p.images, null, 2)}`)
  console.log(`\nimageModules: ${JSON.stringify(p.imageModules, null, 2)}`)
}

await browser.close()
