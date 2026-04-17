# Ancon

## Identity
- **Name (local)**: Ancon
- **Category**: POS (Kassasystem)
- **Status**: in-progress — adapter skeleton written, endpoints not yet validated against a real Ancon account
- **Status reason**: We have a scaffolded adapter using guessed REST paths; no customer has connected an Ancon key yet so we can't verify.
- **Adapter path**: `lib/pos/ancon.ts`
- **Slug**: `ancon`
- **Logo URL**: https://ancon.se

## API technical
- **Docs URL**: NEEDS RESEARCH — not public as of last check
- **Developer portal / sandbox URL**: NEEDS RESEARCH
- **Base URL (prod)**: `https://api.ancon.se/v1` (assumed by adapter — unconfirmed)
- **Auth type**: `api_key` (assumed) — adapter sends `X-API-Key` header
- **Credentials shape**: `{ api_key: string }`
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH — adapter doesn't paginate
- **Data format**: JSON (assumed)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH — adapter picks up `s.vat` if present

## Data model — what we attempt
Based on adapter code, we try these endpoint patterns — none confirmed:
| Endpoint | Purpose | Notes |
|---|---|---|
| `/sales?from=X&to=Y` | Sales list | Response accessor fallback: `data`, `sales`, `data.sales` |
| `/reports/daily?from=X&to=Y` | Daily aggregate | Fields: `total_revenue`, `covers`, `transactions`, `food_revenue`, `bev_revenue` |
| `/health` | Connection test | Fallback to `/sales` with today's range |

## Business / market
- **Sweden market share (rough)**: Small-medium — Ancon is a niche Swedish restaurant POS
- **Target segment**: NEEDS RESEARCH — likely casual restaurants and bars
- **Pricing**: NEEDS RESEARCH
- **Support email**: NEEDS RESEARCH
- **Partnership status**: NEEDS RESEARCH — likely `closed_api` or partnership-gated

## Implementation notes
- **Known gotchas**: Adapter is stub-level — field accessors try multiple common names (`total`/`amount`/`revenue`) because the actual response shape is unverified
- **How the customer obtains the key**: NEEDS RESEARCH
- **Skatteverket certified cash register**: Likely yes (required for SE POS)
- **Supports multi-site / chain**: NEEDS RESEARCH
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 2-4h to verify once we have a real customer + docs

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: —
- **Primary contact at provider**: —

## Sample API interaction
```bash
# Stub — unverified
curl -H "X-API-Key: $KEY" "https://api.ancon.se/v1/sales?from=2026-04-01&to=2026-04-30"
```

## Notes for future integration
- First validate assumed base URL / auth header — may be completely different
- Ask first Ancon customer to share their Ancon support contact so we can get partner docs
