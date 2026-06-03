// Find the image src for a specific productNumber via its product link.
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
    if (body?.products && Array.isArray(body.products) && body.products.length > 0) hits.push(body)
  } catch {}
})

await page.goto('https://www.systembolaget.se/sortiment/?q=baileys', { waitUntil: 'domcontentloaded', timeout: 30000 })
for (const sel of ['button:has-text("Jag är 20")']) {
  try { const b = await page.waitForSelector(sel, { timeout: 2000 }); if (b) await b.click() } catch {}
}
await page.waitForTimeout(6000)

// Dump first product's full JSON
if (hits.length) {
  const p = hits[hits.length - 1].products[0]
  console.log('Full product fields:')
  console.log(JSON.stringify(p, null, 2).slice(0, 3000))
}

await browser.close()
