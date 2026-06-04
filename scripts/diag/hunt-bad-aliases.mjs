// Surface owner_confirmed / fuzzy aliases whose raw_description shares
// almost no meaningful tokens with the product name they're attached to.
// Lookalike to the Coca Cola -> Lök Röd 1kg bug we found via
// peek-lok-rod-thumb.mjs. Read-only; outputs a ranked list of suspects.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

// Same stopword + tokenisation as the dedup normaliser — sv/it/en domain.
const STOPWORDS = new Set([
  'frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan',
  'lös','kg','hg','gr','gram','ml','cl','dl','liter','litre','st','stk','burk','flaska','paket','pkt',
  'frp','fp','pack','styck','kart','krt','dunk','hink','säck','sack','ifrp','ask','back',
  'rte','co','se','es','it','fr','dk','no','fi','nl','dop','igp','dgo','ks','sc','rb','kl1','dg','dgo',
])
function tokens(s) {
  if (!s) return []
  let t = String(s).toLowerCase().normalize('NFKD')
  t = t.replace(/\([^)]*\)/g, ' ')
  t = t.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|st|stk|x)\b/g, ' ')
  t = t.replace(/[^\p{Letter}\s]/gu, ' ')
  return t.split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w))
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b)
  const inter = [...A].filter(x => B.has(x)).length
  const union = new Set([...A, ...B]).size
  return union === 0 ? 0 : inter / union
}

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)
  // Load all active aliases + their product names
  let from = 0
  const rows = []
  while (true) {
    const { data } = await db.from('product_aliases')
      .select('id, product_id, raw_description, supplier_name_snapshot, match_method, is_active')
      .eq('business_id', biz.id)
      .eq('is_active', true)
      .order('id').range(from, from + 999)
    if (!data?.length) break
    rows.push(...data)
    if (data.length < 1000) break
    from += 1000
  }
  const productIds = [...new Set(rows.map(r => r.product_id))]
  const productNameById = new Map()
  for (let i = 0; i < productIds.length; i += 100) {
    const slice = productIds.slice(i, i + 100)
    const { data } = await db.from('products').select('id, name, archived_at').in('id', slice).is('archived_at', null)
    for (const p of data ?? []) productNameById.set(p.id, p.name)
  }

  const suspects = []
  for (const a of rows) {
    const prodName = productNameById.get(a.product_id)
    if (!prodName) continue
    const aT = tokens(a.raw_description)
    const pT = tokens(prodName)
    if (aT.length === 0 || pT.length === 0) continue
    const j = jaccard(aT, pT)
    if (j < 0.15) suspects.push({ ...a, prodName, j })
  }
  suspects.sort((x, y) => x.j - y.j)
  console.log(`  Active aliases scanned: ${rows.length}`)
  console.log(`  Suspects (Jaccard < 0.15): ${suspects.length}`)
  console.log(`  By match_method:`)
  const byMethod = new Map()
  for (const s of suspects) byMethod.set(s.match_method, (byMethod.get(s.match_method) ?? 0) + 1)
  for (const [m, n] of [...byMethod.entries()].sort((a,b) => b[1] - a[1])) console.log(`    ${m}: ${n}`)
  console.log(`\n  Top 25 worst:`)
  for (const s of suspects.slice(0, 25)) {
    console.log(`    j=${s.j.toFixed(2)}  [${s.match_method}]  "${s.raw_description?.slice(0,40)}"  →  "${s.prodName?.slice(0,40)}"`)
  }
}
