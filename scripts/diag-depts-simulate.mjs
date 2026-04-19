#!/usr/bin/env node
// Simulate /api/departments for Apr 13-19 — find where the 7x inflation is.

import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

const ORG = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
const dateFrom = '2026-04-13'
const dateTo   = '2026-04-19'

// Dept defs
const deptRows = await q(`departments?select=name,color,sort_order&org_id=eq.${ORG}&business_id=eq.${VERO}`)
console.log(`departments table (${deptRows.length}): ${deptRows.map(d=>d.name).join(', ')}`)

// Staff group fallback
const sgRows = await q(`staff_logs?select=staff_group&org_id=eq.${ORG}&staff_group=not.is.null&limit=500`)
const staffGroups = [...new Set(sgRows.map(r => r.staff_group))].filter(Boolean)
console.log(`unique staff_groups (${staffGroups.length}): ${staffGroups.join(', ')}`)

const deptNames = [...new Set([...(deptRows ?? []).map(d => d.name), ...staffGroups])].filter(Boolean)
console.log(`final dept names (${deptNames.length}): ${deptNames.join(', ')}`)

// Provider keys
const slug = s => s.toLowerCase().replace(/[^a-z0-9]/g,'_')
const allProv = [...new Set(deptNames.flatMap(n => [`inzii_${slug(n)}`, `pk_${slug(n)}`]))]
console.log(`\nproviders filter (${allProv.length}): ${allProv.join(', ')}`)

// Fetch rev logs using same pagination logic
async function pageAll(fn) { const out=[]; for (let o=0;;o+=1000) { const r = await fn(o, o+999); if (!Array.isArray(r)||r.length===0) break; out.push(...r); if (r.length<1000) break } return out }

const revLogs = await pageAll(async (lo, hi) => {
  const path = `revenue_logs?select=revenue_date,provider,revenue&org_id=eq.${ORG}&business_id=eq.${VERO}&revenue_date=gte.${dateFrom}&provider=in.(${allProv.map(p=>encodeURIComponent(p)).join(',')})&order=revenue_date.asc&limit=1000&offset=${lo}`
  return q(path)
})
const revFiltered = revLogs.filter(r => r.revenue_date <= dateTo)
console.log(`\nrev_logs fetched: ${revLogs.length}, after cutoff filter: ${revFiltered.length}`)

// Dept aggregation
const providerToDept = {}
for (const n of deptNames) {
  providerToDept[`inzii_${slug(n)}`] = n
  providerToDept[`pk_${slug(n)}`]    = n
}
const deptAcc = {}
for (const n of deptNames) deptAcc[n] = { revenue: 0, rows: 0 }
for (const r of revFiltered) {
  const d = providerToDept[r.provider]
  if (!d || !deptAcc[d]) continue
  deptAcc[d].revenue += Number(r.revenue)
  deptAcc[d].rows++
}
console.log(`\nPer-dept totals for ${dateFrom}..${dateTo}:`)
for (const [n, v] of Object.entries(deptAcc).filter(([,v])=>v.rows>0).sort((a,b)=>b[1].revenue-a[1].revenue)) {
  console.log(`  ${n.padEnd(25)} rev=${v.revenue.toFixed(0).padStart(10)}  rows=${v.rows}`)
}
console.log(`TOTAL: ${Object.values(deptAcc).reduce((a,v)=>a+v.revenue,0).toFixed(0)}`)
