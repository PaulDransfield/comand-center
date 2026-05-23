// app/api/cron/supplier-price-creep/route.ts
// Runs 1st of each month at 05:00 UTC — detects supplier price increases
// Blocked on Fortnox OAuth approval — this is a skeleton
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { checkCronSecret }   from '@/lib/admin/check-secret'
import { log }               from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { withCronLog } = await import('@/lib/cron/log')
  return withCronLog('supplier-price-creep', async () => {

  const started = Date.now()
  const db = createAdminClient()
  const today = new Date()
  const lastMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1)
  const year = lastMonth.getFullYear()
  const month = lastMonth.getMonth() + 1

  console.log(`[supplier-price-creep] Running for ${year}-${month}`)

  try {
    // Get all active businesses with Fortnox connected
    const { data: businesses } = await db
      .from('businesses')
      .select('id, name, org_id')
      .eq('is_active', true)

    if (!businesses?.length) {
      return NextResponse.json({ ok: true, analyzed: 0, message: 'No active businesses' })
    }

    let analyzed = 0
    const errors: string[] = []
    const alerts: any[] = []
    const { isAgentEnabled } = await import('@/lib/ai/is-agent-enabled')

    for (const biz of businesses) {
      try {
        // Respect per-customer agent toggle set in admin panel
        const enabled = await isAgentEnabled(db, biz.org_id, 'supplier_price_creep')
        if (!enabled) {
          console.log(`[supplier-price-creep] Skipping ${biz.name} — disabled via feature flag`)
          continue
        }

        // Check if business has Fortnox integration. Schema is
        // (provider, status), not (integration_type, is_active).
        const { data: fortnoxIntegration } = await db
          .from('integrations')
          .select('id, status, last_sync_at')
          .eq('business_id', biz.id)
          .eq('provider', 'fortnox')
          .in('status', ['connected', 'warning'])
          .maybeSingle()

        if (!fortnoxIntegration) {
          console.log(`[supplier-price-creep] Skipping ${biz.name} — no active Fortnox integration`)
          continue
        }

        // Reads from supplier_invoice_lines (Phase B of the inventory
        // catalogue, populated by the PDF extractor + matcher). For
        // every matched line in the last 6 months, group by product +
        // supplier, compare latest 30-day median against prior 60-day
        // median, flag products with >5% increase AND >10 SEK absolute
        // delta. Roll up per supplier; one cost_insights row per
        // supplier that has crept on >=2 products. kind='creep'.
        const SIX_MONTHS_AGO = new Date(today.getTime() - 180 * 86_400_000).toISOString().slice(0, 10)

        const allLines: any[] = []
        let from = 0
        while (true) {
          const { data } = await db
            .from('supplier_invoice_lines')
            .select('product_alias_id, price_per_unit, invoice_date, supplier_name_snapshot, supplier_fortnox_number, raw_description')
            .eq('business_id', biz.id)
            .eq('match_status', 'matched')
            .not('product_alias_id', 'is', null)
            .not('price_per_unit', 'is', null)
            .gte('invoice_date', SIX_MONTHS_AGO)
            .order('invoice_date', { ascending: false })
            .range(from, from + 999)
          if (!data || data.length === 0) break
          allLines.push(...data)
          if (data.length < 1000) break
          from += 1000
          if (from > 50_000) break
        }

        if (allLines.length === 0) {
          console.log(`[supplier-price-creep] ${biz.name} — no matched inventory lines yet`)
          analyzed++
          continue
        }

        // Resolve alias → product
        const aliasIds = Array.from(new Set(allLines.map(l => l.product_alias_id).filter(Boolean)))
        const aliasToProduct = new Map<string, string>()
        const aliasToProductName = new Map<string, string>()
        for (let i = 0; i < aliasIds.length; i += 500) {
          const slice = aliasIds.slice(i, i + 500)
          const { data: aliases } = await db
            .from('product_aliases')
            .select('id, product_id, products(name)')
            .in('id', slice)
          for (const a of aliases ?? []) {
            aliasToProduct.set(a.id, (a as any).product_id)
            aliasToProductName.set(a.id, ((a as any).products?.name) ?? '?')
          }
        }

        // Bucket per supplier-product
        const RECENT_WINDOW_MS = 30 * 86_400_000
        const PRIOR_WINDOW_MS  = 60 * 86_400_000
        const NOW = Date.now()
        type BucketKey = string // `${supplier_fortnox_number ?? supplier_name}_${product_id}`
        const buckets = new Map<BucketKey, {
          supplier: string
          supplier_id: string | null
          product_id: string
          product_name: string
          recent: number[]
          prior: number[]
        }>()

        for (const l of allLines) {
          const productId = aliasToProduct.get(l.product_alias_id)
          if (!productId) continue
          const supplierKey = l.supplier_fortnox_number ?? l.supplier_name_snapshot ?? 'unknown'
          const key: BucketKey = `${supplierKey}_${productId}`
          if (!buckets.has(key)) {
            buckets.set(key, {
              supplier:     l.supplier_name_snapshot ?? l.supplier_fortnox_number ?? 'Okänd',
              supplier_id:  l.supplier_fortnox_number ?? null,
              product_id:   productId,
              product_name: aliasToProductName.get(l.product_alias_id) ?? '?',
              recent:       [],
              prior:        [],
            })
          }
          const ts = new Date(l.invoice_date).getTime()
          const age = NOW - ts
          if (age <= RECENT_WINDOW_MS)        buckets.get(key)!.recent.push(Number(l.price_per_unit))
          else if (age <= RECENT_WINDOW_MS + PRIOR_WINDOW_MS) buckets.get(key)!.prior.push(Number(l.price_per_unit))
        }

        // Find products that crept
        type CreepHit = {
          supplier: string
          supplier_id: string | null
          product_id: string
          product_name: string
          recent_median: number
          prior_median: number
          change_pct: number
          delta_kr: number
        }
        const median = (n: number[]) => {
          if (n.length === 0) return null
          const s = [...n].sort((a, b) => a - b)
          const mid = Math.floor(s.length / 2)
          return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
        }

        const hits: CreepHit[] = []
        for (const b of buckets.values()) {
          const rm = median(b.recent)
          const pm = median(b.prior)
          if (rm == null || pm == null || pm === 0) continue
          const change = (rm - pm) / pm
          const delta = rm - pm
          if (change >= 0.05 && delta >= 10) {
            hits.push({
              supplier:      b.supplier,
              supplier_id:   b.supplier_id,
              product_id:    b.product_id,
              product_name:  b.product_name,
              recent_median: rm,
              prior_median:  pm,
              change_pct:    change,
              delta_kr:      delta,
            })
          }
        }

        if (hits.length === 0) {
          console.log(`[supplier-price-creep] ${biz.name} — no creep detected (${buckets.size} buckets analysed)`)
          analyzed++
          continue
        }

        // Roll up per supplier (one insight per supplier with >= 2 products crept;
        // also surface single-product creeps when the absolute delta is >= 50 SEK)
        const perSupplier = new Map<string, CreepHit[]>()
        for (const h of hits) {
          const k = `${h.supplier_id ?? ''}|${h.supplier}`
          if (!perSupplier.has(k)) perSupplier.set(k, [])
          perSupplier.get(k)!.push(h)
        }

        // Clear stale insights of kind='creep' for this business
        await db.from('cost_insights')
          .update({ dismissed_at: new Date().toISOString() })
          .eq('org_id', biz.org_id)
          .eq('business_id', biz.id)
          .eq('kind', 'creep')
          .is('dismissed_at', null)

        const insights: any[] = []
        for (const [_, supplierHits] of perSupplier) {
          if (supplierHits.length < 2 && supplierHits[0].delta_kr < 50) continue
          const avgChange = supplierHits.reduce((s, h) => s + h.change_pct, 0) / supplierHits.length
          const totalDelta = supplierHits.reduce((s, h) => s + h.delta_kr, 0)
          const topProducts = supplierHits
            .sort((a, b) => b.change_pct - a.change_pct)
            .slice(0, 5)
            .map(h => `${h.product_name} +${(h.change_pct * 100).toFixed(0)}% (${h.prior_median.toFixed(2)} → ${h.recent_median.toFixed(2)} kr)`)
          insights.push({
            org_id:                     biz.org_id,
            business_id:                biz.id,
            kind:                       'creep',
            tone:                       avgChange >= 0.10 ? 'bad' : 'warning',
            entity:                     supplierHits[0].supplier,
            message:                    `${supplierHits[0].supplier} raised prices on ${supplierHits.length} item${supplierHits.length === 1 ? '' : 's'} — avg +${(avgChange * 100).toFixed(1)}% (last 30d vs prior 60d).`,
            estimated_saving_kr_annual: null,  // hard to estimate without volume
            evidence:                   {
              suppliers:    [supplierHits[0].supplier],
              months:       6,
              products:     topProducts,
              total_delta_kr: Math.round(totalDelta),
              hits_count:   supplierHits.length,
            },
          })
        }

        if (insights.length > 0) {
          await db.from('cost_insights').insert(insights)
          for (const i of insights) alerts.push({ business: biz.name, supplier: i.entity, message: i.message })
        }

        console.log(`[supplier-price-creep] ${biz.name} — analysed ${buckets.size} buckets, ${hits.length} hits, ${insights.length} insights`)
        analyzed++

      } catch (err: any) {
        const errorMsg = `${biz.name}: ${err.message}`
        errors.push(errorMsg)
        console.error(`[supplier-price-creep] Error for ${biz.name}:`, err)
      }
    }

    log.info('supplier-price-creep complete', {
      route:       'cron/supplier-price-creep',
      duration_ms: Date.now() - started,
      analyzed,
      alerts:      alerts.length,
      errors:      errors.length,
      status:      errors.length === 0 ? 'success' : 'partial',
    })

    return NextResponse.json({
      ok: true,
      analyzed,
      alerts: alerts.length > 0 ? alerts : undefined,
      errors: errors.length > 0 ? errors : undefined,
      month: `${year}-${String(month).padStart(2, '0')}`,
      timestamp: new Date().toISOString(),
      note: 'Agent skeleton complete — waiting for Fortnox OAuth approval',
    })

  } catch (error: any) {
    log.error('supplier-price-creep failed', {
      route:       'cron/supplier-price-creep',
      duration_ms: Date.now() - started,
      error:       error?.message ?? String(error),
      status:      'error',
    })
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
      note: 'Agent skeleton complete — waiting for Fortnox OAuth approval',
    }, { status: 500 })
  }
  })
}

// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
