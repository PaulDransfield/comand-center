#!/usr/bin/env node
// Final sanity check: simulate the NEW getSales() against live PK for 4 recent
// days, predict what will land in revenue_logs, and show side-by-side with what
// we currently have stored.

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

console.log(`
Date        Raw sales  Net ex-VAT   Food (12%)   Drink (25%)  Other    Stored now
──────────  ────────── ──────────── ──────────── ───────────  ──────── ──────────`)

for (const DATE of ['2026-04-14','2026-04-15','2026-04-16','2026-04-17','2026-04-18']) {
  const sales = await pkAll(`/sales/?sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59&page_size=500`)
  let net=0, food=0, drink=0, other=0
  for (const s of sales) for (const i of (s.items ?? [])) {
    const line = num(i.amount) * num(i.price_per_unit)
    const vat = num(i.vat)
    net += line
    if      (Math.abs(vat - 0.12) < 0.001) food  += line
    else if (Math.abs(vat - 0.25) < 0.001) drink += line
    else                                   other += line
  }
  const stored = await q(`revenue_logs?select=revenue&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&revenue_date=eq.${DATE}&provider=eq.personalkollen`)
  const s = stored[0]?.revenue ?? 0
  console.log(`${DATE}  ${String(sales.length).padStart(8)}  ${net.toFixed(0).padStart(10)}  ${food.toFixed(0).padStart(10)}  ${drink.toFixed(0).padStart(10)}  ${other.toFixed(0).padStart(6)}  ${String(s).padStart(9)}`)
}

console.log(`
After the fix deploys + next sync, the "Stored now" column will be replaced by
the "Net ex-VAT" figure. Compare those against PK's Försäljning dashboard for
these same dates to confirm the match.`)
