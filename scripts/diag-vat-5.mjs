#!/usr/bin/env node
// Reproduce exactly what lib/sync/engine calls: getSales(token, from-90d, today).
// Check how many sales come back and whether they include Apr 15 data.

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
function decrypt(b64){const k=Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY,'hex');const p=Buffer.from(b64,'base64');const d=createDecipheriv('aes-256-gcm',k,p.subarray(0,12),{authTagLength:16});d.setAuthTag(p.subarray(p.length-16));return Buffer.concat([d.update(p.subarray(12,p.length-16)),d.final()]).toString('utf8')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}
const integs=await q(`integrations?select=id,credentials_enc&provider=eq.personalkollen&status=eq.connected`)
const token=decrypt(integs.find(i=>i.id==='2475e1ef-a4d9-4442-ab50-bffe4e831258').credentials_enc)

async function pkAll(path){
  const all=[]; let url=`https://personalkollen.se/api${path}`
  let pages=0
  while (url) {
    const r=await fetch(url,{headers:{Authorization:`Token ${token}`,Accept:'application/json'}})
    if (!r.ok) { console.error('err',r.status); break }
    const j=await r.json()
    all.push(...(j.results??[]))
    url=j.next??null
    pages++
    if (pages > 300) { console.warn('runaway paginator > 300 pages'); break }
  }
  return { all, pages }
}
const num=v=>{const n=parseFloat(v??0);return Number.isFinite(n)?n:0}

// Sync's actual call shape
const FROM = '2026-01-19'  // 90 days back from today
const TO   = '2026-04-19'
console.log(`Reproducing syncPersonalkollen call: /sales/?sale_time__gte=${FROM}&sale_time__lte=${TO}`)
const { all: syncSales, pages: syncPages } = await pkAll(`/sales/?sale_time__gte=${FROM}&sale_time__lte=${TO}`)
console.log(`→ ${syncSales.length} sales across ${syncPages} pages`)

// Break down what got returned — by date
const byDate = {}
for (const s of syncSales) {
  const d = s.sale_time?.slice(0,10) ?? '?'
  const amount = (s.payments ?? []).reduce((a,p)=>a+num(p.amount),0)
  if (!byDate[d]) byDate[d] = { count: 0, amount: 0 }
  byDate[d].count++
  byDate[d].amount += amount
}
const dates = Object.entries(byDate).sort((a,b) => a[0] < b[0] ? -1 : 1)
console.log(`\nDate range covered: ${dates[0]?.[0]} → ${dates[dates.length-1]?.[0]}`)
console.log(`Unique dates: ${dates.length}`)
// Compare sync results to T-format results for the same 4 recent days
console.log(`\nSync filter vs T-format filter, recent days:`)
console.log(`Date        Sync(count/amount)       T-format(count/amount)   Ratio`)
for (const D of ['2026-04-12','2026-04-13','2026-04-14','2026-04-15','2026-04-16','2026-04-17','2026-04-18']) {
  const s = byDate[D] ?? { count: 0, amount: 0 }
  const { all: tFmt } = await pkAll(`/sales/?sale_time__gte=${D}T00:00:00&sale_time__lt=${D}T23:59:59&page_size=500`)
  let tAmt = 0
  for (const sl of tFmt) tAmt += (sl.payments??[]).reduce((a,p)=>a+num(p.amount),0)
  const ratio = tAmt > 0 ? (s.amount / tAmt * 100).toFixed(1) + '%' : '—'
  console.log(`  ${D}   ${String(s.count).padStart(5)} / ${s.amount.toFixed(0).padStart(9)}      ${String(tFmt.length).padStart(5)} / ${tAmt.toFixed(0).padStart(9)}       ${ratio}`)
}

console.log(`\nFirst 5 dates in sync result (if pagination cap theory holds, these should be full-count):`)
for (const [d, v] of dates.slice(0, 5)) {
  console.log(`  ${d}  ${String(v.count).padStart(5)} sales  ${v.amount.toFixed(0).padStart(12)} kr`)
}
console.log(`\nLast 10 dates in sync result:`)
for (const [d, v] of dates.slice(-10)) {
  console.log(`  ${d}  ${String(v.count).padStart(5)} sales  ${v.amount.toFixed(0).padStart(12)} kr`)
}

// Now the same range but WITHOUT the date filter — see if filter is dropping data
console.log(`\n\nNow without date filter:`)
const { all: allSales, pages: allPages } = await pkAll('/sales/')
console.log(`→ ${allSales.length} sales across ${allPages} pages (full history)`)
const allByDate = {}
for (const s of allSales) {
  const d = s.sale_time?.slice(0,10) ?? '?'
  if (!allByDate[d]) allByDate[d] = 0
  allByDate[d]++
}
const allDates = Object.entries(allByDate).sort((a,b) => a[0] < b[0] ? -1 : 1)
console.log(`Full date range: ${allDates[0]?.[0]} → ${allDates[allDates.length-1]?.[0]}`)
// Count sales in Jan 19 → Apr 19 from the no-filter pull
const inWindow = allDates.filter(([d]) => d >= FROM && d <= TO)
const inWindowCount = inWindow.reduce((a,[,v])=>a+v,0)
console.log(`Sales in window ${FROM}→${TO}: ${inWindowCount} (vs ${syncSales.length} when filter applied)`)
