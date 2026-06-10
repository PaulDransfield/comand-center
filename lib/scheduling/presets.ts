// lib/scheduling/presets.ts
//
// Source-aware presentation presets for the scheduling grid (Phase 3 of
// docs/CASPECO-SCHEDULING-INTEGRATION-PLAN.md).
//
// The grid renders ONE canonical data model (staff_profiles / staff_shifts /
// staff_shift_templates) regardless of where the roster came from. This
// preset is the thin presentation layer that makes the grid feel native to
// whichever system the customer already uses:
//   · Personalkollen customers see a PK-shaped grid (shift/period-centric).
//   · Caspeco customers see a Caspeco-shaped grid (staff/station-centric).
// Same component, different labels + default view. No forks.
//
// Keep this purely cosmetic — anything that changes DATA belongs in the
// adapters (pk-sync / caspeco-sync), not here.

export type SchedulingSource = 'personalkollen' | 'caspeco' | null | undefined

export interface SchedulingPreset {
  /** Resolved source key (never null — falls back to 'generic'). */
  source:          'personalkollen' | 'caspeco' | 'generic'
  /** Human label for the badge ("Synced from …"). null = no badge. */
  sourceLabel:     string | null
  /** Which view opens first when the owner hasn't explicitly chosen one. */
  defaultView:     'shift' | 'staff'
  /** View-toggle button labels. */
  shiftViewLabel:  string
  staffViewLabel:  string
  /** Terminology for the shift-template grouping (PK "period", Caspeco "station"). */
  templateNoun:        string
  templateNounPlural:  string
  /** Terminology for the work-area grouping. */
  sectionNoun:     string
}

const PERSONALKOLLEN: SchedulingPreset = {
  source:             'personalkollen',
  sourceLabel:        'Personalkollen',
  defaultView:        'shift',          // PK is period/shift-centric
  shiftViewLabel:     'By shift',
  staffViewLabel:     'By staff',
  templateNoun:       'period',
  templateNounPlural: 'periods',
  sectionNoun:        'section',
}

const CASPECO: SchedulingPreset = {
  source:             'caspeco',
  sourceLabel:        'Caspeco',
  defaultView:        'staff',          // Caspeco is staff/station-centric
  shiftViewLabel:     'By station',
  staffViewLabel:     'By staff',
  templateNoun:       'station',
  templateNounPlural: 'stations',
  sectionNoun:        'station',
}

// Neutral fallback when the source is unknown (legacy businesses, or the
// scheduling_source column not set). Keeps the historical PK-style defaults.
const GENERIC: SchedulingPreset = {
  source:             'generic',
  sourceLabel:        null,
  defaultView:        'shift',
  shiftViewLabel:     'By shift',
  staffViewLabel:     'By staff',
  templateNoun:       'shift',
  templateNounPlural: 'shifts',
  sectionNoun:        'section',
}

export function getSchedulingPreset(source: SchedulingSource): SchedulingPreset {
  if (source === 'personalkollen') return PERSONALKOLLEN
  if (source === 'caspeco')        return CASPECO
  return GENERIC
}
