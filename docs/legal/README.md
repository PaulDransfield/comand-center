# docs/legal/

Evidence and signed documents that back up the claims in `LEGAL-OBLIGATIONS.md`.

## Structure

- `sub-processors/` — one subfolder per sub-processor with its signed DPA PDF, SCCs, and any compliance certs (SOC 2, ISO 27001).
- `screenshots/` — dated screenshots of settings that prove the posture at a point in time (Anthropic ZDR toggle, Supabase region, Vercel region, etc.).
- `policies/` — signed versions of our own policies once the lawyer drafts them (privacy policy, ToS, DPA template, acceptable use).
- `customer-dpas/` — signed DPAs with each paying customer, one PDF per org.

## Naming conventions

- Screenshots: `{provider}-{setting}-{YYYY-MM-DD}.png` — e.g. `anthropic-zdr-2026-04-17.png`
- DPAs: `{provider}-dpa-signed-{YYYY-MM-DD}.pdf` — e.g. `supabase-dpa-signed-2026-04-18.pdf`
- SCCs: `{provider}-sccs-signed-{YYYY-MM-DD}.pdf`

## What NOT to put here

- Secrets, API keys, or OAuth tokens — ever.
- Customer personal data.
- Unredacted copies of support tickets or incident details.

The folder is committed to git. Anything sensitive goes in 1Password / Supabase Storage instead.

## Current status

See the sub-processor matrix in `LEGAL-OBLIGATIONS.md §7`. Each sub-processor listed there should have a matching subfolder once its DPA is signed.
