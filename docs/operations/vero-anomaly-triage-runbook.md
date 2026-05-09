# Vero Anomaly Triage Runbook

> Operations runbook for the one-time triage call with Vero's operator.
> Generated 2026-05-09 as part of Piece 0 of the prediction-system rebuild.
> Estimated call length: 20-30 minutes.

---

## Why this matters

The prediction-system reconciler (Piece 1, ~3 weeks out) needs to know which past anomalies were **real one-off events** (e.g. a contract renewal that genuinely shifted OB-supplement spend) vs **false alarms** (e.g. a one-day spike that wasn't anything meaningful).

- "Real" anomalies → the reconciler **excludes that day's actuals from baseline computations**, so a freak day doesn't pollute the rolling averages used to build the next forecast.
- "False alarm" anomalies → the day stays in baselines.

Without this triage, the reconciler has nothing to filter on. Vero is the only customer at this stage, so this is the single conversation that calibrates the model.

---

## Pre-flight checklist (you, before the call)

1. Apply M053 + M058 in Supabase (M053 adds the workflow columns; M058 auto-resolves the step-change continuations so the operator only sees ONE alert per pattern, not 14).
2. Flip `PREDICTION_V2_ANOMALY_CONFIRM_UI = true` for Vero Italiano in `business_feature_flags`:
   ```sql
   INSERT INTO business_feature_flags (org_id, business_id, flag, enabled, set_by)
   VALUES (
     'e917d4b8-635e-4be6-8af0-afc48c3c7450',
     '0f948ac3-aa8e-4915-8ae0-a6c4c11ddf99',
     'PREDICTION_V2_ANOMALY_CONFIRM_UI',
     true,
     'paul-pre-triage'
   )
   ON CONFLICT (business_id, flag) DO UPDATE SET enabled = EXCLUDED.enabled;
   ```
   (Repeat for Rosali Deli `97187ef3-b816-4c41-9230-7551430784a7` if doing both businesses.)
3. Open `https://comandcenter.se/alerts` yourself and confirm the Confirm/Reject buttons render. If they don't, the flag isn't applied — re-check the SQL.
4. Run this query and paste the output below for the call:
   ```sql
   SELECT
     a.id, a.alert_type, a.severity, a.title, a.description,
     a.metric_value, a.expected_value, a.deviation_pct, a.period_date,
     a.confirmation_status, a.confirmation_notes,
     b.name AS business_name
   FROM anomaly_alerts a
   JOIN businesses b ON b.id = a.business_id
   WHERE a.org_id = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
     AND a.is_dismissed = false
     AND a.confirmation_status = 'pending'
   ORDER BY b.name, a.period_date DESC;
   ```
5. Schedule the call. Put both Vero Italiano + Rosali Deli operators on if possible (you can triage either business in either direction).

---

## The triage list

> **Paste the output of the query above here BEFORE the call so the runbook is self-contained for future reference.**

```
[paste rows here when running this for real]
```

Pre-M058 expected count: ~14 pending alerts.
Post-M058 expected count: ~1-2 pending per (business, alert_type) group.

---

## Walking through each alert

For each `pending` row above, ask the operator:

> "On {period_date} we detected {title}. The system saw {metric_value} when it expected {expected_value} ({deviation_pct} above pattern). Was this a real one-off — say, a contract change, holiday party, equipment breakdown — or was it just normal variation?"

Then click one of:

- **Yes — exclude from baseline predictions.** Real event. Future forecasts won't lean on this day.
  - Notes: write a one-liner the reconciler can preserve in the audit log. Examples: "Contract renewal — new OB rate took effect", "Sportlov week — high family lunch traffic", "Server failure cancelled evening service".
- **No — this was a normal day.** False alarm. Day stays in baselines. The detector's 7d-vs-28d threshold may need tuning if these come back; surface that to the engineering team.
  - Notes: optional. Useful examples: "Variation within seasonal pattern", "Detector's threshold too tight on quiet weekdays".

If the operator says "I don't remember" → leave it `pending` and move on. Better to have one unresolved row than to fabricate a confirmation. Re-visit at the next monthly review.

---

## Special cases

### OB-supplement step-change

If the operator says "yes, this is real — we changed our OB rate in March":
1. Click **Confirm** on the earliest alert with notes like "OB rate change — new contract effective 2026-03-XX."
2. The detector's auto-resolution (D.5) will mark all subsequent OB alerts within 14 days as `auto_resolved` automatically.
3. After 14 days, if the system fires another OB alert, it'll be a fresh fire — confirm again if it's still the same thing, or treat it as new if a different driver.

### Multiple businesses, different stories

If Vero Italiano confirms an OB-supplement step-change but Rosali Deli's similar alert is genuinely a one-off (e.g. one bad night), confirm Vero, reject Rosali. The reconciler scopes to `business_id` so there's no cross-talk.

### Operator wants to reverse a decision

A confirmed alert can be re-decided — the UI hides the buttons after first decision, but you (admin) can clear the row's status back to `pending` via direct SQL:
```sql
UPDATE anomaly_alerts
SET confirmation_status = 'pending', confirmed_at = NULL, confirmed_by = NULL, confirmation_notes = NULL
WHERE id = '...';
```

This is intentionally not exposed in the UI to avoid accidental reversal during the call.

---

## Post-call

1. Verify zero `pending` rows for events more than 14 days old:
   ```sql
   SELECT COUNT(*)
   FROM anomaly_alerts
   WHERE org_id = 'e917d4b8-635e-4be6-8af0-afc48c3c7450'
     AND is_dismissed = false
     AND confirmation_status = 'pending'
     AND period_date < CURRENT_DATE - INTERVAL '14 days';
   ```
   Should return 0. Anything older than 14 days that's still pending was probably forgotten — re-prompt the operator or auto-resolve with a note.
2. Email yourself a one-paragraph summary of what got confirmed vs rejected, with the operator's narrative for any meaningful confirms. This is the input to the prediction-system audit ledger when Piece 1 ships.
3. Add the Vero-specific operator quotes to `CLAUDE.md` if any patterns generalise across customers (e.g. "operators consistently confirm OB step-changes within 1-2 days of contract renewal" → useful future detector heuristic).

---

## When to re-run this runbook

- After a contract change at Vero (new POS, new payroll system, opening hours change) — predict the next ~30 days will produce a fresh batch of "real anomaly" alerts that need confirmation.
- When customer #2 onboards — they'll have their own backlog from the moment anomaly-check runs against their data.
- Quarterly as a hygiene check — make sure no `pending` rows have stagnated past the 14-day window.

---

## Linked artefacts

- `sql/M053-ANOMALY-CONFIRMATION-WORKFLOW.sql` — schema migration
- `sql/M058-VERO-OB-AUTO-RESOLVE-BACKFILL.sql` — pre-call backfill
- `lib/alerts/detector.ts` — step-change auto-resolution logic
- `app/alerts/page.tsx` — operator-facing UI
- `app/api/alerts/route.ts` — confirm/reject API actions
- `PREDICTION-SYSTEM-ARCHITECTURE-2026-05-08-v3.md` Appendix Z — Streams D + E
