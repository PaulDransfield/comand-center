#!/usr/bin/env node
// Check what feature flags / agent toggles currently exist.

import { readFileSync } from 'node:fs'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text(),status:r.status}}

const ORG='e917d4b8-635e-4be6-8af0-afc48c3c7450'

// Check the organisation_agents or feature_flags table if it exists
console.log('── organisation_agents table ──')
const oa = await q(`organisation_agents?select=*&org_id=eq.${ORG}`)
if (Array.isArray(oa)) for (const r of oa) console.log(`  ${r.agent_key?.padEnd(30)} enabled=${r.enabled}  updated=${r.updated_at?.slice(0,19)}`)
else console.log(`  ${JSON.stringify(oa).slice(0,200)}`)

console.log('\n── feature_flags table ──')
const ff = await q(`feature_flags?select=*&org_id=eq.${ORG}`)
if (Array.isArray(ff)) for (const r of ff) console.log(`  ${r.flag_key?.padEnd(30)} value=${JSON.stringify(r.value).slice(0,40)}`)
else console.log(`  ${JSON.stringify(ff).slice(0,200)}`)

console.log('\n── organisations.plan (affects which agents allowed) ──')
const org = await q(`organisations?select=id,name,plan,is_active&id=eq.${ORG}`)
if (Array.isArray(org)) for (const r of org) console.log(`  ${r.name}  plan=${r.plan}  active=${r.is_active}`)

console.log('\n── Resend key present? ──')
console.log(`  RESEND_API_KEY set: ${env.RESEND_API_KEY ? 'yes (len=' + env.RESEND_API_KEY.length + ')' : 'NO'}`)
console.log(`  CRON_SECRET set:    ${env.CRON_SECRET ? 'yes' : 'NO'}`)
console.log(`  ANTHROPIC_API_KEY:  ${env.ANTHROPIC_API_KEY ? 'yes' : 'NO'}`)
console.log(`  ADMIN_SECRET:       ${env.ADMIN_SECRET ? 'yes' : 'NO'}`)
