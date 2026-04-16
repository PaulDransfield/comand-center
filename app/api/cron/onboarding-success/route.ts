// @ts-nocheck
// app/api/cron/onboarding-success/route.ts
// Runs on first successful sync — sends welcome email with setup instructions
// Uses Claude Haiku 4.5
// Follows spec in claude_code_agents_prompt.md

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'

export const dynamic = 'force-dynamic'
export const maxDuration = 60  // Allow up to 60 seconds for processing

export async function POST(req: NextRequest) {
  // Security: only allow Vercel cron with Bearer token
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db = createAdminClient()
  
  console.log(`[onboarding-success] Checking for new businesses needing welcome`)

  try {
    // Get all integrations that have had a successful sync but no welcome email sent
    const { data: newIntegrations } = await db
      .from('integrations')
      .select('id, business_id, org_id, integration_type, last_sync_at, onboarding_email_sent')
      .not('last_sync_at', 'is', null)
      .eq('onboarding_email_sent', false)
      .limit(10) // Process in batches

    if (!newIntegrations?.length) {
      return NextResponse.json({ ok: true, welcomed: 0, message: 'No new businesses needing welcome' })
    }

    let welcomed = 0
    const errors: string[] = []
    const emailsSent: any[] = []

    for (const integration of newIntegrations) {
      try {
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
          .select('id, name, subscription_plan')
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

        const { data: userData } = await db
          .from('users')
          .select('email')
          .eq('id', orgMembers[0].user_id)
          .single()

        if (!userData?.email) {
          console.log(`[onboarding-success] Skipping ${businessData.name} — no user email`)
          continue
        }

        const userEmail = userData.email

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
          integration_type: integration.integration_type,
          first_sync_date: integration.last_sync_at,
          days_of_data: recentRevenue?.length || 0,
          recent_revenue: recentRevenue?.reduce((sum, r) => sum + Number(r.revenue ?? 0), 0) || 0,
          recent_covers: recentRevenue?.reduce((sum, r) => sum + Number(r.covers ?? 0), 0) || 0,
          staff_shifts: recentStaff?.length || 0,
          total_hours: recentStaff?.reduce((sum, s) => sum + Number(s.hours_worked ?? 0), 0) || 0,
          plan: orgData.subscription_plan,
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
- ${businessInfo.days_of_data} days of revenue data (${businessInfo.recent_revenue.toLocaleString('sv-SE')} kr total)
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

          const response = await claude.messages.create({
            model: AI_MODELS.AGENT, // Uses Haiku 4.5
            max_tokens: MAX_TOKENS.AGENT_SUMMARY,
            messages: [{ role: 'user', content: prompt }],
          })

          const emailBody = (response.content?.[0] as any)?.text?.trim()
          
          if (emailBody) {
            // Send email via Resend
            if (!process.env.RESEND_API_KEY) {
              console.log(`[onboarding-success] RESEND_API_KEY not set — would send email to ${userEmail}`)
            } else {
              try {
                // Use fetch instead of Resend SDK to avoid import issues
                const emailResponse = await fetch('https://api.resend.com/emails', {
                  method: 'POST',
                  headers: {
                    'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                  },
                  body: JSON.stringify({
                    from: 'CommandCenter <welcome@comandcenter.se>',
                    to: userEmail,
                    subject: `Welcome to CommandCenter, ${businessData.name}!`,
                    text: emailBody,
                  }),
                })

                if (!emailResponse.ok) {
                  const errorText = await emailResponse.text()
                  throw new Error(`Resend API error: ${emailResponse.status} ${errorText}`)
                }

                const emailResult = await emailResponse.json()
                
                emailsSent.push({
                  business: businessData.name,
                  email: userEmail,
                  message_id: emailResult.id,
                })

                console.log(`[onboarding-success] Welcome email sent to ${userEmail} for ${businessData.name}`)

              } catch (emailError: any) {
                console.error(`[onboarding-success] Email error for ${businessData.name}:`, emailError)
                // Continue anyway - we'll mark as sent to prevent retries
              }
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

    return NextResponse.json({
      ok: true,
      welcomed,
      emails_sent: emailsSent.length > 0 ? emailsSent : undefined,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
      note: 'Onboarding success agent — sends welcome email on first sync',
    })

  } catch (error: any) {
    console.error('[onboarding-success] Failed:', error)
    return NextResponse.json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString(),
    }, { status: 500 })
  }
}
