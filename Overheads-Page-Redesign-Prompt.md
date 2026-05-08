# CLAUDE CODE — OVERHEADS REVIEW VISUAL REDESIGN
> Generated 2026-05-07 (late evening)
> UI redesign + two small backend additions. Implementation grounded in OVERHEADS-INVESTIGATION-2026-05-07.md.

---

## What this is

We're redesigning `/overheads/review` from the current scrollable-list-of-cards pattern to a two-pane "list + detail" pattern (think email client). Left pane: scannable list of pending flags with filters. Right pane: deep context for the selected flag — AI explanation, 12-month price history, invoice drill-down, related periods.

The mockup at `prompts/overheads-mockup-v2.html` shows the target. Open it in a browser before starting.

This is **not**:
- A redesign of the flag classification rules or the detection worker
- A redesign of the AI explanation pipeline
- A change to the decision-storage model
- A schema migration
- A change to the apply/dismiss/defer flow on the backend

It **is**:
- A two-pane UI redesign of `app/overheads/review/page.tsx`
- One new endpoint: `GET /api/overheads/supplier-history` (~80 lines per the investigation)
- One new query: a "decided last 90d" count, either as `?stats=1` on the existing flags endpoint or as a small dedicated endpoint
- A "+ Resolved" toggle that exposes the existing `?include_resolved=1` parameter
- A reorganized headline strip leading with "Total at stake / Price spikes / Reappeared / Decided last 90d"
- Cross-period scope language ("applies to all 4 periods") made explicit in the action bar

---

## Hard constraints — read these first

### Things you MUST NOT touch

- **Detection logic** — `lib/overheads/review-worker.ts` and its helpers. The classifier rules, thresholds (`MIN_FLAG_AMOUNT_SEK`, `MIN_VOLATILE_DIFF_SEK`), normalization (`lib/overheads/normalise.ts`), or any of the four flag-type definitions.
- **AI explanation pipeline** — `lib/overheads/ai-explanation.ts`, the `runExplanationPass` worker, the `/api/overheads/explain/[flagId]` re-explain endpoint, the model choice, max_tokens, or caching strategy. The investigation confirmed the existing eager-generation model already covers the new design's needs.
- **Decision endpoint** — `app/api/overheads/flags/[id]/decide/route.ts`. The supplier-wide × category-wide × all-periods bulk-resolve behavior is correct and the new UI is built around it.
- **Drilldown endpoint** — `/api/integrations/fortnox/drilldown` and the `overhead_drilldown_cache` table. The single-period-at-a-time data shape is fine for the new UI; we use period-chip switching to navigate between periods.
- **Database schema.** No migrations. No new columns. Nothing in `archive/migrations/`.
- **The `expireDeferredFlags` sweep** that runs on every `/api/overheads/flags` GET.
- **Other pages.** Don't refactor `/dashboard`, `/p&l`, `/integrations`, etc.
- **The `duplicate_supplier` flag type.** The investigation noted it exists in the schema CHECK and the UI's `FLAG_TONE` map but no code writes it. Leave it alone — don't delete, don't implement. Out of scope.

### Things you MUST do

- Use `/api/overheads/flags` (existing) as the primary data source for the list pane. The response already includes `ai_explanation`, `ai_confidence`, `reason`, `amount_sek`, `prior_avg_sek`, `period_year/month`, `supplier_name`, `category`, `flag_type`. No new fields needed for list rendering.
- For the detail pane's invoice list, fire `/api/integrations/fortnox/drilldown` lazily on flag-select — same endpoint the current page uses, same per-period scope.
- For the detail pane's "switch periods" affordance, **use the existing per-period drilldown endpoint with multiple separate fetches** (one fetch per period chip, fired on click), NOT a new multi-period endpoint. The investigation noted both are possible; per-period chip-click is the simpler path and matches existing data shape.
- Make the cross-period decision scope explicit in the action bar. The mockup's "Applies supplier-wide for 'Other cost' · resolves all 4 pending periods at once" language is an example — the operator needs to see this clearly before clicking Essential or Plan to cancel.
- Build the "+ Resolved" toggle in the list-pane search row. It flips the existing `?include_resolved=1` parameter on the flags endpoint. When on, resolved flags appear in the list with a visually distinct treatment (gray, smaller, or marked with a "RESOLVED" badge — your call).
- Preserve the existing tabs/filter logic that the current page uses (the "All / Overheads / Direct" pattern in the screenshot). The new filter pills layer on top: All, Spike, Reappeared, New supplier, One-off high.
- Preserve mobile responsive behavior. The investigation flagged the two-pane layout breaking at narrow widths — at <880px, the list pane should be full-width and clicking a flag should push a full-screen detail view (with a back button to return to the list). Don't try to cram both panes side-by-side on mobile.

