// app/api/scheduling/ai-recommend/route.ts
//
// POST /api/scheduling/ai-recommend { business_id, week_iso, force? }
//
// Generates AI-recommended schedule changes for the given week.
// Returns schedule_ai_suggestions rows the UI overlays as orange-dashed
// cells in the grid.
//
// Inputs to Claude (Sonnet 4.6):
//   - Business: target_staff_pct, country, opening_days, business_stage
//   - Current week shifts + templates + staff profiles
//   - Demand forecast: per-day revenue, weather, holidays
//   - HOURLY DEMAND PROFILE: 12-week historical avg revenue + covers per
//     weekday × hour-of-day. This is what lets the AI judge whether a
//     12:00–14:00 overlap actually has demand to support a third FOH
//     person — without it, the AI was only seeing daily totals and
//     guessing.
//   - Recent owner overrides (last 60 days of rejected/modified suggestions)
//     as in-context learning examples
//   - Asymmetric rule guidance (cuts by default; adds only if business
//     has scheduling_ai_allow_adds=true)
//
// Output (per suggestion):
//   - action: cut | reduce | extend | reassign | add | swap_template
//   - target shift / template / staff
//   - before / proposed JSONB
//   - reasoning (owner-facing)
//   - est_sek_saving
//   - confidence 0-1
//
// Server-side cache 24h per (business, week) — clicking Generate again
// returns the same suggestions unless force=true.

import { NextRequest, NextResponse }    from 'next/server'
import { unstable_noStore as noStore }  from 'next/cache'
import { getRequestAuth, createAdminClient } from '@/lib/supabase/server'
import { requireBusinessAccess }        from '@/lib/auth/require-role'
import { AI_MODELS }                    from '@/lib/ai/models'
import { anthropicFetch }               from '@/lib/ai/anthropic-fetch'
import { checkAndIncrementAiLimit }     from '@/lib/ai/usage'
import { getHolidaysForCountry }        from '@/lib/holidays'
import { composeRules, INDUSTRY_BENCHMARKS, VOICE, SCHEDULING_ASYMMETRY, swedishLabourCompliance } from '@/lib/ai/rules'
import { DEFAULT_LABOR_CONFIG, type LaborConfig } from '@/lib/scheduling/labor-rules-sweden'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 120

const CACHE_TTL_HOURS = 24

// Sonnet 4.6 pricing
const SONNET_INPUT_USD_PER_TOKEN  = 3  / 1_000_000
const SONNET_OUTPUT_USD_PER_TOKEN = 15 / 1_000_000

