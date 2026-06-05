// scripts/diag/apply-m129-flips.mts
//
// One-shot: walk inventory_skipped_descriptions and flip every
// matching needs_review supplier_invoice_lines row to not_inventory.
// Removes the rematch-resurrected duplicates from the current queue
// without waiting for the next rematch sweep.
//
// Run after applying sql/M129 + the backfill from outcomes.

import fs from 'node:fs'
import { createClient } from '@supabase/supabase-js'

// Inlined copy of normaliseDescription from lib/inventory/normalise.ts —
// keep in sync. tsx ESM import resolution choked on the .ts import.
const UNIT_SUFFIX_RE = /(\d+)\s+(st|kg|hg|g|l|cl|ml|dl|pack|frp|fp|paket|liter|kilo|gram)\b/gi
function normaliseDescription(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .toLowerCase()
    .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
    .replace(/[éè]/g, 'e')
    .replace(/[^\w\s]/g, ' ')
    .replace(UNIT_SUFFIX_RE, (_, n, u) => `${n}${u.toLowerCase()}`)
    .replace(/\s+/g, ' ')
    .trim()
}

const env = Object.fromEntries(
  fs.readFileSync('.env.production.local','utf-8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => {
    const [k,...v] = l.split('='); return [k.trim(), v.join('=').trim().replace(/^['"]|['"]$/g,'')]
  })
)
const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const { data: rules } = await db.from('inventory_skipped_descriptions')
  .select('business_id, supplier_fortnox_number, normalised_description, unit')
  .range(0, 9999)
console.log(`Loaded ${rules?.length ?? 0} skip rules`)

let totalFlipped = 0
for (const rule of rules ?? []) {
  // Pull needs_review lines for this (business, supplier). Filter client-side
  // by the rule's normalised description + unit so we don't need an exact-on
  // generated column.
  const { data: lines, error } = await db.from('supplier_invoice_lines')
    .select('id, raw_description, unit')
    .eq('business_id', rule.business_id)
    .eq('supplier_fortnox_number', rule.supplier_fortnox_number)
    .eq('match_status', 'needs_review')
    .limit(2000)
  if (error) { console.error(`  ${rule.supplier_fortnox_number}: ${error.message}`); continue }
  if (!lines?.length) continue

  const ids = lines
    .filter((l: any) => normaliseDescription(l.raw_description) === rule.normalised_description
                     && (l.unit ?? '').trim().toLowerCase() === rule.unit)
    .map((l: any) => l.id)
  if (ids.length === 0) continue

  // Batch 100 for the .in() header-size limit.
  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100)
    const { data, error: uErr } = await db.from('supplier_invoice_lines')
      .update({ match_status: 'not_inventory' })
      .in('id', slice)
      .select('id')
    if (uErr) { console.error(`  update batch: ${uErr.message}`); continue }
    totalFlipped += data?.length ?? 0
  }
}
console.log(`Flipped ${totalFlipped} needs_review lines to not_inventory.`)
