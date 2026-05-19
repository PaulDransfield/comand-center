# CommandCenter Implementation Playbook
> v0.1 · 2026-05-19
> Reflects what actually worked onboarding Vero Italiano and Rosali Deli.
> Internal doc; public-facing version lands at `/implementering` as a sales asset (Phase B.1 of the v2 roadmap).
> Companion docs: `THE-NORDIC-PLAN.md` · `COMMANDCENTER-ROADMAP-v2.md` · `ROADMAP.md` · `CLAUDE.md`

---

## 0. Why we have a playbook

Nory publishes their "How we manage change" page because **operators who can't picture what onboarding feels like don't sign**. Restaurant owners have been burned by software rollouts that promised much and demanded more. A documented playbook with named milestones, clear customer artifacts, and explicit exit criteria does three things at once:

1. **Reduces buyer risk perception** during the sales conversation
2. **Forces us to deliver consistently** instead of improvising per customer
3. **Builds the case-study pipeline** — every milestone closure produces measurable outcomes we can quote

The playbook is **always-free** as part of the subscription. No implementation fees, no separate onboarding package. The cost is bundled into the monthly subscription because (a) it would scare off Swedish SMBs to see a separate line item and (b) implementation is part of the product.

---

## 1. Roles — who does what

We define three customer-side roles up front. The customer fills them themselves; we don't assign them. Naming them in the kickoff call is part of getting buy-in.

### Point of Contact (PoC) — required, one person

The owner or operations manager who signs the contract and owns the relationship with CommandCenter. Sees all email; can request changes to billing, plan, integrations.

Time commitment: ~30 minutes per milestone (kick-off call, review calls, decision points).

### CommandCenter Champion — strongly recommended

Internal advocate inside the customer's team. Typically the operations manager, head chef, or general manager — someone who'll be in the product daily and answer "what does the dashboard say?" when other team members ask. Without a Champion, the product gets used by one person (the PoC) and stays a sideshow.

Time commitment: ~2 hours/week for the first month, ~1 hour/week ongoing.

### Task Manager — optional, useful for groups with 3+ locations

Coordinates per-location data collection and handles tactical questions ("does Bella have her own Personalkollen account?"). Often the same person as the Champion in single-location setups; a separate person in group setups.

Time commitment: ~3 hours over the first two weeks; minimal after.

**Our side:** Paul (Founder + Customer Success). One person. Will scale as we grow.

---

## 2. The 4-milestone structure

```
       Kick-off            M1                M2                  M3                  M4
         │                  │                  │                    │                    │
   Days  0  ●─────────●  Day 5     ●─────────●  Day 12    ●──────────●  Day 21   ●──────────●  Day 30-45
         │                  │                  │                    │                    │
         │  POS connected   │  Scheduling AI   │  Fortnox connected │  First full        │
         │  + first         │  active +        │  + 12-month        │  monthly close     │
         │  forecasts       │  hours saved     │  backfill + revisor│  cycle complete    │
         │  visible         │  visible per day │  drilldown ready   │  with revisor      │
```

Total: 4-6 weeks from contract signed to "fully implemented." The first weekly memo lands within 7 days of M1; the first measurable labour% improvement typically shows within 4 weeks.

---

## 3. Pre-onboarding — what we need from the customer

Sent as a one-page form 48 hours after contract sign. Customer fills before the kick-off call. If form not returned within a week, we email a gentle nudge; if not returned in two, we offer a 15-min support call to fill it in together.

### Required artifacts

- **Business name(s)** — legal entity name + operating name(s) if different
- **Org-nr (organisationsnummer)** — required up-front for the onboarding wizard (per M046 schema). Without this, the wizard blocks past step 1.
- **Address(es)** — kommun and län needed for kommun-aware school holiday data
- **Business stage** — new / established_1y / established_3y (drives forecaster cold-start handling)
- **Opening days** — which weekdays each location is open (Mon-Sun toggles per the M046 schema)
- **Cost targets** — target food % (default 31) and target staff % (default 35); operator can override
- **Last year's P&L PDF** — optional but strongly recommended when stage ≠ 'new'; we apply it via the Fortnox extraction pipeline to seed history before live Fortnox connection is up

### Integrations checklist

- [ ] Personalkollen account — owner needs API access enabled (free in PK admin)
- [ ] Fortnox account — owner needs to authorize via OAuth (we provide the consent screen)
- [ ] Banking — we don't pull bank data yet; mention live bank feeds are on the roadmap

### Optional artifacts

- Photos / branding (logo, colours) — only matters when we publish the case study
- Existing reports — week/month/year summary PDFs from current tools; useful for the first-month sanity check

---

## 4. Kick-off call (Day 0) — 45 minutes

Live video, customer's PoC and Champion + Paul. Agenda:

