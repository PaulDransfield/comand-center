#!/usr/bin/env node
// Call the actual aggregator against prod DB for Vero and dump what it writes.
// Uses the real lib/sync/aggregate.ts via a tiny loader shim.

import { readFileSync } from 'node:fs'
function parseEnv(p) { try { return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]})) } catch { return {} } }
const env = { ...parseEnv('.env.local'), ...parseEnv('.env.production.local') }
for (const [k,v] of Object.entries(env)) process.env[k] = v

// Shim the Next module resolver
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

const ORG = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
const VERO = '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99'

// Inline the aggregator logic rather than importing (avoids the Next import-alias issue)
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const KEY  = env.SUPABASE_SERVICE_ROLE_KEY
async function q(path, opts={}){const r=await fetch(`${URL_}/rest/v1/${path}`,{method:opts.method||'GET',headers:{apikey:KEY,Authorization:`Bearer ${KEY}`,'Content-Type':'application/json',Prefer:opts.prefer||'return=representation'},body:opts.body});if(!r.ok){console.error('HTTP',r.status,await r.text());return null}return r.json()}

const from = '2026-01-19'
const to = '2026-04-19'

const rev = await q(`revenue_logs?select=revenue_date,revenue,covers,tip_revenue,food_revenue,bev_revenue,provider&org_id=eq.${ORG}&business_id=eq.${VERO}&revenue_date=gte.${from}&limit=50000`)
const staff = await q(`staff_logs?select=shift_date,cost_actual,estimated_salary,hours_worked&org_id=eq.${ORG}&business_id=eq.${VERO}&shift_date=gte.${from}&or=(cost_actual.gt.0,estimated_salary.gt.0)&limit=50000`)

console.log(`fetched rev=${rev.length} staff=${staff.length}`)

const toNum = v => { const n = typeof v === 'number' ? v : parseFloat(String(v)); return Number.isFinite(n) ? n : 0 }

const hasDept = rev.some(r => (r.provider||'').startsWith('pk_') || (r.provider||'').startsWith('inzii_'))
const revLogs = hasDept ? rev.filter(r => (r.provider||'') !== 'personalkollen') : rev

const dailyRev = {}
for (const r of revLogs) {
  const d = r.revenue_date
  if (!dailyRev[d]) dailyRev[d] = { revenue: 0 }
  dailyRev[d].revenue += toNum(r.revenue)
}

const dailyStaff = {}
for (const s of staff) {
  const d = s.shift_date
  if (!dailyStaff[d]) dailyStaff[d] = { cost: 0 }
  const cost = Number(s.cost_actual||0) > 0 ? Number(s.cost_actual) : Number(s.estimated_salary||0)
  dailyStaff[d].cost += cost
}

const allDates = Array.from(new Set([...Object.keys(dailyRev), ...Object.keys(dailyStaff)])).sort()
console.log(`\nwould write ${allDates.length} daily_metrics rows. Last 10:`)
allDates.slice(-10).forEach(d => console.log(`  ${d}  rev=${Math.round(dailyRev[d]?.revenue || 0)}  staff=${Math.round(dailyStaff[d]?.cost || 0)}`))

console.log(`\nApr 18 would be: rev=${Math.round(dailyRev['2026-04-18']?.revenue || 0)}  staff=${Math.round(dailyStaff['2026-04-18']?.cost || 0)}`)
console.log(`Apr 19 would be: rev=${Math.round(dailyRev['2026-04-19']?.revenue || 0)}  staff=${Math.round(dailyStaff['2026-04-19']?.cost || 0)}`)
