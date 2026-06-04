// Fix the Lök Röd 1kg → Coca Cola alias mismatch found via
// peek-lok-rod-thumb.mjs. Alias fbf46c27 has raw="COCA COLA BRK 33CL"
// but is owner_confirmed onto product a7b6f8c3 "Lök Röd 1kg" at Chicce.
//
// Drops the alias (is_active=false) so:
//   1. The thumbnail route stops pulling the Coke combo
//   2. The matcher re-evaluates the lines on next rematch
//
// Also flips the matched supplier_invoice_lines off this alias →
// match_status='needs_review' so they re-enter the review queue
// and the kitchen can re-confirm them onto the right product.
//
// DRY by default, --apply to write.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const APPLY = process.argv.includes('--apply')

// Look up by the unique combination identified in the diag: this
// specific product + the COCA COLA raw description.
const PRODUCT_ID = 'a7b6f8c3' // Lök Röd 1kg @ Chicce — prefix
const RAW_LIKE   = 'COCA COLA BRK 33CL'

const { data: prods } = await db.from('products').select('id').ilike('name','Lök Röd 1kg').limit(5)
const pid = prods?.[0]?.id
if (!pid) { console.log('Product not found'); process.exit(0) }
const { data: aliasMatches } = await db.from('product_aliases')
  .select('id, product_id, supplier_name_snapshot, raw_description, is_active, match_method, business_id')
  .eq('product_id', pid).eq('raw_description', RAW_LIKE)
if (!aliasMatches?.length) { console.log('Alias not found'); process.exit(0) }
const alias = aliasMatches[0]
console.log(`Found: ${alias.id}  product=${alias.product_id.slice(0,8)}  raw="${alias.raw_description}"  active=${alias.is_active}`)

const { count: linesCount } = await db.from('supplier_invoice_lines')
  .select('id', { count: 'exact', head: true })
  .eq('product_alias_id', alias.id).eq('match_status', 'matched')
console.log(`Matched lines feeding this alias: ${linesCount}`)

if (!APPLY) { console.log('\n(DRY — re-run with --apply)'); process.exit(0) }

const { error: aErr } = await db.from('product_aliases').update({
  is_active: false,
  deactivated_at: new Date().toISOString(),
  deactivated_reason: 'manual_admin',
}).eq('id', alias.id)
if (aErr) { console.error('alias update failed:', aErr.message); process.exit(1) }
console.log(`Alias deactivated.`)

const { error: lErr, count: flipped } = await db.from('supplier_invoice_lines')
  .update({ match_status: 'needs_review', product_alias_id: null }, { count: 'exact' })
  .eq('product_alias_id', alias.id).eq('match_status', 'matched')
if (lErr) { console.error('lines update failed:', lErr.message); process.exit(1) }
console.log(`Lines flipped to needs_review: ${flipped ?? '?'}`)
