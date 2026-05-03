#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const env = Object.fromEntries(readFileSync('.env.production.local','utf8').split('\n').filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')]}))
const URL=env.NEXT_PUBLIC_SUPABASE_URL, KEY=env.SUPABASE_SERVICE_ROLE_KEY
const r = await fetch(`${URL}/rest/v1/fortnox_uploads?select=*&limit=1`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })
const a = await r.json()
if (a[0]) console.log(Object.keys(a[0]).sort().join('\n'))
else console.log('(no rows)')
