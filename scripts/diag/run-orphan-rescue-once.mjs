// One-shot: run the orphan-rescue agent against Chicce + Vero against prod DB.
// Mirrors lib/inventory/orphan-rescue.ts so we can invoke without going through
// the cron route's auth shell.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] }))
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const apiKey = env.ANTHROPIC_API_KEY
if (!apiKey) { console.error('ANTHROPIC_API_KEY missing'); process.exit(1) }

const APPLY = process.argv.includes('--apply')
const MODEL = 'claude-haiku-4-5-20251001'
const CONF_FLOOR = 0.95
const MAX_CANDIDATES = 5
const JACCARD_FLOOR = 0.4

const STOPWORDS = new Set([
  'frys','fryst','eko','ekologisk','pet','varav','pant','per','enhet','sek','och','med','utan',
  'lös','kg','hg','gr','gram','ml','cl','dl','liter','litre','st','stk','burk','flaska','paket','pkt',
  'frp','fp','pack','styck','kart','krt','dunk','hink','säck','sack','ifrp','ask','back',
  'rte','co','se','es','it','fr','dk','no','fi','nl','dop','igp','ks','sc','rb','kl1','dg','krav',
])
function tokens(s){if(!s)return[];let t=String(s).toLowerCase().normalize('NFKD');t=t.replace(/\([^)]*\)/g,' ');t=t.replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|hg|g|gr|gram|ml|cl|dl|l|liter|litre|st|stk|x)\b/g,' ');t=t.replace(/[^\p{Letter}\s]/gu,' ');return t.split(/\s+/).filter(w=>w.length>=3&&!STOPWORDS.has(w))}
function jaccard(a,b){const A=new Set(a),B=new Set(b);const inter=[...A].filter(x=>B.has(x)).length;const union=new Set([...A,...B]).size;return union===0?0:inter/union}

const SYSTEM_PROMPT = `You verify whether two restaurant-catalogue products are the same SKU. The orphan is a newly-discovered product with no purchase history yet. The canonical is an existing product the matcher learned previously.

Return verdict='same' ONLY when you're confident they refer to the same real-world item — same flavour, same fat %, same grade, same vintage, same brand line, same country origin where mentioned. Pack-size variations (e.g. 12kg vs 2kg) ALWAYS mean different SKUs.

Return verdict='different' when any of the following differ: fat % (10% vs 23% mince), grade markings (Kl1 vs other), brand line (Mascarpone 47% vs 48%), country/origin codes (BR vs CR), vintage year, color/variety (Röd vs Gul), bone-in vs boneless.

Return verdict='uncertain' when the difference might just be supplier abbreviation or labelling style (KRAV vs Krav, Nyckelhål annotation, supplier code suffix) but you can't be sure.

Reply ONLY with valid JSON: {"verdict":"same|different|uncertain","confidence":0.95,"reasoning":"<one short sentence>"}`

async function callHaiku(orphan, canonical){
  const userMsg=`orphan:    "${orphan}"\ncanonical: "${canonical}"\n\nAre these the same SKU?`
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':apiKey,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:MODEL,max_tokens:200,system:SYSTEM_PROMPT,messages:[{role:'user',content:userMsg}]})})
  if(!r.ok)return{ok:false,error:`Anthropic ${r.status}: ${(await r.text()).slice(0,200)}`}
  const j=await r.json()
  const text=(j.content??[]).filter(b=>b.type==='text').map(b=>b.text??'').join('').trim()
  const s=text.indexOf('{'),e=text.lastIndexOf('}'); if(s<0||e<=s)return{ok:false,error:'no JSON'}
  let p; try{p=JSON.parse(text.slice(s,e+1))}catch(x){return{ok:false,error:`bad JSON: ${x.message}`}}
  const v=String(p.verdict??''); if(v!=='same'&&v!=='different'&&v!=='uncertain')return{ok:false,error:`bad verdict: ${v}`}
  return{ok:true,verdict:{verdict:v,confidence:Number(p.confidence)||0,reasoning:String(p.reasoning??'').slice(0,250)},tokensIn:j.usage?.input_tokens??0,tokensOut:j.usage?.output_tokens??0}
}

