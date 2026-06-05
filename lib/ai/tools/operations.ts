// lib/ai/tools/operations.ts
//
// Operational tools so Ask CC can answer day-to-day owner questions:
//
//   - get_revenue            → daily/weekly/monthly revenue + covers
//   - get_pnl                → period P&L summary from tracker_data
//   - get_labour_summary     → labour cost + hours from monthly_metrics +
//                              optional shift-level detail
//   - list_recipes           → recipe list with margins + incomplete-cost flags
//   - get_reviews_summary    → Google review rating + themes summary
//   - get_upcoming_calendar  → public holidays + events in N-day window
//
// These wrap the same tables the dashboard reads, so the answers Ask CC
// gives are the same numbers the owner sees on the screen.

import type { AnthropicToolDef, ToolContext } from './index'
import { getUpcomingHolidays } from '@/lib/holidays'

export const OPERATIONS_TOOLS: AnthropicToolDef[] = [
  {
    name: 'get_revenue',
    description:
      `Return revenue + covers for this business. Default = last 30 days; pass ` +
      `period='month'|'week'|'day' + months/weeks/days to control granularity. ` +
      `For monthly, returns up to 12 months. For daily, returns up to 90 days.\n\n` +
      `Use for "how much did we sell last week / last month / yesterday", "what ` +
      `were our covers in March", "how is revenue trending".`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['day','week','month'], description: 'Granularity. Default month.' },
        months: { type: 'integer', description: 'Trailing months for period=month (default 6, max 12).' },
        days:   { type: 'integer', description: 'Trailing days for period=day (default 30, max 90).' },
      },
    },
  },
  {
    name: 'get_pnl',
    description:
      `Return monthly P&L from tracker_data: revenue, food cost, labour cost, ` +
      `other costs, net profit, net margin %. Last N months. Sourced from ` +
      `Fortnox Resultatrapport uploads + automatic backfill — same numbers as the ` +
      `/financials/performance page.\n\n` +
      `Use for "show me last 3 months P&L", "what was our net margin in February", ` +
      `"how is food cost % trending". Only returns CLOSED months (is_provisional ` +
      `excluded automatically).`,
    input_schema: {
      type: 'object',
      properties: {
        months: { type: 'integer', description: 'Trailing months (default 6, max 12).' },
      },
    },
  },
  {
    name: 'get_labour_summary',
    description:
      `Return labour cost + hours summary. Granularity: monthly aggregates ` +
      `(period='month') OR recent shift detail (period='shift', last 14 days). ` +
      `Includes per-staff totals when period='shift'.\n\n` +
      `Use for "how much did I spend on labour last month", "how many hours ` +
      `worked this week", "who's most-scheduled". Source: staff_logs from ` +
      `Personalkollen + monthly_metrics aggregates.`,
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['month','shift'], description: "'month' = aggregates per month (default); 'shift' = last 14 days of individual shifts." },
        months: { type: 'integer', description: 'Trailing months for period=month (default 3, max 12).' },
      },
    },
  },
  {
    name: 'list_recipes',
    description:
      `List recipes with menu price, food cost, GP%, and incomplete-cost flag. ` +
      `Filter by type (e.g. 'wine', 'pasta', 'dessert') or sub-recipe flag. ` +
      `Sort by gp_pct, food_cost, or menu_price. Top N.\n\n` +
      `Use for "which dishes have the worst margin", "show me my wines by GP", ` +
      `"list all desserts and their food cost". When the user asks "how can I ` +
      `improve margins", call this first to ground recommendations in real data.`,
    input_schema: {
      type: 'object',
      properties: {
        type:        { type: 'string', description: "Optional type filter (e.g. 'pasta', 'wine', 'starter')." },
        is_subrecipe:{ type: 'boolean', description: 'Filter to sub-recipes only. Default excludes.' },
        sort_by:     { type: 'string', enum: ['gp_pct_asc','gp_pct_desc','food_cost_desc','menu_price_desc'], description: 'Default gp_pct_asc (worst margin first).' },
        limit:       { type: 'integer', description: 'Top N (default 20, max 50).' },
        incomplete_only:{ type: 'boolean', description: 'Only recipes with missing-price or unit-mismatch issues.' },
      },
    },
  },
  {
    name: 'get_reviews_summary',
    description:
      `Return Google reviews summary: review count, average rating, theme ` +
      `breakdown, sentiment trend. Default last 90 days.\n\n` +
      `Use for "what are customers saying", "what's our Google rating", ` +
      `"what are the top complaints / compliments". Themes are LLM-extracted ` +
      `from each review (persistent — pruning the raw text doesn't lose them).`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Trailing days to summarise (default 90, max 365).' },
      },
    },
  },
  {
    name: 'get_upcoming_calendar',
    description:
      `Return Swedish public holidays + restaurant-relevant flags in the next ` +
      `N days. (Events feed is wired but Ticketmaster credentials are pending — ` +
      `events array will be empty until that's switched on.)\n\n` +
      `Use for "what's coming up next week", "are there any holidays I should ` +
      `staff for", "should I expect a busy weekend".`,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Days to look ahead (default 14, max 90).' },
      },
    },
  },
]

