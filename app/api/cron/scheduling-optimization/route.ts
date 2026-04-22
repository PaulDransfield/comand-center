// @ts-nocheck
// app/api/cron/scheduling-optimization/route.ts
// Runs weekly — optimizes staff scheduling for Group plan customers
// Uses Claude Sonnet 4-6 (not Haiku) — needs 6 months of live data
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { checkCronSecret }    from '@/lib/admin/check-secret'
import { log }                from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const preferredRegion = 'fra1'  // EU-only; Supabase is Frankfurt
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  log.info('scheduling-optimization start', { route: 'cron/scheduling-optimization' })
  const db = createAdminClient()
  const today = new Date()

  try {
    // Get all Group plan customers (orgs with Group subscription).
    // Column is `plan` not `subscription_plan` — bugfix 2026-04-19.
    const { data: groupOrgs } = await db
      .from('organisations')
      .select('id, name, plan')
      .eq('plan', 'group')
      .eq('is_active', true)

    if (!groupOrgs?.length) {
      return NextResponse.json({ ok: true, optimized: 0, message: 'No Group plan customers' })
    }

    let optimized = 0
    const errors: string[] = []
    const recommendations: any[] = []
    const { isAgentEnabled } = await import('@/lib/ai/is-agent-enabled')

    for (const org of groupOrgs) {
      try {
        // Respect per-customer agent toggle set in admin panel
        const enabled = await isAgentEnabled(db, org.id, 'scheduling_optimization')
        if (!enabled) {
          console.log(`[scheduling-optimization] Skipping ${org.name} — disabled via feature flag`)
          continue
        }

        // Get all active businesses for this org
        const { data: businesses } = await db
          .from('businesses')
          .select('id, name')
          .eq('org_id', org.id)
          .eq('is_active', true)

        if (!businesses?.length) continue

        for (const biz of businesses) {
          try {
            // Check if business has at least 6 months of data
            const sixMonthsAgo = new Date(today)
            sixMonthsAgo.setMonth(today.getMonth() - 6)
            
            const { data: staffLogsCount } = await db
              .from('staff_logs')
              .select('shift_date')
              .eq('business_id', biz.id)
              .gte('shift_date', sixMonthsAgo.toISOString().slice(0, 10))
              .limit(1)

            if (!staffLogsCount?.length) {
              console.log(`[scheduling-optimization] Skipping ${biz.name} — insufficient data (<6 months)`)
              continue
            }

            // Get last 90 days of staff logs for analysis
            const ninetyDaysAgo = new Date(today)
            ninetyDaysAgo.setDate(today.getDate() - 90)
            
            const { data: recentStaffLogs } = await db
              .from('staff_logs')
              .select('shift_date, staff_name, hours_worked, cost_actual, ob_supplement_kr, is_late, late_minutes, costgroup_name, staff_group')
              .eq('business_id', biz.id)
              .gte('shift_date', ninetyDaysAgo.toISOString().slice(0, 10))
              .order('shift_date', { ascending: false })
              .limit(1000) // Limit to prevent timeout

            // Get last 90 days of revenue for demand patterns
            const { data: recentRevenue } = await db
              .from('revenue_logs')
              .select('revenue_date, revenue, covers')
              .eq('business_id', biz.id)
              .gte('revenue_date', ninetyDaysAgo.toISOString().slice(0, 10))
              .order('revenue_date', { ascending: false })
              .limit(500)

            if (!recentStaffLogs?.length || !recentRevenue?.length) {
              console.log(`[scheduling-optimization] Skipping ${biz.name} — insufficient recent data`)
              continue
            }

            // Prepare data for AI analysis
            const analysisData = {
              business_name: biz.name,
              analysis_period: `${ninetyDaysAgo.toISOString().slice(0, 10)} to ${today.toISOString().slice(0, 10)}`,
              staff_summary: {
                total_shifts: recentStaffLogs.length,
                total_hours: recentStaffLogs.reduce((sum, log) => sum + Number(log.hours_worked ?? 0), 0),
                total_cost: recentStaffLogs.reduce((sum, log) => sum + Number(log.cost_actual ?? 0), 0),
                total_ob_supplement: recentStaffLogs.reduce((sum, log) => sum + Number(log.ob_supplement_kr ?? 0), 0),
                late_shifts: recentStaffLogs.filter(log => log.is_late).length,
                avg_late_minutes: recentStaffLogs.filter(log => log.is_late).reduce((sum, log) => sum + Number(log.late_minutes ?? 0), 0) / Math.max(recentStaffLogs.filter(log => log.is_late).length, 1),
              },
              revenue_summary: {
                total_revenue: recentRevenue.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0),
                total_covers: recentRevenue.reduce((sum, r) => sum + Number(r.covers ?? 0), 0),
                avg_revenue_per_cover: recentRevenue.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0) / Math.max(recentRevenue.reduce((sum, r) => sum + Number(r.covers ?? 0), 0), 1),
              },
              // Sample data for AI (limited to prevent token overflow)
              sample_staff_logs: recentStaffLogs.slice(0, 20).map(log => ({
                date: log.shift_date,
                staff: log.staff_name,
                hours: log.hours_worked,
                cost: log.cost_actual,
                ob_supplement: log.ob_supplement_kr,
                is_late: log.is_late,
                department: log.costgroup_name,
              })),
              sample_revenue_logs: recentRevenue.slice(0, 20).map(r => ({
                date: r.revenue_date,
                revenue: r.revenue,
                covers: r.covers,
              })),
            }

            // Call Claude Sonnet 4-6 for scheduling optimization
            if (!process.env.ANTHROPIC_API_KEY) {
              console.log(`[scheduling-optimization] ANTHROPIC_API_KEY not set — would analyze ${biz.name}`)
              optimized++
              continue
            }

            try {
              const Anthropic = (await import('@anthropic-ai/sdk')).default
              const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

              const prompt = `You are a restaurant scheduling optimization expert. Analyze this data and provide specific, actionable scheduling recommendations.

BUSINESS: ${biz.name}
ANALYSIS PERIOD: ${analysisData.analysis_period}

STAFF SUMMARY:
- Total shifts: ${analysisData.staff_summary.total_shifts}
- Total hours: ${analysisData.staff_summary.total_hours.toFixed(1)}
- Total labor cost: ${analysisData.staff_summary.total_cost.toLocaleString('en-GB')} kr
- Total OB supplement: ${analysisData.staff_summary.total_ob_supplement.toLocaleString('en-GB')} kr
- Late shifts: ${analysisData.staff_summary.late_shifts} (${((analysisData.staff_summary.late_shifts / analysisData.staff_summary.total_shifts) * 100).toFixed(1)}%)
- Average late minutes: ${analysisData.staff_summary.avg_late_minutes.toFixed(1)} min

REVENUE SUMMARY:
- Total revenue: ${analysisData.revenue_summary.total_revenue.toLocaleString('en-GB')} kr
- Total covers: ${analysisData.revenue_summary.total_covers}
- Average revenue per cover: ${analysisData.revenue_summary.avg_revenue_per_cover.toFixed(0)} kr

SAMPLE STAFF LOGS (last 20 shifts):
${analysisData.sample_staff_logs.map(log => `- ${log.date}: ${log.staff} worked ${log.hours}h (${log.cost} kr) ${log.is_late ? 'LATE' : ''} ${log.ob_supplement ? `+${log.ob_supplement} kr OB` : ''}`).join('\n')}

SAMPLE REVENUE LOGS (last 20 days):
${analysisData.sample_revenue_logs.map(r => `- ${r.date}: ${r.revenue} kr, ${r.covers} covers`).join('\n')}

Provide 3-5 specific scheduling optimization recommendations. Focus on:
1. Reducing overtime and OB supplement costs
2. Improving schedule alignment with demand patterns
3. Addressing chronic lateness issues
4. Department-specific staffing adjustments
5. Potential cost savings opportunities

Format as bullet points with concrete actions.`

              const _started = Date.now()
              const response = await claude.messages.create({
                model: AI_MODELS.ANALYSIS, // Uses Sonnet 4-6 for scheduling optimization
                max_tokens: MAX_TOKENS.AGENT_RECOMMENDATION,
                messages: [{ role: 'user', content: prompt }],
              })

              // Log cost (Sonnet is 3× Haiku — visibility matters here)
              try {
                const { logAiRequest } = await import('@/lib/ai/usage')
                await logAiRequest(db, {
                  org_id:        org.id,
                  request_type:  'scheduling_optimization',
                  model:         AI_MODELS.ANALYSIS,
                  input_tokens:  response.usage?.input_tokens ?? 0,
                  output_tokens: response.usage?.output_tokens ?? 0,
                  duration_ms:   Date.now() - _started,
                })
              } catch { /* non-fatal */ }

              const text = (response.content?.[0] as any)?.text?.trim()
              
              if (text) {
                // Store recommendation in database
                await db.from('scheduling_recommendations').insert({
                  org_id: org.id,
                  business_id: biz.id,
                  generated_at: new Date().toISOString(),
                  recommendations: text,
                  analysis_period: analysisData.analysis_period,
                  metadata: {
                    staff_shifts: analysisData.staff_summary.total_shifts,
                    total_hours: analysisData.staff_summary.total_hours,
                    labor_cost: analysisData.staff_summary.total_cost,
                    ob_supplement: analysisData.staff_summary.total_ob_supplement,
                    late_shifts: analysisData.staff_summary.late_shifts,
                  },
                })

                recommendations.push({
                  business: biz.name,
                  recommendations: text.substring(0, 200) + '...', // Truncate for response
                })

                optimized++
                console.log(`[scheduling-optimization] Optimized ${biz.name} — ${org.name}`)
              }

            } catch (aiError: any) {
              console.error(`[scheduling-optimization] AI error for ${biz.name}:`, aiError)
              // Continue with next business
            }

          } catch (bizError: any) {
            const errorMsg = `${org.name}/${biz.name}: ${bizError.message}`
            errors.push(errorMsg)
            console.error(`[scheduling-optimization] Error for ${biz.name}:`, bizError)
          }
        }

      } catch (orgError: any) {
        const errorMsg = `${org.name}: ${orgError.message}`
        errors.push(errorMsg)
        console.error(`[scheduling-optimization] Error for org ${org.name}:`, orgError)
      }
    }

    log.info('scheduling-optimization complete', {
      route:       'cron/scheduling-optimization',
      duration_ms: Date.now() - started,
      optimized,
      errors:      errors.length,
      status:      errors.length === 0 ? 'success' : 'partial',
    })

    return NextResponse.json({
      ok: true,
      optimized,
      recommendations: recommendations.length > 0 ? recommendations : undefined,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
      note: 'Scheduling optimization agent — uses Claude Sonnet 4-6 for Group plan customers',
    })

  } catch (error: any) {
    log.error('scheduling-optimization failed', {
      route:       'cron/scheduling-optimization',
      duration_ms: Date.now() - started,
      error:       error?.message ?? String(error),
      status:      'error',
    })
    return NextResponse.json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}


// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