### 1. Introductions + scope confirmation (10 min)
- Paul: 60-second elevator pitch on CommandCenter's positioning (Nordic-native, Fortnox+PK depth, intelligence layer not replacement)
- Customer: 5-minute summary of their current operations, biggest pain (lunch overstaffing? Month-end close anxiety? Food waste?)
- **Outcome:** confirm whether their #1 pain is something CommandCenter actually solves. If not, recommend deferring and being honest about it.

### 2. Roles + commitments (5 min)
- Confirm PoC + Champion (+ Task Manager if applicable)
- Confirm Paul's commitment: weekly email check-in for first month, then monthly + on-request
- **Outcome:** named contacts on both sides, email/Slack channels confirmed

### 3. Milestone walk-through (15 min)
- Show this playbook (the customer-facing version once published at `/implementering`)
- Set expectations for M1-M4 timing
- Confirm what's required before each milestone closes
- **Outcome:** customer knows the journey

### 4. Goals + KPIs (10 min)
- "What does success look like in 90 days?" — get the customer to articulate it in their own words
- Quantify if possible: labour % from X to Y, food waste from X to Y, hours/week saved
- Document in the customer's CRM record + the public-facing case-study draft
- **Outcome:** baseline numbers captured, target numbers agreed

### 5. Immediate next steps (5 min)
- Customer: complete pre-onboarding form by [date], grant Fortnox + PK access by [date]
- Paul: schedule M1 review call for [date+5]
- **Outcome:** calendar invites sent, no ambiguity

### Exit criterion (Kick-off)

✓ Pre-onboarding form returned · ✓ Champion named · ✓ M1 review call scheduled · ✓ Goals documented

---

## 5. Milestone 1 — POS + first forecasts visible (Day 5)

### Goal
The customer sees their first CommandCenter dashboard with real revenue data and a forecast for the upcoming week.

### What we do

1. **Personalkollen API token** — customer grants in PK admin; we connect via `/integrations`.
2. **Trigger PK sync** — pulls last 90 days of revenue + shift data into our DB.
3. **Run hourly backfill** — `scripts/backfill-hourly-metrics.mjs <business_id> 90` populates the hourly_metrics table.
4. **Verify daily forecaster generates** — `/api/forecasts/today` returns predictions for next 7 days.
5. **Verify hourly forecaster on `/scheduling` works** — `/api/scheduling/ai-suggestion` returns meal-period predictions.
6. **Email customer the dashboard link + a Loom video walking through what they're seeing** — 3 minutes max.

### What customer experiences

- Logs in to `/dashboard`, sees their actual revenue chart for the last 30 days
- Sees the predicted revenue line projecting next 7 days
- Sees the "Why this week's numbers" attribution panel below the chart
- Opens `/scheduling` → Day-by-day list → sees the rota visualization with demand curve and (where applicable) staff shifts overlaid
- Receives the first weekly memo email by end of week

### Required customer artifacts

None at this milestone (delivered during pre-onboarding).

### Exit criterion

✓ Last 30 days of revenue visible in `/dashboard` · ✓ Forecast line shows for next 7 days · ✓ First weekly memo email delivered · ✓ Customer has logged in at least once and confirmed seeing their data · ✓ M2 review call scheduled

### Common failure modes (and fixes)

- **PK token revoked between grant and sync** → re-issue, re-sync
- **PK has < 30 days of history** → forecaster runs in short-history mode; communicate this is expected and accuracy improves over time
- **Day-of-week pattern looks weird** → check anomaly_alerts table for flagged dates; ask customer about any unusual events (closures, promotions) in the window

---

## 6. Milestone 2 — Scheduling AI active + hours-saved visible (Day 12)

### Goal
The customer sees specific cut recommendations per meal period and has reviewed at least one full week of suggested cuts.

### What we do

1. **Confirm scheduling AI flag is on** — default ON for new customers; verify per the feature flag table.
2. **Walk through the rota view** — 30-min call with Champion, screen-share through Day-by-day list, explain demand curve + staff bars + cut recommendations
3. **Explain asymmetric policy** — we ONLY recommend cuts, never adds. Operator judgment on adding hours is preserved.
4. **Tag any anomaly dates** — confirmed anomalies feed back into the forecaster.
5. **Set up the Monday memo** — auto-send config + email address verification.

### What customer experiences

