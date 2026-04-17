// One-shot Inzii diagnostic. Run: node scripts/diagnose-inzii.mjs
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.vercel', 'utf8')
    .split('\n')
    .filter(l => l.includes('='))
    .map(l => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, '')]
    })
)

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY
const ORG_ID       = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'

const headers = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  Accept:        'application/json',
}

async function q(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers })
  if (!r.ok) throw new Error(`${path} -> ${r.status} ${await r.text()}`)
  return r.json()
}

const bizs = await q(`businesses?org_id=eq.${ORG_ID}&select=id,name,city,is_active,created_at&order=created_at.desc`)
const bizMap = new Map(bizs.map(b => [b.id, b]))

const byOrg = await q(`integrations?org_id=eq.${ORG_ID}&provider=eq.inzii&select=id,provider,status,org_id,business_id,department,last_sync_at,last_error,created_at`)

// Any Inzii where business_id points at one of the org's businesses (catches org_id mismatches)
const bizIdList = bizs.map(b => b.id).join(',')
const byBiz = bizIdList
  ? await q(`integrations?provider=eq.inzii&business_id=in.(${bizIdList})&select=id,provider,status,org_id,business_id,department,last_sync_at,last_error,created_at`)
  : []

const seen = new Set()
const allInzii = [...byOrg, ...byBiz].filter(i => { if (seen.has(i.id)) return false; seen.add(i.id); return true })

// Look up any foreign businesses (business_ids not in this org)
const unknownBizIds = [...new Set(allInzii.map(i => i.business_id).filter(bid => bid && !bizMap.has(bid)))]
let foreign = []
if (unknownBizIds.length) {
  foreign = await q(`businesses?id=in.(${unknownBizIds.join(',')})&select=id,name,is_active,org_id`)
}
const foreignMap = new Map(foreign.map(b => [b.id, b]))

const labelled = allInzii.map(i => {
  let label, biz = null
  if (!i.business_id) label = 'no_business'
  else if (bizMap.has(i.business_id)) {
    biz = bizMap.get(i.business_id)
    label = biz.is_active ? 'matches_active_biz' : 'matches_inactive_biz'
  } else if (foreignMap.has(i.business_id)) {
    biz = foreignMap.get(i.business_id)
    label = biz.org_id === ORG_ID ? 'matches_unlinked_biz' : 'wrong_org'
  } else label = 'ghost_business'

  return {
    id:           i.id.slice(0, 8),
    department:   i.department,
    status:       i.status,
    org_match:    i.org_id === ORG_ID,
    biz_id:       i.business_id?.slice(0, 8) ?? null,
    label,
    biz_name:     biz?.name ?? null,
    biz_is_active: biz?.is_active ?? null,
    biz_org_id:   biz?.org_id === ORG_ID ? 'SAME' : biz?.org_id?.slice(0, 8) ?? null,
  }
})

console.log('\n=== BUSINESSES in org ===')
console.table(bizs.map(b => ({ id: b.id.slice(0, 8), name: b.name, is_active: b.is_active })))

console.log('\n=== INZII INTEGRATIONS ===')
console.table(labelled)

console.log('\n=== SUMMARY ===')
console.log({
  businesses_total:       bizs.length,
  businesses_active:      bizs.filter(b => b.is_active).length,
  inzii_total:            allInzii.length,
  matches_active_biz:     labelled.filter(l => l.label === 'matches_active_biz').length,
  matches_inactive_biz:   labelled.filter(l => l.label === 'matches_inactive_biz').length,
  matches_unlinked_biz:   labelled.filter(l => l.label === 'matches_unlinked_biz').length,
  wrong_org:              labelled.filter(l => l.label === 'wrong_org').length,
  no_business:            labelled.filter(l => l.label === 'no_business').length,
  ghost_business:         labelled.filter(l => l.label === 'ghost_business').length,
  org_id_mismatch:        labelled.filter(l => !l.org_match).length,
})

if (foreign.length) {
  console.log('\n=== FOREIGN BUSINESSES referenced by Inzii rows ===')
  console.table(foreign.map(b => ({ id: b.id.slice(0, 8), name: b.name, is_active: b.is_active, org_id: b.org_id.slice(0, 8) })))
}