### Things you MUST investigate before implementing

Before writing any code, answer these and put the answers in your implementation report:

1. **Confirm the flag-type filter counts can be derived client-side from the existing `/api/overheads/flags` response.** Look at the actual response shape in production for Vero. If yes, the filter pills compute purely from the response. If the response doesn't include `flag_type` per row (it should — the investigation confirmed this), surface and pause.

2. **Confirm `ai_explanation` is non-null for the majority of pending flags for Vero.** The investigation says eager generation runs at detection time. If many flags have null explanations (edge case: detection happened before PR4 shipped, or the AI call timed out), the empty-state UI must handle this. Confirm typical density before assuming the always-visible explanation pattern works.

3. **Confirm the existing decision-feedback flow.** When the user clicks Essential or Plan to cancel, the endpoint returns `flags_resolved: N`. Find where the current UI consumes this — does it show a toast, refetch the list, optimistically remove rows? The new UI should preserve whatever feedback pattern exists today.

4. **Find the existing `lib/format.ts` or equivalent** for currency formatting. Use it for "21 902 kr" rendering. Don't reinvent Swedish space-as-thousands-separator logic.

5. **Identify the existing chart library used in CommandCenter** (Recharts, Chart.js, custom SVG, etc.). The new 12-month price history chart should use the same library/pattern as charts on the dashboard or P&L tracker for visual consistency. If no chart library is set up and the dashboard uses inline SVG, build the chart as inline SVG.

