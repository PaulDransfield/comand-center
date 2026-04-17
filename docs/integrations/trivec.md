# Trivec

## Identity
- **Name (local)**: Trivec
- **Category**: POS (Kassasystem)
- **Status**: in-progress — adapter skeleton exists (`lib/pos/trivec.ts`), unverified
- **Adapter path**: `lib/pos/trivec.ts`
- **Slug**: `trivec`
- **Logo URL**: https://trivecgroup.com

## API technical
- **Docs URL**: Not public — partner-gated. 3rd-party summary at https://apitracker.io/a/trivecgroup
- **Developer portal / sandbox URL**: Customer-side: https://mytrivec.com. Partner API access via Trivec partner program.
- **Base URL (prod)**: `https://api.trivec.com/v1` (from adapter comment, unconfirmed)
- **Auth type**: `api_key` via `Authorization: Bearer <key>` per adapter code
- **Credentials shape**: `{ api_key: string, unit_id: string }` — per-unit scoping
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: `both_fields` expected — adapter reads `net_sales` / `total_excl_vat`

## Data model — what we attempt
| Endpoint | Purpose | Notes |
|---|---|---|
| `/units/{unit_id}` | Unit metadata / connection test | Returns `name` |
| `/units/{unit_id}/reports/daily?from=X&to=Y` | Daily report | Fields: `date`, `lunch`/`lunch_covers`, `dinner`/`dinner_covers`, `takeaway`, `delivery`, `catering`, `other`, `net_sales`, `total_excl_vat` |

## Business / market
- **Sweden market share (rough)**: Large — 8,000+ customers across Sweden, Belgium, France, Norway, Denmark. Founded 1998. Acquired into Caspeco group.
- **Target segment**: Restaurants, bars, hotels — full spectrum including fine dining and large multi-site chains
- **Pricing**: Enterprise — contact sales. Not publicly listed.
- **Support email**: NEEDS RESEARCH (trivecgroup.com/contact)
- **Partnership status**: `official_partner` — formal partner network with integrations to accounting, staffing, loyalty, inventory, hotel, reservations

## Implementation notes
- **Known gotchas**:
  - **Unit ID required** — each restaurant is a "unit"; credentials are scoped per unit
  - **Caspeco relationship** — customers with Caspeco staffing often run Trivec POS. Same partnership route for API access.
  - **Multi-country** — operates in 5 countries; API behaviour may differ (VAT rates, currency)
- **How the customer obtains the key**: mytrivec.com → API section, or contact Trivec support if not self-serve
- **Skatteverket certified cash register**: Yes
- **Supports multi-site / chain**: Yes — each site has its own unit_id; multi-site customers register multiple integrations
- **API response language**: English field names (assumed)
- **Build estimate**: 3-5h to validate adapter against a real Trivec account

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17 (web research only, no API access)
- **Primary contact at provider**: — (contact Trivec partner team when we get first customer request)

## Sample API interaction
```bash
# Stub — from adapter code, unverified
curl -H "Authorization: Bearer $TRIVEC_KEY" \
     -H "Content-Type: application/json" \
     "https://api.trivec.com/v1/units/$UNIT_ID/reports/daily?from=2026-04-01&to=2026-04-30"
```

## Notes for future integration
- **Third-party aggregators** already integrate Trivec: Chift (chift.eu/tools/trivec), Apicbase, Inpulse, Flipdish — using a middleware is an option if direct access is difficult
- **Caspeco bundle** — customers with Caspeco staffing can often share a single credential. Ask during onboarding.
- Trivec's partner program is formal; expect a signed agreement before getting API docs.

## Sources
- [Trivec API tracker](https://apitracker.io/a/trivecgroup)
- [Trivec POS system](https://trivecgroup.com/)
- [Trivec integrations](https://trivecgroup.com/products/integrations/)
- [Chift Trivec integration](https://www.chift.eu/tools/trivec)
