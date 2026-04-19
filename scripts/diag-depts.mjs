#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

// Pull all pk_bella rows for Apr 13-19. Any duplicates?
const rows = await q(`revenue_logs?select=*&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&provider=eq.pk_bella&revenue_date=gte.2026-04-13&revenue_date=lte.2026-04-19&order=revenue_date`)
console.log(`pk_bella Apr 13-19: ${rows.length} rows`)
let sum = 0
for (const r of rows) { console.log(`  ${r.revenue_date}  rev=${r.revenue}  id=${r.id}  created=${r.created_at?.slice(0,19)}`); sum += Number(r.revenue) }
console.log(`SUM: ${sum}`)

// Check full distinct set of providers across all pk_*, inzii_*
const allProv = await q(`revenue_logs?select=provider&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&revenue_date=gte.2026-04-13&revenue_date=lte.2026-04-19`)
const counts = {}
for (const r of allProv) counts[r.provider] = (counts[r.provider] ?? 0) + 1
console.log(`\nDistinct providers on Apr 13-19:`)
for (const [p, n] of Object.entries(counts).sort((a,b)=>b[1]-a[1])) console.log(`  ${String(p).padEnd(25)} × ${n}`)
