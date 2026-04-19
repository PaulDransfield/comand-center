#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

// ALL monthly_metrics for Vero business, any org
const rows = await q(`monthly_metrics?select=*&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&year=eq.2026&month=eq.4`)
console.log(`scoped by business_id: ${rows.length} rows`)
for (const r of rows) console.log(`  id=${r.id}  org=${r.org_id?.slice(0,8)}  rev=${r.revenue}  staff=${r.staff_cost}  updated=${r.updated_at?.slice(0,19)}`)

// All April 2026 rows across all businesses
const all = await q(`monthly_metrics?select=*&year=eq.2026&month=eq.4`)
console.log(`\nAll Apr 2026 rows: ${all.length}`)
for (const r of all) console.log(`  biz=${r.business_id?.slice(0,8)}  org=${r.org_id?.slice(0,8)}  rev=${r.revenue}  staff=${r.staff_cost}`)

// Look for ORG-level row without business_id
const orgRows = await q(`monthly_metrics?select=*&org_id=eq.e917d4b8-635e-4be6-8af0-afc48c3c7450&year=eq.2026&month=eq.4`)
console.log(`\nBy org_id only: ${orgRows.length}`)
for (const r of orgRows) console.log(`  biz=${r.business_id?.slice(0,8) ?? '(null)'}  rev=${r.revenue}  staff=${r.staff_cost}`)
