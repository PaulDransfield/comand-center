// Simulate the GET /api/inventory/prep-sessions/[id] enrichment EXACTLY
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const SESSION_ID = '4fb0f4cf-89e2-484e-a18e-6df74d2ef063'
// The session's business id
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: sessions } = await db
  .from('prep_sessions')
  .select('id, business_id')
  .eq('business_id', CHICCE)
  .is('completed_at', null)
const session = sessions?.[0]
console.log('session:', session?.id, 'biz:', session?.business_id)
const businessId = session.business_id

const { data: lines } = await db
  .from('prep_session_lines')
  .select('id, kind, entity_id, name_snapshot')
  .eq('session_id', session.id)
  .order('position')

const componentIds = lines.filter(l => l.kind === 'component').map(l => l.entity_id)
const productIds   = lines.filter(l => l.kind === 'product').map(l => l.entity_id)
console.log('componentIds:', componentIds)
console.log('productIds:', productIds)

// Step 1: sub-ingredients for components
console.log('\n── subIngs query for component ids:')
const { data: subIngs } = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, quantity, unit, notes, position, products(name)')
  .in('recipe_id', componentIds)
  .order('position')
console.log(`   returned ${(subIngs ?? []).length} rows`)
for (const i of subIngs ?? []) {
  console.log(`   recipe ${i.recipe_id.slice(0,8)} ing ${i.id.slice(0,8)} · ${i.quantity}${i.unit ?? ''} ${i.products?.name ?? i.product_id?.slice(0,8)} · notes=${JSON.stringify(i.notes)}`)
}

// Step 2: uses for products — two-step
console.log('\n── uses two-step for products:')
const { data: bizRecipes } = await db
  .from('recipes')
  .select('id, name')
  .eq('business_id', businessId)
  .is('archived_at', null)
const bizRecipeIds = (bizRecipes ?? []).map(r => r.id)
console.log(`   bizRecipeIds: ${bizRecipeIds.length}`)
const { data: ris } = await db
  .from('recipe_ingredients')
  .select('id, recipe_id, product_id, quantity, unit, notes')
  .in('product_id', productIds)
  .in('recipe_id', bizRecipeIds)
console.log(`   returned ${(ris ?? []).length} rows`)
for (const r of ris ?? []) {
  const rec = bizRecipes.find(b => b.id === r.recipe_id)
  console.log(`   product ${r.product_id.slice(0,8)} in ${rec?.name ?? '?'} · qty=${r.quantity}${r.unit ?? ''} notes=${JSON.stringify(r.notes)}`)
}
