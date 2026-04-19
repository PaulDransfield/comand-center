#!/usr/bin/env node
// Simulate exactly what the NEW getSales() does for a 9-day window.

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
function decrypt(b64){const k=Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY,'hex');const p=Buffer.from(b64,'base64');const d=createDecipheriv('aes-256-gcm',k,p.subarray(0,12),{authTagLength:16});d.setAuthTag(p.subarray(p.length-16));return Buffer.concat([d.update(p.subarray(12,p.length-16)),d.final()]).toString('utf8')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}
const integs=await q(`integrations?select=id,credentials_enc&provider=eq.personalkollen&status=eq.connected`)
const token=decrypt(integs.find(i=>i.id==='2475e1ef-a4d9-4442-ab50-bffe4e831258').credentials_enc)

const FROM = '2026-04-10'
const TO   = '2026-04-19'
const endpoint = `/sales/?sale_time__gte=${FROM}T00:00:00`
console.log(`Single query: ${endpoint}`)
let url = `https://personalkollen.se/api${endpoint}`
const all = []
let pages = 0
while (url) {
  pages++
  const r = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
  if (!r.ok) break
  const j = await r.json()
  all.push(...(j.results ?? []))
  url = j.next
  if (pages > 300) break
}
console.log(`Returned ${all.length} rows across ${pages} pages\n`)

const cutoff = `${TO}T23:59:59.999Z`
const seen = new Set()
const raw = []
for (const s of all) {
  if (!s.uid || seen.has(s.uid)) continue
  if (s.sale_time && s.sale_time > cutoff) continue
  seen.add(s.uid)
  raw.push(s)
}
console.log(`After dedupe + cutoff: ${raw.length} unique rows\n`)

const num=v=>{const n=parseFloat(v??0);return Number.isFinite(n)?n:0}
const byDate = {}
for (const s of raw) {
  const d = s.sale_time?.slice(0,10) ?? '?'
  if (!byDate[d]) byDate[d] = { count: 0, net: 0, gross: 0 }
  byDate[d].count++
  let net = 0
  for (const i of (s.items ?? [])) net += num(i.amount) * num(i.price_per_unit)
  byDate[d].net += net
  byDate[d].gross += (s.payments ?? []).reduce((a,p)=>a+num(p.amount),0)
}
console.log(`Date         sales    net ex-VAT    gross`)
for (const [d,v] of Object.entries(byDate).sort()) {
  console.log(`  ${d}   ${String(v.count).padStart(5)}  ${v.net.toFixed(0).padStart(10)}  ${v.gross.toFixed(0).padStart(11)}`)
}
