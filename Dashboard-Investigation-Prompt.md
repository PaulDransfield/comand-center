# CLAUDE CODE — DASHBOARD INVESTIGATION
> Generated 2026-05-08
> Read-only investigation. No code changes. Single deliverable: a markdown report.

---

## What this is

We're considering a redesign of the dashboard at `/dashboard` (or whatever the main post-login overview page is called — confirm). The mockup at `prompts/dashboard-v6-modern-chart.html` shows the target.

Before designing further or building, we need to map what's currently true: what data exists, where it comes from, what's computed live vs cached, what surfaces it renders on, and where the gaps are between the current state and the redesign.

This investigation maps the dashboard across ten dimensions. The report it produces will inform mockup refinement and the eventual implementation prompt.

---

## Hard constraints

- **Read-only.** Don't modify any files. No migrations. No tooling changes.
- **Don't write the new design.** This is investigation only.
- **Don't propose architectures or fixes.** Just describe what exists.
- **Don't speculate.** If you can't find something, say so. Don't guess what "should" be there.
- **No FIXES.md entry, no commits.**
- **Don't rewrite the mockup.** Reference it where relevant — describe what the current code can or can't support — but don't propose mockup changes.

---

## Ten questions to answer

### 1. Page location and current layout

- Where does the dashboard live? Confirm the route (probably `/dashboard` or `/overview`) and primary file path.
- Map the current layout sections in document order. For each section, note:
  - Approximate visual purpose (anomaly banner, three-card top row, big chart, departments card, attention feed, weather strip)
  - Component file path
  - Data dependencies (what API calls / data fetches it makes)
- Total roughly how many distinct API calls fire on dashboard mount.

### 2. The big chart

- Component file path and primary export
- Charting library used (Recharts, Chart.js, custom SVG, D3, etc.)
- Data shape consumed: what fields per data point, granularity (hourly / daily / weekly), how many points
- Source endpoints — does it fetch revenue and labour separately, or one combined endpoint?
- Compare toggle (None / Prev week / AI) — how does each mode work? Where does "AI" come from — the same `/api/scheduling/ai-suggestion` endpoint we mapped earlier, or a different forecast?
- "Predicted" bars for upcoming days — does the current chart distinguish actual vs predicted at day level, or only show full data for past days?
- Anomaly markers on the chart — does the current chart annotate anomalies inline, or is the anomaly banner separate from the chart?

### 3. The three-card top row

The current dashboard has a top row of cards: "This week", "Next week labour projection", "[Period] overheads review" (and possibly a fourth). For each:
- Component or page section
- Data source (which endpoint(s))
- Computation — is "63.3% labour" computed on the page, on the server, or pulled from a shared aggregate?
- The before/after percentages ("45% → 39%" for labour, "18% → 29%" for overhead) — where do these come from? The same scheduling AI endpoint? A separate aggregator?

### 4. Anomaly detection — the OB-tillägg case

The current dashboard's persistent yellow banner says: *"OB supplement spike +78% — Vero Italiano. Your supplements cost per cover jumped on May 8th — likely due to ei..."*

- Where is "OB supplement" / "OB-tillägg" detected? Code path.
- Is this part of a general anomaly detection system, or a one-off rule?
- What categories does the anomaly system cover (food cost, labour, supplements, OB-tillägg specifically, anomalies on specific BAS accounts, etc.)?
- How are anomalies surfaced in the data layer — table name, schema, lifecycle (created when, dismissed when, expired when)?
- Endpoint that the dashboard reads from to populate the anomaly banner — endpoint name, response shape
- The "click for details" flow — does clicking the banner navigate to a dedicated page, expand inline, open a modal?

### 5. Weather + holidays

The current dashboard's weather outlook is at the bottom: 7 days, weather emoji, predicted revenue per day. The redesign combines weather + holidays into one section.

