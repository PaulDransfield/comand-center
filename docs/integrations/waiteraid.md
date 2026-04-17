# Waiteraid

## Identity
- **Name (local)**: WaiterAid
- **Category**: Reservations (Bordsbokning)
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `waiteraid`
- **Logo URL**: https://waiteraid.com

## API technical
- **Docs URL**: https://app.waiteraid.com/api-docs/index.html
- **Developer portal / sandbox URL**: Same as docs
- **Base URL (prod)**: `https://app.waiteraid.com` (based on doc path)
- **Auth type**: `api_key` (auth_hash param) OR basic username/password in request params — flexible
- **Credentials shape**: `{ auth_hash: string }` or `{ username: string, password: string }`
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: Europe/Stockholm (restaurant-local)
- **VAT handling**: N/A (reservations, not sales)

## Data model — what they expose
Per docs:
- **Bookings** — create, read, cancel with guest info (name, email, phone), party size, date/time, special requests
- **Widget reservations API** — for embedding in customer-facing sites
- **Tables / availability** — read table availability
- **Menu** — some menu integration
- **Sales metrics** — WaiterAid exposes some sales data
- **Customer data** — reservation history per guest
- **Staff schedules** — limited

## Business / market
- **Sweden market share (rough)**: Dominant among **high-profile / fine dining** Swedish restaurants. Also international (Germany, Canada).
- **Target segment**: Fine dining, mid-to-high end casual, restaurants with active reservations model
- **Pricing**: NEEDS RESEARCH (per-restaurant subscription, contact sales)
- **Support email**: support@waiteraid.com (standard)
- **Partnership status**: `open_api_unofficial` — public API docs at app.waiteraid.com/api-docs — strong sign they're integration-friendly
- **BokaBord connection**: WaiterAid powers BokaBord.se (Stockholm reservations portal, ~500k diners/year)

## Implementation notes
- **Known gotchas**:
  - **API docs publicly visible** at app.waiteraid.com/api-docs — rare for Swedish restaurant tech, strong positive signal
  - **Auth flexibility** — either auth_hash or username/password. Use auth_hash for stability.
  - **Used by scraping tools** — there's a GitHub bot (lukas-hen/waiteraid-booking-tool) that automates booking via their API; confirms API is accessible
- **How the customer obtains the key**: Customer generates auth_hash in their WaiterAid admin portal (assumed — NEEDS RESEARCH for exact path)
- **Skatteverket certified cash register**: N/A (reservations)
- **Supports multi-site / chain**: Yes
- **API response language**: English field names (per docs format)
- **Build estimate**: 3-5h (public docs, simple auth)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: via website

## Sample API interaction
```bash
# Create reservation (pattern from docs/third-party references)
curl -X POST "https://app.waiteraid.com/api/..." \
  -d "auth_hash=$HASH" \
  -d "date=2026-04-20&time=19:00&guests=4&name=Test"
```

## Notes for future integration
- **Good candidate for an early reservations integration** — public API, well-documented, big in high-end segment that aligns with our target customers
- **Covers data** — if reservation count matters for scheduling analysis, WaiterAid's data directly answers "how many covers tomorrow" questions
- **Airbyte connector exists** for ETL use cases — confirms API is usable for external data sync

## Sources
- [WaiterAid API docs](https://app.waiteraid.com/api-docs/index.html)
- [WaiterAid main](https://waiteraid.com/)
- [WaiterAid API overview on FoodFriends](https://old.foodfriends.com/blog/waiteraid-api/)
- [WaiterAid integrations (API Tracker)](https://apitracker.io/a/waiteraid/integrations)