- Reviews the per-meal-period cut recommendations for the upcoming week (e.g. "Lunch cut 4h Tue, save 1,200 kr")
- Decides which cuts to apply via Personalkollen (the recommendations DON'T edit PK directly; the customer remains in control)
- Sees the Monday memo land in their inbox with 3 actions for the week

### Required customer artifacts

- **Confirmed anomaly dates** — any unusual revenue days they want excluded from forecaster baseline (one-off events, private functions, equipment failures, etc.)

### Exit criterion

✓ Customer has reviewed at least one full week of cut recommendations · ✓ Monday memo delivered + acknowledged · ✓ At least one cut applied (or formally declined with reasoning) · ✓ M3 review call scheduled

### Common failure modes (and fixes)

- **Cut recommendation seems too aggressive** → check the per-meal-period P75 rev/hour proxy. If history has anomalously busy days driving the P75, exclude them via the anomaly mechanism.
- **No cut recommendations appear** → either confidence is `low` (cold-start; needs more data) OR scheduled hours are already lean (no overstaffing detected; this IS the right answer).
- **Customer wants to ADD hours instead** → acknowledge the model can't help with adds (asymmetric policy is intentional, explained in the rota's reasoning line)

---

## 7. Milestone 3 — Fortnox + drilldown + revisor view (Day 21)

### Goal
The customer's Fortnox is connected, last 12 months of P&L is backfilled, and cost-flag drilldown reveals source invoices.

### What we do

1. **Trigger Fortnox OAuth** — customer authorizes via `/integrations`; we apply the `archive + inbox + connectfile` scope set required for PDF access (per memory `reference_fortnox_scopes`).
2. **Confirm business_id is correctly bound** — must be non-null per `feedback_fortnox_business_id_required`. Use the business-selector modal flow to ensure the customer confirms which business the connection belongs to.
3. **Trigger 12-month backfill** — `/api/cron/fortnox-backfill-worker` claims and runs. Takes 2-5 minutes typically.
4. **Verify the audit ledger** — backfill_status='completed', backfill_finished_at populated, tracker_data rows present for each of the last 12 months.
5. **Set up the revisor account** — read-only access for the customer's external accountant. (Revisor view is part of the Group tier and above; Solo tier customers get the full dashboard themselves.)
6. **Walk through `/overheads/review`** — Champion sees flagged costs, drills into individual supplier invoices via "Show invoices" → can open the actual PDF in a new tab.

### What customer experiences

- Sees 12 months of historical P&L in `/financials/performance`
- Sees flagged overhead anomalies in `/overheads/review` with one-click drilldown to source invoice
- Can show their revisor the read-only view and have them validate the BAS classification
- The "Why this week's numbers" panel now has access to richer history (12 months vs 30 days)

### Required customer artifacts

- **Revisor email address** (if Group tier+) — used to send the read-only invite

### Exit criterion

✓ Fortnox 12-month backfill complete · ✓ At least one overhead drilldown executed (Champion sees a supplier invoice PDF) · ✓ Revisor view active (if applicable) · ✓ M4 review call scheduled

### Common failure modes (and fixes)

- **OAuth fails with `fortnox_invalid_state`** → base64url encoding issue. Memory `feedback_fortnox_oauth_state_encoding` documents this. Should be solved in production but watch for it on new edge cases.
- **Backfill stuck at "pending"** → the cron worker probe runs every 5 minutes; just wait. If stuck >30 min, manually trigger via admin tools.
- **Drilldown 401s** → token expired between OAuth and first drilldown call. Memory `feedback_fortnox_token_refresh_required` — must use `getFreshFortnoxAccessToken()`. Already fixed; flag if it recurs.

---

## 8. Milestone 4 — First full monthly close cycle (Day 30-45)

### Goal
The customer has completed a full month using CommandCenter and has a documented before/after on at least one of: labour %, food waste, monthly close time, or forecast accuracy.

### What we do

1. **Run month-end aggregation** — daily 06:30 UTC cron handles this; verify it ran successfully for the customer's month.
2. **Send the AI-generated monthly summary** — narrative version of the P&L with attribution (what drove the variance from forecast, what to act on next month).
3. **Hold the M4 review call** — 45 min with PoC + Champion + (where applicable) the revisor. Walk through the month, compare to baseline, document outcomes.
4. **Lock in the case-study data points** — confirm rights to use the numbers + logo + quote in published case studies. Standard rate continues; the deal is the quarterly review touchpoint + public visibility.
5. **Set the cadence** — monthly check-ins for the next quarter, quarterly reviews thereafter.

### What customer experiences

- Receives the AI monthly summary in their inbox + dashboard
- Sees the month-over-month comparison in `/financials/performance`
- Has a concrete answer to "did CommandCenter pay for itself this month?"
- (If they signed up for the public case-study deal) their logo appears on the comandcenter.se trust strip within 30 days

### Required customer artifacts

- **Pre-CommandCenter baseline numbers** for whatever metric is being compared. Ideally captured at kick-off; re-confirm at M4 if missing.
- **Quote** — 1-2 sentence quote from the PoC about a specific outcome. Used in the case study.

