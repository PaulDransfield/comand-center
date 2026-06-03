// Verify nothing got half-applied during the failed auto-merge run.
// Recipe_ingredient redirects ran BEFORE archive failed; check whether
// any of those redirects landed.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// All 64 orphan names from the DRY/apply output
const ORPHANS = [
  // Chicce
  'Argentinsk kummelfilé 110/220 MSC',
  'HARICOTS VERTS 2,5KG, Nyckelhål;',
  'HASSELNÖTSKÄRNA BLANCH 1KG Nyckelhål;',
  'Rödingfile färsk / salvelinus alpinus / od. Sverig',
  'Rödingfile färsk / salvelinus alpinus / od. Sverige',
  'Oxfilésvans',
  'Villa Massa Limoncello 50cl',
  'Kallrökt lax skivad fryst',
  'Tvål & Shampoo ULTRA 2,5L',
  'Hummerkött vac 320g * MSC',
  'Nitrilhandske Puderfri Blå L (200/infp)',
  'HJORTYTTERFILE 1,1-1,8KG Ursprungsland:Nya Zeeland',
  'KÖRSBÄR UKÄ 2,5KG Nyckelhål;',
  'Oxfilé svans 2,5kg x 2st',
  'Il Fattorino Bianco Eko 75eg',
]

const BIZ_IDS = [
  '63ada0ac-18af-406a-8ad3-4acfd0379f2c',  // Chicce
  '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99',  // Vero
]

console.log('Checking for half-applied state...\n')
let totalRecipeIngs = 0
for (const name of ORPHANS) {
  const { data: prods } = await db.from('products')
    .select('id, name, archived_at')
    .in('business_id', BIZ_IDS)
    .eq('name', name)
    .is('archived_at', null)
  for (const p of prods ?? []) {
    const { data: ings } = await db.from('recipe_ingredients').select('id').eq('product_id', p.id)
    console.log(`  "${p.name}" (${p.id.slice(0,8)}): ${ings?.length ?? 0} recipe_ingredients still pointing here`)
    totalRecipeIngs += ings?.length ?? 0
  }
}
console.log(`\nTotal recipe_ingredients still on orphans: ${totalRecipeIngs}`)
console.log(`(If this is non-zero, the redirect didn't happen — no half-state.)`)
console.log(`(If this is zero, redirects DID happen — orphans now need their archive done.)`)
