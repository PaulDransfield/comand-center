#!/usr/bin/env node
// scripts/diag-vat-3.mjs
// Corrected: price_per_unit is NET, payments[].amount is GROSS.
// Compute true NET and GROSS for each day and compare to what we store.

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
  while (url) { const r=await fetch(url,{headers:{Authorization:`Token ${token}`,Accept:'application/json'}});if(!r.ok)break;const j=await r.json();all.push(...(j.results??[]));url=j.next??null }
  return all
}

const num=v=>{const n=parseFloat(v??0);return Number.isFinite(n)?n:0}

console.log(`
Assumption: price_per_unit is NET (ex-VAT); payment.amount is GROSS (inc-VAT + tip)

Day         Items NET    Items GROSS    Pay.gross    Pay.−tip    Stored     Diff vs pay.−tip
──────────  ─────────── ───────────── ──────────── ─────────── ────────── ────────────────`)

for (const DATE of ['2026-04-15','2026-04-16','2026-04-17','2026-04-18']) {
  const sales = await pkAll(`/sales/?sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59&page_size=500`)
  let net=0, gross=0, paygross=0, tip=0
  for (const s of sales) {
    paygross += (s.payments ?? []).reduce((a,p)=>a+num(p.amount),0)
    tip      += num(s.tip)
    for (const i of (s.items ?? [])) {
      const n = num(i.amount) * num(i.price_per_unit)
      const g = n * (1 + num(i.vat))
      net   += n
      gross += g
    }
  }
  const stored = await q(`revenue_logs?select=revenue&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&revenue_date=eq.${DATE}&provider=eq.personalkollen`)
  const storedVal = stored[0]?.revenue ?? 0
  const payExTip = paygross - tip
  const diff = Number(storedVal) - payExTip
  console.log(`${DATE}  ${net.toFixed(2).padStart(11)}  ${gross.toFixed(2).padStart(12)}  ${paygross.toFixed(2).padStart(11)}  ${payExTip.toFixed(2).padStart(10)}  ${String(storedVal).padStart(9)}  ${diff.toFixed(2).padStart(15)}`)
}

console.log(`
Interpretation guide:
  Items NET    = ex-moms  (what PK dashboard probably shows)
  Items GROSS  = inc-moms (items × (1 + vat rate))
  Pay.gross    = what customers paid (inc-moms + tip)
  Pay.−tip     = inc-moms without tip — should equal Items GROSS
`)
