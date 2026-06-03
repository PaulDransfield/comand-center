// Verify the helper now correctly resolves Mini Brioche Roll 150x27g.
import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'
const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')] })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Inline the helper (mirror of lib/inventory/pack-from-supplier-article.ts)
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
    if(direct){const claimed=direct.n*direct.perItemG;const consistent=Math.abs(claimed-eg)/eg<=0.15;if(consistent)return{kind:'multi_pack_count',pack_size:direct.n,base_unit:'st',notes:`"${direct.matched}" → ${direct.n} × ${direct.perItemG}g = ${claimed}g (net ${eg}g)`}}
    const np=parseNP(n),pp=parsePerPackG(n);if(np&&pp&&pp>0){const sp=Math.round(eg/pp);if(sp>=1&&sp<=50){const t=np.n*sp;return{kind:'multi_pack_count',pack_size:t,base_unit:'st',notes:`${np.matched}×${sp} sub-packs (g/${pp}) → ${t} st`}}}
  }
  return{kind:'skip',reason:`u=${u} l="${l}" g=${g}`}
}

const { data: art } = await db.from('supplier_articles')
  .select('article_number, official_name, unit, net_weight_g, units_per_pack, units_per_pack_label, fetch_status')
  .eq('article_number', '112828').maybeSingle()
console.log('Article 112828 (Mini Brioche Roll):', art)

if (art) {
  const decision = pack(art)
  console.log(`\nHelper decision:`, decision)
  console.log(`\nExpected: pack_size=150 st (150 pieces per KRT)`)
  console.log(`Result:   ${decision.kind === 'multi_pack_count' && decision.pack_size === 150 ? '✓ CORRECT' : '✗ WRONG'}`)
}
