# CLAUDE CODE — FORTNOX INTEGRATION DIAGNOSTIC
> Generated 2026-05-07
> One-time investigation. Read-only. Single document deliverable.

---

## What this is

We have the full Fortnox API v3 OpenAPI spec in hand and need to understand exactly where our existing integration stands relative to what's available. This task answers the question: **"Can we onboard new customers via Fortnox API today, and if not, what specifically is missing?"**

The output is a single diagnostic document. No code changes. No PRs. No suggestions about what to build. Just ground truth.

The advisor reviewing this output will use it to decide whether the next sprint is "deepen the API integration," "fix legal/contractual gaps first," or "stay on the current path because customers don't actually need API depth yet." Your job is to make that decision well-informed, not to make it.

---

## Pre-flight

Read these before starting:

- `CLAUDE.md` — operational rules
- `lib/fortnox/` — the existing integration code, every file
- Any Fortnox-related migrations (search M*.sql for "fortnox")
- `FIXES.md` — search for "fortnox" sections to understand history
- Any environment variable references to `FORTNOX_*` or `STRIPE_PRICE_*` that hint at integration state

You don't need to read the OpenAPI spec exhaustively. It's at `vendor/fortnox-openapi.json` if Paul has copied it there; if not, work from what you can infer from the existing code. The spec is large (1.4MB JSON, 233 endpoints) — sample it, don't memorize it.

---

## Hard constraints

- **Read-only.** Don't create, edit, or delete any file in the repo *except* the final diagnostic document.
- **No probing of Vero or Rosali's actual Fortnox accounts.** You don't have authorization. Look at what the codebase tells you about their connection state via DB schema and code logic, not by calling Fortnox.
- **No live API calls.** Don't `curl` Fortnox. Don't try to validate endpoints. The spec is the contract; trust it.
- **No new prompts.** This task ends with the diagnostic doc. The advisor decides what comes next.
- **No "I would suggest" language.** Strip every advisory phrase. State facts. The advisor reads opinions in conversation, not in the diagnostic.

---

## What to investigate

Six areas, in this order. Don't skip ahead — earlier sections inform later ones.

### 1. Code surface — what does our integration actually do?

Read every `.ts` file under `lib/fortnox/` and any `app/api/fortnox/*` routes. For each file, note:
- File path
- Purpose (one sentence)
- Whether it calls Fortnox API endpoints, parses PDFs, or both
- Which endpoints it hits (if any) — search for `api.fortnox.se`, `fetch(.*fortnox`, or similar patterns
- What data it produces or consumes

Output as a table or list. Be specific about endpoint paths where you can find them.

### 2. The PDF-vs-API split

This is the core diagnostic question. For each major data flow in CommandCenter that involves Fortnox:

- Where does the data currently come from? (PDF upload, API call, manual entry, none)
- What endpoint(s) in the OpenAPI spec could replace it?
- Is the API path implemented but unused, partially implemented, or missing entirely?

Specific flows to investigate:
- P&L / Resultatrapport extraction
- Supplier invoice data
- General ledger transactions / vouchers
- Customer (debtor) data
- Supplier data
- Chart of accounts / account names
- Financial year metadata
- Company information
- Cost center / project dimensions
- Employee / payroll / absence data (if Fortnox Lön is used)
- File attachments / inbox / archive

For each, give a one-line status: "PDF-only / API-only / Both / Neither / Partial."

### 3. OAuth and credential state

Read the OAuth flow code. Document:
- Where is the OAuth client ID and secret stored? (env var name, not value)
- What scopes does the OAuth flow request?
- Where are access tokens persisted? (table name, schema if findable)
- Is there a refresh token flow? Where? How often does it run?
- What happens when a token refresh fails? (Sentry alert? Customer notification? Silent failure?)
- Is there a token health check or monitoring?

Verify by reading code, not by running anything.

### 4. Customer connection state

Without calling any external API, determine from the database schema and code:
- What table tracks Fortnox-connected customers?
- How does the schema represent "this customer has an active Fortnox connection"?
- For Vero and Rosali specifically (if you can identify their org_ids from CLAUDE.md or admin code), what does the data say about their connection state? OAuth tokens present? Last-sync timestamp recent? Errors logged?
- Is there a UI flow for customers to connect/reconnect Fortnox? Where does it live?

