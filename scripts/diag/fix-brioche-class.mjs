// Re-evaluate products where the supplier_articles helper now produces a
// pack_size that differs from what's currently stored. Targets the
// Mini Brioche Roll class — products whose name has the "NxYg" pattern
// where the old parser captured Y (per-piece weight) but the correct
// value is N (count of pieces in the KRT).
//
// DRY-default. --apply to write.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const APPLY = process.argv.includes('--apply')

// Inline helper — mirror of lib/inventory/pack-from-supplier-article.ts
const SINGLE_WEIGHT_UNITS = new Set(['DUNK','BURK','HINK','PKT','FRP','PÅSE','PASE','SÄCK','SACK','IFRP','KG','ASK','BACK'])
function up(u){return (u??'').trim().toUpperCase()}
function parseVolumeLabel(l){let m=l.match(/^(\d+(?:[.,]\d+)?)\s*l\s*\//i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*1000)};m=l.match(/^(\d+(?:[.,]\d+)?)\s*cl\s*\//i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*10)};m=l.match(/^(\d+(?:[.,]\d+)?)\s*ml\s*\//i);if(m)return{ml:Math.round(Number(m[1].replace(',','.')))};return null}
function parseVolumeName(n){const t=n.trim();let m=t.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*l\b/i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*1000),matched:m[0]};m=t.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*cl\b/i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))*10),matched:m[0]};m=t.match(/(?<![\d,.])(\d+(?:[.,]\d+)?)\s*ml\b/i);if(m)return{ml:Math.round(Number(m[1].replace(',','.'))),matched:m[0]};return null}
function parseNP(n){const m=n.match(/(?<![\d,.])(\d+)\s*(?:p|p\.|-pack|st)\b/i);if(m)return{n:parseInt(m[1],10),matched:m[0]};return null}
function parseDirectCount(n){const m=n.match(/(?<![\d,.])(\d+)\s*x\s*(\d+(?:[.,]\d+)?)\s*(g|kg)\b/i);if(!m)return null;const N=parseInt(m[1],10);const num=Number(m[2].replace(',','.'));const perItemG=m[3].toLowerCase()==='kg'?Math.round(num*1000):Math.round(num);if(N<=0||N>10000||perItemG<=0)return null;return{n:N,perItemG,matched:m[0]}}
function parsePerPackG(n){let m=n.match(/(\d+(?:[.,]\d+)?)\s*kg\b/i);if(m)return Math.round(Number(m[1].replace(',','.'))*1000);m=n.match(/(\d+(?:[.,]\d+)?)\s*g\b/i);if(m)return Math.round(Number(m[1].replace(',','.')));return null}
function pack(row){
  const u=up(row.unit),l=(row.units_per_pack_label??'').trim(),lo=l.toLowerCase(),g=row.net_weight_g!=null?Number(row.net_weight_g):null,n=(row.official_name??'').trim()
  if(/^\d[\d.,]*\s*st\s*\//i.test(lo)&&Number.isFinite(Number(row.units_per_pack))&&Number(row.units_per_pack)>0){const k=Math.round(Number(row.units_per_pack));return{kind:'count_carton',pack_size:k,base_unit:'st',notes:`${l} → ${k} st`}}
  const vl=parseVolumeLabel(l);if(vl&&u!=='KRT'&&u!=='BACK')return{kind:'volume_from_label',pack_size:vl.ml,base_unit:'ml',notes:`${l} → ${vl.ml}ml`}
  if(u!=='KRT'&&u!=='BACK'){const v=parseVolumeName(n);if(v)return{kind:'volume_from_name',pack_size:v.ml,base_unit:'ml',notes:`name "${v.matched}" → ${v.ml}ml`}}
  if(/^\s*viktvara\s*$/i.test(l)&&u==='KG')return{kind:'viktvara',pack_size:1000,base_unit:'g',notes:'viktvara → 1kg'}
  if(g!=null&&g>0&&(SINGLE_WEIGHT_UNITS.has(u)||(u==='ST'&&/\/styck/i.test(lo))))return{kind:'single_container_weight',pack_size:g,base_unit:'g',notes:`${u} → ${g}g`}
  let eg=g
  if((eg==null||eg<=0)&&u==='KRT'&&/^(\d+(?:[.,]\d+)?)\s*kg\s*\//i.test(l)){const m=l.match(/^(\d+(?:[.,]\d+)?)\s*kg\s*\//i);if(m)eg=Math.round(Number(m[1].replace(',','.'))*1000)}
  if(u==='KRT'&&eg!=null&&eg>0&&/\/kartong/i.test(lo)){
    const direct=parseDirectCount(n);
    if(direct){const claimed=direct.n*direct.perItemG;const consistent=Math.abs(claimed-eg)/eg<=0.15;if(consistent)return{kind:'multi_pack_count',pack_size:direct.n,base_unit:'st',notes:`"${direct.matched}" → ${direct.n} × ${direct.perItemG}g`}}
    const np=parseNP(n),pp=parsePerPackG(n);if(np&&pp&&pp>0){const sp=Math.round(eg/pp);if(sp>=1&&sp<=50){const t=np.n*sp;return{kind:'multi_pack_count',pack_size:t,base_unit:'st',notes:`${np.matched}×${sp} → ${t} st`}}}
  }
  return{kind:'skip',reason:`u=${u} l="${l}" g=${g}`}
}

for (const biz of [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]) {
  console.log(`\n=== ${biz.name} ===`)

  // 1. Active products NOT owner_set
  const products = []
  let from = 0
  while (true) {
    const { data } = await db.from('products')
      .select('id, name, pack_size, base_unit, pack_source, invoice_unit')
      .eq('business_id', biz.id).is('archived_at', null)
      .or('pack_source.neq.owner_set,pack_source.is.null')   // SAFE — skip owner_set
      .order('id').range(from, from + 999)
    if (!data?.length) break
    products.push(...data)
    if (data.length < 1000) break; from += 1000
  }
  console.log(`Products considered: ${products.length}`)

  // 2. For each product, find latest article via aliases
  const productCombos = new Map()
  const ids = products.map(p => p.id)
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200)
    const { data: aliases } = await db.from('product_aliases').select('id, product_id').in('product_id', slice).eq('is_active', true)
    if (!aliases?.length) continue
    const aliasToProduct = new Map(aliases.map(a => [a.id, a.product_id]))
    const aliasIds = aliases.map(a => a.id)
    for (let j = 0; j < aliasIds.length; j += 200) {
      const aSlice = aliasIds.slice(j, j + 200)
      const { data: lines } = await db.from('supplier_invoice_lines')
        .select('product_alias_id, supplier_fortnox_number, article_number, invoice_date')
        .in('product_alias_id', aSlice)
        .not('article_number','is',null).not('supplier_fortnox_number','is',null)
        .order('invoice_date', { ascending: false }).limit(2000)
      for (const l of lines ?? []) {
        const pid = aliasToProduct.get(l.product_alias_id); if (!pid) continue
        if (productCombos.has(pid)) continue
        productCombos.set(pid, `${l.supplier_fortnox_number}|${l.article_number}`)
      }
    }
  }

  // 3. Pull supplier_articles for those combos
  const articleByCombo = new Map()
  const combos = [...new Set([...productCombos.values()])]
  for (let i = 0; i < combos.length; i += 60) {
    const slice = combos.slice(i, i + 60)
    const orParts = slice.map(k => { const [s,a] = k.split('|'); return `and(supplier_fortnox_number.eq.${s},article_number.eq.${a})` })
    const { data } = await db.from('supplier_articles')
      .select('supplier_fortnox_number, article_number, unit, net_weight_g, units_per_pack, units_per_pack_label, official_name')
      .or(orParts.join(',')).eq('fetch_status', 'ok')
    for (const r of data ?? []) articleByCombo.set(`${r.supplier_fortnox_number}|${r.article_number}`, r)
  }

  // 4. For each product with supplier_articles, compare current pack vs helper output.
  // SAFE GATES (only update when one of these holds):
  //   - Current pack_source = 'invoice_unit_inferred' — old value was a guess;
  //     supplier_articles is unambiguously better.
  //   - Current value clearly buggy (<10 for any unit) — Swedish-comma parser bug.
  //   - Helper kind ∈ {multi_pack_count, count_carton} AND base_unit changes
  //     to 'st' — this is the brioche/egg fix class (chef-readable counts
  //     beat per-piece weight for these SKUs).
  //   - Helper kind ∈ {volume_from_label, volume_from_name} AND current
  //     base_unit ≠ 'ml' — fix wrong-base-unit on bottles.
  //
  // SKIP otherwise: viktvara overreach (Champinjon 3kg → 1kg standard
  // wipes legitimate name_parsed), case-vs-piece ambiguity (Pannoumi 12x90g),
  // and small-count fields with conflicting unit changes (Etikett 500st).
  const proposals = []
  for (const p of products) {
    const combo = productCombos.get(p.id); if (!combo) continue
    const art = articleByCombo.get(combo); if (!art) continue
    const decision = pack(art)
    if (decision.kind === 'skip') continue
    if (p.pack_size === decision.pack_size && p.base_unit === decision.base_unit) continue

    const safeOverride =
      // Allow on guess-only baseline
      (p.pack_source === 'invoice_unit_inferred')
      // Allow on obvious parser bugs (Swedish-comma class)
      || (p.pack_size != null && Number(p.pack_size) > 0 && Number(p.pack_size) < 10)
      // Allow brioche/egg multi-pack class — converting to 'st'
      || ((decision.kind === 'multi_pack_count' || decision.kind === 'count_carton')
            && decision.base_unit === 'st' && p.base_unit !== 'st')
      // Allow volume fixes when current isn't already ml
      || ((decision.kind === 'volume_from_label' || decision.kind === 'volume_from_name')
            && decision.base_unit === 'ml' && p.base_unit !== 'ml')

    if (!safeOverride) continue
    proposals.push({ product: p, decision, art })
  }

  console.log(`Proposals (current ≠ helper output): ${proposals.length}`)
  for (const pr of proposals.slice(0, 20)) {
    const { product, decision } = pr
    console.log(`  • "${product.name}"`)
    console.log(`      ${product.pack_size} ${product.base_unit} (${product.pack_source ?? '∅'}) → ${decision.pack_size} ${decision.base_unit}  [${decision.kind}]`)
    console.log(`      ${decision.notes}`)
  }

  if (APPLY) {
    console.log(`\nAPPLYING ${proposals.length} updates…`)
    let ok = 0
    for (const pr of proposals) {
      const { error } = await db.from('products').update({
        pack_size:   pr.decision.pack_size,
        base_unit:   pr.decision.base_unit,
        pack_source: 'supplier_official',
      }).eq('id', pr.product.id)
      if (error) { console.error(`  "${pr.product.name}": ${error.message}`); continue }
      ok++
    }
    console.log(`Updated: ${ok} / ${proposals.length}`)
  } else {
    console.log(`(DRY — re-run with --apply to write)`)
  }
}
