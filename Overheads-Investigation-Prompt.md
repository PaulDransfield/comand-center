# CLAUDE CODE — OVERHEADS PAGE INVESTIGATION
> Generated 2026-05-07
> Read-only investigation. No code changes. Single deliverable: a markdown report.

---

## What this is

We're considering a UI redesign of `/overheads` that moves from the current "scrollable list of flag cards" to a two-pane "list + detail" pattern (think email client). Before designing or building it, we need to understand the current state of the data, components, and computations that back this page.

This investigation maps what exists today across six dimensions: flag types, AI explanations, decision persistence, cross-period grouping, invoice drill-through, and per-supplier history. The report it produces will be the basis for the implementation prompt that follows.

---

## Hard constraints

- **Read-only.** Don't modify any files. No migrations. No tooling changes.
- **Don't write the new design.** This is investigation only.
- **Don't propose architectures or fixes.** Just describe what exists.
- **Don't speculate.** If you can't find something, say so. Don't guess at what "should" be there.
- **No FIXES.md entry, no commits.** Nothing is being fixed or changed.

---

## Six questions to answer

### 1. Flag types — where each is classified, what each means

The current page shows badges like "REAPPEARED", "PRICE +178%", "OVERHEAD", and presumably others ("New", "Volatile", etc.). For each distinct flag type that exists in the codebase, report:

- **Name** (the literal string used in the UI badge)
- **Code path** — file and function where this classification happens
- **Definition** — what numerical or logical condition triggers it (e.g., "price increase >50% vs 12-month average")
- **Storage** — is the classification stored in a database column, computed live on every request, or some hybrid?
- **Source data** — what tables and fields it reads from

If multiple flag types share a single classifier function, group them. If a flag type is defined in copy/UI strings but not in the backend (e.g., the badge is hardcoded), say so.

If there's a fixed set of canonical flag types (an enum or string union), report it verbatim. If the set is open-ended or text-based, report the actual values currently observed in production data for Vero (`org_id e917d4b8-635e-4be6-8af0-afc48c3c7450`).

### 2. AI explanations — current behaviour

The live page shows a "Generate AI explanation" link per flag, which suggests on-demand generation. For the AI explanation flow:

- **Trigger** — what calls the AI (button click, page load, cron, etc.)?
- **Endpoint or function** — file path and primary export
- **Model used** — which Anthropic model, what max_tokens
- **Cache** — is the result cached anywhere (table, row, JSON column)? With what key and TTL?
- **Cost per call** — observable from any existing logging or `logAiRequest` call
- **Latency** — how long does generation typically take? If logged, quote a recent example.

Specifically answer: **if the new design requires AI explanations to render alongside every flag in a detail pane, would that require eager generation, a different caching strategy, or just an automatic fire-on-row-select?**

### 3. Decision state — Defer / Plan to cancel / Essential

The page has three primary actions per flag. For each:

- **Endpoint** — what URL the click hits (e.g., `/api/overheads/decide`)
- **Storage** — what table records the decision, what columns it writes
- **Scope** — does a decision apply to a single flag, a single supplier across periods, an account, or something else?
- **Reversibility** — can a decision be undone? Is there an audit trail?
- **Effect on display** — once decided, does the flag disappear from this page, get filtered out, or change appearance?

Also: is there a stat in production data right now answering "decisions made in the last 90 days for Vero"? If yes, what's the count? If the data exists but isn't surfaced, say so.

### 4. Cross-period grouping — "one decision applies to all"

The screenshot shows: *"Also flagged in Feb 2026, Jan 2026, Mar 2025 · one decision applies to all."* This implies a grouping primitive that links a single supplier's flags across periods.

- **Where is this grouping computed?** File and function.
- **By what key?** Supplier ID, account number, supplier+account, supplier+description hash, something else?
- **What does "applies to all" actually do** — does it write one decision row that applies to multiple flags, or write multiple rows in a transaction?
- **Edge cases** — if the same supplier appears in two different account categories (e.g., partly OVERHEAD and partly DIRECT), are they grouped or kept separate?

### 5. Invoice drill-through — "Show invoices"

Each flag card has a "Show invoices ▾" affordance. Investigate:

- **What it shows when expanded** — invoice list inline, separate page, modal?
- **Data source** — is invoice data eagerly loaded with the flag, or fetched on click?
- **Per-invoice fields available** — date, ref number, description, amount, link to source PDF / Fortnox URL?
- **Quantity** — for a typical flag like "IT-tjänster" with 4 flagged periods, how many invoices typically populate?

