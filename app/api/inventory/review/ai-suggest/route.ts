// app/api/inventory/review/ai-suggest/route.ts
//
// AI-assisted bulk review. Given the current needs_review groups for a
// business, asks Claude Haiku 4.5 to classify each group into:
//   - approve_existing: matches an existing product (high-confidence)
//   - create_new:       distinct product worth adding (food/drink/etc)
//   - skip_non_inventory: deposit, returnback, freight, discount, empty
//   - review:           ambiguous, owner must decide
//
// Returns a suggestion per group with confidence + reasoning. Caches
// 24h in inventory_review_suggestions so re-renders are free.
//
// Learning loop: prompt includes recent owner outcomes (last 60 days
// of disagreements + agreements) as in-context examples. Over time
// the model gets better at this business's specific catalogue.
//
// The grouping + Claude call live in lib/inventory/ai-suggest-core.ts so
// the concierge onboarding catalogue auto-build worker can reuse them.
//
// POST { business_id, force?: boolean } → { suggestions: [...] }

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess }        from '@/lib/auth/require-role'
import { checkAndIncrementAiLimit }     from '@/lib/ai/usage'
import { buildGroups, runClaudeBatch, MAX_GROUPS_PER_RUN } from '@/lib/inventory/ai-suggest-core'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 300   // Haiku call takes ~90-100s on 120-group batches; 60s default 504s

const CACHE_TTL_HOURS = 24

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const force      = body.force === true
  if (!businessId) return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // Per-org AI quota gate — bulk-review is a Haiku call but at 120 groups
  // × multiple presses of "Refresh AI sort" it'll burn through quota fast.
  // Atomic increment so spamming doesn't race past the cap.
  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) {
    return NextResponse.json(usage.body, { status: usage.status })
  }

  // ── 1. Load current needs_review groups ──────────────────────────
  const { data: lines, error: linesErr } = await db
    .from('supplier_invoice_lines')
    .select('supplier_fortnox_number, supplier_name_snapshot, raw_description, unit, price_per_unit, total_excl_vat, invoice_date, account_number')
    .eq('business_id', businessId)
    .eq('match_status', 'needs_review')
    .limit(15_000)
  if (linesErr) return NextResponse.json({ error: linesErr.message }, { status: 500 })

  const groups = buildGroups(lines ?? [])
  if (groups.length === 0) {
    return NextResponse.json({ suggestions: [], message: 'No needs_review groups to classify.' })
  }

  // Cap to keep the prompt manageable; sort by line_count desc so the
  // biggest catalogue holes get attention first.
  groups.sort((a, b) => b.line_count - a.line_count)
  const groupsToProcess = groups.slice(0, MAX_GROUPS_PER_RUN)

  // ── 2. Cache check ───────────────────────────────────────────────
  if (!force) {
    const { data: cached } = await db
      .from('inventory_review_suggestions')
      .select('*')
      .eq('business_id', businessId)
      .gte('created_at', new Date(Date.now() - CACHE_TTL_HOURS * 3600_000).toISOString())
    if (cached && cached.length > 0) {
      // Return all current cached + flag stale-misses for the UI
      const cachedKeys = new Set(cached.map((c: any) => c.group_key))
      const stale = groupsToProcess.filter(g => !cachedKeys.has(g.group_key))
      if (stale.length === 0) {
        return NextResponse.json({
          suggestions: cached,
          cached:      true,
          groups_in_cache: cached.length,
          stale_groups: 0,
        })
      }
      // Some new groups since the last run — fall through to run AI on JUST those.
      const staleSet = new Set(stale.map(g => g.group_key))
      const groupsToRun = groupsToProcess.filter(g => staleSet.has(g.group_key))
      const newSuggestions = await runClaudeBatch(db, auth.orgId, businessId, groupsToRun)
      return NextResponse.json({
        suggestions: [...cached, ...newSuggestions],
        cached:      'partial',
        new_suggestions: newSuggestions.length,
        cached_kept:    cached.length,
      })
    }
  }

  // ── 3. Fresh run on all groups ───────────────────────────────────
  const suggestions = await runClaudeBatch(db, auth.orgId, businessId, groupsToProcess)
  return NextResponse.json({
    suggestions,
    cached:    false,
    new_suggestions: suggestions.length,
    total_groups:    groups.length,
    processed:       suggestions.length,
  })
}