- Weather data source (already known to be SMHI per earlier investigation, but confirm endpoint/component)
- Per-day predicted revenue — same source as scheduling agent A's `est_revenue`, or different? Per the earlier scheduling investigation there's also a newer `/api/weather/demand-forecast` endpoint — which one does the dashboard currently use?
- **Holidays:** Is there a Swedish holidays data source today? If yes, where (database table, hardcoded list, external API)? If not, where does the scheduling agent's "holiday gate" come from (mentioned in earlier investigation)?
- For the redesign's combined weather + holidays day cards, are the data shapes compatible — i.e., can we render "Wednesday May 13 · sunny 14°/19° · 28 900 kr forecast · holiday Kristi himmelsfärds dag" from one fetch, or does it require joining weather + holiday + revenue forecast?

### 6. Labour ratio per day — for the chart's color-coded bars

The redesign color-codes each day's labour bar by its labour ratio (green / amber / red) and shows the ratio value (32%, 38%, etc.) above each bar. To support this:

- Is daily labour cost as a number available per day? Where?
- Is daily revenue available per day? Where?
- The ratio (cost/revenue) — computed where? On the dashboard, or upstream?
- Does the dashboard's existing chart already render labour bars per day, or just totals?
- For the predicted future days (Sat/Sun in the mockup) — is "projected labour cost" a number that exists, or only "scheduled hours" multiplied by hourly cost? In other words, is there a forecasted labour cost stream parallel to the forecasted revenue stream?

### 7. The "this week" stats on the chart header

The redesign shows four stats inline above the chart: Revenue / Labour / Margin / Covers. For each:
- Is the value already computed/cached, or computed live on the page?
- Source endpoint
- "Covers" (number of customers served) specifically — is this tracked? If yes, where? POS integration? Personalkollen? A different field?

### 8. Performance and load behavior

- Approximate load time for `/dashboard` cold (no cache). If logged or measurable, quote a recent observation.
- Number of parallel/serial API calls fired on mount
- Are any sections loaded lazily (after the page is rendered) vs eagerly?
- Is there any caching layer between the dashboard and the database (e.g., a 5-min cache on `/api/dashboard` or similar)?
- Does mobile-load behave differently?

### 9. Multi-business context

The screenshot shows Rosali Deli active in the sidebar but the persistent banner is about Vero Italiano (the *other* business). This suggests:
- The dashboard is per-business (per the active sidebar selection)
- BUT the anomaly banner pulls from a cross-business surface — confirm this
- Are there other dashboard elements that span businesses (e.g., aggregate "group" view), or is everything else strictly per-business?
- Is there a "Group" / multi-business dashboard route separate from the per-business one?

### 10. Departments

The current dashboard's "Departments — Week 19" card was empty in the screenshot ("No department data for this period yet").
- Where does department data come from?
- Is it rare for some customers (e.g., Vero) but common for others, or generally rare?
- For Vero specifically — why is it empty? Configuration not done, integration missing, no POS connector, or fundamentally not applicable?
- Should the redesign drop departments from the dashboard entirely (which the mockup did), keep it as a conditional empty state, or move it elsewhere?

---

## Bonus questions worth answering

If easy to determine, also report:

- **Total LOC** on the current dashboard page file (just the page, not subcomponents)
- **Most-recently-modified subcomponents** — which dashboard pieces have churned recently? (`git log --oneline -- app/dashboard/**` or similar)
- **Existing design tokens** for typography sizes, color palette, spacing scale — file path. We've been color-matching by eye; the implementation should use the actual tokens.
- **Test coverage** on dashboard components (just a fact — % covered, no recommendation)
- **Are there feature flags** controlling what shows on the dashboard for different customers/plans?
- **Any A/B tests or multivariate tests** running on the current dashboard?

---

## Deliverable

Single markdown file at repo root: `DASHBOARD-INVESTIGATION-2026-05-08.md`. Don't commit it; Paul reads and decides next steps.

Structure:

