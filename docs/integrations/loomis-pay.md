# Loomis Pay

## Identity
- **Name (local)**: Loomis Pay
- **Category**: POS + Payments (all-in-one payment system with POS)
- **Status**: planned
- **Adapter path**: not yet
- **Slug**: `loomis-pay`
- **Logo URL**: https://loomispay.com

## API technical
- **Docs URL**: NEEDS RESEARCH — not public. Contact Loomis Pay directly.
- **Developer portal / sandbox URL**: NEEDS RESEARCH
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH (likely OAuth2 or API key for payment platforms)
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON (assumed)
- **Webhooks supported**: Likely yes — payment platforms typically push transaction events
- **Timezone handling**: NEEDS RESEARCH
- **VAT handling**: NEEDS RESEARCH

## Data model — what they likely expose
Inferred from the "complete end-to-end payment system" positioning:
- Transactions (cash, card, mobile — Loomis Pay handles all three channels)
- Settlements / batches
- Merchant accounts
- Devices / terminals

## Business / market
- **Sweden market share (rough)**: Growing — Loomis Pay is the newer fintech arm of Loomis AB (large cash-handling company). Focused on Sweden + Denmark since 2020.
- **Target segment**: Merchants, restaurants, shops that need unified cash + card + mobile. Appeals to cash-heavy businesses since Loomis has historical cash handling expertise.
- **Pricing**: Not public. Merchant-style pricing (transaction fees + monthly).
- **Support email**: NEEDS RESEARCH
- **Partnership status**: NEEDS RESEARCH — likely `closed_api`, partnership-gated
- **HQ**: Stockholm, operations in Sweden + Denmark

## Implementation notes
- **Known gotchas**:
  - Loomis Pay is a PAYMENT platform with POS capability — integrating it is different from integrating a POS. We care about transaction data and settlement info.
  - Multi-channel (cash + card + mobile) means transaction attribution matters
- **How the customer obtains the key**: NEEDS RESEARCH
- **Skatteverket certified cash register**: Yes (required for SE merchants)
- **Supports multi-site / chain**: Yes — enterprise-leaning
- **API response language**: NEEDS RESEARCH
- **Build estimate**: 6-10h (payment platform APIs tend to be more complex)

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17 (web research only)
- **Primary contact at provider**: —

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- Consider whether Loomis Pay customers also use a separate POS brand — if yes, integrate the POS, not Loomis Pay. If Loomis Pay IS their POS, then go direct.
- Tech stack (Vue.js, Kotlin, ASP.NET) suggests a mature engineering org; partnership API likely exists even if not public.
- Good segue: for cash-heavy restaurants not covered by Swish/cards-only POS

## Sources
- [Loomis Pay EU-Startups](https://www.eu-startups.com/directory/loomis-pay/)
- [Loomis Pay at The Org](https://theorg.com/org/loomis-pay)
- [Loomis Sweden](https://se.loomis.com/en-se/)
