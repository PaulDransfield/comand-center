#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

const VERO='0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// All distinct dates with personalkollen aggregate, plus per-day rev
const rev = await q(`revenue_logs?select=revenue_date,revenue,created_at&business_id=eq.${VERO}&provider=eq.personalkollen&order=revenue_date.asc&limit=500`)
console.log(`Earliest revenue_date: ${rev[0]?.revenue_date}  Latest: ${rev[rev.length-1]?.revenue_date}  (${rev.length} rows)`)

// Group by month
const byMonth = {}
for (const r of rev) {
  const ym = r.revenue_date?.slice(0, 7)
  if (!byMonth[ym]) byMonth[ym] = { count: 0, rev: 0, firstDate: r.revenue_date, lastDate: r.revenue_date, created: r.created_at }
  byMonth[ym].count++
  byMonth[ym].rev += Number(r.revenue)
  if (r.revenue_date < byMonth[ym].firstDate) byMonth[ym].firstDate = r.revenue_date
  if (r.revenue_date > byMonth[ym].lastDate) byMonth[ym].lastDate = r.revenue_date
}
console.log('\nrevenue_logs (personalkollen) per month:')
console.log('Month     days  revSum    range                     firstRowCreated')
for (const [m, v] of Object.entries(byMonth).sort()) {
  console.log(`  ${m}   ${String(v.count).padStart(3)}  ${v.rev.toFixed(0).padStart(10)}  ${v.firstDate}→${v.lastDate}  ${v.created?.slice(0,19)}`)
}

// monthly_metrics snapshot
const mm = await q(`monthly_metrics?select=year,month,revenue,staff_cost,updated_at&business_id=eq.${VERO}&order=year,month`)
console.log('\nmonthly_metrics snapshot:')
for (const r of mm) console.log(`  ${r.year}-${String(r.month).padStart(2,'0')}  rev=${r.revenue}  staff=${r.staff_cost}  updated=${r.updated_at?.slice(0,19)}`)
