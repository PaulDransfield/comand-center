#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

const VERO='0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

console.log('tracker_data for Vero 2026:')
const td = await q(`tracker_data?select=period_year,period_month,revenue,staff_cost,food_cost,updated_at&business_id=eq.${VERO}&period_year=eq.2026&order=period_month`)
for (const r of td) console.log(`  ${r.period_year}-${String(r.period_month).padStart(2,'0')}  rev=${r.revenue}  staff=${r.staff_cost}  food=${r.food_cost}  updated=${r.updated_at?.slice(0,19)}`)

console.log('\nmonthly_metrics for Vero 2026:')
const mm = await q(`monthly_metrics?select=year,month,revenue,staff_cost,food_cost&business_id=eq.${VERO}&year=eq.2026&order=month`)
for (const r of mm) console.log(`  ${r.year}-${String(r.month).padStart(2,'0')}  rev=${r.revenue}  staff=${r.staff_cost}  food=${r.food_cost}`)

console.log('\nTracker route would return for April:')
const apr_td = td.find(r => r.period_month === 4)
const apr_mm = mm.find(r => r.month === 4)
const realRev  = Math.round(Number(apr_mm?.revenue ?? 0))
const realCost = Math.round(Number(apr_mm?.staff_cost ?? 0))
const revenue  = realRev > 0 ? realRev : Number(apr_td?.revenue ?? 0)
const staffCost= realCost > 0 ? realCost : Number(apr_td?.staff_cost ?? 0)
console.log(`  revenue=${revenue}  staff_cost=${staffCost}`)
