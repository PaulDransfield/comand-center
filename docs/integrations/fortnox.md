# Fortnox

## Identity
- **Name (local)**: Fortnox
- **Category**: Accounting (bokföring)
- **Status**: blocked — OAuth developer approval pending
- **Status reason**: We've applied for Fortnox's partner program; waiting on access approval. Code path exists but cannot authenticate.
- **Adapter path**: `lib/sync/engine.ts → syncFortnox` · `lib/api-discovery/fortnox.ts`
- **Slug**: `fortnox`
- **Logo URL**: https://www.fortnox.se

## API technical
- **Docs URL**: https://developer.fortnox.se/documentation/
- **Developer portal / sandbox URL**: https://developer.fortnox.se/
- **Base URL (prod)**: `https://api.fortnox.se/3/`
- **Auth type**: `oauth2` (as of Fortnox 3.0 API; legacy API used static access tokens — sunset)
- **Credentials shape**: `{ access_token: string, refresh_token: string, expires_at: ISO }`
- **Rate limits**: 200 requests/minute per client (per Fortnox docs as of 2024)
- **Pagination**: `page+size` — `?page=N&limit=100` max 100
- **Data format**: JSON (legacy XML deprecated)
- **Webhooks supported**: Limited — some event types via partner integration
- **Timezone handling**: ISO-8601 UTC; invoices have date only (no time component)
- **VAT handling**: `both_fields` — invoice lines expose `Price`, `VAT`, and `Total` separately; we can compute ex/inkl either way

## Data model — what they expose
| Endpoint | Purpose | Key fields |
|---|---|---|
| `/3/invoices` | Customer invoices (revenue) | `InvoiceNumber`, `InvoiceDate`, `CustomerNumber`, `Total`, `TotalVAT`, `Currency` |
| `/3/suppliers` | Suppliers | `SupplierNumber`, `Name`, `OrganisationNumber` |
| `/3/supplierinvoices` | Supplier invoices (costs) | `GivenNumber`, `InvoiceDate`, `SupplierNumber`, `Total`, `VAT`, `Deductions` |
| `/3/vouchers` | Bookkeeping vouchers | `VoucherNumber`, `VoucherSeries`, `TransactionDate`, `VoucherRows[]` (Account, Debit, Credit) |
| `/3/accounts` | Chart of accounts | `Number`, `Description` — use for grouping (4xxx = food/goods, 5xxx = premises, 7xxx = staff) |
| `/3/customers` | Customers | `CustomerNumber`, `Name`, `OrganisationNumber` |

## Business / market
- **Sweden market share (rough)**: Dominant — Fortnox is the largest Swedish accounting SaaS (~400k+ SMB users). Nearly universal among restaurant operators.
- **Target segment**: All SMBs including restaurants; accountants often the primary user
- **Pricing**: From ~149 kr/mo (Fakturering) up to Fortnox Komplett ~599 kr/mo. API access is via free developer program after approval.
- **Support email**: support@fortnox.se
- **Partnership status**: `official_partner` (once approved) — Fortnox's partner program gates API access
- **Developer contact**: partner@fortnox.se

## Implementation notes
- **Known gotchas**:
  - **OAuth approval is slow** — can take weeks. We applied 2026 Q1, still pending.
  - **Account classification** — 4xxx/5xxx/7xxx conventions work for most but some businesses use non-standard chart of accounts. Map per customer on onboarding.
  - **Voucher-based revenue** can double-count with invoice-based revenue — pick one view
  - **Currency** — almost always SEK but Fortnox supports multi-currency; check `Currency` field
- **How the customer obtains the key**: We redirect them through OAuth at `https://apps.fortnox.se/oauth-v1/auth` with our `client_id` and scopes (`invoice`, `supplierinvoice`, `voucher`, `companyinformation`). They authenticate in Fortnox, approve scopes, get redirected back with an authorization code → we exchange for refresh_token.
- **OAuth redirect URI we register**: `https://comandcenter.se/api/integrations/fortnox/callback`
- **Required OAuth scopes**: `invoice`, `supplierinvoice`, `voucher`, `companyinformation`, `customer`, `supplier`, `settings`
- **Skatteverket certified cash register**: N/A (accounting)
- **Supports multi-site / chain**: One Fortnox account per legal entity. Chains with one org-nr share one Fortnox; chains with separate legal entities need separate OAuth per entity.
- **API response language**: English field names, Swedish-friendly values
- **Build estimate**: Remaining: ~3h to wire OAuth callback + complete adapter once approved

## Ops tracking
- **Customer demand count**: 0 (all customers on trial still)
- **Last verified date**: Not yet — pending OAuth approval
- **Primary contact at provider**: Fortnox partner team (applied via developer portal)
- **Related issues**: ROADMAP.md "Fortnox OAuth approval pending"

## Sample API interaction
```bash
# List invoices in a date range (requires valid access_token)
curl -H "Authorization: Bearer $FORTNOX_ACCESS_TOKEN" \
     -H "Client-Secret: $FORTNOX_CLIENT_SECRET" \
     -H "Accept: application/json" \
     "https://api.fortnox.se/3/invoices?fromdate=2026-04-01&todate=2026-04-30&limit=100"
```

## Notes for future integration
- Unlocks: supplier price creep agent, full P&L automation, removes need for manual tracker_data entries
- Competes with: Björn Lundén, Visma eAccounting, Bokio. But Fortnox has ~60-70% of the Swedish SMB accounting market so it's our top priority.
- The supplier price creep agent (`app/api/cron/supplier-price-creep/route.ts`) is already scaffolded — just needs real Fortnox data to analyse.