The Direction 2 design wants invoice history rendered inline in the detail pane, always visible for the selected flag. Note whether the current data shape supports this directly or would need adjustment.

### 6. Per-supplier history & headline stats

Direction 2 includes:
- A 12-month price-history chart per supplier (line chart of monthly invoice totals)
- A headline strip with "Total at stake / Price spikes / Reappeared / Decided last 90d"

For each, answer:

- **Does this data exist today?** (Either as a stored aggregate or as a query that could be run.)
- **Where would the query/computation live?** A specific endpoint, a service file, or genuinely new code needed.
- **For the 12-month chart specifically** — is per-month per-supplier expense data already computed for any other view (e.g., dashboard widgets, the P&L tracker)? Could it be reused?
- **For the headline counts** — are these derivable from the same data the current page reads, or do they require additional joins?

---

## Bonus questions worth answering

If easy to determine, also report:

- **Approximate data volume.** For Vero specifically: total flags pending review (the screenshot says 27), total flags ever raised, total decisions ever made, total suppliers tracked, total monthly invoices in the last 12 months.
- **Is there an "overheads" cron or batch job** that produces these flags on a schedule, or are they computed live on page load? File and schedule if cron.
- **Does this page exist in mobile-responsive form today?** What breaks on a 380px viewport currently?

---

## Deliverable

A single markdown file at repo root: `OVERHEADS-INVESTIGATION-2026-05-07.md`. Don't commit it; Paul reads and decides next steps.

Structure:

```
# Overheads Page Investigation
> Generated by Claude Code on [date]
> Read-only. Maps current state of /overheads data, components, and computations.

## 1. Flag types
[For each distinct flag type: name, code path, definition, storage, source data]

## 2. AI explanations
[Current behaviour and answer to the eager-vs-on-demand question]

## 3. Decision state
[Endpoint, storage, scope, reversibility, effect on display]

## 4. Cross-period grouping
[How "applies to all" works in current code]

## 5. Invoice drill-through
[How "Show invoices" works today, fields available, data shape]

## 6. Per-supplier history & headline stats
[What exists, what would need new computation]

## Bonus
[Volume, cron behaviour, mobile responsiveness]

## Summary — gap from current state to Direction 2 design
[One paragraph naming the smallest delta. Categories like:
- "Pure UI redesign — all data exists, just rendered differently"
- "UI redesign + caching layer for AI explanations"
- "UI redesign + new aggregation query for per-supplier 12-month history"
- "UI redesign + decision-history surface (currently unstored)"
- Multiple of the above, or something else.]

## Recommended implementation-prompt shape
[2-3 sentences. Whether the next prompt should be a single visual-update
prompt, or split into "data layer changes" + "visual update" as two prompts.]
```

End with this exact line:

> "Investigation complete. No code changed. Ready for review."

Then stop. Don't propose code. Don't open PRs. Don't suggest implementation.

---

## Time budget

60-90 minutes. This investigation is broader than the scheduling one because it spans more code paths (classification, AI explanation, decision storage, invoice handling). If you're past 2 hours, surface what's hard and what you've covered before continuing.

---

## What success looks like

After Paul reads the report, he can answer:

1. **Is Direction 2 a pure UI redesign**, or does it require backend work to support? If backend work, how much?
2. **What's the riskiest unknown** — the thing that could turn a "small UI update" into "two-week build"?
3. **Are there opportunistic improvements lurking** — places where the current implementation has obvious gaps that the redesign could naturally fix at low marginal cost?
4. **Does the AI-explanation pattern need to change** to make the detail pane feel responsive, or does the on-demand model still work?

If the report makes any of these ambiguous, surface what's hard. The expected outcome is a clear three-bucket categorization (in scope / new but small / new and meaningful) for the design's components.

---

## What I'm explicitly NOT asking for

- Any code changes
- Mockups or design proposals
- Recommendations on which Direction (1, 2, 3) to pick — that decision is made; investigation is for Direction 2
- Comparison against R365, Visma, or any external product
- Performance optimization
- Test coverage analysis
- Schema migration suggestions

If you find issues in those categories during the investigation, note them in a "Bonus" or "Adjacent observations" section but don't act on them.
