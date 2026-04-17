// app/api/cron/supplier-price-creep/route.ts
// Runs 1st of each month at 05:00 UTC — detects supplier price increases
// Blocked on Fortnox OAuth approval — this is a skeleton
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60  // Allow up to 60 seconds for processing

export async function POST(req: NextRequest) {
  // Security: only allow Vercel cron with Bearer token
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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

        // Check if business has Fortnox integration
        const { data: fortnoxIntegration } = await db
          .from('integrations')
          .select('id, is_active, last_sync_at')
          .eq('business_id', biz.id)
          .eq('integration_type', 'fortnox')
          .eq('is_active', true)
          .single()

        if (!fortnoxIntegration) {
          console.log(`[supplier-price-creep] Skipping ${biz.name} — no active Fortnox integration`)
          continue
        }

        // TODO: When Fortnox OAuth is approved, implement:
        // 1. Fetch supplier invoices from Fortnox API
        // 2. Group by supplier and item
        // 3. Compare prices over last 6 months
        // 4. Detect price increases >10% month-over-month
        // 5. Store alerts in supplier_price_alerts table

        // For now, just log that this business would be analyzed
        console.log(`[supplier-price-creep] Would analyze ${biz.name} — Fortnox integration active`)
        analyzed++

      } catch (err: any) {
        const errorMsg = `${biz.name}: ${err.message}`
        errors.push(errorMsg)
        console.error(`[supplier-price-creep] Error for ${biz.name}:`, err)
      }
    }

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
    console.error('[supplier-price-creep] Failed:', error)
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString(),
      note: 'Agent skeleton complete — waiting for Fortnox OAuth approval',
    }, { status: 500 })
  }
}