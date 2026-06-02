import { chromium } from 'playwright'
import fs from 'node:fs'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  locale: 'sv-SE',
  viewport: { width: 1280, height: 1800 },
})
const page = await ctx.newPage()
await page.goto('https://www.martinservera.se/produkter/262899/', { waitUntil: 'domcontentloaded', timeout: 30000 })
// Age gate
try {
  const btn = page.getByRole('button', { name: /20 år eller äldre/i }).first()
  if (await btn.isVisible({ timeout: 2000 })) {
    console.log('Clicking age gate…')
    await btn.click()
    await page.waitForTimeout(1500)
  }
} catch (_) {}
await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
await page.waitForTimeout(2000)
// Try clicking any "Detaljer"/"Specifikation" toggle
const labels = ['Detaljer', 'Specifikation', 'Specifikationer', 'Visa mer', 'Mer information']
for (const t of labels) {
  const btn = page.locator(`text="${t}"`).first()
  try {
    if (await btn.isVisible({ timeout: 500 })) {
      console.log(`Clicking "${t}"…`)
      await btn.click({ timeout: 2000 }).catch(() => {})
      await page.waitForTimeout(500)
    }
  } catch (_) {}
}
const html = await page.content()
fs.writeFileSync('scripts/diag/ms-rendered.html', html)
await page.screenshot({ path: 'scripts/diag/ms-shot.png', fullPage: true })
console.log(`HTML: ${html.length} chars → scripts/diag/ms-rendered.html`)
console.log(`Screenshot → scripts/diag/ms-shot.png`)
// Quick extracts
const ean = html.match(/\b\d{13}\b/)?.[0]
const imgs = Array.from(html.matchAll(/https?:\/\/[^"]*\.(?:jpg|jpeg|png|webp)/g)).map(m => m[0])
  .filter(s => !/logo|favicon|emv|inspiration|toppbild|annons|kategori|banner/i.test(s))
console.log(`EAN candidate: ${ean ?? '∅'}`)
console.log(`Image candidates (${imgs.length}):`)
for (const u of imgs.slice(0, 5)) console.log(`  ${u}`)
console.log(`Body text samples (Specifikation context):`)
const m = html.match(/.{0,30}Specifikation.{0,200}/g)
for (const x of (m ?? []).slice(0, 3)) console.log(`  …${x}…`)
await browser.close()