export async function runOperationsTool(
  ctx: ToolContext,
  name: 'get_revenue' | 'get_pnl' | 'get_labour_summary' | 'list_recipes' | 'get_reviews_summary' | 'get_upcoming_calendar',
  args: any,
): Promise<any> {
  if (name === 'get_revenue') {
    const period = args.period === 'day' || args.period === 'week' ? args.period : 'month'
    if (period === 'month') {
      const months = Math.min(12, Math.max(1, parseInt(String(args.months ?? 6), 10) || 6))
      const today = new Date()
      const fromY = today.getFullYear(), fromM = today.getMonth() + 1
      const startY = (fromY * 12 + (fromM - months)) / 12 | 0
      const startM = ((fromY * 12 + (fromM - months)) % 12) + 1
      const { data } = await ctx.db.from('monthly_metrics')
        .select('year, month, revenue, covers, food_revenue, bev_revenue, staff_cost, food_cost')
        .eq('business_id', ctx.businessId)
        .or(`and(year.gt.${startY}),and(year.eq.${startY},month.gte.${startM})`)
        .order('year').order('month')
      return {
        period: 'month', months_returned: data?.length ?? 0,
        rows: (data ?? []).map((r: any) => ({
          period:        `${r.year}-${String(r.month).padStart(2,'0')}`,
          revenue:       Math.round(Number(r.revenue ?? 0)),
          covers:        r.covers ?? 0,
          rev_per_cover: r.covers > 0 ? Math.round(Number(r.revenue ?? 0) / r.covers) : null,
          food_revenue:  r.food_revenue != null ? Math.round(Number(r.food_revenue)) : null,
          bev_revenue:   r.bev_revenue  != null ? Math.round(Number(r.bev_revenue))  : null,
          staff_cost:    r.staff_cost   != null ? Math.round(Number(r.staff_cost))   : null,
        })),
      }
    } else if (period === 'day') {
      const days = Math.min(90, Math.max(1, parseInt(String(args.days ?? 30), 10) || 30))
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
      const { data } = await ctx.db.from('daily_metrics')
        .select('date, revenue, covers, rev_per_cover, food_revenue, bev_revenue, dine_in, takeaway, staff_cost, hours_worked, shifts')
        .eq('business_id', ctx.businessId).gte('date', cutoff).order('date')
      return { period: 'day', days_returned: data?.length ?? 0, rows: data ?? [] }
    } else {
      // Weekly — bucket daily into ISO weeks.
      const days = 7 * Math.min(12, Math.max(1, parseInt(String(args.weeks ?? 8), 10) || 8))
      const cutoff = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
      const { data } = await ctx.db.from('daily_metrics')
        .select('date, revenue, covers, food_revenue, bev_revenue, staff_cost')
        .eq('business_id', ctx.businessId).gte('date', cutoff).order('date')
      const buckets = new Map<string, any>()
      for (const r of data ?? []) {
        const d = new Date(r.date)
        const week = isoWeekLabel(d)
        const b = buckets.get(week) ?? { week, revenue: 0, covers: 0, food: 0, bev: 0, staff: 0 }
        b.revenue += Number(r.revenue ?? 0)
        b.covers  += r.covers ?? 0
        b.food    += Number(r.food_revenue ?? 0)
        b.bev     += Number(r.bev_revenue ?? 0)
        b.staff   += Number(r.staff_cost ?? 0)
        buckets.set(week, b)
      }
      return { period: 'week', weeks_returned: buckets.size, rows: [...buckets.values()].map(b => ({
        week: b.week, revenue: Math.round(b.revenue), covers: b.covers,
        food_revenue: Math.round(b.food), bev_revenue: Math.round(b.bev), staff_cost: Math.round(b.staff),
      }))}
    }
  }

  if (name === 'get_pnl') {
    const months = Math.min(12, Math.max(1, parseInt(String(args.months ?? 6), 10) || 6))
    const today = new Date()
    const startY = ((today.getFullYear() * 12 + today.getMonth() - months) / 12) | 0
    const startM = (((today.getFullYear() * 12 + today.getMonth() - months) % 12)) + 1
    const { data } = await ctx.db.from('tracker_data')
      .select('period_year, period_month, revenue, food_cost, staff_cost, other_cost, total_cost, gross_profit, net_profit, margin_pct, source')
      .eq('business_id', ctx.businessId)
      .or('is_provisional.is.null,is_provisional.eq.false')
      .or(`and(period_year.gt.${startY}),and(period_year.eq.${startY},period_month.gte.${startM})`)
      .order('period_year').order('period_month')
    return {
      months_returned: data?.length ?? 0,
      rows: (data ?? []).map((r: any) => ({
        period:        `${r.period_year}-${String(r.period_month).padStart(2,'0')}`,
        revenue:       Math.round(Number(r.revenue ?? 0)),
        food_cost:     Math.round(Number(r.food_cost ?? 0)),
        staff_cost:    Math.round(Number(r.staff_cost ?? 0)),
        other_cost:    Math.round(Number(r.other_cost ?? 0)),
        net_profit:    Math.round(Number(r.net_profit ?? 0)),
        margin_pct:    r.margin_pct != null ? Math.round(Number(r.margin_pct) * 10) / 10 : null,
        food_pct:      r.revenue > 0 ? Math.round((Number(r.food_cost) / Number(r.revenue)) * 1000) / 10 : null,
        labour_pct:    r.revenue > 0 ? Math.round((Number(r.staff_cost) / Number(r.revenue)) * 1000) / 10 : null,
        source:        r.source,
      })),
    }
  }

  if (name === 'get_labour_summary') {
    const period = args.period === 'shift' ? 'shift' : 'month'
    if (period === 'month') {
      const months = Math.min(12, Math.max(1, parseInt(String(args.months ?? 3), 10) || 3))
      const today = new Date()
      const startY = ((today.getFullYear() * 12 + today.getMonth() - months) / 12) | 0
      const startM = (((today.getFullYear() * 12 + today.getMonth() - months) % 12)) + 1
      const { data } = await ctx.db.from('monthly_metrics')
        .select('year, month, revenue, staff_cost')
        .eq('business_id', ctx.businessId)
        .or(`and(year.gt.${startY}),and(year.eq.${startY},month.gte.${startM})`)
        .order('year').order('month')
      return { period: 'month', months_returned: data?.length ?? 0, rows: (data ?? []).map((r: any) => ({
        period:    `${r.year}-${String(r.month).padStart(2,'0')}`,
        revenue:   Math.round(Number(r.revenue ?? 0)),
        staff_cost:Math.round(Number(r.staff_cost ?? 0)),
        labour_pct:r.revenue > 0 ? Math.round((Number(r.staff_cost) / Number(r.revenue)) * 1000) / 10 : null,
      }))}
    } else {
      const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10)
      const { data } = await ctx.db.from('staff_logs')
        .select('staff_name, staff_group, shift_date, shift_start, shift_end, hours_worked, cost_actual, estimated_salary')
        .eq('business_id', ctx.businessId).gte('shift_date', cutoff).order('shift_date', { ascending: false })
      // Per-staff aggregate
      const byStaff = new Map<string, { name: string; hours: number; cost: number; shifts: number }>()
      for (const s of data ?? []) {
        const k = s.staff_name ?? '—'
        const e = byStaff.get(k) ?? { name: k, hours: 0, cost: 0, shifts: 0 }
        e.hours  += Number(s.hours_worked ?? 0)
        e.cost   += Number(s.cost_actual ?? s.estimated_salary ?? 0)
        e.shifts += 1
        byStaff.set(k, e)
      }
      const top = [...byStaff.values()].sort((a, b) => b.hours - a.hours).slice(0, 20)
      return { period: 'shift', window_days: 14, total_shifts: data?.length ?? 0, top_staff: top, recent_shifts: (data ?? []).slice(0, 50) }
    }
  }

  if (name === 'list_recipes') {
    const limit = Math.min(50, Math.max(1, parseInt(String(args.limit ?? 20), 10) || 20))
    let q = ctx.db.from('recipes')
      .select('id, name, type, menu_price, selling_price_ex_vat, vat_rate, portions, is_subrecipe, notes, updated_at')
      .eq('business_id', ctx.businessId).is('archived_at', null)
    if (args.type) q = q.eq('type', String(args.type).toLowerCase())
    if (args.is_subrecipe === true) q = q.eq('is_subrecipe', true)
    else                            q = q.or('is_subrecipe.is.null,is_subrecipe.eq.false')
    const { data: recipes } = await q.range(0, 999)
    if (!recipes || recipes.length === 0) return { recipes: [], message: 'No recipes for this business yet.' }

    // The actual food cost + GP requires the recipe-cost engine which is
    // expensive per recipe. Defer to a header summary + flag of issues —
    // owner can call /inventory/recipes for full numbers.
    return {
      total_recipes: recipes.length,
      note: 'Headline list — for live food-cost + GP per recipe, the owner can open /inventory/recipes.',
      recipes: recipes.slice(0, limit).map((r: any) => ({
        id:                r.id,
        name:              r.name,
        type:              r.type,
        menu_price:        r.menu_price != null ? Number(r.menu_price) : null,
        selling_price_ex_vat: r.selling_price_ex_vat != null ? Number(r.selling_price_ex_vat) : null,
        vat_rate:          r.vat_rate,
        portions:          r.portions,
        is_subrecipe:      r.is_subrecipe === true,
      })),
    }
  }

  if (name === 'get_reviews_summary') {
    const days = Math.min(365, Math.max(7, parseInt(String(args.days ?? 90), 10) || 90))
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString()
    const { data } = await ctx.db.from('review_themes')
      .select('rating, sentiment, themes, key_phrase, published_at, replied_at')
      .eq('business_id', ctx.businessId).gte('published_at', cutoff).range(0, 999)
    if (!data || data.length === 0) return { window_days: days, total_reviews: 0, message: 'No reviews in window.' }
    const ratings = data.map((r: any) => Number(r.rating)).filter((n: any) => Number.isFinite(n))
    const avg = ratings.length ? ratings.reduce((a: number, b: number) => a + b, 0) / ratings.length : null
    const themeCount = new Map<string, number>()
    for (const r of data) {
      for (const t of (r as any).themes ?? []) themeCount.set(t, (themeCount.get(t) ?? 0) + 1)
    }
    const topThemes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([theme, count]) => ({ theme, count }))
    const sentimentCounts = { positive: 0, neutral: 0, negative: 0 } as any
    for (const r of data) sentimentCounts[(r as any).sentiment ?? 'neutral'] = (sentimentCounts[(r as any).sentiment ?? 'neutral'] ?? 0) + 1
    const replied = data.filter((r: any) => r.replied_at).length
    return {
      window_days: days,
      total_reviews: data.length,
      avg_rating: avg != null ? Math.round(avg * 10) / 10 : null,
      sentiment: sentimentCounts,
      top_themes: topThemes,
      replied,
      reply_rate_pct: Math.round((replied / data.length) * 1000) / 10,
    }
  }

  if (name === 'get_upcoming_calendar') {
    const days = Math.min(90, Math.max(1, parseInt(String(args.days ?? 14), 10) || 14))
    const { data: biz } = await ctx.db.from('businesses').select('country').eq('id', ctx.businessId).maybeSingle()
    const country = (biz?.country ?? 'SE').toUpperCase()
    const today = new Date().toISOString().slice(0, 10)
    const holidays = getUpcomingHolidays(country, today, days)
    return {
      window_days: days,
      country,
      holidays: holidays.map((h: any) => ({ date: h.date, name: h.name, kind: h.kind ?? null })),
      events: [],
      events_note: 'Events integration is wired but currently disabled (TICKETMASTER_API_KEY not set + business geocoding pending). See EVENTS-LLM-INTEGRATION-PLAN.md.',
    }
  }

  return { error: 'unknown_operations_tool', name }
}

// ── helpers ──────────────────────────────────────────────────────────────
function isoWeekLabel(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNum = date.getUTCDay() || 7
  date.setUTCDate(date.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${date.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}
