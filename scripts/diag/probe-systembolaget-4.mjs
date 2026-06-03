// Reproduce the scraper's loop pattern: navigate, wait, navigate, wait.
// Does the second navigation also fire productsearch responses?
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
    if (body?.products && Array.isArray(body.products)) {
      hits.push({ url: resp.url(), n: body.products.length })
    }
  } catch {}
})

async function dismissGates(p) {
  for (const sel of ['button:has-text("Jag är 20")', 'button:has-text("Ja, jag är")']) {
    try { const b = await p.waitForSelector(sel, { timeout: 2000 }); if (b) { await b.click(); break } } catch {}
  }
  for (const sel of ['button:has-text("Acceptera")', 'button:has-text("Tillåt")']) {
    try { const b = await p.waitForSelector(sel, { timeout: 2000 }); if (b) { await b.click(); break } } catch {}
  }
}

const queries = ['tenuta frescobaldi', 'Castello di Neive Langhe', 'Baileys Original', 'Frescobaldi Albizzia']
for (let i = 0; i < queries.length; i++) {
  hits.length = 0
  await page.goto(`https://www.systembolaget.se/sortiment/?q=${encodeURIComponent(queries[i])}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (i === 0) await dismissGates(page)
  await page.waitForTimeout(6000)
  console.log(`[${i+1}] "${queries[i]}"  → ${hits.length} hits`)
  for (const h of hits) console.log(`     ${h.n} products  ${h.url.slice(0, 120)}`)
}

await browser.close()
