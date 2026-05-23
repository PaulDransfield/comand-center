import { createClient } from '@supabase/supabase-js'
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
const db = createClient(url, key, { auth: { persistSession: false } })
const bizId = '63ada0ac-18af-406a-8ad3-4acfd0379f2c'

const now = new Date()
const curYear  = now.getUTCFullYear()
const curMonth = now.getUTCMonth() + 1
const cutoffYear  = curMonth === 12 ? curYear : curYear - 1
const cutoffMonth = curMonth === 12 ? 1       : curMonth
console.log(`Cutoff: ${cutoffYear}-${String(cutoffMonth).padStart(2,'0')}`)

// Test 1: combined .or() chain
const q1 = await db
  .from('tracker_data')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
  .or(`period_year.gt.${cutoffYear},and(period_year.eq.${cutoffYear},period_month.gte.${cutoffMonth})`)
  .or('is_provisional.is.null,is_provisional.eq.false')
console.log(`Test 1 (chained .or):  count=${q1.count}  error=${q1.error?.message ?? 'none'}`)

// Test 2: just the period filter
const q2 = await db
  .from('tracker_data')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
  .or(`period_year.gt.${cutoffYear},and(period_year.eq.${cutoffYear},period_month.gte.${cutoffMonth})`)
console.log(`Test 2 (period only):  count=${q2.count}  error=${q2.error?.message ?? 'none'}`)

// Test 3: simple period_year >= cutoffYear (over-counts but cheap)
const q3 = await db
  .from('tracker_data')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
  .gte('period_year', cutoffYear)
console.log(`Test 3 (.gte period_year): count=${q3.count}  error=${q3.error?.message ?? 'none'}`)

// Test 4: no filter
const q4 = await db
  .from('tracker_data')
  .select('*', { count: 'exact', head: true })
  .eq('business_id', bizId)
console.log(`Test 4 (no filter): count=${q4.count}  error=${q4.error?.message ?? 'none'}`)
