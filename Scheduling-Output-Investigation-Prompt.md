# CLAUDE CODE — SCHEDULING OUTPUT INVESTIGATION
> Generated 2026-05-07 evening
> Read-only investigation. No code changes. Single deliverable: a markdown report.

---

## What this is

We want to introduce a new visualization in CommandCenter — a three-row weekly grid showing (1) demand forecast per day, (2) what the operator scheduled, and (3) what the AI suggests, plus an explicit kronor savings callout below.

Before we design or build it, we need to understand the current state of the AI scheduling agent's output: what data it produces, where that data is stored, where (if anywhere) it currently surfaces in the UI, and what's missing between what exists and what the new layout would need.

This investigation answers that. The report it produces will be the basis for the implementation prompt that comes next.

---

## Hard constraints

- **Read-only.** Don't modify any files, run any migrations, or change any behaviour.
- **Don't write the new component.** This investigation is upstream of design and build. Both happen later.
- **Don't propose architectures or fixes.** Just describe what exists.
- **No FIXES.md entry, no commits.** Nothing is being fixed.

---

## Five questions to answer

### 1. Where does AI scheduling output exist today in the codebase?

Find the AI agent (or set of agents) that produces scheduling suggestions. Likely candidates based on prior context: somewhere under `lib/agents/`, `lib/scheduling/`, or referenced in cron jobs / `app/api/sync/`.

For each scheduling-related agent file you find, report:
- File path and primary function name
- What inputs it consumes (tables read, API calls made, time windows)
- What it returns / writes (return type, table written, log format)
- How it's invoked (cron job, manual trigger, on-demand from UI)
- Current state: actively running, scaffolded but unused, deprecated

If there's no clear "scheduling agent" — only generic AI prompts that touch staffing — say so explicitly.

### 2. What data does the agent actually produce?

This is the most important question. For the most live/active scheduling agent, identify the exact shape of its output. Specifically:

- Is the output **structured data** (e.g., `{ monday: { scheduled: 42, suggested: 42, forecast_demand: 90 }, ... }`) or **narrative text** ("Thursday is overstaffed by 8 hours...")?
- If structured, what's the schema? Per-day, per-shift, per-employee, per-department?
- If narrative, where does the structured underlying data live (if anywhere) — or is the LLM the only thing computing the comparison?
- Does it produce a per-day forecast number, or only a comparison/recommendation?
- Does it produce a kronor savings figure today, or would that need to be computed?
- Does it cover a full week ahead, or only past weeks (review-style)?

Quote the actual return type / response shape if findable. If output goes to a database table, name the table and key columns.

### 3. Where (if anywhere) does this output currently render in the UI?

Search the frontend for any page, component, or widget that displays scheduling-related output today. Likely candidates:
- `/dashboard` overview cards
- `/scheduling` or `/staff` dedicated pages
- The Monday Briefing / weekly briefing surfaces
- Embedded in alerts or anomaly feeds

For each surface found, report:
- Route path (e.g., `app/dashboard/page.tsx:123`)
- What the user sees today (text block, table, chart, list, none)
- What data shape the surface consumes
- Whether the surface is currently visible to users or hidden behind feature flags

If scheduling output never reaches the UI today — only exists in logs or briefings — say so explicitly.

### 4. What's the current state of the underlying data?

The proposed layout needs three streams of data per day:
- (a) demand forecast (numerical, for the upcoming week)
- (b) operator's scheduled hours (from Personalkollen)
- (c) AI's suggested hours (or implied by "cut these shifts")

For each:
- Where does this data live today? (Table, API endpoint, computed live)
- Is it computed and stored, or computed on-demand?
- Is it per-day, per-shift, or per-something-else?
- For a customer like Vero with active PK + Fortnox integrations, would all three exist today, or are some missing?

The point: which of the three streams is "ready to query" and which would need new computation or new storage.

### 5. The gap, named

In one paragraph: what's the smallest delta between what exists today and what the proposed week-grid visualization needs?

Possible shapes:
- "Everything exists; this is purely a new UI component." (small)
- "Data exists but is text/narrative; needs a structured-output mode added to the agent." (medium)
- "Only past-week review exists; forward-looking suggestions don't run." (medium-large)
- "Demand forecast per-day numbers don't exist; would need a new computation." (medium-large)
- Something else.

Be specific. Name files. Don't propose how to bridge the gap — just describe it.

---

## Deliverable

A single markdown file at repo root: `SCHEDULING-OUTPUT-INVESTIGATION-2026-05-07.md`. Don't commit it; Paul reads it and decides next steps.

Structure:

```
# Scheduling Output Investigation
> Generated by Claude Code on [date]
> Read-only. Maps current state of AI scheduling output and rendering.

## 1. Agents & code paths
[List of scheduling-related agents/files with the details requested in Q1]

## 2. Output shape
[The most important section. Describe what the agent actually returns,
with code excerpts and concrete examples of recent runs if available.]

## 3. UI surfaces
[Where scheduling output currently renders. List per surface, or
state explicitly that no surface exists today.]

## 4. Underlying data streams
[For each of the three streams (demand forecast / scheduled hours /
AI-suggested hours): where does it live, computed how, present for Vero?]

## 5. The gap
[One paragraph naming the delta between current state and proposed layout.]

## Recommended next-step shape
[2-3 sentences only. What kind of follow-up prompt would Paul write
based on this report? E.g., "purely a new component build" vs
"agent output refactor first, component build second" vs other.]
```

End with this exact line:

> "Investigation complete. No code changed. Ready for review."

Then stop. Don't propose code. Don't open PRs. Don't suggest implementation.

---

## Time budget

45-75 minutes. This is a tour of the AI agent code and a search through the frontend. If you're past 90 minutes, surface what's hard before continuing.

---

## What success looks like

After Paul reads the report, he can answer:

1. Does CommandCenter already produce the data the new layout needs, or does the agent need work first?
2. Is there an existing scheduling UI to redesign, or is this a brand-new screen?
3. What's the rough size of the implementation: small (new component only), medium (component + agent change), or larger?

If the report makes the gap feel ambiguous, surface what's hard. The expected outcome is one of three clear paths forward; if the answer is "it depends," that itself is information worth knowing.
