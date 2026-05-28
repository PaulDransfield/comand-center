// lib/constants/tokens.ts
//
// UX redesign tokens. ADDITIVE ONLY — do not replace colors.ts. The existing
// colors.ts / globals.css stay in use for non-redesigned surfaces; everything
// migrated to the new system references `UX` from this file.
//
// Source of truth: DESIGN.md § Design tokens.

// ── Pastel-lavender system (UXP) — ADDITIVE ALONGSIDE `UX` ──────────
//
// Phase 1 of the UI overhaul. New surfaces consume `UXP.*`; legacy
// surfaces continue on `UX.*` and `colors.ts` until each page is
// migrated. Do NOT edit `UX` or `colors.ts` while migrating.
export const UXP = {
  pageBg:     '#f1eff9',
  cardBg:     '#ffffff',
  subtleBg:   '#faf9fd',
  border:     'rgba(58,53,80,0.08)',
  borderSoft: 'rgba(58,53,80,0.05)',

  ink1: '#3a3550',
  ink2: 'rgba(58,53,80,0.62)',
  ink3: 'rgba(58,53,80,0.45)',
  ink4: 'rgba(58,53,80,0.38)',

  lav:     '#a99ce6',
  lavDeep: '#7d6cc9',
  lavText: '#564a8a',
  lavFill: '#ece8f8',
  lavMid:  '#c4b8ec',
  lavPale: '#d8d2f0',

  green:     '#5f9e7e',
  greenDeep: '#477f60',
  greenFill: '#eef4f0',
  greenBar:  '#4f9b76',

  coral:     '#c0703a',
  coralLine: '#e7a37e',
  costAmber: '#b0883c',

  rose:     '#c06a72',
  roseFill: '#f7dee0',
  roseText: '#b0454e',

  slate:     '#7a7782',
  slateFill: '#efeef2',

  r_sm:  6,
  r_md:  8,
  r_lg:  12,
  railW: 46,

  // ── Polish tier — added 2026-05-28 for the dashboard polish pilot.
  // Additive only; existing surfaces keep using their inline values until
  // they opt in. See POLISH-ROADMAP.md for the rollout plan.

  // Elevation. Hairline border + a whisper of shadow gives depth without
  // looking heavy on the pastel-lavender background. Use shadowSoft for
  // static surfaces (banners, secondary cards), shadowCard for the primary
  // content cards, shadowLift for hover/active states later.
  shadowSoft: '0 1px 2px rgba(58,53,80,0.04)',
  shadowCard: '0 1px 3px rgba(58,53,80,0.05), 0 1px 2px rgba(58,53,80,0.03)',
  shadowLift: '0 4px 14px rgba(58,53,80,0.08), 0 1px 3px rgba(58,53,80,0.04)',

  // Typography scale — one canonical reference. The dashboard hardcodes
  // these numbers today (9, 11, 12, 13, 17, 24); listing them here makes
  // them grep-able and consistent when other pages migrate.
  fsMicro:   9,
  fsLabel:   11,
  fsBody:    12,
  fsSection: 13,
  fsTitle:   17,
  fsHero:    24,

  fwRegular:  400,
  fwMedium:   500,
  fwSemibold: 600,

  // Motion. Snappier than the legacy 150ms default; uses a smooth-out
  // curve so interactions feel responsive rather than easing into place.
  motionFast: '120ms cubic-bezier(0.2, 0, 0.2, 1)',
  motionMed:  '180ms cubic-bezier(0.2, 0, 0.2, 1)',
} as const

// Z-index scale. Use these instead of raw numbers so the stacking order
// stays predictable across modals, tooltips, banners, and overlays.
// Audit (2026-05-25) found values ranging 50/100/199/200/1000 across the
// codebase — confusing and brittle on mobile where multiple panels stack.
export const Z = {
  sticky:    10,    // sticky page headers, fixed tables
  rail:      20,    // sidebar / RailNav (above page content, below banners)
  banner:    50,    // BrokenIntegrationBanner, AiUsageBanner, ConsentBanner
  dropdown:  100,   // toolbar dropdowns, autocomplete menus
  backdrop:  199,   // modal scrim (immediately below modal)
  modal:     200,   // slide-in panels, dialog cards
  tooltip:   300,   // hover tooltips (above all)
  toast:     400,   // ephemeral notifications (highest)
} as const

export type UxpToken = keyof typeof UXP

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