If you can't determine specific customer state without making external calls, say so. Don't guess.

### 5. Production-readiness signals

Read the integration code with a "would I trust this in production at 50 customers" lens. Note any of these patterns:

- Hardcoded URLs that look like sandbox/staging vs production
- Hardcoded organization IDs (which would suggest debugging code shipped to prod)
- `console.log` calls in Fortnox-related code paths
- Catch blocks that swallow errors silently
- Rate-limiting awareness (the spec says 25 req/5sec — does the code respect this?)
- Pagination handling for endpoints that return paginated results
- Idempotency for any `POST` or `PUT` calls
- `@ts-nocheck` on Fortnox files

State each finding factually. Don't characterize as "good" or "bad."

### 6. Legal / contractual signals from code

These are signals only — the actual legal review happens outside the codebase. From the code, can you tell:

- Is there a Privacy Policy linked anywhere customer-facing? (`app/privacy*`, `app/terms*`)
- Does the OAuth flow show a consent screen or just redirect?
- When a customer disconnects Fortnox, does the app delete their Fortnox-derived data, retain it, or have no clear path?
- Is there a "data export" or "right to be forgotten" flow?

These signals don't make the legal status; they hint at it.

---

## Deliverable

Single file at repo root: `FORTNOX-DIAGNOSTIC-2026-05-07.md`. Don't commit it — Paul will review and decide.

Structure:

```markdown
# Fortnox Integration Diagnostic
> Generated by Claude Code on [date]
> Read-only investigation. No code changed.

## 1. Executive summary

Three to five sentences. State facts only. Examples of the kind of statement that belongs here:
- "Our integration uses 4 of the 233 available endpoints. PDF upload is the primary data flow for new customers. OAuth credentials are present in env but the customer-facing 'Connect Fortnox' button does not exist in any rendered route."
- "Our integration calls 12 endpoints, OAuth is fully wired, both Vero and Rosali have active tokens, and PDF upload is a fallback path for the supplier invoice flow only."

The advisor uses this paragraph to decide whether to keep reading the rest in detail or skip to specific sections.

## 2. Code surface

Table of every Fortnox-related file: path, purpose, calls-API-or-parses-PDF, endpoints touched.

## 3. PDF vs API split

Table of every Fortnox-data flow with status (PDF-only / API-only / Both / Neither / Partial) and the OpenAPI endpoint that could (or does) cover it.

## 4. OAuth and credentials

Findings from section 3 of the investigation. Bullet form. Be specific about env var names and table names.

## 5. Customer connection state

What the database and code say about Vero, Rosali, and any other org's Fortnox connection state.

## 6. Production readiness

The list of signals you found in section 5 of the investigation. State each plainly.

## 7. Legal / contractual signals

The signals from section 6, with explicit "this is a code-level observation, not a legal conclusion" framing.

## 8. Open questions

Things the codebase could not answer that the advisor should ask Paul or check externally. Each item: the question, why it matters, who would know.

## 9. What this diagnostic does NOT cover

Three to five lines. Examples:
- "Whether Fortnox developer credentials are production or sandbox — only the Fortnox developer dashboard knows."
- "Whether a Developer Agreement exists and what version — Paul would need to confirm."
- "Whether Vero or Rosali are actually generating fresh data in their Fortnox accounts — out of scope."
```

End the document with this exact line:

> "This diagnostic is ready for review. No code was changed during its production."

Then stop.

---

## Time budget

Two hours. If you find yourself at 90 minutes still reading code without writing the diagnostic, switch to writing — partial diagnostic with clear gaps is more useful than a complete diagnostic that doesn't exist.

Eighty percent coverage at high fidelity beats hundred percent coverage with detail nobody reads.

---

## What success looks like

Paul reads the diagnostic in 10-15 minutes and can answer four questions confidently:

1. Can a new customer be onboarded via Fortnox API right now? (Yes / No / Yes-but-with-caveats, with the caveats listed)
2. What's the gap between current integration and "API-first onboarding"?
3. What's actually load-bearing in our current PDF-based flow vs what's vestigial?
4. What questions do I need to answer outside the codebase before deciding the next move?

If the diagnostic produces those answers cleanly, success. If it produces a wishlist of things to build, it has overstepped.
