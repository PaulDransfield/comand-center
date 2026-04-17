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

## Known architectural concern
Current sync (`app/api/integrations/fortnox/route.ts`) writes to `tracker_data` with `source='fortnox'`. Per the data-source audit (2026-04), `tracker_data` is intended for manual P&L entries only, with real monthly totals belonging in `monthly_metrics`. When Fortnox goes live with a real customer, migrate the Fortnox sync to write to `monthly_metrics` (with `source='fortnox'`) and have `tracker_data` keep being the manual-entry fallback. Estimated ~2h to switch plus a data backfill.

## Admin concierge flow (new, 2026-04-17)
Admins cannot impersonate Fortnox consent — the customer must log in directly at Fortnox. To start a connection on a customer's behalf:

1. In `/admin/customers/<orgId>`, click **+ {business}** under Integrations.
2. Pick **Fortnox** in the provider dropdown. The modal switches to the OAuth concierge view.
3. Click **Generate 1h connect link**. Copy the URL (or **Email to customer** to open a pre-filled draft).
4. Customer clicks the link → `/api/integrations/fortnox?action=connect&token=...` verifies the HMAC-signed token, redirects to Fortnox login.
5. Customer authorises at Fortnox → Fortnox redirects to `/api/integrations/fortnox?action=callback` → tokens are stored encrypted in `integrations.credentials_enc`.
6. Initial sync runs in the background.

Signed tokens live 1 hour by default (configurable via `ttl_seconds` in `/api/admin/oauth-link`). Every link generation and every OAuth callback writes to `admin_audit_log`.

## Sandbox / dev testing
1. Apply for a developer account at https://developer.fortnox.se (approval takes 2–4 weeks).
2. Create an app. Note the Client ID and Client Secret.
3. Register the redirect URI: `https://comandcenter.se/api/integrations/fortnox?action=callback` (and `http://localhost:3000/api/integrations/fortnox?action=callback` for local dev).
4. Set env vars: `FORTNOX_CLIENT_ID`, `FORTNOX_CLIENT_SECRET`.
5. Use Fortnox's test company credentials (provided in the developer portal) to test without touching production customer data.
6. Verify in Supabase that `integrations.credentials_enc` is non-null and `npx tsx scripts/audit-encrypted-credentials.ts` still passes.
7. Verify `admin_audit_log` has rows for `integration_add` (via=oauth_callback) and the earlier `oauth_link_generated`.
