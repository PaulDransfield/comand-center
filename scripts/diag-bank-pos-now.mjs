import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const { data: rows } = await db
  .from('overhead_drilldown_cache')
  .select('category, fetched_at, payload')
  .eq('business_id', bizId)
  .like('category', '__accounts_list_fy%')
  .order('fetched_at', { ascending: false })

console.log(`accounts_list cache rows: ${rows?.length ?? 0}`)
for (const r of rows ?? []) {
  const p = r.payload
  console.log(`\n  ${r.category}  fetched=${r.fetched_at}`)
  console.log(`    fy: ${p?.fiscal_year_from} → ${p?.fiscal_year_to}`)
  console.log(`    total_accounts: ${p?.total_accounts}`)
  if (p?.accounts) {
    let sum = 0
    const accs = []
    for (const a of Object.values(p.accounts)) {
      if (a.number >= 1900 && a.number <= 1989) {
        const cur = Number(a.current_balance ?? 0)
        sum += cur
        accs.push(`${a.number} ${(a.description || '').slice(0,20).padEnd(22)} ${String(cur).padStart(10)}`)
      }
    }
    for (const line of accs) console.log(`      ${line}`)
    console.log(`    sum 1900-1989 current_balance: ${sum}`)
  }
}
