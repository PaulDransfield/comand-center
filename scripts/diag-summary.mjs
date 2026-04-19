#!/usr/bin/env node
import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}

console.log('\ndaily_metrics Vero Apr 13-19:')
const dm = await q(`daily_metrics?select=date,revenue,staff_cost,hours_worked,updated_at&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&date=gte.2026-04-13&order=date`)
for (const r of dm) console.log(`  ${r.date}  rev=${String(r.revenue).padStart(10)}  staff=${String(r.staff_cost).padStart(8)}  hrs=${r.hours_worked}  updated=${r.updated_at?.slice(0,19)}`)

console.log('\ndept_metrics Vero April:')
const depts = await q(`dept_metrics?select=dept_name,year,month,revenue,staff_cost,updated_at&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&year=eq.2026&month=eq.4&order=revenue.desc`)
for (const r of depts) console.log(`  ${r.dept_name.padEnd(20)}  rev=${String(r.revenue).padStart(10)}  staff=${String(r.staff_cost).padStart(8)}  updated=${r.updated_at?.slice(0,19)}`)

console.log('\nmonthly_metrics Vero April:')
const mm = await q(`monthly_metrics?select=year,month,revenue,staff_cost,updated_at&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&year=eq.2026&month=eq.4`)
for (const r of mm) console.log(`  ${r.year}-${String(r.month).padStart(2,'0')}  rev=${r.revenue}  staff=${r.staff_cost}  updated=${r.updated_at?.slice(0,19)}`)
