# Superb (POS / Experience Platform)

## Identity
- **Name (local)**: Superb Experience
- **Category**: POS + CRM + reservations (unified "restaurant experience platform")
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `superb-pos`
- **Logo URL**: https://www.superbexperience.com

## API technical
- **Docs URL**: NEEDS RESEARCH — no public developer docs surfaced in searches
- **Developer portal / sandbox URL**: NEEDS RESEARCH — contact Superb directly
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH — likely OAuth2 (modern platform)
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed)
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they likely expose
Based on positioning (restaurant experience platform combining POS, reservations, CRM):
- Sales / orders
- Reservations
- Guests (CRM profiles with visit history, preferences)
- Menu / products
- Marketing automations

## Business / market
- **Sweden market share (rough)**: Growing — Danish/Swedish origin, popular in higher-end European restaurants
- **Target segment**: Fine dining, high-end casual, experience-focused venues. Strong in Nordic + parts of Europe.
- **Pricing**: Not public — enterprise SaaS pricing
- **Support email**: via superbexperience.com contact
- **Partnership status**: NEEDS RESEARCH — likely partnership-gated

## Implementation notes
- **Known gotchas**:
  - **"Superb" disambiguation** — there's Superb Experience (restaurant platform, what we mean) and other products also called Superb. Use superbexperience.com as canonical.
  - **Dual product surface** — POS AND reservations separately; same credentials likely cover both
- **How the customer obtains the key**: NEEDS RESEARCH — likely partner-brokered
- **Skatteverket certified cash register**: Yes (POS side, for Swedish market)
- **Supports multi-site / chain**: Yes (platform designed for groups)
- **API response language**: NEEDS RESEARCH (likely English)
- **Build estimate**: 6-10h

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: —

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- **High-value integration** — Superb's target segment overlaps with premium customers
- **Guest CRM data** is unique value — few other Swedish POS expose rich guest profiles
- **Reservations + POS bundle** — if we build this, consolidates two integrations into one

## Sources
- [Superb Experience main](https://www.superbexperience.com/)
- [Top restaurant management systems (Superb blog)](https://www.superbexperience.com/experience-matters/top-restaurant-management-systems)
