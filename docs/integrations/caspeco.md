# Caspeco

## Identity
- **Name (local)**: Caspeco
- **Category**: POS (parent company also owns Trivec)
- **Status**: in-progress — adapter skeleton written for staffing side; POS endpoints not validated
- **Adapter path**: `lib/pos/caspeco.ts`
- **Slug**: `caspeco`
- **Logo URL**: https://caspeco.com

## API technical
- **Docs URL**: NEEDS RESEARCH (partner-only per Caspeco's developer page)
- **Developer portal / sandbox URL**: NEEDS RESEARCH
- **Base URL (prod)**: `https://api.caspeco.se/v1` (assumed)
- **Auth type**: `api_key` passed as `Authorization: Bearer <key>` per adapter comments
- **Credentials shape**: `{ api_key: string }`
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what we attempt
| Endpoint | Purpose | Notes |
|---|---|---|
| Employees list | Staff roster | Maps `employee_id`, `name`, `email` |
| Shifts list | Worked shifts | Maps `date`, `start`, `end`, `employee_id`, `department` |

Our adapter focuses on **staff/shifts** (labour cost), not POS sales. For POS, see [Trivec](./trivec.md) — same parent company, slightly different API.

## Business / market
- **Sweden market share (rough)**: Large in hospitality — Caspeco is a major Swedish restaurant/staffing tech group
- **Target segment**: Restaurants, hotels, bars — often bundled with Trivec POS
- **Pricing**: NEEDS RESEARCH (enterprise pricing, contact sales)
- **Support email**: NEEDS RESEARCH
- **Partnership status**: `closed_api` — partnership / customer-approval required
- **Relationship to Trivec**: Caspeco acquired Trivec; they're marketed together. Most customers with Trivec POS use Caspeco staffing too.

## Implementation notes
- **Known gotchas**:
  - We use `pk_log_url: caspeco-<shift_id>` as the dedup key in staff_logs so Caspeco shifts don't collide with PK shifts if both are connected
  - Cost field: `cost_actual` when payroll approved, falls back to `estimated_salary`
- **How the customer obtains the key**: NEEDS RESEARCH — probably Caspeco customer portal
- **Skatteverket certified cash register**: N/A (staffing side). Yes for Trivec side.
- **Supports multi-site / chain**: Yes — Caspeco is enterprise-leaning and supports multi-unit operators
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 4-6h once we have credentials + docs

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: —
- **Primary contact at provider**: —

## Sample API interaction
```bash
# Stub — unverified
curl -H "Authorization: Bearer $KEY" "https://api.caspeco.se/v1/shifts?from=2026-04-01&to=2026-04-30"
```

## Notes for future integration
- If a customer has **both** Caspeco and PK, deduplicate shifts — PK often mirrors Caspeco. Our aggregate.ts already handles dedup for revenue; staff dedup is simpler since each shift has a unique ID per provider.
- Caspeco also has a reservation-style booking module for larger venues — out of scope for initial adapter
