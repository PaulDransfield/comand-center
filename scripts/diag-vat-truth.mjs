#!/usr/bin/env node
// Simulate the new getSales logic. For each day, query PK starting at that
// day and filter to only rows whose sale_time is on that day.

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
function decrypt(b64){const k=Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY,'hex');const p=Buffer.from(b64,'base64');const d=createDecipheriv('aes-256-gcm',k,p.subarray(0,12),{authTagLength:16});d.setAuthTag(p.subarray(p.length-16));return Buffer.concat([d.update(p.subarray(12,p.length-16)),d.final()]).toString('utf8')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}
const integs=await q(`integrations?select=id,credentials_enc&provider=eq.personalkollen&status=eq.connected`)
const token=decrypt(integs.find(i=>i.id==='2475e1ef-a4d9-4442-ab50-bffe4e831258').credentials_enc)

async function pkAll(path){const a=[];let u=`https://personalkollen.se/api${path}`;while(u){const r=await fetch(u,{headers:{Authorization:`Token ${token}`,Accept:'application/json'}});if(!r.ok)break;const j=await r.json();a.push(...(j.results??[]));u=j.next??null}return a}
const num=v=>{const n=parseFloat(v??0);return Number.isFinite(n)?n:0}

console.log(`Date         rawResp filteredToSameDay  netEx-VAT   gross`)
for (const day of ['2026-04-14','2026-04-15','2026-04-16','2026-04-17','2026-04-18']) {
  const rows = await pkAll(`/sales/?sale_time__gte=${day}T00:00:00`)
  const filtered = rows.filter(r => typeof r.sale_time === 'string' && r.sale_time.slice(0,10) === day)
  let net = 0, gross = 0
  for (const s of filtered) {
    for (const i of (s.items ?? [])) net += num(i.amount) * num(i.price_per_unit)
    gross += (s.payments ?? []).reduce((a,p)=>a+num(p.amount),0)
  }
  console.log(`  ${day}  ${String(rows.length).padStart(5)}  ${String(filtered.length).padStart(14)}  ${net.toFixed(0).padStart(10)}  ${gross.toFixed(0).padStart(9)}`)
}
