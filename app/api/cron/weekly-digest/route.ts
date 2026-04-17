// @ts-nocheck
// app/api/cron/weekly-digest/route.ts
//
// Runs every Monday at 07:00 Stockholm time (05:00 UTC in summer, 06:00 UTC in winter)
// Sends a weekly performance digest email to each org owner.
//
// Triggered by Vercel Cron (configured in vercel.json)
// Protected by CRON_SECRET header

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { generateDigestHtml, BusinessDigest } from '@/lib/email/digest'

export const dynamic = 'force-dynamic'
export const maxDuration = 60  // Allow up to 60 seconds for processing

export async function POST(req: NextRequest) {
  // Security: only allow Vercel cron with Bearer token
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db  = createAdminClient()
  const now = new Date()

  // Last week date range (Mon–Sun)
  const dayOfWeek  = now.getDay() // 0=Sun, 1=Mon...
  const daysToMon  = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisMonday = new Date(now)
  thisMonday.setDate(now.getDate() - daysToMon)
  thisMonday.setHours(0, 0, 0, 0)

  const lastMonday = new Date(thisMonday)
  lastMonday.setDate(thisMonday.getDate() - 7)
  const lastSunday = new Date(thisMonday)
  lastSunday.setDate(thisMonday.getDate() - 1)

  const fromDate = lastMonday.toISOString().slice(0, 10)
  const toDate   = lastSunday.toISOString().slice(0, 10)

  // Week label e.g. "Week 14 — 31 Mar to 6 Apr 2026"
  const weekNum  = Math.ceil((lastMonday.getTime() - new Date(lastMonday.getFullYear(), 0, 1).getTime()) / 604800000)
  const weekLabel = `Week ${weekNum} — ${lastMonday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} to ${lastSunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  // Get all active orgs with email digest enabled
  const { data: orgs } = await db
    .from('organisations')
    .select('id, name, billing_email, is_active')
    .eq('is_active', true)

  console.log('[digest] Found orgs:', orgs?.length ?? 0)
  if (!orgs?.length) return NextResponse.json({ ok: true, sent: 0, message: 'No active orgs' })

  let sent = 0
  const errors: string[] = []
  const { isAgentEnabled } = await import('@/lib/ai/is-agent-enabled')

  for (const org of orgs) {
    try {
      // Respect per-customer agent toggle set in admin panel
      const enabled = await isAgentEnabled(db, org.id, 'monday_briefing')
      if (!enabled) {
        console.log(`[digest] Skipping ${org.name} — disabled via feature flag`)
        continue
      }

      // Get org owner user_id then fetch email from auth.users
      const { data: member } = await db
        .from('organisation_members')
        .select('user_id')
        .eq('org_id', org.id)
        .eq('role', 'owner')
        .single()

      let ownerEmail = org.billing_email ?? null

      if (member?.user_id) {
        const { data: authUser } = await db.auth.admin.getUserById(member.user_id)
        ownerEmail = authUser?.user?.email ?? ownerEmail
      }

      console.log('[digest] Org:', org.name, '| Owner email:', ownerEmail)
      if (!ownerEmail) {
        console.log('[digest] No email found for org:', org.name)
        continue
      }

      // Get all active businesses for this org
      const { data: businesses } = await db
        .from('businesses')
        .select('id, name, city')
        .eq('org_id', org.id)
        .eq('is_active', true)

      if (!businesses?.length) continue

      const bizDigests: BusinessDigest[] = []

      for (const biz of businesses) {
        // This week's tracker data (aggregated from covers table by week)
        const { data: weekCovers } = await db
          .from('covers')
          .select('total, revenue, revenue_per_cover')
          .eq('business_id', biz.id)
          .gte('date', fromDate)
          .lte('date', toDate)

        // Last week's covers
        const lwFrom = new Date(lastMonday); lwFrom.setDate(lwFrom.getDate() - 7)
        const lwTo   = new Date(lastSunday); lwTo.setDate(lwTo.getDate() - 7)
        const { data: lwCovers } = await db
          .from('covers')
          .select('total, revenue, revenue_per_cover')
          .eq('business_id', biz.id)
          .gte('date', lwFrom.toISOString().slice(0, 10))
          .lte('date', lwTo.toISOString().slice(0, 10))

        const revenue        = weekCovers?.reduce((s, c) => s + Number(c.revenue ?? 0), 0) ?? 0
        const revenueLW      = lwCovers?.reduce((s, c) => s + Number(c.revenue ?? 0), 0) ?? 0
        const covers         = weekCovers?.reduce((s, c) => s + (c.total ?? 0), 0) ?? 0
        const coversLW       = lwCovers?.reduce((s, c) => s + (c.total ?? 0), 0) ?? 0
        const rpcCount       = weekCovers?.filter(c => c.revenue_per_cover).length ?? 0
        const revenuePerCover= rpcCount > 0
          ? (weekCovers?.reduce((s, c) => s + Number(c.revenue_per_cover ?? 0), 0) ?? 0) / rpcCount
          : (covers > 0 ? revenue / covers : 0)

        // Get monthly tracker data for cost %
        const month = lastSunday.getMonth() + 1
        const year  = lastSunday.getFullYear()
        const { data: tracker } = await db
          .from('tracker_data')
          .select('revenue, staff_cost, food_cost, margin_pct')
          .eq('business_id', biz.id)
          .eq('period_year', year)
          .eq('period_month', month)
          .single()

        const monthRevenue  = Number(tracker?.revenue    ?? 0)
        const foodPct       = monthRevenue > 0 ? (Number(tracker?.food_cost  ?? 0) / monthRevenue) * 100 : 0
        const staffPct      = monthRevenue > 0 ? (Number(tracker?.staff_cost ?? 0) / monthRevenue) * 100 : 0

        // Get budget for this month
        const { data: budget } = await db
          .from('budgets')
          .select('revenue_target, food_cost_pct_target, staff_cost_pct_target')
          .eq('business_id', biz.id)
          .eq('year', year)
          .eq('month', month)
          .single()

        // Get unpaid invoices
        const { data: unpaid } = await db
          .from('notebook_documents')
          .select('name, file_size, created_at')
          .eq('org_id', org.id)
          .eq('doc_type', 'invoice')
          .limit(5)

        // Get top supplier invoices this week (from document_chunks metadata)
        // For now use placeholder — will be real data when Fortnox is connected
        const topSuppliers: BusinessDigest['topSuppliers'] = []

        bizDigests.push({
          name:            biz.name,
          city:            biz.city,
          revenue,
          revenueLW,
          revenueBudget:   budget?.revenue_target ? Number(budget.revenue_target) : null,
          foodPct,
          staffPct,
          foodBudgetPct:   budget?.food_cost_pct_target  ? Number(budget.food_cost_pct_target)  : null,
          staffBudgetPct:  budget?.staff_cost_pct_target ? Number(budget.staff_cost_pct_target) : null,
          covers,
          coversLW,
          revenuePerCover,
          unpaidInvoices:  [],  // Will be real when Fortnox is connected
          topSuppliers,
        })
      }

      if (!bizDigests.length) continue

      // Generate email HTML
      const appUrl       = process.env.NEXT_PUBLIC_APP_URL ?? 'https://commandcenter.se'
      const unsubscribeUrl = `${appUrl}/api/unsubscribe?org=${org.id}&token=${Buffer.from(org.id).toString('base64')}`

      const html = generateDigestHtml({
        orgName:  org.name,
        weekLabel,
        businesses: bizDigests,
        unsubscribeUrl,
      })

      // Send via Resend
      const resendKey = process.env.RESEND_API_KEY
      console.log('[digest] RESEND_API_KEY present:', !!resendKey, '| Sending to:', ownerEmail)
      if (!resendKey) {
        console.log(`[digest] RESEND_API_KEY not set — would send to ${ownerEmail}`)
        sent++
        continue
      }

      const emailRes = await fetch('https://api.resend.com/emails', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${resendKey}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          from:    'CommandCenter <digest@comandcenter.se>',
          to:      ownerEmail,
          subject: `☕ Weekly digest — ${weekLabel}`,
          html,
        }),
      })

      if (emailRes.ok) {
        sent++
        console.log(`[digest] Sent to ${ownerEmail} for org ${org.name}`)
      } else {
        const err = await emailRes.text()
        errors.push(`${org.name}: ${err}`)
        console.error(`[digest] Failed for ${org.name}:`, err)
      }

    } catch (err: any) {
      errors.push(`${org.name}: ${err.message}`)
      console.error(`[digest] Error for ${org.name}:`, err)
    }
  }

  return NextResponse.json({
    ok:     true,
    sent,
    errors: errors.length > 0 ? errors : undefined,
    week:   weekLabel,
  })
}