async function processOrphan(biz, orphan, canonicalsBySupplier, seen) {
  if (seen.has(orphan.id)) return null
  const sup = orphan.default_supplier_fortnox_number
  if (!sup) return null
  const sameSupplier = canonicalsBySupplier.get(sup) ?? []
  const orphanTokens = tokens(orphan.name)
  const candidates = sameSupplier
    .filter(c => String(c.pack_size ?? '') === String(orphan.pack_size ?? '') &&
                 String(c.base_unit ?? '') === String(orphan.base_unit ?? ''))
    .map(c => ({ c, j: jaccard(orphanTokens, tokens(c.name)) }))
    .filter(x => x.j >= JACCARD_FLOOR)
    .sort((a, b) => b.j - a.j)
    .slice(0, MAX_CANDIDATES)
  if (candidates.length === 0) {
    if (APPLY) await logSkip(biz, orphan, null, 0, 'skipped_no_candidate', null, 0, 0)
    return { action: 'skipped_no_candidate' }
  }
  const top = candidates[0]
  const r = await callHaiku(orphan.name, top.c.name)
  if (!r.ok) {
    if (APPLY) await logError(biz, orphan, top.c, r.error)
    return { action: 'error', error: r.error }
  }
  if (r.verdict.verdict !== 'same' || r.verdict.confidence < CONF_FLOOR) {
    if (APPLY) await logSkip(biz, orphan, top.c, candidates.length, 'skipped_low_confidence', r.verdict, r.tokensIn, r.tokensOut)
    return { action: 'skipped_low_confidence', verdict: r.verdict, candidate: top.c.name, tIn: r.tokensIn, tOut: r.tokensOut }
  }
  if (candidates.length > 1) {
    const r2 = await callHaiku(orphan.name, candidates[1].c.name)
    if (r2.ok && r2.verdict.verdict === 'same' && r2.verdict.confidence >= CONF_FLOOR) {
      if (APPLY) await logSkip(biz, orphan, top.c, candidates.length, 'skipped_ambiguous', r.verdict, r.tokensIn + r2.tokensIn, r.tokensOut + r2.tokensOut)
      return { action: 'skipped_ambiguous', verdict: r.verdict, candidate: top.c.name, tIn: r.tokensIn + r2.tokensIn, tOut: r.tokensOut + r2.tokensOut }
    }
  }
  if (APPLY) {
    await db.from('recipe_ingredients').update({ product_id: top.c.id }).eq('product_id', orphan.id)
    await db.from('products').update({ archived_at: new Date().toISOString() }).eq('id', orphan.id)
    await logMerged(biz, orphan, top.c, candidates.length, r.verdict, r.tokensIn, r.tokensOut)
  }
  return { action: 'merged', verdict: r.verdict, canonical: top.c.name, tIn: r.tokensIn, tOut: r.tokensOut }
}

async function logMerged(biz, o, c, n, v, tI, tO){await db.from('orphan_rescue_log').insert({business_id:biz,orphan_product_id:o.id,orphan_name:o.name,canonical_product_id:c.id,canonical_name:c.name,candidate_count:n,verdict:v.verdict,confidence:v.confidence,reasoning:v.reasoning,action:'merged',tokens_in:tI,tokens_out:tO})}
async function logSkip(biz, o, c, n, action, v, tI, tO){await db.from('orphan_rescue_log').insert({business_id:biz,orphan_product_id:o.id,orphan_name:o.name,canonical_product_id:c?.id??null,canonical_name:c?.name??null,candidate_count:n,verdict:v?.verdict??null,confidence:v?.confidence??null,reasoning:v?.reasoning??null,action,tokens_in:tI,tokens_out:tO})}
async function logError(biz, o, c, msg){await db.from('orphan_rescue_log').insert({business_id:biz,orphan_product_id:o.id,orphan_name:o.name,canonical_product_id:c?.id??null,canonical_name:c?.name??null,candidate_count:0,action:'error',error_message:msg.slice(0,500)})}

