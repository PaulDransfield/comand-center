# Bokad

## Identity
- **Name (local)**: Bokad (bokad.se)
- **Category**: Reservations (Bordsbokning)
- **Status**: in-progress — adapter stub at `lib/pos/bokad.ts`
- **Adapter path**: `lib/pos/bokad.ts`
- **Slug**: `bokad`
- **Logo URL**: https://bokad.se

## API technical
- **Docs URL**: NEEDS RESEARCH — not in top search results
- **Developer portal / sandbox URL**: Contact bokad.se for API access
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: NEEDS RESEARCH
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: N/A (reservations)

## Data model — what they likely expose
- Bookings / reservations
- Availability
- Guest data
- Restaurant info

## Business / market
- **Sweden market share (rough)**: Small — niche Swedish reservation system
- **Target segment**: NEEDS RESEARCH (likely mid-size restaurants)
- **Pricing**: NEEDS RESEARCH
- **Support email**: NEEDS RESEARCH (contact via bokad.se)
- **Partnership status**: `closed_api` probably — partnership-required

## Implementation notes
- **Known gotchas**: Adapter is a stub, hasn't been verified against real credentials
- **How the customer obtains the key**: NEEDS RESEARCH
- **Skatteverket certified cash register**: N/A
- **Supports multi-site / chain**: NEEDS RESEARCH
- **API response language**: Likely Swedish
- **Build estimate**: 6-10h including partnership setup

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: —

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- Not in Paul's 54-provider list originally — adapter stub exists from earlier scaffolding work
- If not seeing customer demand, deprioritise
- Consider consolidating Swedish reservation coverage around WaiterAid (big market share, public docs) rather than Bokad

## Sources
- NEEDS RESEARCH — direct search didn't surface documentation
