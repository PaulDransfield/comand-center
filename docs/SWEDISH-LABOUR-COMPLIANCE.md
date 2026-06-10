# Swedish Labour Compliance — scheduling AI

> Encoded source of truth: `lib/scheduling/labor-rules-sweden.ts`
> Consumers: the scheduling AI prompt (`lib/ai/rules.ts` → `/api/scheduling/ai-recommend`) and the pre-publish compliance engine (`lib/scheduling/compliance.ts`).
> Last verified against sources: 2026-06.

This is the "guide" the scheduling AI is built from. Three layers, each with the authoritative citation. **Statute applies to everyone; the agreement applies when the business is bound by it; the minor rules can never be weakened by any agreement.**

---

## 1. Statute — Arbetstidslagen (1982:673)

Applies to **every** employer regardless of collective agreement. Source: [riksdagen.se — Arbetstidslag (1982:673)](https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/arbetstidslag-1982673_sfs-1982-673/), explained at [av.se — Om arbetstidslagen](https://www.av.se/arbetsmiljoarbete-och-inspektioner/lagar-och-regler-om-arbetsmiljo/om-arbetstidslagen/).

| Rule | Section | Value | Encoded as |
|---|---|---|---|
| Dygnsvila (daily rest) | §13 | ≥11h continuous per 24h; should include 00:00–05:00 | `STATUTE.MIN_DAILY_REST_H = 11` → compliance CHECK 1 (HARD) |
| Veckovila (weekly rest) | §14 | ≥36h continuous per 7-day period, preferably weekend | `STATUTE.MIN_WEEKLY_REST_H = 36` → compliance CHECK 2 (HARD, via consecutive-days proxy) |
| Ordinarie arbetstid | §5 | 40h/week | `STATUTE.ORDINARY_WEEKLY_H = 40` (contract-floor math) |
| Sammanlagd arbetstid | §10b | ≤48h/week averaged over 4 months | `STATUTE.MAX_WEEKLY_H = 48` → compliance CHECK 3 (HARD) |
| Rast (break) | §15 | No one works >6h without a rast | `STATUTE.RAST_AFTER_H = 6` → compliance CHECK 5 (WARN) |

---

## 2. Agreement — Visita–HRF "Gröna Riksavtalet"

Applies when the business is a **Visita member** or has a **hängavtal with HRF**. (Chicce: yes.) Source: [Gröna Riksavtalet 2025-04-01 – 2027-03-31 (hrf.net PDF)](https://www.hrf.net/app/uploads/2025/05/Grona-riksen-2025-2027.pdf).

Adds **on top of** statute:

| Rule | Value | Encoded as |
|---|---|---|
| **Max working time per 24h** | **10h** (excl. breaks) — stricter than statute, which has no fixed cap | `AGREEMENT_VISITA_HRF.MAX_HOURS_PER_24H = 10` → compliance CHECK 7 (HARD, agreement-only) |
| Ordinary weekly | 40h/week average | same as statute |
| Daily / weekly rest | 11h / 36h | affirms statute |

### OB — obekväm arbetstid (inconvenient-hours premium)

OB is paid as a **fixed kr/hour** (26.79 kr/h from 2025-04-01; 27.59 kr/h from 2026-04-01 — [hrf.net/din-lon/ob-tillagg](https://www.hrf.net/din-lon/ob-tillagg/)), **not a percentage**. Per owner decision we use **relative awareness** only — the AI knows which hours carry the premium and prefers trimming them; we don't store the tariff (it changes each agreement period).

**Bands (when OB applies):**

| Day | OB window |
|---|---|
| Mon–Fri | 20:00 → 06:00 (next day) |
| Saturday (+ midsommar-/jul-/nyårsafton) | 16:00 → 06:00 |
| Sunday & public holidays | all day (06:00 → 06:00) |
| Night premium (extra) | 01:00 – 06:00 every day |

Because every evening band runs to 06:00, **00:00–06:00 is always OB**. Implemented in `obBreakdownForShift()` (uses the `lib/holidays` Swedish calendar for the Sunday/helgdag classification) which returns `{ ob_hours, night_hours, ob_fraction }` per shift for cost-weighting and UI tooltips.

---

## 3. Minors — Minderårigas arbetsmiljö (AFS 2012:3)

For under-18s who have completed year 9 (the realistic restaurant case: ungdom 16–17). **A collective agreement can NOT weaken these** ([av.se — Arbetstider för minderåriga](https://www.av.se/arbetsmiljoarbete-och-inspektioner/arbetsgivarens-ansvar-for-arbetsmiljon/minderariga-arbetstagare/arbetstider-for-minderariga/), [AFS 2012:3 PDF](https://www.av.se/globalassets/filer/publikationer/foreskrifter/minderarigas-arbetsmiljo-foreskrifter-afs2012-3.pdf)).

| Rule | Value | Encoded as |
|---|---|---|
| Night-free | 22:00–06:00 (or 23:00–07:00) work-free | `MINOR.NIGHT_FREE_START/END` → compliance CHECK 8a (HARD) |
| Daily rest | ≥12h (may shorten to 11h if shift ends 22–24 or starts 05–07) | `MINOR.MIN_DAILY_REST_H = 12` |
| Max per day | 8h | `MINOR.MAX_HOURS_PER_DAY = 8` → CHECK 8b (HARD) |
| Max per week | 40h | `MINOR.MAX_WEEKLY_H = 40` → CHECK 8c (HARD) |
| Weekly rest | ≥2 days per 7-day period | `MINOR.MIN_WEEKLY_REST_DAYS = 2` |

Gated off by default. Fire when `LaborConfig.enforce_minor_rules = true` **and** the staff member is flagged `is_minor`.

---

## How the AI uses this

`swedishLabourCompliance(config)` in `lib/ai/rules.ts` renders the active rules into the scheduling system prompt (`/api/scheduling/ai-recommend`). The AI is told:
- the **hard limits** it must never break with an extend/reassign/swap (cuts can only *increase* rest, so cuts are always safe);
- the **OB bands**, so when two cuts save similar coverage it prefers the one removing more OB hours (saves more kr) and mentions OB in its reasoning.

This sits alongside the existing **cuts-only asymmetry** rule (`SCHEDULING_ASYMMETRY`).

## Per-business config (`LaborConfig`)

```ts
{ agreement: 'visita_hrf' | 'hangavtal_hrf' | 'none',  // default visita_hrf
  enforce_minor_rules: boolean,                          // default false
  // optional numeric overrides (default to statute/agreement) }
```

Read defensively from `businesses.scheduling_labor_config` (JSONB) when present, else `DEFAULT_LABOR_CONFIG`.

## Shipped (2026-06-10)

- **Schema (M149)** — `businesses.scheduling_labor_config JSONB` + `staff_profiles.is_minor boolean` + `staff_profiles.birth_date date`. Applied.
- **Settings UI** — `/settings/scheduling` (link card on `/settings`): pick the collective agreement, toggle minor enforcement, and tag under-18 staff. API: `/api/settings/labor-rules` (GET/POST).
- **Wiring** — `/api/scheduling/week` returns `labor_config` + per-staff `is_minor`; the pre-publish review panel (`app/scheduling/page.tsx`) passes both into `runCompliance`, so CHECK 7 (10h/24h) and CHECK 8 (minors) actually fire. `/api/scheduling/ai-recommend` reads `scheduling_labor_config` and renders the matching rules into the prompt.
- **Auto-flag minors (PK)** — `refreshStaffProfiles` in `lib/scheduling/pk-sync.ts` derives `birth_date` + `is_minor` from the PK staff personnummer/birth field (best-effort, multi-field probe), and **preserves a manual flag** when PK exposes no birth date.

## Follow-ups

1. **Caspeco auto-flag** — `caspeco_employees.personal_identity` carries the personnummer; wire the same derivation when a Caspeco-sourced business populates `staff_profiles` (Chicce is PK-based, so already covered).
2. **UI polish** — surface CHECK 7/8 violations distinctly in the review panel and show per-shift OB share on grid cells (engine + `obBreakdownForShift()` ready).
3. **Veckovila** — CHECK 2 uses a consecutive-days proxy; a true rolling 36h-continuous-rest check is a refinement.
4. **OB exactness** — if precise savings ever matter, switch OB from relative to the tariff kr/h (owner-confirmed), keeping the same band logic.