const BUSINESSES = [
  { name: 'Chicce', id: '63ada0ac-18af-406a-8ad3-4acfd0379f2c' },
  { name: 'Vero',   id: '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99' },
]

for (const biz of BUSINESSES) {
  console.log(`\n══ ${biz.name} ══════════════════════════════════════════════════════`)
  const { data: allProducts } = await db.from('products')
    .select('id, name, pack_size, base_unit, default_supplier_fortnox_number, default_supplier_name')
    .eq('business_id', biz.id).is('archived_at', null).order('id').limit(5000)
  const productIds = (allProducts ?? []).map(p => p.id)
  const aliasCount = new Map()
  for (let i = 0; i < productIds.length; i += 200) {
    const slice = productIds.slice(i, i + 200)
    const { data } = await db.from('product_aliases').select('product_id').in('product_id', slice).eq('is_active', true)
    for (const a of data ?? []) aliasCount.set(a.product_id, (aliasCount.get(a.product_id) ?? 0) + 1)
  }
  const orphans = (allProducts ?? []).filter(p => (aliasCount.get(p.id) ?? 0) === 0 && p.default_supplier_fortnox_number)
  const canonicals = (allProducts ?? []).filter(p => (aliasCount.get(p.id) ?? 0) > 0)
  console.log(`  Orphans: ${orphans.length}  Canonicals: ${canonicals.length}`)

  const sevenDaysAgo = new Date(Date.now() - 7*24*60*60*1000).toISOString()
  const { data: recent } = await db.from('orphan_rescue_log').select('orphan_product_id').eq('business_id', biz.id).gte('created_at', sevenDaysAgo)
  const seen = new Set((recent ?? []).map(r => r.orphan_product_id))

  const canonicalsBySupplier = new Map()
  for (const c of canonicals) {
    const sup = c.default_supplier_fortnox_number
    if (!sup) continue
    const arr = canonicalsBySupplier.get(sup) ?? []; arr.push(c); canonicalsBySupplier.set(sup, arr)
  }

  const buckets = { merged: 0, skipped_low_confidence: 0, skipped_ambiguous: 0, skipped_no_candidate: 0, error: 0 }
  let totalIn = 0, totalOut = 0
  const samples = { merged: [], skipped_low_confidence: [], skipped_ambiguous: [] }
  for (const o of orphans) {
    const r = await processOrphan(biz.id, o, canonicalsBySupplier, seen)
    if (!r) continue
    buckets[r.action] = (buckets[r.action] ?? 0) + 1
    totalIn += r.tIn ?? 0; totalOut += r.tOut ?? 0
    if (samples[r.action]?.length < 8) {
      samples[r.action]?.push({ orphan: o.name, canonical: r.canonical ?? r.candidate, conf: r.verdict?.confidence, reasoning: r.verdict?.reasoning })
    }
  }
  console.log(`\n  Results:`)
  for (const [k, v] of Object.entries(buckets)) console.log(`    ${k}: ${v}`)
  console.log(`  Tokens: in=${totalIn} out=${totalOut} cost ≈ $${((totalIn*0.000001) + (totalOut*0.000005)).toFixed(4)}`)
  for (const action of ['merged', 'skipped_low_confidence', 'skipped_ambiguous']) {
    if (samples[action].length) {
      console.log(`\n  Sample ${action}:`)
      for (const s of samples[action]) {
        console.log(`    "${s.orphan?.slice(0,40)}"  →  "${s.canonical?.slice(0,40)}"  conf=${s.conf} ${s.reasoning ? `· ${s.reasoning?.slice(0,90)}` : ''}`)
      }
    }
  }
}
console.log(`\n${APPLY ? '(APPLIED — actions written to orphan_rescue_log + products archived)' : '(DRY — re-run with --apply)'}`)
