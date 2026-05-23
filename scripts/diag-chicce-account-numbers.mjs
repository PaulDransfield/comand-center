// scripts/diag-chicce-account-numbers.mjs
//
// Does Chicce have account_number populated on supplier_invoice_lines?
// The matcher's BAS-account routing only works if Fortnox is posting
// AccountNumber on the row. If everything is NULL we fall back to
// supplier-name classification (much noisier).
//
// Run: node --env-file=.env.production.local scripts/diag-chicce-account-numbers.mjs

import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const BIZ = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: lines } = await db
  .from('supplier_invoice_lines')
  .select('account_number, match_status, supplier_name_snapshot')
  .eq('business_id', BIZ)
  .limit(10000)

const total = lines.length
const withAcct = lines.filter(l => l.account_number).length
const without  = total - withAcct

console.log(`Total lines:        ${total}`)
console.log(`With account_number: ${withAcct} (${(withAcct/total*100).toFixed(1)}%)`)
console.log(`Without:             ${without} (${(without/total*100).toFixed(1)}%)`)

// Top suppliers by line count, with how many have account_number
const bySupplier = {}
for (const l of lines) {
  const k = l.supplier_name_snapshot ?? '(unknown)'
  if (!bySupplier[k]) bySupplier[k] = { total: 0, with_acct: 0, status: {} }
  bySupplier[k].total++
  if (l.account_number) bySupplier[k].with_acct++
  bySupplier[k].status[l.match_status] = (bySupplier[k].status[l.match_status] ?? 0) + 1
}

console.log('\nTop 25 suppliers by line count:')
const top = Object.entries(bySupplier).sort((a, b) => b[1].total - a[1].total).slice(0, 25)
for (const [name, s] of top) {
  const statusStr = Object.entries(s.status).map(([k, v]) => `${k}=${v}`).join(' ')
  console.log(`  ${name.padEnd(40).slice(0, 40)} total=${String(s.total).padStart(4)} acct=${s.with_acct}/${s.total} [${statusStr}]`)
}

// If account_number is mostly populated, what BAS codes are dominant?
const accts = {}
for (const l of lines) {
  if (!l.account_number) continue
  accts[l.account_number] = (accts[l.account_number] ?? 0) + 1
}
console.log('\nBAS account distribution:')
for (const [a, n] of Object.entries(accts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${a}: ${n}`)
}
