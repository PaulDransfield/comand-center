// lib/constants/tokens.ts
//
// UX redesign tokens. ADDITIVE ONLY — do not replace colors.ts. The existing
// colors.ts / globals.css stay in use for non-redesigned surfaces; everything
// migrated to the new system references `UX` from this file.
//
// Source of truth: DESIGN.md § Design tokens.

export const UX = {
  // Surfaces
  pageBg:      '#f9fafb',
  cardBg:      '#ffffff',
  subtleBg:    '#fafbfc',
  border:      '#e5e7eb',
  borderSoft:  '#f3f4f6',

  // Text — use these, not raw hex inline
  ink1:        '#111827',  // primary — hero, KPI values, day names
  ink2:        '#374151',  // body copy
  ink3:        '#6b7280',  // secondary labels
  ink4:        '#9ca3af',  // tertiary, axis ticks, eyebrows
  ink5:        '#d1d5db',  // separators, disabled

  // Brand & accent
  navy:        '#1a1f2e',  // revenue bars, primary buttons, KPI values
  navyDeep:    '#0f1320',  // sidebar bg
  indigo:      '#6366f1',  // AI / forecast / predicted / links
  indigoLight: '#a5b4fc',  // predicted-stripe accent
  indigoBg:    '#eef2ff',  // light fill for AI tags
  indigoTint:  'rgba(99,102,241,0.14)',  // active nav state

  // Labour / cost — burnt orange (intentionally NOT the existing amber,
  // to distinguish from warning status)
  burnt:       '#c2410c',
  burntBg:     'rgba(194,65,12,0.28)',

  // Semantic — good / warning / bad
  greenInk:    '#15803d',
  greenBg:     '#dcfce7',
  greenBorder: '#bbf7d0',
  greenSoft:   '#eaf3de',
  amberInk:    '#d97706',
  amberInk2:   '#854f0b',
  amberBg:     '#fef3c7',
  amberBorder: '#fde68a',
  amberSoft:   '#faeeda',
  redInk:      '#dc2626',
  redInk2:     '#991b1b',
  redBg:       '#fee2e2',
  redBorder:   '#fecaca',
  redSoft:     '#fef2f2',

  // Margin line — brighter than CC_GREEN for contrast against navy bars
  marginLine:  '#16a34a',

  // Typography
  fsHero:      17,   // hero h1
  fsSection:   13,   // card titles
  fsBody:      12,   // default body
  fsLabel:     11,   // sub-labels, legend
  fsMicro:     10,   // eyebrow, column headers
  fsNano:       9,   // axis ticks

  fwMedium:    500,  // "bold" — headings, values, labels
  fwRegular:   400,  // body

  // Layout
  r_sm:        4,
  r_md:        6,
  r_lg:        10,
  sidebarW:    148, // expanded
  sidebarWCol: 52,  // collapsed icon-only

  shadowPop:   '0 8px 24px rgba(0,0,0,0.08)',
  shadowPill:  '0 1px 2px rgba(0,0,0,0.06)',
} as const

export type UxToken = keyof typeof UX