export async function POST(req: NextRequest) {
  noStore()
  const auth = await getRequestAuth(req)
  if (!auth) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })

  let body: any
  try { body = await req.json() } catch { body = {} }
  const businessId = String(body.business_id ?? '').trim()
  const weekIso    = String(body.week_iso ?? '').trim()
  const force      = body.force === true
  if (!businessId)               return NextResponse.json({ error: 'business_id required' }, { status: 400 })
  if (!/^\d{4}-W\d{2}$/.test(weekIso)) return NextResponse.json({ error: 'week_iso must be YYYY-Www' }, { status: 400 })
  const forbidden = requireBusinessAccess(auth, businessId)
  if (forbidden) return forbidden

  const db = createAdminClient()

  // ── Cache check ─────────────────────────────────────────────────
  if (!force) {
    const { data: cached } = await db
      .from('schedule_ai_suggestions')
      .select('*')
      .eq('business_id', businessId)
      .eq('week_iso', weekIso)
      .gte('created_at', new Date(Date.now() - CACHE_TTL_HOURS * 3600_000).toISOString())
      .order('created_at', { ascending: false })
    if (cached && cached.length > 0) {
      return NextResponse.json({
        suggestions: cached,
        cached:      true,
        count:       cached.length,
      })
    }
  }

  // ── Load context ────────────────────────────────────────────────
  const { data: biz } = await db.from('businesses')
    .select('id, name, country, opening_days, target_staff_pct, business_stage, scheduling_labor_config')
    .eq('id', businessId).maybeSingle()
  if (!biz) return NextResponse.json({ error: 'business not found' }, { status: 404 })

  const { monday, sunday } = isoWeekToRange(weekIso)
  const days: string[] = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setUTCDate(d.getUTCDate() + i)
    days.push(d.toISOString().slice(0, 10))
  }

  // Load 12 weeks back for hourly history; the demand profile is built from this.
  const hourlyFrom = new Date(monday); hourlyFrom.setUTCDate(hourlyFrom.getUTCDate() - 12 * 7)
  const hourlyFromIso = hourlyFrom.toISOString().slice(0, 10)

  // Also load planned-cost-per-hour reference: historical staff cost % by
  // (weekday × hour) — pairs with hourly revenue to show the AI which
  // hours have ALREADY been over-staffed historically. We approximate
  // this from staff_shifts vs hourly_metrics.
  const [shiftsRes, templatesRes, profilesRes, forecastRes, recentOutcomesRes, hourlyRes] = await Promise.all([
    db.from('staff_shifts')
      .select('id, staff_uid, shift_date, start_at, end_at, start_time_local, end_time_local, staff_name, period_name, shift_template_id, shift_kind, breaks_seconds, has_ob, ob_hours, estimated_cost, is_published')
      .eq('business_id', businessId)
      .gte('shift_date', days[0]).lte('shift_date', days[6])
      .order('shift_date').order('start_at'),
    db.from('staff_shift_templates')
      .select('id, name, section, modal_start_time, modal_end_time, sort_order, shifts_count_60d')
      .eq('business_id', businessId).is('archived_at', null)
      .order('section').order('sort_order'),
    db.from('staff_profiles')
      .select('staff_uid, display_name, primary_section, salary_type, hourly_rate_sek, service_grade_pct, typical_days, typical_shift_window, versatility_score, no_show_rate, closer_confidence, rush_capability')
      .eq('business_id', businessId).eq('is_active', true),
    db.from('forecasts')
      .select('forecast_date, predicted_revenue')
      .eq('business_id', businessId)
      .gte('forecast_date', days[0]).lte('forecast_date', days[6]),
    db.from('schedule_ai_suggestions')
      .select('action, before, proposed, reasoning, status, owner_reason, reason_code, modified_to')
      .eq('business_id', businessId)
      .in('status', ['rejected', 'modified', 'approved', 'applied'])
      .gte('created_at', new Date(Date.now() - 60 * 86_400_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(200),
    db.from('hourly_metrics')
      .select('business_date, hour, revenue, covers')
      .eq('business_id', businessId)
      .gte('business_date', hourlyFromIso)
      .lt('business_date', days[0])
      .order('business_date'),
  ])

  if (shiftsRes.error)    return NextResponse.json({ error: `shifts: ${shiftsRes.error.message}` }, { status: 500 })
  if (templatesRes.error) return NextResponse.json({ error: `templates: ${templatesRes.error.message}` }, { status: 500 })

  const shifts    = shiftsRes.data    ?? []
  const templates = templatesRes.data ?? []
  const profiles  = profilesRes.data  ?? []
  const forecast  = forecastRes.data  ?? []
  const recent    = recentOutcomesRes.data ?? []
  const hourly    = hourlyRes.data    ?? []

  // Split owner feedback into NEGATIVE (don't repeat / learn the tweak) and
  // POSITIVE (these landed — do more of this) examples. Previously only the
  // negative half reached the prompt, so the model learned from failure but
  // never from success. Also tally WHY suggestions get rejected so the AI can
  // see its own failure distribution (e.g. mostly "busier_than_forecast" =>
  // it's over-cutting).
  const rejectedModified = recent.filter((r: any) => r.status === 'rejected' || r.status === 'modified').slice(0, 15)
  const approvedApplied  = recent.filter((r: any) => r.status === 'approved' || r.status === 'applied').slice(0, 12)
  const reasonTally: Record<string, number> = {}
  for (const r of recent) {
    if (r.status === 'rejected' && r.reason_code) {
      reasonTally[r.reason_code] = (reasonTally[r.reason_code] ?? 0) + 1
    }
  }
  const rejectionBreakdown = Object.entries(reasonTally)
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }))

  // ── Build per-(weekday × hour) demand profile from 12-week history ─
  //
  // Output: hourlyDemand[weekday=0..6][hour=0..23] = { avgRev, avgCovers, samples }
  // where weekday 0 = Mon, 6 = Sun (ISO).  An "hour" cell with samples=0
  // means we've never seen revenue at that slot — almost certainly closed.
  const hourlyDemand: { weekday: number; hour: number; avg_rev: number; avg_covers: number; samples: number }[] = []
  {
    const buckets: Record<string, { rev: number; covers: number; n: number; dates: Set<string> }> = {}
    // Track distinct dates per weekday so a "no row" counts as a 0
    const datesByWeekday: Record<number, Set<string>> = { 0: new Set(), 1: new Set(), 2: new Set(), 3: new Set(), 4: new Set(), 5: new Set(), 6: new Set() }
    for (const row of hourly) {
      const wd = isoWeekday(row.business_date)
      datesByWeekday[wd].add(row.business_date)
      const k = `${wd}|${row.hour}`
      if (!buckets[k]) buckets[k] = { rev: 0, covers: 0, n: 0, dates: new Set() }
      buckets[k].rev    += Number(row.revenue ?? 0)
      buckets[k].covers += Number(row.covers  ?? 0)
      buckets[k].n      += 1
      buckets[k].dates.add(row.business_date)
    }
    for (let wd = 0; wd < 7; wd++) {
      const denom = datesByWeekday[wd].size || 1
      for (let h = 0; h < 24; h++) {
        const b = buckets[`${wd}|${h}`]
        if (!b) {
          hourlyDemand.push({ weekday: wd, hour: h, avg_rev: 0, avg_covers: 0, samples: 0 })
        } else {
          // Average across ALL dates of that weekday (a "no row" implies 0)
          hourlyDemand.push({
            weekday: wd, hour: h,
            avg_rev:    Math.round(b.rev / denom),
            avg_covers: Math.round((b.covers / denom) * 10) / 10,
            samples:    denom,
          })
        }
      }
    }
  }

  // Compact summary the AI can read at a glance — group by weekday with
  // open hours only (drop closed hours = avg_rev < 100 kr AND samples > 4).
  const hourlyByWeekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, wd) => {
    const openHours = hourlyDemand
      .filter(c => c.weekday === wd && !(c.avg_rev < 100 && c.samples > 4))
      .sort((a, b) => a.hour - b.hour)
      .map(c => ({ h: c.hour, rev: c.avg_rev, covers: c.avg_covers }))
    return { day, hours: openHours }
  })

  // Compute per-day aggregates the AI needs
  const forecastByDate = new Map(forecast.map(f => [f.forecast_date, Number(f.predicted_revenue)]))
  const holidays = getHolidaysForCountry(biz.country ?? 'SE', new Date(monday).getUTCFullYear())
  const holidayByDate = new Map(holidays.map(h => [h.date, h]))

  const dayContext = days.map(d => {
    const dayShifts = shifts.filter((s: any) => s.shift_date === d && s.shift_kind === 'regular')
    const totalSeconds = dayShifts.reduce((sum: number, s: any) =>
      sum + (new Date(s.end_at).getTime() - new Date(s.start_at).getTime()) / 1000 - (s.breaks_seconds ?? 0), 0)
    const totalCost = dayShifts.reduce((sum: number, s: any) => sum + Number(s.estimated_cost ?? 0), 0)
    return {
      date: d,
      day_of_week: new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' }),
      planned_hours: Math.round(totalSeconds / 360) / 10,
      planned_cost:  Math.round(totalCost),
      forecast_revenue: forecastByDate.get(d) ?? null,
      projected_staff_pct: (forecastByDate.get(d) ?? 0) > 0
        ? Math.round((totalCost / (forecastByDate.get(d) as number)) * 1000) / 10
        : null,
      holiday: holidayByDate.get(d)?.name_en ?? null,
      shift_count: dayShifts.length,
    }
  })

  const targetPct      = biz.target_staff_pct ? Number(biz.target_staff_pct) : 32
  const allowAdds      = false   // Plan §7 — default cuts-only. Per-business opt-in lives on businesses.scheduling_ai_allow_adds (not yet added; uncomment when wired)
  // Swedish labour ruleset for this business. Reads businesses.scheduling_labor_config
  // (JSONB) when present; falls back to the Visita–HRF default (SE restaurants).
  // Defensive: the column may not be applied yet — treat absence as default.
  const laborConfig: LaborConfig = (biz as any).scheduling_labor_config
    ? { ...DEFAULT_LABOR_CONFIG, ...(biz as any).scheduling_labor_config }
    : DEFAULT_LABOR_CONFIG
  const totalForecast  = dayContext.reduce((s, d) => s + (d.forecast_revenue ?? 0), 0)
  const totalCost      = dayContext.reduce((s, d) => s + d.planned_cost, 0)
  const weekStaffPct   = totalForecast > 0 ? (totalCost / totalForecast) * 100 : null

  // ── Build prompt ────────────────────────────────────────────────
  const SYSTEM_PROMPT = composeRules(
    `You are CommandCenter's scheduling AI for a Swedish restaurant. Your job is to recommend per-shift changes to next week's roster so the business hits its target staff cost %.`,
    INDUSTRY_BENCHMARKS,
    VOICE,
    allowAdds
      ? `Scheduling rule — SYMMETRIC (this business has opted in):
- You may recommend either CUTTING or ADDING shifts based on forecast and historical patterns.
- For every ADD: explicitly quantify downside risk in your reasoning ("if revenue lands at 70% of forecast, this adds X kr fixed cost on a slow day").
- Adds must respect typical_days for the suggested staff member — never schedule someone outside their normal pattern unless absolutely necessary.`
      : SCHEDULING_ASYMMETRY,
    swedishLabourCompliance(laborConfig),
    `HOURLY DEMAND PROFILE (12-week history):
- "hourly_demand_by_weekday" gives the average revenue + covers for every open hour of each weekday, derived from the past 12 weeks of POS sales. This is your PRIMARY signal for whether a shift overlap is justified.
- Use these numbers in your reasoning. Specific example: "Monday 12:00–13:00 avg 1,800 kr / 22 covers — below the threshold to justify three FOH on the floor; cutting Linnéa's 12:00 start to 14:00 is safe."
- Cite the actual hourly figures when explaining a cut. Owners trust reasoning that quotes their own data over reasoning that sounds plausible.
- An empty hours list for a weekday means we have no POS data — be more conservative there (lower confidence on cuts).
- Cover-count tells you whether the trough is light traffic or just low spend (e.g. coffee crowd). Don't cut staff on a high-cover hour even if revenue is modest.`,
    `LEARNING — this owner's own history is your strongest signal:
- REJECTED suggestions (recent_owner_overrides): do NOT propose the same change again, and read owner_reason to understand why it was wrong.
- rejection_reason_breakdown is the tally of WHY this owner rejects, most common first. Use it to correct course: if "busier_than_forecast" dominates, your cuts are too aggressive — trust the forecast less and lean harder on the hourly demand profile before cutting. If "min_staffing" or "service_quality" dominate, you are cutting below the floor the owner needs — raise your bar for proposing a cut. If "wrong_role_section" dominates, you are misreading who covers what — be more careful matching staff to section.
- MODIFIED suggestions: they liked the idea but changed the amount — aim for where they landed (owner_modified_to), not your original number.
- APPROVED / APPLIED suggestions (recent_owner_approvals): these LANDED. Favour the same KIND of change — same action type, similar day / shift / section pattern. Repeating what the owner has already accepted builds trust and acceptance rate.
- You can suggest fewer, higher-quality changes rather than many marginal ones. Confidence < 0.65 → omit the suggestion entirely.`,
    `OUTPUT FORMAT — return a JSON object with a "suggestions" array. Each suggestion:
{
  "action": "cut" | "reduce" | "extend" | "reassign" | "add" | "swap_template",
  "shift_date": "YYYY-MM-DD",
  "target_shift_id": "uuid or null" (null when action='add'),
  "target_staff_uid": "string or null",
  "before": { description of current state, e.g. "Anna 11:00-19:00 Kväll" },
  "proposed": { description of proposed state, e.g. "Anna 11:00-17:00 Kväll (cut 2h)" },
  "reasoning": "1-2 sentence owner-facing explanation",
  "est_sek_saving": number (positive = saving, negative = additional cost),
  "confidence": number 0-1
}

Return at most 8 suggestions per week — prioritise highest-impact (largest SEK delta).`,
  )

  const userMessage = JSON.stringify({
    business: {
      name: biz.name,
      country: biz.country,
      target_staff_pct: targetPct,
      business_stage: biz.business_stage,
      opening_days: biz.opening_days,
    },
    week: {
      iso: weekIso,
      from: days[0],
      to: days[6],
      forecast_revenue_sek: totalForecast,
      planned_cost_sek: totalCost,
      projected_staff_pct: weekStaffPct,
      gap_to_target_pct: weekStaffPct != null ? Math.round((weekStaffPct - targetPct) * 10) / 10 : null,
    },
    days: dayContext,
    hourly_demand_by_weekday: hourlyByWeekday,
    templates: templates.map((t: any) => ({
      id: t.id, name: t.name, section: t.section,
      modal_start: t.modal_start_time, modal_end: t.modal_end_time,
      uses_60d: t.shifts_count_60d,
    })),
    staff: profiles.map((p: any) => ({
      uid: p.staff_uid,
      name: p.display_name,
      section: p.primary_section,
      salary_type: p.salary_type,
      hourly_rate: p.hourly_rate_sek,
      contract_pct: p.service_grade_pct,
      typical_days: p.typical_days,
      shift_window: p.typical_shift_window,
      versatility: p.versatility_score,
      no_show_rate: p.no_show_rate,
      closer_confidence: p.closer_confidence,
      rush_capability: p.rush_capability,
    })),
    current_shifts: shifts.map((s: any) => ({
      id: s.id, date: s.shift_date,
      staff_uid: s.staff_uid, staff_name: s.staff_name,
      template_id: s.shift_template_id, template_name: s.period_name,
      start: s.start_time_local, end: s.end_time_local,
      kind: s.shift_kind,
      est_cost: s.estimated_cost,
      published: s.is_published,
    })),
    recent_owner_overrides: rejectedModified.map((r: any) => ({
      ai_action: r.action,
      ai_proposed: r.proposed,
      owner_decision: r.status,
      owner_reason: r.owner_reason ?? null,
      owner_reason_code: r.reason_code ?? null,
      owner_modified_to: r.modified_to ?? null,
    })),
    // Positive examples — suggestions the owner accepted. The model should
    // reinforce these patterns, not just avoid the rejected ones.
    recent_owner_approvals: approvedApplied.map((r: any) => ({
      ai_action: r.action,
      ai_proposed: r.proposed,
      owner_decision: r.status,
    })),
    // Distribution of rejection reasons (controlled vocab) so the model can
    // self-correct its systematic bias.
    rejection_reason_breakdown: rejectionBreakdown,
  })

  // ── Per-org AI quota gate ───────────────────────────────────────
  // Atomic INSERT … ON CONFLICT DO UPDATE via the increment_ai_usage_checked
  // RPC. Decrements on over-limit so rejected attempts don't tick the counter.
  // Without this an owner spamming "Generate AI suggestions" could burn
  // the entire plan's daily AI budget in seconds.
  const usage = await checkAndIncrementAiLimit(db, auth.orgId)
  if (!usage.ok) {
    return NextResponse.json(usage.body, { status: usage.status })
  }

  // ── Call Sonnet ─────────────────────────────────────────────────
  const t0 = Date.now()
  const result = await anthropicFetch({
    body: {
      model:       AI_MODELS.ANALYSIS,   // Sonnet 4.6
      max_tokens:  6000,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: `Generate scheduling suggestions for this week:\n\n${userMessage}\n\nReturn JSON object {"suggestions": [...]} only.` },
      ],
    },
  })

  if (!result.ok) {
    return NextResponse.json({ error: `Anthropic HTTP ${result.status}: ${result.errorText}` }, { status: 502 })
  }
  const json = result.json
  const tIn  = result.tokensIn
  const tOut = result.tokensOut
  const cost = tIn * SONNET_INPUT_USD_PER_TOKEN + tOut * SONNET_OUTPUT_USD_PER_TOKEN

  const rawText = json?.content?.[0]?.text ?? ''
  const jsonStart = rawText.indexOf('{'), jsonEnd = rawText.lastIndexOf('}') + 1
  let parsed: any
  try { parsed = JSON.parse(rawText.slice(jsonStart, jsonEnd)) }
  catch (e: any) {
    return NextResponse.json({
      error: 'Failed to parse Claude response',
      detail: String(e?.message ?? e),
      preview: rawText.slice(0, 400),
    }, { status: 502 })
  }
  const items: any[] = parsed?.suggestions ?? []

  // ── Persist suggestions ────────────────────────────────────────
  const rows = items
    .filter(s => s && s.action && Number(s.confidence ?? 0) >= 0.65)
    .map(s => ({
      org_id:        auth.orgId,
      business_id:   businessId,
      week_iso:      weekIso,
      shift_date:    s.shift_date ?? null,
      action:        String(s.action),
      target_staff_uid:   s.target_staff_uid ?? null,
      target_shift_id:    s.target_shift_id ?? null,
      target_template_id: s.target_template_id ?? null,
      before:        s.before    ?? null,
      proposed:      s.proposed  ?? null,
      reasoning:     String(s.reasoning ?? '').slice(0, 500),
      est_sek_saving: s.est_sek_saving != null ? Number(s.est_sek_saving) : null,
      confidence:    Math.max(0, Math.min(1, Number(s.confidence ?? 0))),
      status:        'pending',
      ai_model:      AI_MODELS.ANALYSIS,
      tokens_input:  Math.round(tIn  / Math.max(1, items.length)),
      tokens_output: Math.round(tOut / Math.max(1, items.length)),
    }))

  if (rows.length > 0) {
    const { error: insErr } = await db.from('schedule_ai_suggestions').insert(rows)
    if (insErr) {
      return NextResponse.json({
        error: `Failed to persist suggestions: ${insErr.message}`,
        suggestions: rows,
      }, { status: 500 })
    }
  }

  // Return the inserted suggestions (refetch to include generated ids)
  const { data: finalRows } = await db
    .from('schedule_ai_suggestions')
    .select('*')
    .eq('business_id', businessId)
    .eq('week_iso', weekIso)
    .eq('status', 'pending')
    .order('confidence', { ascending: false })

  return NextResponse.json({
    suggestions: finalRows ?? [],
    cached:      false,
    count:       finalRows?.length ?? 0,
    cost_usd:    Math.round(cost * 10000) / 10000,
    duration_ms: Date.now() - t0,
  })
}

// ─────────────────────────────────────────────────────────────────────

// ISO weekday: 0 = Mon, 6 = Sun
function isoWeekday(dateIso: string): number {
  const d = new Date(dateIso + 'T00:00:00Z')
  return (d.getUTCDay() + 6) % 7
}

function isoWeekToRange(weekIso: string): { monday: string; sunday: string } {
  const [yearStr, weekStr] = weekIso.split('-W')
  const year = Number(yearStr)
  const week = Number(weekStr)
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const jan4Dow = (jan4.getUTCDay() + 6) % 7
  const week1Monday = new Date(jan4)
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Dow)
  const monday = new Date(week1Monday)
  monday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  return { monday: monday.toISOString().slice(0, 10), sunday: sunday.toISOString().slice(0, 10) }
}
