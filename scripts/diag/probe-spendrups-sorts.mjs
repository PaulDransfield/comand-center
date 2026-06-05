import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const ORIGIN = 'https://www.spendrups.se'
const cookies = new Map()
function setCookie(setHdr) { if (!setHdr) return; for (const c of [].concat(setHdr)) { const m = c.match(/^([^=]+)=([^;]+)/); if (m) cookies.set(m[1].trim(), m[2].trim()) } }
function cookieHeader() { return [...cookies.entries()].map(([k,v]) => `${k}=${v}`).join('; ') }
const r1 = await fetch(`${ORIGIN}/avp/?returnUrl=%2fhitta-dryck%2f`, { headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'manual' })
setCookie(r1.headers.getSetCookie?.() ?? r1.headers.get('set-cookie'))
const html = await r1.text()
const m = html.match(/__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/)
const token = m[1]
const body = new URLSearchParams({ __RequestVerificationToken: token, age: '25' }).toString()
const r2 = await fetch(`${ORIGIN}/avp/?returnUrl=%2fhitta-dryck%2f`, { method: 'POST', headers: { 'User-Agent': 'Mozilla/5.0', 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieHeader(), 'Referer': `${ORIGIN}/avp/` }, body, redirect: 'manual' })
setCookie(r2.headers.getSetCookie?.() ?? r2.headers.get('set-cookie'))

for (const sort of ['name','namedesc','articlenumber','articlenumberdesc','alcohol','alcoholdesc','volume','volumedesc','brand','country','-name','sort-asc','-articlenumber']) {
  const r = await fetch(`${ORIGIN}/api/products?grid=small&sortfield=${sort}`, { headers: { 'User-Agent':'Mozilla/5.0','Cookie': cookieHeader(),'Accept':'application/json' } })
  const j = await r.json().catch(() => null)
  if (!j) { console.log(`${sort}: parse fail`); continue }
  console.log(`${sort.padEnd(20)} count=${j.items?.length}  first="${j.items?.[0]?.name?.slice(0,30)}"  last="${j.items?.[j.items.length-1]?.name?.slice(0,30)}"`)
}
