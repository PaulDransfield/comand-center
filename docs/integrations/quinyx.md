# Quinyx

## Identity
- **Name (local)**: Quinyx
- **Category**: HR / Workforce management
- **Status**: in-progress — adapter stub at `lib/pos/quinyx.ts`
- **Adapter path**: `lib/pos/quinyx.ts`
- **Slug**: `quinyx`
- **Logo URL**: https://www.quinyx.com

## API technical
- **Docs URL**: Partner-gated; API tracker summary at https://apitracker.io/a/quinyx
- **Developer portal / sandbox URL**: Via Quinyx integration team
- **Base URL (prod)**: NEEDS RESEARCH
- **Auth type**: NEEDS RESEARCH (standard auth — likely OAuth2 or API key)
- **Credentials shape**: NEEDS RESEARCH
- **Rate limits**: NEEDS RESEARCH
- **Pagination**: NEEDS RESEARCH
- **Data format**: JSON
- **Webhooks supported**: NEEDS RESEARCH
- **Timezone handling**: UTC
- **VAT handling**: N/A (HR)

## Data model — what they likely expose
Per Quinyx positioning (workforce management):
- Employees / staff records
- Schedules (planned shifts)
- Time tracking (actual worked hours)
- Absences
- Labour forecasts / AI-generated schedules
- Integrations: most HR, payroll, POS, CRM, HCM, ERP systems

## Business / market
- **Sweden market share (rough)**: Large in enterprise — Quinyx is Swedish-origin, widely used by retail and hospitality chains. Many European/UK customers too.
- **Target segment**: Mid-to-large chains (restaurant groups, retail, cleaning, healthcare). Less common for single-restaurant SMBs.
- **Pricing**: Enterprise — contact sales
- **Support email**: Via Quinyx integration team
- **Partnership status**: `official_partner` — both REST and SOAP APIs, prebuilt connectors

## Implementation notes
- **Known gotchas**:
  - **SOAP legacy** — Quinyx has both REST (modern) and SOAP (legacy) APIs. Use REST.
  - **Scale** — Quinyx customers tend to have thousands of employees; expect pagination and batch operations
  - **Dedicated integration team** — Quinyx has a global integrations team that helps with setup. Use them.
- **How the customer obtains the key**: Via Quinyx integration team
- **Skatteverket certified cash register**: N/A
- **Supports multi-site / chain**: Yes — designed for enterprise/chain use
- **API response language**: English
- **Build estimate**: 5-8h once credentials obtained

## Ops tracking
- **Customer demand count**: 0
- **Last verified date**: 2026-04-17
- **Primary contact at provider**: Quinyx integration team

## Sample API interaction
NEEDS RESEARCH

## Notes for future integration
- **Competes with Personalkollen** — but Quinyx targets bigger customers. If a restaurant group is using Quinyx, they're not using PK. Mutually exclusive in practice.
- **Complements POS** — Quinyx gives us actual hours; we still need POS for revenue. Same pattern as PK.
- **Enterprise customers** first — not worth prioritising until we have a customer at the chain scale

## Sources
- [Quinyx main](https://www.quinyx.com/)
- [Quinyx API Tracker](https://apitracker.io/a/quinyx)
- [Quinyx integrations](https://www.quinyx.com/workforce-management/integrations)
- [Quinyx API specs](https://apitracker.io/a/quinyx/specifications)