```
# Dashboard Investigation
> Generated by Claude Code on [date]
> Read-only. Maps current state of /dashboard data, components, and computations.

## 1. Page location and current layout
[Route, file path, sections in order, API calls fired on mount]

## 2. The big chart
[Component path, library, data shape, compare modes, predicted-vs-actual rendering]

## 3. The three-card top row
[Per card: source, computation, before/after origins]

## 4. Anomaly detection — the OB-tillägg case
[Detection code path, system coverage, storage, endpoint, click-through flow]

## 5. Weather + holidays
[Weather source, predicted revenue source, holidays source, joinability for redesign]

## 6. Labour ratio per day
[Daily labour cost availability, daily revenue availability, ratio computation, projected future labour]

## 7. The "this week" stats
[Each stat: source, computation. Covers field specifically.]

## 8. Performance and load behavior
[Load time, API call count, lazy loading, caching, mobile behavior]

## 9. Multi-business context
[Per-business vs cross-business surfaces, group view existence]

## 10. Departments
[Source, prevalence, why empty for Vero, recommendation context]

## Bonus
[LOC, churn, design tokens, coverage, feature flags, A/B tests]

## Summary — gap from current state to dashboard-v6 mockup
[One paragraph naming the smallest delta. Categories like:
- "All data exists, this is pure visual redesign"
- "Visual redesign + small new endpoint for combined weather+holiday"
- "Visual redesign + new daily labour ratio computation"
- "Visual redesign + restructure of anomaly system to support inline chart callouts"
- Multiple of the above, or something more substantial]

## Recommended implementation-prompt shape
[2-3 sentences. Whether the next prompt should be a single visual-update
prompt, or split. What the riskiest single piece is.]
```

End with this exact line:

> "Investigation complete. No code changed. Ready for review."

Then stop. Don't propose code. Don't open PRs. Don't suggest implementation.

---

## Time budget

90-120 minutes. This investigation is broader than scheduling or overheads because the dashboard touches more code paths. If you're past 2.5 hours, surface what's hard and what you've covered before continuing.

---

## What success looks like

After Paul reads the report, he can answer:

1. **Is the dashboard redesign a pure UI update**, or does it require backend work? If backend work, how much?
2. **What's the riskiest unknown** — the thing that could turn a small UI update into a multi-week build?
3. **Is the OB-tillägg anomaly real or a mockup placeholder?** If real, where does it come from. If placeholder, what's the actual anomaly story we should design around.
4. **Does the data exist to support the v6 mockup's design choices** — particularly the per-day labour ratio coloring, the inline today marker with both actual and predicted bars, and the combined weather+holidays day cards?
5. **What gets deferred vs shipped in v1?** If the redesign requires multiple backend additions, which can be cut from v1 without losing the design's value?

If the report makes any of these ambiguous, surface what's hard. The expected outcome is a clear three-bucket categorization (in scope / new but small / new and meaningful) for each component of the redesign.

---

## What I'm explicitly NOT asking for

- Any code changes
- Mockup proposals or design suggestions
- Recommendations on which redesign direction to pick — that's been decided (v6 mockup)
- Comparison against R365, Visma, or any external product
- Performance optimization beyond observation
- Test coverage analysis
- Schema migration suggestions

If you find issues in those categories during the investigation, note them in a "Bonus" or "Adjacent observations" section but don't act on them.

---

## A note on the OB-tillägg question

This is the single most important unknown in the investigation. The mockup commits to surfacing OB-tillägg (the Swedish unsocial-hours wage premium) as the anomaly headline. But it's possible:

- The current "OB supplement" banner in the screenshot is from a generic anomaly system that happens to have flagged a specific OB-tillägg increase
- "OB supplement" is the system's term for something different than OB-tillägg
- The detection logic is broader than OB-tillägg specifically (e.g., labour cost spikes in any category)
- Any anomaly the system flags could end up in the banner — it's not a dedicated OB-tillägg detection

Whichever is true affects the redesign's headline copy and how generalizable the design is. **Spend extra time on Question 4** if other questions are easy.
