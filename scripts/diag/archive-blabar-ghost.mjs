// Archive Blåbär 2,5kg (2e23fd90) — the ghost with no aliases when
// there are 3 sibling products carrying the matching aliases.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')

const GHOST_ID = '2e23fd90-3903-4f2a-8522-da094094c5c8'
// Pick BLÅBÄR 2,5KG, Nyckelhål as canonical — its alias raw "BLÅBÄR 2,5KG"
// matches Martin Servera's standard invoice description for this SKU.
const CANONICAL_ID = 'bf720f6a' // (we'll resolve to full)

const { data: ghost } = await db.from('products').select('id, name, archived_at').eq('id', GHOST_ID).maybeSingle()
const { data: canonRows } = await db.from('products').select('id, name').ilike('name','BLÅBÄR 2,5KG, Nyckelhål').limit(1)
const canon = canonRows?.[0]
console.log(`Ghost:     ${ghost?.id?.slice(0,8)} "${ghost?.name}" archived=${ghost?.archived_at}`)
console.log(`Canonical: ${canon?.id?.slice(0,8)} "${canon?.name}"`)
if (!ghost || !canon) { console.log('Missing one or both'); process.exit(1) }
if (ghost.archived_at) { console.log('Ghost already archived'); process.exit(0) }

// Check recipe references on the ghost
const { count: refs } = await db.from('recipe_ingredients').select('id', { count: 'exact', head: true }).eq('product_id', ghost.id)
console.log(`Recipe ingredient refs on ghost: ${refs}`)

if (!APPLY) { console.log('\n(DRY — re-run with --apply)'); process.exit(0) }

if (refs && refs > 0) {
  const { error } = await db.from('recipe_ingredients').update({ product_id: canon.id }).eq('product_id', ghost.id)
  if (error) { console.error('repoint failed:', error.message); process.exit(1) }
  console.log(`Repointed ${refs} recipe_ingredients to canonical.`)
}
const { error } = await db.from('products').update({ archived_at: new Date().toISOString() }).eq('id', ghost.id)
if (error) { console.error('archive failed:', error.message); process.exit(1) }
console.log('Ghost archived.')
