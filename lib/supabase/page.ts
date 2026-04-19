// lib/supabase/page.ts
//
// Paginate through a Supabase query with `.range(lo, hi)` until all rows
// are fetched. Supabase's `max_rows` config (default 1000) silently caps
// responses — `.limit(50000)` does NOT override it. See FIXES.md §0c.
//
// Usage:
//   const rows = await fetchAllPaged<Shift>((from, to) =>
//     db.from('staff_logs')
//       .select('shift_date, cost_actual, ...')
//       .eq('org_id', orgId)
//       .gte('shift_date', fromDate)
//       .order('shift_date', { ascending: true })
//       .range(from, to)
//   )
//
// Always combine with `.order(...)` for stable iteration — otherwise rows
// dropping off the end is order-undefined.

export async function fetchAllPaged<T = any>(
  buildQuery: (from: number, to: number) => any,
  opts: { pageSize?: number; maxRows?: number } = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? 1000
  const maxRows  = opts.maxRows  ?? 200_000  // runaway guard
  const out: T[] = []
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await buildQuery(offset, offset + pageSize - 1)
    if (error) throw new Error(`paged fetch failed at offset ${offset}: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < pageSize) break
  }
  return out
}
