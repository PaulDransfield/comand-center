#!/usr/bin/env node
// Break down the PK pull by workplace + sale_center for ONE day.

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
function decrypt(b64){const k=Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY,'hex');const p=Buffer.from(b64,'base64');const d=createDecipheriv('aes-256-gcm',k,p.subarray(0,12),{authTagLength:16});d.setAuthTag(p.subarray(p.length-16));return Buffer.concat([d.update(p.subarray(12,p.length-16)),d.final()]).toString('utf8')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

const integs=await q(`integrations?select=id,credentials_enc,business_id&provider=eq.personalkollen&status=eq.connected`)
const integ=integs.find(i=>i.id==='2475e1ef-a4d9-4442-ab50-bffe4e831258')
const token=decrypt(integ.credentials_enc)

async function pkAll(path){
  const all=[]; let url=`https://personalkollen.se/api${path}`
  while (url) { const r=await fetch(url,{headers:{Authorization:`Token ${token}`,Accept:'application/json'}});if(!r.ok)break;const j=await r.json();all.push(...(j.results??[]));url=j.next??null }
  return all
}
const num=v=>{const n=parseFloat(v??0);return Number.isFinite(n)?n:0}

// Pull all workplaces first to resolve URLs to names.
const workplaces = await pkAll('/workplaces/?page_size=200')
const wpMap = new Map(workplaces.map(w => [w.url, { name: w.name, id: w.uid }]))
console.log(`PK integration id: ${integ.id}`)
console.log(`integration business_id: ${integ.business_id}`)
console.log(`workplaces returned by token (${workplaces.length}):`)
for (const w of workplaces) console.log(`  ${String(w.uid ?? w.id ?? '?').padEnd(10)}  ${w.name ?? '(no name)'}  ${w.url}`)

const DATE = '2026-04-15'
const sales = await pkAll(`/sales/?sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59&page_size=500`)
console.log(`\n${sales.length} sales on ${DATE}. Breakdown by workplace:\n`)

const byWp = {}
for (const s of sales) {
  const wp  = s.workplace
  const key = wpMap.get(wp)?.name ?? `(unknown ${wp})`
  const pay = (s.payments ?? []).reduce((a,p)=>a+num(p.amount),0)
  const tip = num(s.tip)
  let itemNet = 0
  for (const i of (s.items ?? [])) itemNet += num(i.amount) * num(i.price_per_unit)
  if (!byWp[key]) byWp[key] = { count: 0, pay: 0, tip: 0, net: 0 }
  byWp[key].count++
  byWp[key].pay += pay
  byWp[key].tip += tip
  byWp[key].net += itemNet
}

const rows = Object.entries(byWp).sort((a,b) => b[1].pay - a[1].pay)
console.log(`  workplace                       sales    pay.gross       tip      items.net`)
for (const [name, v] of rows) {
  console.log(`  ${name.padEnd(32)}  ${String(v.count).padStart(5)}  ${v.pay.toFixed(2).padStart(11)}  ${v.tip.toFixed(2).padStart(8)}  ${v.net.toFixed(2).padStart(11)}`)
}

console.log(`\n  TOTAL                             ${String(sales.length).padStart(5)}  ${rows.reduce((a,[,v])=>a+v.pay,0).toFixed(2).padStart(11)}  ${rows.reduce((a,[,v])=>a+v.tip,0).toFixed(2).padStart(8)}  ${rows.reduce((a,[,v])=>a+v.net,0).toFixed(2).padStart(11)}`)

// Also check what the sync engine's syncPersonalkollen writes — look at distinct providers in revenue_logs for the same day.
const rl = await q(`revenue_logs?select=business_id,provider,revenue&revenue_date=eq.${DATE}`)
console.log(`\nrevenue_logs rows for ${DATE} (all orgs):`)
for (const r of rl) console.log(`  business=${r.business_id?.slice(0,8)}  provider=${r.provider?.padEnd(22)}  rev=${r.revenue}`)
