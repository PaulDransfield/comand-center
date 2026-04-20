// @ts-nocheck
// app/api/cron/weekly-digest/route.ts
//
// Runs every Monday at 07:00 Stockholm time (05:00 UTC in summer, 06:00 UTC in winter).
// Generates an AI-written memo per business, sends one consolidated email per
// org owner. Writes each memo to `briefings` for history + idempotency.
//
// Protected by CRON_SECRET header (Vercel Cron).

import { NextRequest, NextResponse } from 'next/server'
import { createAdminClient }         from '@/lib/supabase/server'
import { checkCronSecret }           from '@/lib/admin/check-secret'
import { buildWeeklyContext, generateWeeklyMemo, memoEmailHtml } from '@/lib/ai/weekly-manager'

export const dynamic     = 'force-dynamic'
export const maxDuration = 120

export async function POST(req: NextRequest) {
  if (!checkCronSecret(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const db  = createAdminClient()
  const now = new Date()

  // The Monday on/before today — the memo summarises the week that ended last Sunday.
  const dayOfWeek  = now.getDay()                       // 0=Sun, 1=Mon...
  const daysToMon  = dayOfWeek === 0 ? 6 : dayOfWeek - 1
  const thisMonday = new Date(now)
  thisMonday.setDate(now.getDate() - daysToMon)
  thisMonday.setHours(0, 0, 0, 0)

  const lastMonday = new Date(thisMonday); lastMonday.setDate(thisMonday.getDate() - 7)
  const lastSunday = new Date(thisMonday); lastSunday.setDate(thisMonday.getDate() - 1)
  const fromDate   = lastMonday.toISOString().slice(0, 10)

  const weekNum  = Math.ceil((lastMonday.getTime() - new Date(lastMonday.getFullYear(), 0, 1).getTime()) / 604800000)
  const weekLabel = `Week ${weekNum} — ${lastMonday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} to ${lastSunday.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`

  // All active orgs
  const { data: orgs } = await db
    .from('organisations')
    .select('id, name, billing_email, is_active')
    .eq('is_active', true)

  if (!orgs?.length) return NextResponse.json({ ok: true, sent: 0, message: 'No active orgs' })

  let sent = 0
  let memosGenerated = 0
  const errors: string[] = []
  const resendKey = process.env.RESEND_API_KEY
  const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://comandcenter.se'
  const { isAgentEnabled } = await import('@/lib/ai/is-agent-enabled')

  for (const org of orgs) {
    try {
      const enabled = await isAgentEnabled(db, org.id, 'monday_briefing')
      if (!enabled) {
        console.log(`[digest] ${org.name} disabled via feature flag`)
        continue
      }

      // Find owner email (auth.users > billing_email fallback)
      const { data: member } = await db
        .from('organisation_members')
        .select('user_id')
        .eq('org_id', org.id).eq('role', 'owner').maybeSingle()
      let ownerEmail = org.billing_email ?? null
      if (member?.user_id) {
        const { data: authUser } = await db.auth.admin.getUserById(member.user_id)
        ownerEmail = authUser?.user?.email ?? ownerEmail
      }
      if (!ownerEmail) {
        console.log(`[digest] no email for ${org.name}`)
        continue
      }

      // All active businesses
      const { data: businesses } = await db
        .from('businesses')
        .select('id, name, city')
        .eq('org_id', org.id).eq('is_active', true)
      if (!businesses?.length) continue

      // Generate one AI memo per business, send one email concatenating them.
      const bizMemos: Array<{
        biz: { id: string; name: string; city?: string }
        ctx: any
        memo: any
      }> = []

      for (const biz of businesses) {
        const ctx = await buildWeeklyContext(db, org.id, biz.id, biz.name, thisMonday, biz.city ?? null)

        // Skip businesses with no revenue in the last 8 weeks — nothing to say.
        const anyRev = ctx.thisWeek.revenue + ctx.lastWeek.revenue +
          ctx.prior4Weeks.reduce((s: number, w: any) => s + w.revenue, 0)
        if (anyRev === 0) {
          console.log(`[digest] ${biz.name} has no revenue data — skipping memo`)
          continue
        }

        const memo = await generateWeeklyMemo(db, org.id, biz.id, ctx)
        if (!memo) {
          console.warn(`[digest] memo generation failed for ${biz.name}`)
          continue
        }
        memosGenerated++
        bizMemos.push({ biz, ctx, memo })
      }

      if (!bizMemos.length) continue

      // Persist briefings FIRST so we have stable IDs to embed in the email's
      // feedback links. If the persist fails we still send the email, just
      // without the thumbs-up/down block. (Prior to 2026-04-20 briefings were
      // upserted AFTER send — that meant feedback links had no target.)
      const briefRows = bizMemos.map(b => ({
        org_id:      org.id,
        business_id: b.biz.id,
        week_start:  fromDate,
        content:     b.memo.narrative,
        key_metrics: {
          actions:     b.memo.actions,
          facts_cited: b.memo.facts_cited,
          week:        weekLabel,
          revenue:     b.ctx.thisWeek.revenue,
          staff_cost:  b.ctx.thisWeek.staff_cost,
          labour_pct:  b.ctx.thisWeek.labour_pct,
        },
      }))

      let briefingIdByBusiness: Record<string, string> = {}
      try {
        const { data: persisted } = await db
          .from('briefings')
          .upsert(briefRows, { onConflict: 'business_id,week_start' })
          .select('id, business_id')
        for (const row of persisted ?? []) {
          briefingIdByBusiness[row.business_id] = row.id
        }
      } catch (bErr: any) {
        console.warn(`[digest] briefings persist failed for ${org.name}:`, bErr.message)
      }

      // Build the email — one memo per business, stacked. Each section's
      // feedback links are signed against that business's briefing id.
      const htmlSections = bizMemos.map(b =>
        memoEmailHtml(b.ctx, b.memo, appUrl, org.id, briefingIdByBusiness[b.biz.id] ?? null),
      )
      const combinedHtml = bizMemos.length === 1
        ? htmlSections[0]
        : `<!doctype html><html><body style="margin:0;padding:0;background:#f5f5f0;">${htmlSections.join('<div style="height:12px;background:#f5f5f0;"></div>')}</body></html>`

      if (!resendKey) {
        console.log(`[digest] dry-run (no RESEND_API_KEY) would send ${bizMemos.length} memo(s) to ${ownerEmail}`)
        sent++
      } else {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            from:    'CommandCenter <digest@comandcenter.se>',
            to:      ownerEmail,
            subject: `Monday memo — ${weekLabel}`,
            html:    combinedHtml,
          }),
        })
        if (emailRes.ok) {
          sent++
          console.log(`[digest] sent to ${ownerEmail} for ${org.name}`)
        } else {
          const err = await emailRes.text()
          errors.push(`${org.name}: ${err}`)
          console.error(`[digest] email failed for ${org.name}:`, err)
          continue
        }
      }

    } catch (err: any) {
      errors.push(`${org.name}: ${err.message}`)
      console.error(`[digest] Error for ${org.name}:`, err)
    }
  }

  return NextResponse.json({
    ok:              true,
    emails_sent:     sent,
    memos_generated: memosGenerated,
    errors:          errors.length ? errors : undefined,
    week:            weekLabel,
  })
}


// Vercel Cron dispatches GET — delegate to the same handler.
export const GET = POST
