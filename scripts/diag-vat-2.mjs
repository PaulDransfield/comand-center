#!/usr/bin/env node
// scripts/diag-vat-2.mjs
// Fully paginated PK pull + proper gross/net computation from item-level data.

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'

function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}

function decrypt(b64){
  const key=Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY,'hex')
  const p=Buffer.from(b64,'base64')
  const d=createDecipheriv('aes-256-gcm',key,p.subarray(0,12),{authTagLength:16})
  d.setAuthTag(p.subarray(p.length-16))
  return Buffer.concat([d.update(p.subarray(12,p.length-16)),d.final()]).toString('utf8')
}

async function q(path){
  const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${path}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}})
  return r.ok?r.json():{error:await r.text()}
}

const integs=await q(`integrations?select=id,credentials_enc&provider=eq.personalkollen&status=eq.connected`)
const veroIntegId='2475e1ef-a4d9-4442-ab50-bffe4e831258'
const integ=integs.find(i=>i.id===veroIntegId)??integs[0]
const token=decrypt(integ.credentials_enc)

// Fully paginate through PK sales for the day.
async function pkGetAll(startPath){
  const all=[]
  let url=`https://personalkollen.se/api${startPath}`
  while (url) {
    const r=await fetch(url,{headers:{Authorization:`Token ${token}`,Accept:'application/json'}})
    if (!r.ok) { console.error('PK err', r.status, await r.text().catch(()=>'')); break }
    const j=await r.json()
    all.push(...(j.results??[]))
    url=j.next??null
  }
  return all
}

const num=v=>{const n=parseFloat(v??0);return Number.isFinite(n)?n:0}

for (const DATE of ['2026-04-15','2026-04-16','2026-04-17','2026-04-18']) {
  const sales = await pkGetAll(`/sales/?sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59&page_size=500`)

  let sumPaymentsGross = 0        // payments — what customer paid (incl VAT + tip)
  let sumTip           = 0
  let sumItemGross     = 0        // Σ amount × price_per_unit
  let sumItemList      = 0        // Σ amount × list_price_per_unit
  let sumItemNet       = 0        // Σ amount × price_per_unit / (1 + vat)
  let sumVatAmount     = 0        // Σ vat portion of each item
  let vat12Gross       = 0
  let vat25Gross       = 0
  let vat06Gross       = 0
  let vat0Gross        = 0
  let otherVatRates    = new Set()

  for (const s of sales) {
    sumPaymentsGross += (s.payments ?? []).reduce((a, p) => a + num(p.amount), 0)
    sumTip           += num(s.tip)
    for (const i of (s.items ?? [])) {
      const qty = num(i.amount)
      const ppu = num(i.price_per_unit)
      const lpu = num(i.list_price_per_unit)
      const vat = num(i.vat)
      const gross = qty * ppu
      const net   = vat > 0 ? gross / (1 + vat) : gross
      sumItemGross += gross
      sumItemList  += qty * lpu
      sumItemNet   += net
      sumVatAmount += (gross - net)
      if      (vat === 0.25)                vat25Gross += gross
      else if (vat === 0.12)                vat12Gross += gross
      else if (vat === 0.06)                vat06Gross += gross
      else if (vat === 0)                   vat0Gross  += gross
      else                                  otherVatRates.add(vat)
    }
  }

  // Compare to what we actually stored in revenue_logs for the day (dedup, pk_* only).
  const stored = await q(
    `revenue_logs?select=revenue_date,provider,revenue&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&revenue_date=eq.${DATE}&order=provider`
  )
  const pkAgg = stored.find(r => r.provider === 'personalkollen')?.revenue ?? 0
  const pkDeptSum = stored.filter(r => r.provider?.startsWith('pk_')).reduce((a,r)=>a+Number(r.revenue),0)

  console.log(`\n═══════ ${DATE}  (${sales.length} sales) ═══════`)
  console.log(`  payments[].amount (GROSS + tip)   : ${sumPaymentsGross.toFixed(2)}  ← what we store`)
  console.log(`  sum tip                            : ${sumTip.toFixed(2)}`)
  console.log(`  payments − tip (GROSS ex-tip)      : ${(sumPaymentsGross - sumTip).toFixed(2)}`)
  console.log()
  console.log(`  Σ item gross  (qty × price)        : ${sumItemGross.toFixed(2)}`)
  console.log(`  Σ item list   (qty × list_price)   : ${sumItemList.toFixed(2)}`)
  console.log(`  Σ item NET    (gross / (1 + vat))  : ${sumItemNet.toFixed(2)}  ← probable "ex-moms"`)
  console.log(`  Σ VAT amount                       : ${sumVatAmount.toFixed(2)}`)
  console.log()
  console.log(`  Gross by VAT rate:`)
  console.log(`    25 % : ${vat25Gross.toFixed(2)}  (${((vat25Gross/sumItemGross)*100).toFixed(1)}%)`)
  console.log(`    12 % : ${vat12Gross.toFixed(2)}  (${((vat12Gross/sumItemGross)*100).toFixed(1)}%)`)
  console.log(`     6 % : ${vat06Gross.toFixed(2)}`)
  console.log(`     0 % : ${vat0Gross.toFixed(2)}`)
  if (otherVatRates.size) console.log(`    other: ${[...otherVatRates].join(', ')}`)
  console.log()
  console.log(`  Stored in revenue_logs:`)
  console.log(`    personalkollen (aggregate)       : ${pkAgg}`)
  console.log(`    Σ pk_* (per-dept)                 : ${pkDeptSum}`)
}
