# Personalkollen

## Identity
- **Name (local)**: Personalkollen
- **Category**: HR & staffing (personalliggare, scheduling, time tracking)
- **Status**: built
- **Adapter path**: `lib/pos/personalkollen.ts` · `lib/api-discovery/personalkollen.ts`
- **Slug**: `personalkollen`
- **Logo URL**: https://personalkollen.se/

## API technical
- **Docs URL**: No public docs — API is partner-accessible via tokens provisioned by PK support
- **Developer portal / sandbox URL**: None public; ask support
- **Base URL (prod)**: `https://personalkollen.se/api`
- **Auth type**: `api_key` — passed as `Authorization: Token <api_key>` header
- **Credentials shape**: `{ api_key: string }`
- **Rate limits**: Not publicly documented; haven't observed throttling in practice
- **Pagination**: `page+size` — uses `?page_size=N` query; responses contain `results[]`, `count`, `next`, `previous`
- **Data format**: JSON
- **Webhooks supported**: Unknown / not used
- **Timezone handling**: Timestamps in local Europe/Stockholm time, ISO-8601 without offset; we normalise to CET/CEST
- **VAT handling**: **Excludes VAT** (ex moms) for sales endpoint — confirmed during 2026-04-17 investigation where our raw totals were VAT-inclusive but PK dashboard shows ex-moms. We strip 12% VAT for food sales to match

## Data model — what they expose
| Endpoint | Purpose | Key fields we use |
|---|---|---|
| `/staffs/` | Staff roster | `url`, `first_name`, `last_name`, `email`, `short_identifier` |
| `/workplaces/` | Locations / businesses | `description`, `short_identifier`, `url`, `pos_provider`, `pos_status` |
| `/logged-times/` | Actual shifts worked | `start`, `stop`, `duration`, `staff`, `workplace`, `cost_actual`, `cost_estimated`, `ob_supplement_kr`, `ob_type`, `break_seconds`, `is_late`, `late_minutes` |
| `/work-periods/` | Scheduled shifts | `start`, `stop`, `staff`, `workplace` |
| `/sales/` | POS sales pulled through PK | `sale_time`, `uid`, `workplace`, `payments[]`, `number_of_guests`, `is_take_away`, `total` |
| `/cost-groups/` | Departments | `description`, `url` |
| `/absences/` | Sick leave / time off | `start`, `stop`, `type`, `staff` |

Date filtering uses `sale_time__gte` / `sale_time__lte` on `/sales/`, `start__gte` / `start__lte` on `/logged-times/`.

## Business / market
- **Sweden market share (rough)**: Dominant for restaurant **personalliggare** (Skatteverket-mandated staff presence log). Used by thousands of Swedish restaurants.
- **Target segment**: Restaurants, cafés, bars — small to mid-size chains. Serves as both staff scheduling and the tax-compliance log.
- **Pricing**: Per-workplace + per-user tiers (~300–500 kr/mo/workplace — confirm current pricing with PK)
- **Support email**: support@personalkollen.se
- **Partnership status**: `open_api_unofficial` — API exists and is reliable, but no public docs. Customers generate tokens in their dashboard.

## Implementation notes
- **Known gotchas**:
  - **VAT**: raw `/sales/` totals include VAT; PK dashboard shows ex-moms. Strip 12% for food (25% for alcohol) when reporting to match PK UI. See FIXES.md entry from 2026-04-17.
  - **Scheduled vs actual**: `pk_log_url` suffix `_scheduled` = planned shifts (future). We filter these out of cost aggregations — only logged-times count toward staff_cost.
  - **POS passthrough**: PK can ingest POS data from Inzii/Swess under `/sales/` with `pos_provider` indicating source. If a customer has both PK and Inzii, we dedupe (prefer Inzii direct, skip PK-aggregate). See `lib/sync/aggregate.ts`.
  - **Pagination**: default page size is small (~20). Use `page_size=100` and follow `next` links.
- **How the customer obtains the key**: PK customer portal → Inställningar → API → generate token
- **Skatteverket certified cash register**: N/A (PK is staffing, not a POS)
- **Supports multi-site / chain**: Yes — one token scopes to the org, workplaces returned in `/workplaces/`
- **API response language**: Swedish field values, English field names (mixed)
- **Build estimate**: Built — ~6 hours historical

## Ops tracking
- **Customer demand count**: 1 (vero italia ab + rosali deli)
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: —
- **Related issues**: FIXES.md → "Inzii/Swess Covers" + VAT fixes

## Sample API interaction
```bash
# List sales for a date range
curl -H "Authorization: Token $PK_TOKEN" \
  "https://personalkollen.se/api/sales/?sale_time__gte=2026-04-01&sale_time__lte=2026-04-30&page_size=100"

# List shifts worked
curl -H "Authorization: Token $PK_TOKEN" \
  "https://personalkollen.se/api/logged-times/?start__gte=2026-04-01&start__lte=2026-04-30&page_size=100"
```

## Notes for future integration
- PK is the strongest data source we have — it covers both staff AND POS (via passthrough). When a restaurant has PK, we can almost always get what we need without a separate POS integration.
- The `pos_provider` field on `/workplaces/` tells us what POS they use — useful for onboarding wizard to pre-fill provider dropdown.
- PK's own `/sales/` passthrough sometimes has different totals than the POS direct API — we've seen Inzii direct vs PK-passthrough diverge by ~1% (rounding / payment-method grouping). Treat direct POS as authoritative.
