// @ts-nocheck
// app/api/cron/onboarding-success/route.ts
// Runs on first successful sync — sends welcome email with setup instructions
// Uses Claude Haiku 4.5
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { checkCronSecret }    from '@/lib/admin/check-secret'
import { log }                from '@/lib/log/structured'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const started = Date.now()
  log.info('onboarding-success start', { route: 'cron/onboarding-success' })
  const db = createAdminClient()

  try {
    // Only process integrations that:
    //   (a) have completed at least one sync
    //   (b) have not been welcomed yet
    //   (c) synced within the last 48 hours — safety net so we never mass-email old customers
    //       if the column default was ever mis-set again.
    // The inline agent (lib/sync/engine.ts → /api/agents/onboarding-success) handles Personalkollen
    // in real-time on first sync. This cron catches anything the inline path missed.
    const cutoff48h = new Date(Date.now() - 48 * 3600_000).toISOString()

    const { data: newIntegrations } = await db
      .from('integrations')
      .select('id, business_id, org_id, provider, last_sync_at, onboarding_email_sent')
      .not('last_sync_at', 'is', null)
      .gte('last_sync_at', cutoff48h)
      .eq('onboarding_email_sent', false)
      .limit(10) // Process in batches

    if (!newIntegrations?.length) {
      return NextResponse.json({ ok: true, welcomed: 0, message: 'No new businesses needing welcome' })
    }

    let welcomed = 0
    const errors: string[] = []
    const emailsSent: any[] = []
    const { isAgentEnabled } = await import('@/lib/ai/is-agent-enabled')

    for (const integration of newIntegrations) {
      try {
        // Respect per-customer agent toggle set in admin panel
        const enabled = await isAgentEnabled(db, integration.org_id, 'onboarding_success')
        if (!enabled) {
          console.log(`[onboarding-success] Skipping integration ${integration.id} — disabled via feature flag`)
          continue
        }

        // Get business details
        const { data: businessData } = await db
          .from('businesses')
          .select('id, name, city')
          .eq('id', integration.business_id)
          .eq('is_active', true)
          .single()

        if (!businessData) {
          console.log(`[onboarding-success] Skipping integration ${integration.id} — business not found or inactive`)
          continue
        }

        // Get organisation details
        const { data: orgData } = await db
          .from('organisations')
          .select('id, name, plan')
          .eq('id', integration.org_id)
          .single()

        if (!orgData) {
          console.log(`[onboarding-success] Skipping ${businessData.name} — organisation not found`)
          continue
        }

        // Get user email for this organisation (first member)
        const { data: orgMembers } = await db
          .from('organisation_members')
          .select('user_id')
          .eq('org_id', integration.org_id)
          .limit(1)

        if (!orgMembers?.length) {
          console.log(`[onboarding-success] Skipping ${businessData.name} — no organisation members`)
          continue
        }

        const { data: { user: authUser } } = await db.auth.admin.getUserById(orgMembers[0].user_id)

        if (!authUser?.email) {
          console.log(`[onboarding-success] Skipping ${businessData.name} — no user email`)
          continue
        }

        const userEmail = authUser.email

        // Get some initial data to personalize the email
        const { data: recentRevenue } = await db
          .from('revenue_logs')
          .select('revenue_date, revenue, covers')
          .eq('business_id', integration.business_id)
          .order('revenue_date', { ascending: false })
          .limit(7) // Last 7 days

        const { data: recentStaff } = await db
          .from('staff_logs')
          .select('shift_date, staff_name, hours_worked, cost_actual')
          .eq('business_id', integration.business_id)
          .order('shift_date', { ascending: false })
          .limit(10) // Last 10 shifts

        // Prepare data for AI email generation
        const businessInfo = {
          name: businessData.name,
          city: businessData.city,
          org_id: integration.org_id,
          integration_type: integration.provider,
          first_sync_date: integration.last_sync_at,
          days_of_data: recentRevenue?.length || 0,
          recent_revenue: recentRevenue?.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0) || 0,
          recent_covers: recentRevenue?.reduce((sum, r) => sum + Number(r.covers ?? 0), 0) || 0,
          staff_shifts: recentStaff?.length || 0,
          total_hours: recentStaff?.reduce((sum, s) => sum + Number(s.hours_worked ?? 0), 0) || 0,
          plan: orgData.plan,
        }

        // Generate personalized welcome email using Claude Haiku 4.5
        if (!process.env.ANTHROPIC_API_KEY) {
          console.log(`[onboarding-success] ANTHROPIC_API_KEY not set — would send welcome to ${businessData.name}`)
          // Mark as sent anyway to prevent retries
          await db
            .from('integrations')
            .update({ onboarding_email_sent: true })
            .eq('id', integration.id)
          
          welcomed++
          continue
        }

        try {
          const Anthropic = (await import('@anthropic-ai/sdk')).default
          const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })

          const prompt = `You are writing a welcome email for a restaurant owner who just connected their ${businessInfo.integration_type} integration to CommandCenter.

BUSINESS: ${businessInfo.name} in ${businessInfo.city}
PLAN: ${businessInfo.plan}
FIRST SYNC: ${businessInfo.first_sync_date}
DATA SYNCED:
- ${businessInfo.days_of_data} days of revenue data (${businessInfo.recent_revenue.toLocaleString('en-GB')} kr total)
- ${businessInfo.recent_covers} covers served
- ${businessInfo.staff_shifts} staff shifts (${businessInfo.total_hours.toFixed(1)} hours)

Write a friendly, professional welcome email that:
1. Thanks them for connecting their ${businessInfo.integration_type}
2. Highlights what data is now available in their dashboard
3. Suggests 2-3 immediate actions they can take (e.g., check dashboard, set up forecasts, explore staff page)
4. Mentions their ${businessInfo.plan} plan benefits
5. Provides support contact information
6. Encourages them to explore the AI assistant

Keep it concise (3-4 paragraphs max). Use a warm, helpful tone. Include specific numbers from their data to show it's personalized.

Format as plain text email body (no HTML).`

          const _started = Date.now()
          const response = await claude.messages.create({
            model: AI_MODELS.AGENT, // Uses Haiku 4.5
            max_tokens: MAX_TOKENS.AGENT_SUMMARY,
            messages: [{ role: 'user', content: prompt }],
          })

          // Log cost so agent spend shows up in the ai_request_log dashboard.
          try {
            const { logAiRequest } = await import('@/lib/ai/usage')
            await logAiRequest(db, {
              org_id:        businessInfo.org_id,
              request_type:  'onboarding_welcome',
              model:         AI_MODELS.AGENT,
              input_tokens:  response.usage?.input_tokens ?? 0,
              output_tokens: response.usage?.output_tokens ?? 0,
              duration_ms:   Date.now() - _started,
            })
          } catch { /* non-fatal */ }

          const emailBody = (response.content?.[0] as any)?.text?.trim()
          
          if (emailBody) {
            // Send email via Resend
            if (!process.env.RESEND_API_KEY) {
              console.log(`[onboarding-success] RESEND_API_KEY not set — would send email to ${userEmail}`)
            } else {
              const { sendEmail } = await import('@/lib/email/send')
              const emailResult = await sendEmail({
                from:    'CommandCenter <welcome@comandcenter.se>',
                to:      userEmail,
                subject: `Welcome to CommandCenter, ${businessData.name}!`,
                html:    emailBody.replace(/\n/g, '<br/>'),
                text:    emailBody,
                context: { kind: 'onboarding_welcome', business_id: businessData.id, business: businessData.name },
              })
              if (emailResult.ok) {
                emailsSent.push({ business: businessData.name, email: userEmail, message_id: emailResult.messageId })
              }
              // Failure path already captured by sendEmail + kept the
              // 'continue anyway' semantics (no retry); explicit handling not needed.
            }

            // Mark integration as welcome email sent
            await db
              .from('integrations')
              .update({ onboarding_email_sent: true })
              .eq('id', integration.id)

            welcomed++
            console.log(`[onboarding-success] Welcomed ${businessData.name} — ${orgData.name}`)

          } else {
            throw new Error('AI response empty')
          }

        } catch (aiError: any) {
          console.error(`[onboarding-success] AI error for ${businessData.name}:`, aiError)
          // Mark as sent anyway to prevent infinite retries
          await db
            .from('integrations')
            .update({ onboarding_email_sent: true })
            .eq('id', integration.id)
          
          welcomed++
        }

      } catch (integrationError: any) {
        const errorMsg = `Integration ${integration.id}: ${integrationError.message}`
        errors.push(errorMsg)
        console.error(`[onboarding-success] Error for integration ${integration.id}:`, integrationError)
      }
    }

    log.info('onboarding-success complete', {
      route:       'cron/onboarding-success',
      duration_ms: Date.now() - started,
      welcomed,
      emails_sent: emailsSent.length,
      errors:      errors.length,
      status:      errors.length === 0 ? 'success' : 'partial',
    })

    return NextResponse.json({
      ok: true,
      welcomed,
      emails_sent: emailsSent.length > 0 ? emailsSent : undefined,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
      note: 'Onboarding success agent — sends welcome email on first sync',
    })

  } catch (error: any) {
    log.error('onboarding-success failed', {
      route:       'cron/onboarding-success',
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
