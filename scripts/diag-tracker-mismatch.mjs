#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
const URL=env.NEXT_PUBLIC_SUPABASE_URL,KEY=env.SUPABASE_SERVICE_ROLE_KEY
const ORG='e917d4b8-635e-4be6-8af0-afc48c3c7450',VERO='0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'
async function q(p){const r=await fetch(`${URL}/rest/v1/${p}`,{headers:{apikey:KEY,Authorization:`Bearer ${KEY}`}});return r.ok?r.json():{error:await r.text()}}

const monthly = await q(`monthly_metrics?select=month,revenue,staff_cost&business_id=eq.${VERO}&year=eq.2026&order=month.asc`)
console.log('monthly_metrics Vero 2026:')
monthly.forEach(m => console.log(`  M${m.month}  rev=${m.revenue}  staff=${m.staff_cost}`))

const daily = await q(`daily_metrics?select=date,revenue,staff_cost&business_id=eq.${VERO}&date=gte.2026-04-01&date=lt.2026-05-01&order=date.asc`)
let totalRev=0, totalStaff=0
daily.forEach(d => { totalRev += Number(d.revenue||0); totalStaff += Number(d.staff_cost||0) })
console.log(`\ndaily_metrics Apr sum: rev=${totalRev}  staff=${totalStaff}  (${daily.length} days)`)

const aprMonthly = monthly.find(m => m.month === 4)
if (aprMonthly) {
  console.log(`\nApr monthly_metrics: rev=${aprMonthly.revenue}  staff=${aprMonthly.staff_cost}`)
  console.log(`Match: rev=${aprMonthly.revenue === totalRev ? 'YES' : 'NO'}  staff=${aprMonthly.staff_cost === totalStaff ? 'YES' : 'NO'}`)
}
