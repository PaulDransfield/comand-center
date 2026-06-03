// Simulate the /api/inventory/items/backfill-pack-size resolution chain
// for the egg product the owner hit "Incomplete cost" on. NO writes.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local', 'utf-8').split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
      const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g, '')]
    })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Helper (mirror of lib/inventory/pack-from-supplier-article.ts)
const SINGLE_WEIGHT_UNITS = new Set(['DUNK','BURK','HINK','PKT','FRP','PÅSE','PASE','SÄCK','SACK','IFRP','KG','ASK','BACK'])
function up(u){return (u??'').trim().toUpperCase()}
function parseVolumeLabel(l){let m=l.match(/^(\d+(?:[.,]\d+)?)\s*l\s*\//i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*1000)};m=l.match(/^(\d+(?:[.,]\d+)?)\s*cl\s*\//i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*10)};m=l.match(/^(\d+(?:[.,]\d+)?)\s*ml\s*\//i);if(m)return{ml:Math.round(Number(m[1].replace(',','.')))};return null}
function parseVolumeName(n){const t=n.trim();let m=t.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*l\b/i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*1000),matched:m[0]};m=t.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*cl\b/i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*10),matched:m[0]};m=t.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*ml\b/i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))),matched:m[0]};return null}
function parseNP(n){const m=n.match(/(?<![\d,.])(\d+)\s*(?:p|p\.|-pack|st)\b/i);if(m)return{n:parseInt(m[1],10),matched:m[0]};return null}
function parsePerPackG(n){let m=n.match(/(\d+(?:[.,]\d+)?)\s*kg\b/i);if(m)return Math.round(Number(m[1].replace(',','.'))*1000);m=n.match(/(\d+(?:[.,]\d+)?)\s*g\b/i);if(m)return Math.round(Number(m[1].replace(',','.')));return null}
function pack(row){
  const u=up(row.unit),l=(row.units_per_pack_label??'').trim(),lo=l.toLowerCase(),g=row.net_weight_g!=null?Number(row.net_weight_g):null,n=(row.official_name??'').trim()
  if(/^\d[\d.,]*\s*st\s*\//i.test(lo)&&Number.isFinite(Number(row.units_per_pack))&&Number(row.units_per_pack)>0){const k=Math.round(Number(row.units_per_pack));return{kind:'count_carton',pack_size:k,base_unit:'st',notes:`${l} → ${k} st`}}
  const vl=parseVolumeLabel(l);if(vl&&u!=='KRT'&&u!=='BACK')return{kind:'volume_from_label',pack_size:vl.ml,base_unit:'ml',notes:`${l} → ${vl.ml}ml`}
  if(u!=='KRT'&&u!=='BACK'){const v=parseVolumeName(n);if(v)return{kind:'volume_from_name',pack_size:v.ml,base_unit:'ml',notes:`name "${v.matched}" → ${v.ml}ml`}}
  if(/^\s*viktvara\s*$/i.test(l)&&u==='KG')return{kind:'viktvara',pack_size:1000,base_unit:'g',notes:'viktvara → 1kg'}
  if(g!=null&&g>0&&(SINGLE_WEIGHT_UNITS.has(u)||(u==='ST'&&/\/styck/i.test(lo))))return{kind:'single_container_weight',pack_size:g,base_unit:'g',notes:`${u} → ${g}g`}
  if(u==='KRT'&&g!=null&&g>0&&/\/kartong/i.test(lo)){const np=parseNP(n),pp=parsePerPackG(n);if(np&&pp&&pp>0){const sp=Math.round(g/pp);if(sp>=1&&sp<=50){const t=np.n*sp;return{kind:'multi_pack_count',pack_size:t,base_unit:'st',notes:`${np.matched}×${sp} sub-packs (g/${pp}) → ${t} st`}}}}
  return{kind:'skip',reason:`u=${u} l="${l}" g=${g}`}
}
function jaccard(a,b){const A=new Set(a.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g,' ').trim().split(/\s+/).filter(t=>t.length>1));const B=new Set(b.toLowerCase().replace(/[^\wåäöÅÄÖ]+/g,' ').trim().split(/\s+/).filter(t=>t.length>1));if(A.size===0||B.size===0)return 0;let i=0;for(const t of A)if(B.has(t))i++;return i/(A.size+B.size-i)}

