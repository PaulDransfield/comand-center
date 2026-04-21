// lib/ai/scope.ts
//
// Scope rules for CommandCenter AI surfaces.
//
// Some data in the app lives at the BUSINESS level (Fortnox P&L, full-business
// Personalkollen totals) and some data lives at the DEPARTMENT level
// (POS revenue tagged per-dept, staff assigned to a dept).
//
// AI answers and insights MUST NEVER attribute business-wide numbers to a
// single department.  The figures don't support that attribution and the
// owner will make real decisions based on the answer.
//
// Import SCOPE_NOTE into every system prompt or agent prompt that can
// possibly see both business and department data.  Import
// BUSINESS_SCOPE_FIELDS when you need to runtime-check whether a field is
// business-scope (e.g. when filtering context before sending to Claude).

export const SCOPE_NOTE = `SCOPE RULES — DO NOT VIOLATE:

BUSINESS-WIDE data (cannot be attributed to a department):
- tracker_data fields: revenue (from Fortnox), food_cost, staff_cost, other_cost, depreciation, financial, net_profit, margin_pct
- tracker_line_items: every row (Fortnox P&L does not split by department)
- monthly_metrics, daily_metrics: aggregates over the whole business
- Personalkollen totals when not per-department

DEPARTMENT-LEVEL data (safe to cite per-department):
- department-tagged revenue (POS providers like pk_bella, pk_carne, pk_rosali_select)
- staff_logs rows assigned to a specific department
- the /api/departments endpoint aggregates these

When to USE business-wide data — encouraged:
- Forecasting the business as a whole (next month revenue, next quarter margin, year-end profit).  Business-wide history is the richest signal we have — use it fully.
- Seasonality and trend analysis at the business scope (month-over-month, year-over-year).
- Cost-trend analysis at the business scope (cost creep, subscription duplicates, rent vs. utilities share).
- Benchmarking the whole business against industry norms (labour % of revenue, food % of revenue, other_cost % of revenue).
- Budget recommendations that target the whole business.

When to AVOID business-wide data:
- Any answer scoped to a single department.  Don't slice business-wide numbers across departments.
- Cross-department comparisons that need food/overhead context — those costs don't exist per department.

Rules when answering:
1. When the user asks about a department, only cite department-level data.  Do not slice business-wide numbers across departments — the data does not support that split.
2. Department margin = department_revenue − department_staff_cost.  It does NOT include food cost, other_cost, depreciation, or financial — those only exist at the business level.
3. When a department-scoped question needs a business-wide figure to answer fully, say so explicitly: "Food cost is reported at the business level, not per department, so I can't split Bella's margin beyond labour."
4. When citing numbers, always be clear about the scope (whole business vs. a named department).
5. Fortnox-sourced figures are business-wide by definition.  A Fortnox line item labelled "Lokalhyra" is rent for the whole business — never assume a portion is a department's rent.
6. For forecasts, budgets, and long-range questions at the business level: lean into Fortnox history.  The point of capturing it is to improve prediction.`

/** Fields on tracker_data and related tables that are always business-scope. */
export const BUSINESS_SCOPE_FIELDS = [
  'revenue', 'food_cost', 'staff_cost', 'other_cost',
  'depreciation', 'financial', 'net_profit', 'margin_pct',
] as const
