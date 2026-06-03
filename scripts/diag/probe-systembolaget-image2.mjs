import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
  viewport: { width: 1280, height: 800 },
})
const page = await ctx.newPage()

await page.goto('https://www.systembolaget.se/sortiment/?q=baileys', { waitUntil: 'domcontentloaded', timeout: 30000 })
for (const sel of ['button:has-text("Jag är 20")']) {
  try { const b = await page.waitForSelector(sel, { timeout: 2000 }); if (b) await b.click() } catch {}
}
await page.waitForTimeout(6000)

// Grab all <img src> on the page
const imgs = await page.$$eval('img', els => els.map(el => ({ src: el.src, alt: el.alt })).filter(i => i.src))
console.log(`Total images: ${imgs.length}`)
for (const i of imgs.slice(0, 20)) console.log(`  alt="${i.alt?.slice(0, 50)}"  src=${i.src.slice(0, 160)}`)

// Try to navigate to first product detail
const productLink = await page.$('a[href*="/produkt/"]')
if (productLink) {
  const href = await productLink.getAttribute('href')
  console.log(`\nNavigating to first product: ${href}`)
  await page.goto(`https://www.systembolaget.se${href}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForTimeout(4000)
  const detailImgs = await page.$$eval('img', els => els.map(el => ({ src: el.src, alt: el.alt })).filter(i => i.src))
  console.log(`Detail-page images: ${detailImgs.length}`)
  for (const i of detailImgs.slice(0, 10)) console.log(`  alt="${i.alt?.slice(0, 50)}"  src=${i.src.slice(0, 200)}`)
}

await browser.close()
