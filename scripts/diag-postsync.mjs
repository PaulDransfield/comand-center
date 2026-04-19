#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

for (const DATE of ['2026-04-14','2026-04-15','2026-04-17','2026-04-18']) {
  const rows = await q(`revenue_logs?select=business_id,provider,revenue,transactions,covers,food_revenue,bev_revenue&revenue_date=eq.${DATE}&order=provider`)
  console.log(`\n── ${DATE} ──`)
  for (const r of rows) {
    const biz = r.business_id?.slice(0,8) ?? '(null)'
    console.log(`  biz=${biz}  ${String(r.provider ?? '').padEnd(22)}  rev=${String(r.revenue).padStart(10)}  txns=${r.transactions ?? '?'}  covers=${r.covers ?? '?'}  food=${r.food_revenue ?? '?'}  bev=${r.bev_revenue ?? '?'}`)
  }
}
