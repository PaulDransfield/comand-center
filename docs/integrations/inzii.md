# Inzii (Swess)

## Identity
- **Name (local)**: Inzii — rebranded from Swess
- **Category**: POS (Kassasystem)
- **Status**: in-progress — adapter built, API endpoint not yet confirmed
- **Status reason**: We store credentials per department and call `api.swess.se`, but the correct path is not yet verified — we've probed 30 candidate paths and all return 429 or auth errors. Awaiting either Swess docs or whitelist for higher rate limits.
- **Adapter path**: `lib/pos/inzii.ts`
- **Slug**: `inzii`
- **Logo URL**: https://inzii.se

## API technical
- **Docs URL**: Not publicly available — partnership required
- **Developer portal / sandbox URL**: None public
- **Base URL (prod)**: `https://api.swess.se` (confirmed live — Varnish cache fronting it)
- **Auth type**: `api_key` — specific header / param pattern unknown (we've tried `api_key=`, `token=`, `Authorization: Bearer`, `x-api-key`)
- **Credentials shape**: `{ api_key: string }` stored per department (6 departments × 1 key each for Vero Italiano)
- **Rate limits**: Aggressive — Varnish returns 429 after ~10 requests in rapid succession. Back off + 2-second delay between requests works in probes.
- **Pagination**: Unknown
- **Data format**: JSON (likely)
- **Webhooks supported**: Unknown
- **Timezone handling**: Unknown
- **VAT handling**: Unknown — but their UI appears to show inkl-moms, we'd need to confirm API values

## Data model — what they expose
Unknown. Typical POS endpoints we expect: sales, receipts, z-reports, products, employees.

## Business / market
- **Sweden market share (rough)**: Small — specialist restaurant POS. Vero Italiano uses it across 6 concept departments (Bella, Brus, Carne, Chilango, Ölbaren, Rosalis Select).
- **Target segment**: Multi-concept restaurants and larger bars where one location runs several kitchens / bars
- **Pricing**: Contact sales (not public)
- **Support email**: support@swess.se / support@inzii.se
- **Partnership status**: `closed_api` — opens with partnership agreement

## Implementation notes
- **Known gotchas**:
  - **Multi-department**: Inzii uses **one API key per department**, not one per restaurant. Our adapter stores each as a separate `integrations` row with `provider=inzii`, `department=<name>` (Bella, Brus, etc.). The sync engine iterates all Inzii rows for a business and aggregates.
  - **Same API as Swess**: "Inzii" is the rebrand; the API domain is still `api.swess.se`. The adapter key in our registry is `inzii` but Swess customers get the same flow.
  - **Rate limiting**: the probe-inzii route implements 2-second delays between requests. When doing live adapter work, keep this in mind.
- **How the customer obtains the key**: Each department's key is generated in Personalkollen under "Kassaleverantör" for the corresponding workplace. PK brokered the integration — customers don't see the raw Inzii dashboard.
- **Skatteverket certified cash register**: Yes (required for Swedish POS)
- **Supports multi-site / chain**: One key per department, no chain-level master key
- **API response language**: Unknown — probably Swedish field names
- **Build estimate**: Unknown — depends on docs access. Probe work so far: ~4h. Remaining: 4-8h once docs obtained.

## Ops tracking
- **Customer demand count**: 1 (Vero Italiano, 6 departments)
- **Last verified date**: 2026-04-17 (probes still return 429)
- **Primary contact at provider**: Unknown — need to reach out via Swess support
- **Related issues**: ROADMAP.md "Inzii API endpoint unknown"

## Sample API interaction
```bash
# Probe pattern from our test tooling — not confirmed working yet
curl -H "Accept: application/json" \
  "https://api.swess.se/api/v1/sales?api_key=$KEY&from=2026-04-01&to=2026-04-30"
```

See `app/api/admin/probe-inzii/route.ts` for the 30-candidate probe sweep.

## Notes for future integration
- **First step**: reach out to Swess/Inzii support for API documentation. Our partnership request hasn't produced docs yet.
- **Fallback**: scrape the Inzii merchant web dashboard. Legally grey. Not recommended unless customer explicitly approves and we have their login credentials.
- **Alternative**: use PK's `/sales/` passthrough for this customer — PK already ingests Inzii data under the workplace POS fields. Revenue totals match but we lose per-department breakdown (PK aggregates to workplace level).
- **Rebranding**: "Inzii" is the new brand (~2024). Materials/contracts may still say "Swess" — same product, same API.
