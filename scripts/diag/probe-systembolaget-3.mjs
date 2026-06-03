// Capture ALL JSON responses (no URL filter) so we can see what the
// search page actually calls.
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
    if (!body) return
    const has = body.products ?? body.results ?? body.items
    if (Array.isArray(has) && has.length > 0) {
      hits.push({ url: resp.url(), n: has.length, keys: Object.keys(body).slice(0, 10) })
    }
  } catch {}
})

await page.goto('https://www.systembolaget.se/sortiment/?q=tenuta%20frescobaldi', { waitUntil: 'domcontentloaded', timeout: 30000 })
for (const sel of ['button:has-text("Jag är 20")', 'button:has-text("Ja, jag är")']) {
  try { const b = await page.waitForSelector(sel, { timeout: 1500 }); if (b) { await b.click(); break } } catch {}
}
for (const sel of ['button:has-text("Acceptera")', 'button:has-text("Tillåt")']) {
  try { const b = await page.waitForSelector(sel, { timeout: 1500 }); if (b) { await b.click(); break } } catch {}
}
await page.waitForTimeout(5000)

console.log(`JSON responses with array data: ${hits.length}`)
for (const h of hits) {
  console.log(`  ${h.n} items  keys=${h.keys.join(',')}`)
  console.log(`    ${h.url.slice(0, 140)}`)
}

await browser.close()
