// Check what's in the user's active prep session
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: sessions } = await db
  .from('prep_sessions')
  .select('id, name, created_at, completed_at')
  .eq('business_id', CHICCE)
  .order('created_at', { ascending: false })
  .limit(5)
console.log('── Latest prep_sessions for Chicce:')
for (const s of sessions ?? []) {
  console.log(`   ${s.id.slice(0,8)} · ${s.name ?? '(no name)'} · created ${s.created_at} · ${s.completed_at ? 'COMPLETED' : 'ACTIVE'}`)
}

const active = (sessions ?? []).find(s => !s.completed_at)
if (active) {
  console.log(`\n── Active session ${active.id.slice(0,8)} lines:`)
  const { data: lines } = await db
    .from('prep_session_lines')
    .select('id, kind, entity_id, name_snapshot, total_qty, unit, uncertain, position')
    .eq('session_id', active.id)
    .order('position')
  for (const l of lines ?? []) {
    console.log(`   [${l.position}] ${l.kind} ${l.entity_id.slice(0,8)} · "${l.name_snapshot}" · ${l.total_qty}${l.unit ?? ''}`)
  }

  // For component lines, check if the entity_id matches a real recipe
  for (const l of (lines ?? []).filter(l => l.kind === 'component')) {
    const { data: r } = await db
      .from('recipes')
      .select('id, name, business_id, archived_at')
      .eq('id', l.entity_id)
      .maybeSingle()
    if (!r) console.log(`   !! component ${l.name_snapshot} entity_id ${l.entity_id} → NO MATCHING RECIPE`)
    else if (r.business_id !== CHICCE) console.log(`   !! component ${l.name_snapshot} → recipe in different biz ${r.business_id.slice(0,8)}`)
    else if (r.archived_at) console.log(`   !! component ${l.name_snapshot} → recipe ARCHIVED`)
  }

  // For product lines, check if the entity_id matches a real product + has recipe_ingredients
  for (const l of (lines ?? []).filter(l => l.kind === 'product')) {
    const { data: p } = await db
      .from('products')
      .select('id, name, business_id')
      .eq('id', l.entity_id)
      .maybeSingle()
    if (!p) console.log(`   !! product ${l.name_snapshot} entity_id ${l.entity_id} → NO MATCHING PRODUCT`)
    else if (p.business_id !== CHICCE) console.log(`   !! product ${l.name_snapshot} → product in different biz`)
    else {
      const { data: ris } = await db
        .from('recipe_ingredients')
        .select('id, recipe_id, notes')
        .eq('product_id', l.entity_id)
      if (!ris || ris.length === 0) console.log(`   ✗ product ${l.name_snapshot} (${l.entity_id.slice(0,8)}) has ZERO recipe_ingredients`)
      else console.log(`   ✓ product ${l.name_snapshot} → ${ris.length} ri rows`)
    }
  }
}
