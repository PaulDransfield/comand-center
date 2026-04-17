# Wolt

## Identity
- **Name (local)**: Wolt (Finnish-origin, acquired by DoorDash)
- **Category**: Delivery platform
- **Status**: in-progress — adapter stub at `lib/pos/wolt.ts`
- **Adapter path**: `lib/pos/wolt.ts`
- **Slug**: `wolt`
- **Logo URL**: https://wolt.com

## API technical
- **Docs URL**: https://developer.wolt.com/docs
- **Developer portal / sandbox URL**: https://developer.wolt.com/
- **Base URL (prod)**: Per docs (Marketplace API)
- **Auth type**: `oauth2` — Bearer token via OAuth 2.0 flow
- **Credentials shape**: `{ client_id: string, client_secret: string, access_token: string }`
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: Standard REST
- **Data format**: JSON
- **Webhooks supported**: Yes — Wolt Drive webhook service documented
- **Timezone handling**: UTC / ISO-8601
- **VAT handling**: `both_fields`

## Data model — APIs available
| API | Purpose |
|---|---|
| Order API | Retrieve order details, send to POS/KDS |
| Menu API | Push/pull menus between POS and Wolt |
| Venue API | Manage venue availability + info |
| Wolt Drive API | Third-party delivery using Wolt's courier network (even for non-marketplace orders) |

Integration types:
- **SSIO** (Self-Service Integration Onboarding) — partner self-onboards
- **WIO** (Wolt-led Integration Onboarding) — Wolt guides implementation

## Business / market
- **Sweden market share**: Large — Wolt competes directly with Foodora in Nordic + Baltic. Dominant in Helsinki/Stockholm urban markets.
- **Target segment**: Any restaurant offering delivery; also non-restaurant (grocery, retail) via Retail API
- **Pricing**: Commission per order (typically 20-30%) + onboarding fees. Wolt Drive standalone is per-delivery.
- **Support email**: Via Wolt account manager
- **Partnership status**: `official_partner` — formal integration partner program
- **Parent**: DoorDash (acquired 2022)

## Implementation notes
- **Known gotchas**:
  - **Menu API is bidirectional** — POS can push menus to Wolt; changes from Wolt side can be pulled. Conflict handling matters.
  - **Venue availability** — Wolt venues can be temporarily closed via API; restaurant staff use this daily
  - **Wolt Drive vs Marketplace** — separate products. Wolt Drive lets restaurants use Wolt couriers for their OWN orders (direct ordering sites) without listing on Wolt marketplace.
  - **Integration onboarding** is a formal process with Wolt account manager
- **How the customer obtains the key**: Via Wolt account manager — not self-serve
- **Skatteverket certified cash register**: N/A
- **Supports multi-site / chain**: Yes
- **API response language**: English
- **Build estimate**: 4-8h (stub exists, documented)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: Wolt account manager / Technical account manager

## Sample API interaction
```bash
# Bearer token auth via OAuth 2.0
curl -H "Authorization: Bearer $TOKEN" \
  "https://.../orders?venue_id=$VENUE_ID&from=2026-04-01"
```

## Notes for future integration
- **Among the best-documented** delivery platforms. Developer portal is actively maintained.
- **Integration partners listed** at developer.wolt.com/integration-partners — we can see who else has built integrations (Qopla, Mergeport, others)
- **Wolt Drive is a separate value prop** — could be a revenue-generating recommendation for our customers: "we notice most of your delivery is self-pickup — try Wolt Drive for courier coverage"

## Sources
- [Wolt Developer docs](https://developer.wolt.com/docs/api/order)
- [Wolt getting started for restaurants](https://developer.wolt.com/docs/getting-started/restaurant)
- [Wolt Drive overview](https://developer.wolt.com/docs/wolt-drive)
- [Wolt integration partners](https://developer.wolt.com/integration-partners)