If any answer surprises you (e.g., `ai_explanation` is null for most flags; the existing decision feedback uses a pattern the new UI can't preserve), pause and surface before implementing.

---

## Concrete deliverables

### 1. The redesigned page
Replace the contents of `app/overheads/review/page.tsx` with the two-pane layout. Pull components into `components/overheads/` for cleanliness:

- `components/overheads/HeadlineStrip.tsx` — the four-stat header (Total at stake, Price spikes, Reappeared, Decided last 90d)
- `components/overheads/FlagListPane.tsx` — left pane: search, filter pills, sort, list rows
- `components/overheads/FlagDetailPane.tsx` — right pane: header, action bar, AI explanation, price chart, invoice list, related-periods card
- `components/overheads/SupplierPriceChart.tsx` — the 12-month chart (consumed by detail pane)
- `components/overheads/PeriodChips.tsx` — the period switcher above the invoice list

The page itself becomes a thin orchestrator: fetches data, manages selected-flag state, threads props.

### 2. Two new backend endpoints

**`GET /api/overheads/supplier-history`** at `app/api/overheads/supplier-history/route.ts` (~80 lines per the investigation).

Inputs: `business_id`, `supplier_name_normalised`, `category`, optional `months` (default 12).
Output: `[{ year: number, month: number, amount: number }]` — one row per month, in chronological order.

Implementation: single Supabase query against `tracker_line_items`, filtered by `business_id`, `category`, supplier matching via `normaliseSupplier(label)` (reuse `lib/overheads/normalise.ts`), date range based on `months` parameter. Aggregate by `(period_year, period_month)`, sum amounts, return sorted ASC.

Auth: same scope check pattern as `/api/overheads/flags` — verify `auth.orgId` owns the business.

**Decision: where does the "decided last 90d" count live?**

Two options. Investigate before picking:

- Option A: Add a `?stats=1` parameter to `/api/overheads/flags` that returns an additional `stats` object with `decided_last_90d` count alongside the existing flags array. Single endpoint, single fetch. Simpler.
- Option B: Create a new dedicated `GET /api/overheads/stats` endpoint. Cleaner separation, easier to extend later.

Pick whichever fits the existing API patterns better. Surface your choice in the implementation report. If unsure, default to Option A (additive parameter) for simpler plumbing.

### 3. The "+ Resolved" toggle

In the list-pane search row. When clicked, the page refetches `/api/overheads/flags?include_resolved=1`. Resolved flags appear in the list with a visually distinct treatment. The toggle's state persists in the URL as `?include_resolved=1` so refresh preserves the view.

When a resolved flag is selected in the list, the detail pane shows it as historical context: action buttons disabled (or replaced with "Resolved on [date] by [user]"), AI explanation visible, invoices clickable. The user can re-decide a resolved flag, but it's not the primary intent.

### 4. The cross-period decision-scope language

In the detail pane's action bar, immediately above the Defer / Plan to cancel / Mark Essential buttons, render:

```
Decision needed
Applies supplier-wide for "{category}" · resolves all {N} pending periods at once
```

Where `{N}` is computed from the existing flags response by counting matching `(supplier_name_normalised, category, resolution_status='pending')` rows. The "{category}" is the human-readable category name ("Other cost" / "Food cost") not the database value (`other_cost` / `food_cost`).

When N=1, render: "Applies to this flag only · 1 period." (Don't mislead about scope when there's only one.)

### 5. Mobile responsiveness

Below 880px viewport width:
- Two-pane layout collapses to single-pane
- List pane is shown by default
- Selecting a flag pushes the detail pane as a full-screen view with a "← Back to list" button at the top
- Filter pills wrap or scroll horizontally — don't try to fit them in two rows on a 380px screen
- Decision buttons (Defer / Plan to cancel / Mark Essential) stack vertically below the action prompt, full-width

This is genuine mobile work, not a desktop layout shrunk down. Test at 380px width.

---

## Mockup-as-spec discipline

The mockup at `prompts/overheads-mockup-v2.html` is a faithful visual target. Some values are illustrative — compute the actual values from the API:

| Element | In mockup | Should come from |
|---|---|---|
| `186 935 kr/mo` total at stake | hardcoded | sum of `amount_sek` for pending flags (already in `total_monthly_savings_sek`) |
| `27 suppliers · 69 flags` | hardcoded | count of unique suppliers and total flag count |
| `3` price spikes / `11` reappeared / `8` new / `5` one-off counts | hardcoded | client-side `groupBy(flag_type).count()` from existing response |
| `42` decided last 90d | hardcoded | new `?stats=1` query or new `/api/overheads/stats` endpoint |
| `~31 200 kr/mo cut` | hardcoded | sum of `amount_sek` for `resolution_status='dismissed'` in last 90d |
| Per-flag `21 902 kr`, `+178%`, `↑ 14 020 kr vs avg` | hardcoded | `amount_sek`, computed delta from `prior_avg_sek` |
| `+3 periods` indicator | hardcoded | computed from grouped flags (`others.length` per supplier-category group) |
| AI explanation paragraph text | mocked | `ai_explanation` from row |
| `Confidence: 0.82` | hardcoded | `ai_confidence` from row |
| `Generated 4h ago · Sonnet 4.6` | mocked | derived from row metadata; if not present, omit the model name |
| 12-month chart line | mocked | new `/api/overheads/supplier-history` endpoint |
| `4 times`, `~87 608 kr` related-periods text | hardcoded | computed from grouped flag count and amount sums |
| Period chips (Feb 2026, Jan 2026, etc.) | hardcoded | derived from the supplier's flagged periods (`latestKey` + `others.map(o => o.periodKey)`) |
| Invoice rows in `Inv #1145` etc. | mocked | from `/api/integrations/fortnox/drilldown` response |
| Currency formatting | "21 902 kr" | use existing format helper from `lib/format.ts` (Swedish space-as-thousands) |

The mockup uses `0f7a3e` for green, `b8412e` for red, `c46a18` for amber, `3a6f9a` for blue. These match what's already in CommandCenter — but if you have a design tokens file (Tailwind config, CSS variables), use those tokens instead of hardcoded values.

---

## Hard rules of engagement

- **No FIXES.md entry.** This isn't a fix.
- **One PR, one descriptive commit.** No "auto-checkpoint" commits during the work. If your environment is auto-committing on a timer, disable it for this work or squash before opening the PR.
- **Don't ship until you've manually verified the page renders for Vero with real data.** Both the populated state (after the OAuth backfill from yesterday) and the empty state (a business with zero pending flags). Both must work.
- **If you find a bug in adjacent code while doing this work, do NOT fix it.** Surface it in your implementation report and let Paul decide whether to scope a follow-up. The discipline of "fix only what you came to fix" is non-negotiable for this work.
- **If the existing data shape doesn't support something the mockup assumes**, surface the gap. Don't fabricate fields or invent endpoints to fill the gap.
- **Don't extract or refactor `lib/overheads/normalise.ts`** even if you have ideas. Use it as-is for the new supplier-history endpoint.
- **Don't write tests for the existing endpoints you're consuming** unless they're broken. Test the new code (the supplier-history endpoint, the components) but don't expand test coverage of pre-existing code as part of this PR.

---

## Adjacent observations (from the investigation report — surface, don't fix)

The investigation surfaced these. They're real but out of scope for this PR. If you encounter them while building, note in the implementation report and continue:

- **`duplicate_supplier` flag type orphan.** Schema CHECK and UI `FLAG_TONE` map both reference it; no code path writes it. Leave alone.
- **No audit trail on classification changes.** Owner can flip Essential → Dismissed → Essential and only the latest decision is preserved. Not blocking the redesign.
- **Detection worker doesn't fire on API-backfilled `tracker_data` writes.** When Vero connected Fortnox yesterday and the 12-month backfill ran, those backfilled months don't trigger flag detection (only PDF apply does). This means after the OAuth flow shipped yesterday, the new pages may show fewer flags than expected. This is **important context**, not a bug to fix here. If you're testing the redesign and the page looks empty for Vero, this is why. Apply a real PDF for one of the freshly-backfilled months if you want to see populated flags.

---

## Implementation order suggestion

1. **Investigation pass** (45-60 min): answer the five investigation questions, confirm response shapes, identify any surprises.

2. **Build the new endpoint(s)** (60-90 min):
   - `/api/overheads/supplier-history` first — purest piece, no UI dependencies
   - The "decided last 90d" stat (either `?stats=1` or new endpoint) — second
   - Quick smoke-test both with real Vero data before moving on

3. **Build the components** (3-4 hours):
   - `HeadlineStrip` first — simplest, validates data wiring
   - `FlagListPane` next — lots of pieces (search, filters, sort, rows, "+ Resolved" toggle) but no inter-component complexity
   - `FlagDetailPane` last — most complex, depends on supplier-history endpoint and drilldown integration
   - `SupplierPriceChart` and `PeriodChips` are sub-components used by the detail pane

4. **Wire into the page** (60 min): the orchestrator that manages selected state and threads data.

5. **Mobile pass** (60-90 min): genuine work, not just shrinking. The single-pane navigation pattern (list → detail → back) needs real testing.

6. **Visual polish pass** (30 min): exact spacing, typography, color tokens to match existing CommandCenter aesthetic.

7. **Manual verification** (45 min): both populated state (real Vero data) and empty state (a business with zero flags). Test mobile breakpoints. Test the "+ Resolved" toggle. Test re-deciding a resolved flag.

8. **Open PR** with a clear description and screenshots of both panes (desktop) and the single-pane mobile flow.

Total: roughly a day of focused work. If it's taking materially longer than 1.5 days, surface what's hard before continuing.

---

## What "done" looks like

- `/overheads/review` renders without errors for Vero.
- The two-pane layout is the default at desktop widths.
- The list pane shows accurate filter counts derived from the response.
- The detail pane shows AI explanation, 12-month chart (new data), invoice list (existing drilldown), and related-periods card.
- The action bar communicates cross-period scope clearly with a computed N.
- Decisions hit the existing endpoint and resolved flags disappear from the default view.
- The "+ Resolved" toggle works and uses the existing `?include_resolved=1` parameter.
- Mobile single-pane navigation works at 380px.
- TypeScript clean. No new ESLint warnings.
- Existing detection, AI explanation, decision, and drilldown code paths unchanged.

---

## Implementation report

After the PR is open, write a one-page report covering:

- The five investigation answers
- Which option you picked for the "decided last 90d" stat (Option A vs B) and why
- Any deviations from the mockup and why
- Adjacent issues you noticed but didn't fix (per "surface, don't act")
- Anything that needs follow-up

This report goes in the PR description, not as a separate file.

---

> "UI redesign + two small data-side additions. Detection, AI explanation, decision, and drilldown code paths unchanged."
