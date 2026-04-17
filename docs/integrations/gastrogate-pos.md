# Gastrogate (POS)

## Identity
- **Name (local)**: Gastrogate — LOCO platform (POS + order management + restaurant management)
- **Category**: POS (Kassasystem) — also has reservations (separate file: [gastrogate-reservations.md](./gastrogate-reservations.md))
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `gastrogate-pos`
- **Logo URL**: https://www.gastrogate.io

## API technical
- **Docs URL**: NEEDS RESEARCH — not public
- **Developer portal / sandbox URL**: NEEDS RESEARCH — contact Gastrogate directly
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH (likely API key or OAuth — modern platform)
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they likely expose
Based on LOCO positioning (unified POS + order management + restaurant management):
- Orders / sales
- Menu / products
- Tables / reservations
- Staff

## Business / market
- **Sweden market share (rough)**: Medium — Gastrogate is trusted by 500+ restaurants in their own stats
- **Target segment**: Restaurants seeking unified platform (POS + order + reservations in one). Appeals to smaller chains who want one vendor.
- **Pricing**: Not public
- **Support email**: via gastrogate.io
- **Partnership status**: NEEDS RESEARCH — likely partnership-gated

## Implementation notes
- **Known gotchas**:
  - **Dual product surface** — Gastrogate is BOTH a POS and a reservations system. Customers may use one, the other, or both. Check which during onboarding.
  - **LOCO is the platform name** — customers may know their product as "LOCO" rather than "Gastrogate"
- **How the customer obtains the key**: NEEDS RESEARCH
- **Skatteverket certified cash register**: Yes (POS side)
- **Supports multi-site / chain**: Yes
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 5-8h once docs obtained

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- **Unified platform efficiency** — if we build Gastrogate POS integration, we can often add reservations from the same credentials (same vendor, same tenant)
- **Mid-size sweet spot** — target segment overlaps with our ideal customer (restaurant groups)

## Sources
- [Gastrogate (LOCO)](https://www.gastrogate.io/)