### Exit criterion

✓ Monthly summary delivered and read · ✓ M4 review call held + outcomes documented · ✓ Case-study rights agreed or formally declined · ✓ Next-quarter cadence agreed

---

## 9. After M4 — steady-state cadence

### Monthly (Paul → customer)
- Auto-generated monthly summary lands by the 3rd of the following month
- Paul sends a 2-sentence email asking if there's anything they want to discuss

### Quarterly (live call, 30 min)
- Customer success review: labour %, food %, forecast accuracy delta from baseline
- Customer feedback: what's working, what's missing, any feature requests
- Document outcomes for ongoing case-study refresh
- For Group + Chain tiers: review per-location performance

### On-request (no SLA in writing — keep flexible)
- Customer Slack/email channel for questions
- Aim to respond within 4 business hours during EU working hours
- Bugs reported during quarterly call get a fix or roadmap commitment within 14 days

### Renewal (every 12 months)
- 60 days out: confirm continued fit, review pricing tier (have they grown to a new tier?)
- 30 days out: send renewal terms

---

## 10. What we measure — internal scorecard per customer

Tracked per-customer in our admin tools. Becomes the customer success dashboard once we have 5+ customers.

| Metric | Pre-onboarding | M1 | M2 | M3 | M4 | Q+1 |
|---|---|---|---|---|---|---|
| Labour % (target ≤ 35%) | baseline | — | first observation | — | first close | quarterly review |
| Food % (target ≤ 31%) | baseline | — | — | first Fortnox close | first full close | quarterly review |
| Forecast accuracy (MAPE) | n/a | n/a (cold-start) | first measurement | — | 30-day rolling | rolling |
| Time-to-close (days) | baseline | — | — | first close | full cycle | quarterly review |
| Customer NPS-style 0-10 | n/a | — | "how was getting started?" | — | "would you recommend?" | quarterly |
| Customer support tickets (count) | n/a | — | — | — | sum | quarterly |

The aggregated dashboard across all customers tells us where the playbook needs improving. If 3 customers in a row stall at M2 because cut recommendations seem wrong, that's a forecaster issue. If 3 stall at M3 because Fortnox is confusing, that's a flow issue.

---

## 11. Failure modes — what to do when implementation stalls

### Customer goes dark for > 2 weeks
- Send a 1-line email: "Are we still good? Anything blocking?"
- If no response in 5 days, escalate to call.
- If no response in 14 days, pause and re-engage with: "We're keeping your access live; happy to restart when you're ready."

### Integration fails repeatedly (PK or Fortnox)
- Don't push past M1 / M3 with broken integrations. Pause the milestone, get the integration solid, then resume.
- We do not move to dependent milestones with broken upstream data.

### Customer says "this isn't working for us"
- Schedule a call within 2 business days.
- Listen first; identify whether it's:
  - **Mismatch** — the product doesn't solve their #1 pain (refund + part ways gracefully)
  - **Friction** — the product solves it but the UX/learning curve is in the way (extra support call, custom walkthrough)
  - **Edge case** — their setup has a quirk we haven't handled (file the bug, ship a fix if 2-3 weeks)
- Document the reason. Pattern across 2+ customers becomes a roadmap item.

### Customer wants more than the product does
- Acknowledge the gap honestly. Tell them the roadmap timing.
- For groups: offer a quarterly review where they propose feature priorities. We won't promise but we'll listen.

---

## 12. Public-facing version (Phase B.1 deliverable)

This document is the internal v0.1. The public-facing version at `/implementering`:
- Drops the failure-mode section (operator-facing version assumes happy path)
- Drops the internal scorecard (Section 10)
- Adds customer quotes from Vero + Rosali at the milestone boundaries ("after M2, we cut 12h from our Friday rota and saved 4,200 kr — Vero owner")
- Adds a visual timeline graphic + the milestone icons used in marketing
- Localized to SE first, EN second

Owner of the public-facing version: Paul + landing-page contractor.

---

## 13. Open questions / next iteration

- **Should there be a M0 "trial" period?** — Currently customers start paying from the contract sign. We could offer a 14-day trial where they see M1 outputs without committing. Argument for: reduces buyer risk further. Argument against: serious operators don't need a trial; trial-shopping attracts the wrong customers.
- **Do we need a M3 → M4 buffer for Fortnox close cycles that don't align to calendar month?** — Some businesses have non-calendar fiscal months. We probably won't hit this until customer #10+.
- **How do we handle Group customers where locations are at different milestones?** — Treat each location as its own implementation track? Or run them in parallel under one Group banner? Likely the latter for sanity, but explicit treatment will be needed when we onboard a first multi-location customer.

---

*Revisit when we hit 5 paying customers. The structure should hold; the timings + customer quotes will refine.*
