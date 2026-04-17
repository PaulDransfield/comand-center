# TheFork (Manager)

## Identity
- **Name (local)**: TheFork / TheFork Manager (owned by TripAdvisor; was LaFourchette)
- **Category**: Reservations (Bordsbokning)
- **Status**: in-progress — adapter stub at `lib/pos/thefork.ts`, unverified
- **Adapter path**: `lib/pos/thefork.ts`
- **Slug**: `thefork`
- **Logo URL**: https://www.thefork.com

## API technical
- **Docs URL**: https://docs.thefork.io/
- **Developer portal / sandbox URL**: https://docs.thefork.io/getting-started
- **Base URL (prod)**: Per docs — B2B API at `/B2B-API/`
- **Auth type**: `oauth2` — client_id + client_secret → Bearer token (per existing adapter stub)
- **Credentials shape**: `{ client_id: string, client_secret: string }`
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: Standard REST pagination
- **Data format**: JSON, OpenAPI 3 spec
- **Webhooks supported**: Likely (mature platform)
- **Timezone handling**: UTC / ISO-8601
- **VAT handling**: N/A (reservations)

## Data model — per docs
Documented endpoints include:
| Endpoint | Purpose |
|---|---|
| `POST /v1/restaurants/{id}/reservations` | Create a reservation |
| `GET /v1/restaurants/{id}/reservations` | List reservations |
| `GET /v1/restaurants/{id}` | Restaurant info |
| Preset menus | Read curated menus/offers |

## Business / market
- **Sweden market share (rough)**: Medium — TheFork is strong in international / tourist-dense cities (Stockholm). Less dominant than WaiterAid in local high-end but common alongside it.
- **Target segment**: Mid-to-high end restaurants, especially those wanting international guest acquisition
- **Pricing**: Per-reservation commission + monthly subscription; not publicly listed
- **Support email**: Via TheFork developer portal
- **Partnership status**: `official_partner` — formal B2B API with OpenAPI docs

## Implementation notes
- **Known gotchas**:
  - **TripAdvisor ownership** — data governance affected by their parent policies
  - **Commission model** — TheFork charges per booking; may affect how customers want us to treat these reservations for analytics
  - **OpenAPI 3 spec** — can auto-generate client SDK from their spec if needed
- **How the customer obtains the key**: Register app on TheFork developer portal, OAuth flow for customer linking
- **Skatteverket certified cash register**: N/A
- **Supports multi-site / chain**: Yes (restaurant groups)
- **API response language**: English
- **Build estimate**: 4-6h (stub exists, clear docs)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: TheFork developer relations

## Sample API interaction
```bash
# Create reservation (pattern from docs)
curl -X POST https://docs.thefork.io/B2B-API/.../restaurants/{id}/reservations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"meal_date":"2026-04-20","party_size":4,"customer":{...}}'
```

## Notes for future integration
- **Among the best-documented** of Swedish-usable reservations APIs
- **Complementary to WaiterAid** — customers may use both (WaiterAid for local, TheFork for international discovery)
- **Engineering blog** at medium.com/thefork has useful technical context

## Sources
- [TheFork Developers Portal](https://docs.thefork.io/)
- [Getting started](https://docs.thefork.io/getting-started)
- [Booking flow API](https://docs.thefork.io/B2B-API/API%20specifications/post-v-1-restaurants-id-reservations)
- [TheFork API Tracker](https://apitracker.io/a/thefork)
