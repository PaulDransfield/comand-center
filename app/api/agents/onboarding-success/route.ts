// @ts-nocheck
// app/api/agents/onboarding-success/route.ts
// Background onboarding success agent — sends a welcome message once the first sync is live.

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/server'
import { AI_MODELS, MAX_TOKENS } from '@/lib/ai/models'
import { checkCronSecret } from '@/lib/admin/check-secret'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  // FIXES §0ee (Sprint 2 Task 8): standardised on checkCronSecret. The
  // helper accepts the same two header shapes (x-cron-secret, Authorization
  // Bearer) plus the x-vercel-cron=1 trusted-scheduler short-circuit, which
  // the inline check missed.
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { org_id, business_id, integration_id, business_name, city, systems, result } = body
  if (!org_id || !business_id) {
    return NextResponse.json({ error: 'org_id and business_id required' }, { status: 400 })
  }

  const db = createAdminClient()

  const { data: member } = await db
    .from('organisation_members')
    .select('user_id')
    .eq('org_id', org_id)
    .limit(1)
    .maybeSingle()

  if (!member) return NextResponse.json({ error: 'No organisation member found' }, { status: 404 })

  const { data: { user } } = await db.auth.admin.getUserById(member.user_id)
  if (!user?.email) return NextResponse.json({ error: 'No email found for organisation owner' }, { status: 404 })

  const { data: staffLogs } = await db
    .from('staff_logs')
    .select('staff_name, staff_group, shift_date')
    .eq('org_id', org_id)
    .eq('business_id', business_id)
    .order('shift_date', { ascending: true })
    .limit(500)

  const shifts = staffLogs?.length ?? 0
  const staffSet = new Set<string>()
  const deptCounts: Record<string, number> = {}
  const dates: string[] = []

  for (const row of staffLogs ?? []) {
    if (row.staff_name) staffSet.add(row.staff_name)
    const dept = row.staff_group ?? 'Unknown'
    deptCounts[dept] = (deptCounts[dept] ?? 0) + 1
    if (row.shift_date) dates.push(row.shift_date)
  }

  const staffCount = staffSet.size
  const earliestDate = dates.sort()[0] ?? null
  const departments = Object.keys(deptCounts)
  const topDepartment = Object.entries(deptCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Unknown'
  const topDeptPct = staffCount > 0 ? Math.round((deptCounts[topDepartment] ?? 0) / shifts * 100) : 0

  const prompt = `Write a friendly 2-sentence welcome message for a restaurant owner whose data has just connected to CommandCenter.

Data imported:
- ${shifts} shifts across ${staffCount} staff members
- Date range: ${earliestDate ?? 'unknown'} to today
- Departments: ${departments.join(', ') || 'Unknown'}
- Most active department: ${topDepartment} (${topDeptPct}% of shifts)

Tone: warm, brief, tell them what they can now explore. End with one suggested first action.`

  let bodyText = `Your data is live in CommandCenter! ${shifts} shifts have been imported` 
  if (business_name) bodyText += ` for ${business_name}`
  bodyText += '.'

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! })
    const response = await claude.messages.create({
      model:      AI_MODELS.AGENT,
      max_tokens: MAX_TOKENS.AGENT_SUMMARY,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text = (response.content?.[0] as any)?.text?.trim()
    if (text) bodyText = text
  } catch (err: any) {
    console.error('Onboarding success AI error:', err)
  }

  const systemsSummary = Object.entries(systems ?? {})
    .filter(([, value]) => value && value !== 'none')
    .map(([key, value]) => `${key}: ${value}`)
    .join(', ') || 'Not specified'

  const emailHtml = `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:40px 24px;color:#1a1f2e">
      <div style="font-size:20px;font-weight:700;margin-bottom:24px">CommandCenter</div>
      <h1 style="font-size:24px;font-weight:700;margin-bottom:12px">Your data is now live</h1>
      <p style="font-size:15px;color:#374151;line-height:1.7;margin-bottom:20px">
        ${bodyText}
      </p>
      <div style="background:#f9fafb;border-radius:10px;padding:18px 20px;margin-bottom:24px;font-size:13px;color:#374151">
        <div style="font-weight:600;margin-bottom:8px">Imported data summary:</div>
        <div>${shifts} shifts</div>
        <div>${staffCount} staff members</div>
        <div>Location: ${city ?? 'Unknown'}</div>
        <div>Systems: ${systemsSummary}</div>
      </div>
      <p style="font-size:14px;color:#374151;line-height:1.7;margin-bottom:20px">
        Next step: open CommandCenter and explore the dashboard, staff costs, and monthly tracker.
      </p>
      <a href="https://comandcenter.se/dashboard" style="display:inline-block;padding:10px 18px;background:#1a1f2e;color:#fff;border-radius:8px;text-decoration:none;font-size:14px">Go to Dashboard</a>
      <div style="margin-top:40px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af">
        CommandCenter · ComandCenter AB · comandcenter.se
      </div>
    </div>
  `

  const { sendEmail } = await import('@/lib/email/send')
  await sendEmail({
    from:    'CommandCenter <hello@comandcenter.se>',
    to:      user.email,
    subject: 'Your CommandCenter data is live',
    html:    emailHtml,
    context: { kind: 'onboarding_data_live', user_id: user.id, integration_id },
  })

  if (integration_id) {
    try {
      await db.from('integrations').update({ onboarding_email_sent: true }).eq('id', integration_id)
    } catch (err: any) {
      console.warn('Could not mark onboarding_email_sent:', err.message)
    }
  }

  return NextResponse.json({ ok: true })
}