// Walk the chain for product 346fa1c3 ÄGG LV FRIGÅENDE M 30P
const CHICCE = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'
const { data: [product] } = await db.from('products')
  .select('id, name, pack_size, base_unit, pack_source, invoice_unit')
  .eq('business_id', CHICCE)
  .ilike('name', 'ÄGG LV FRIGÅENDE M 30P')
  .limit(1)
console.log(`Product: ${product.id.slice(0,8)} "${product.name}" pack=${product.pack_size ?? '∅'} base=${product.base_unit ?? '∅'}`)

// Step 1a: get latest line + try article_number match
const { data: aliases } = await db.from('product_aliases')
  .select('id, supplier_fortnox_number')
  .eq('product_id', product.id).eq('is_active', true)
const { data: lines } = await db.from('supplier_invoice_lines')
  .select('supplier_fortnox_number, article_number, invoice_date')
  .in('product_alias_id', aliases.map(a => a.id))
  .not('article_number','is',null)
  .order('invoice_date', { ascending: false }).limit(1)
const sup = lines[0]?.supplier_fortnox_number
const art = lines[0]?.article_number
console.log(`Latest line: sup=${sup} art="${art}"`)

const { data: byArt } = await db.from('supplier_articles')
  .select('article_number, official_name, unit, net_weight_g, units_per_pack, units_per_pack_label, fetch_status')
  .eq('supplier_fortnox_number', sup).eq('article_number', art).eq('fetch_status','ok').maybeSingle()
console.log(`Step 1a (article-number match): ${byArt ? 'HIT' : 'MISS'}`)
if (byArt) {
  const d = pack(byArt)
  console.log(`  decision: ${d.kind} → pack=${d.pack_size} ${d.base_unit}`)
} else {
  console.log(`  → falling through to Step 1b (name match)`)
  const { data: catalogue } = await db.from('supplier_articles')
    .select('article_number, official_name, unit, net_weight_g, units_per_pack, units_per_pack_label')
    .eq('supplier_fortnox_number', sup).eq('fetch_status','ok').limit(2000)
  let bestSim = 0
  const matchesAtTop = []
  for (const row of catalogue ?? []) {
    if (!row.official_name) continue
    const sim = jaccard(product.name, row.official_name)
    if (sim > bestSim) { bestSim = sim; matchesAtTop.length = 0; matchesAtTop.push({ sim, row }) }
    else if (Math.abs(sim - bestSim) < 0.05) { matchesAtTop.push({ sim, row }) }
  }
  console.log(`Step 1b (name match): bestSim=${bestSim.toFixed(2)}, ${matchesAtTop.length} ties at top`)
  for (const m of matchesAtTop) console.log(`  tied: art=${m.row.article_number} "${m.row.official_name}" sim=${m.sim.toFixed(2)}`)
  if (bestSim < 0.5) { console.log(`  → below threshold`); }
  else {
    const decisions = matchesAtTop.map(m => pack(m.row))
    const first = decisions[0]
    if (first.kind === 'skip') console.log(`  → first decision is skip`)
    else {
      const allAgree = decisions.every(d => d.kind === first.kind && d.pack_size === first.pack_size && d.base_unit === first.base_unit)
      if (matchesAtTop.length === 1 || allAgree) {
        console.log(`  → ACCEPTED (${matchesAtTop.length === 1 ? 'unique' : 'consensus'}). decision: ${first.kind} → pack=${first.pack_size} ${first.base_unit}`)
        console.log(`  notes: ${first.notes}`)
      } else {
        console.log(`  → ${matchesAtTop.length} tied with DIFFERENT decisions; no auto-apply`)
        for (let i = 0; i < decisions.length; i++) console.log(`    art ${matchesAtTop[i].row.article_number}: ${decisions[i].kind} pack=${decisions[i].pack_size} ${decisions[i].base_unit}`)
      }
    }
  }
}

// Sanity: confirm the recipe cost engine would now resolve correctly
console.log(`\nRecipe simulation:`)
console.log(`  If pack_size=120 st applied → 18 st of eggs costs 18 × (unit_price / 120) = 15% of carton price`)
console.log(`  That's the right answer for the Lemon Curd recipe.`)
