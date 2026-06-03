// Probe Systembolaget search page with Playwright. Capture any XHR/fetch
// requests it makes to the API to see how the frontend talks to the
// catalogue without the subscription key.
import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext()
const page = await ctx.newPage()

const apiCalls = []
page.on('request', req => {
  const u = req.url()
  if (u.includes('/api/') || u.includes('api-extern') || u.includes('productsearch')) {
    apiCalls.push({ url: u, method: req.method(), headers: req.headers() })
  }
})

console.log('Loading search page...')
await page.goto('https://www.systembolaget.se/sortiment/?q=Tenuta%20Frescobaldi', { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2000)

console.log(`\nAPI calls observed: ${apiCalls.length}`)
for (const c of apiCalls.slice(0, 10)) {
  console.log(`\n  ${c.method} ${c.url}`)
  for (const [k, v] of Object.entries(c.headers)) {
    if (/ocp-apim|subscription|authorization|api-key/i.test(k)) {
      console.log(`    ${k}: ${v?.slice(0, 60)}...`)
    }
  }
}

// Try to find product detail URL on the page
const links = await page.$$eval('a[href*="/produkt/"]', as => as.map(a => a.href).slice(0, 5))
console.log(`\nProduct links found: ${links.length}`)
for (const l of links) console.log(`  ${l}`)

// Inspect HTML for product card content
const html = await page.content()
console.log(`\nPage size: ${html.length} bytes`)
console.log(`Contains "Tenuta":   ${html.includes('Tenuta')}`)
console.log(`Contains "Frescobaldi": ${html.includes('Frescobaldi')}`)

await browser.close()
console.log('\nDone.')
