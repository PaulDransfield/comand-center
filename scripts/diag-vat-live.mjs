#!/usr/bin/env node
// Live PK pull for Apr 18 with page counting + sanity checks.

import { readFileSync } from 'node:fs'
import { createDecipheriv } from 'node:crypto'
function parseEnv(p){try{return Object.fromEntries(readFileSync(p,'utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))}catch{return{}}}
const env={...parseEnv('.env.local'),...parseEnv('.env.production.local')}
function decrypt(b64){const k=Buffer.from(env.CREDENTIAL_ENCRYPTION_KEY,'hex');const p=Buffer.from(b64,'base64');const d=createDecipheriv('aes-256-gcm',k,p.subarray(0,12),{authTagLength:16});d.setAuthTag(p.subarray(p.length-16));return Buffer.concat([d.update(p.subarray(12,p.length-16)),d.final()]).toString('utf8')}
async function q(p){const r=await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/${p}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`}});return r.ok?r.json():{error:await r.text()}}
const integs=await q(`integrations?select=id,credentials_enc&provider=eq.personalkollen&status=eq.connected`)
const token=decrypt(integs.find(i=>i.id==='2475e1ef-a4d9-4442-ab50-bffe4e831258').credentials_enc)

for (const DATE of ['2026-04-14','2026-04-17','2026-04-18']) {
  console.log(`\n── ${DATE} ──`)
  let url = `https://personalkollen.se/api/sales/?sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59`
  let page = 0
  let total = 0
  let timestamps = []
  while (url) {
    page++
    const r = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
    if (!r.ok) { console.error(`  err p${page}`, r.status); break }
    const j = await r.json()
    const got = j.results?.length ?? 0
    total += got
    if (page <= 3 || page % 10 === 0) console.log(`  page ${page}: ${got} rows, next=${j.next ? j.next.slice(60, 120) + '...' : 'null'}`)
    if (got > 0) {
      timestamps.push(j.results[0].sale_time, j.results[got-1].sale_time)
    }
    url = j.next
    if (page > 100) { console.log('  BAIL at 100 pages'); break }
  }
  console.log(`  TOTAL: ${total} sales across ${page} pages`)
  console.log(`  time range: ${timestamps[0]} → ${timestamps[timestamps.length-1]}`)

  // Also count unique sale UIDs to see if duplicates
  url = `https://personalkollen.se/api/sales/?sale_time__gte=${DATE}T00:00:00&sale_time__lt=${DATE}T23:59:59`
  const uids = new Set()
  let all = []
  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Token ${token}`, Accept: 'application/json' } })
    if (!r.ok) break
    const j = await r.json()
    for (const s of (j.results ?? [])) { uids.add(s.uid); all.push(s) }
    url = j.next
  }
  console.log(`  unique sale uids: ${uids.size} vs rows fetched: ${all.length}`)

  // Also what's stored in revenue_logs right now
  const stored = await q(`revenue_logs?select=provider,revenue,transactions&business_id=eq.0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99&revenue_date=eq.${DATE}&provider=eq.personalkollen`)
  console.log(`  stored personalkollen: rev=${stored[0]?.revenue ?? '?'} txns=${stored[0]?.transactions ?? '?'}`)
}
