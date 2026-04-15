// lib/constants/colors.ts
// Single source of truth for all colours across CommandCenter
// Import this in every page — never define colours inline

// ── Brand colours ─────────────────────────────────────────────
export const CC_DARK   = '#1a1f2e'  // Primary dark — buttons, headings
export const CC_PURPLE = '#6366f1'  // Accent — links, highlights
export const CC_GREEN  = '#10b981'  // Success / positive
export const CC_RED    = '#dc2626'  // Error / negative
export const CC_AMBER  = '#d97706'  // Warning
export const CC_GREY   = '#9ca3af'  // Muted text

// ── Status colours ─────────────────────────────────────────────
export const STATUS = {
  connected:    { bg: '#f0fdf4', border: '#bbf7d0', text: '#15803d', dot: '#10b981' },
  error:        { bg: '#fef2f2', border: '#fecaca', text: '#dc2626', dot: '#dc2626' },
  warning:      { bg: '#fffbeb', border: '#fde68a', text: '#92400e', dot: '#d97706' },
  disconnected: { bg: '#f9fafb', border: '#e5e7eb', text: '#9ca3af', dot: '#d1d5db' },
}

// ── KPI card style ─────────────────────────────────────────────
// Use this object for ALL KPI cards across every page
export const KPI_CARD: React.CSSProperties = {
  background:   'white',
  border:       '0.5px solid #e5e7eb',
  borderRadius: 12,
  padding:      '14px 16px',
}

// ── Department colours ─────────────────────────────────────────
// Covers ALL known departments across ALL businesses
// Add new departments here when new customers join
// Unknown departments automatically get a colour from DEPT_PALETTE
export const DEPT_COLORS: Record<string, string> = {
  // Vero Italiano departments
  'Bella':           '#f59e0b',
  'Chilango':        '#10b981',
  'Carne':           '#ef4444',
  'Runner':          '#8b5cf6',
  'Administration':  '#6366f1',
  'Ölbaren':         '#3b82f6',
  'Olbaren':         '#3b82f6',
  'Bubbel & Brus':   '#06b6d4',
  'Rosalis Select':  '#f97316',
  'Sandwichtitos':   '#84cc16',

  // Rosali Deli departments
  'Kök':             '#ec4899',
  'Servering':       '#14b8a6',
  'zPizza':          '#f97316',
  'Klistret':        '#a855f7',
  'Drive':           '#0ea5e9',
  'Bar':             '#84cc16',

  // Generic departments any restaurant might use
  'Kitchen':         '#ec4899',
  'Front of House':  '#14b8a6',
  'Management':      '#6366f1',
  'Events':          '#f59e0b',
  'Delivery':        '#0ea5e9',
}

// Fallback palette for unknown departments — cycles through these
export const DEPT_PALETTE = [
  '#f59e0b', '#10b981', '#3b82f6', '#ef4444',
  '#8b5cf6', '#06b6d4', '#f97316', '#84cc16',
  '#ec4899', '#14b8a6', '#a855f7', '#0ea5e9',
]

// Get colour for any department — known or unknown
export function deptColor(name: string, index: number = 0): string {
  if (!name) return CC_GREY
  if (DEPT_COLORS[name]) return DEPT_COLORS[name]
  // Generate consistent colour from name hash
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
  return DEPT_PALETTE[Math.abs(hash) % DEPT_PALETTE.length]
}

// Background version of dept colour (10% opacity)
export function deptBg(name: string, index: number = 0): string {
  return deptColor(name, index) + '20'
}

// ── Typography ────────────────────────────────────────────────
export const FONT = {
  pageTitle:   { fontSize: 22, fontWeight: 500, color: '#111', margin: 0 },
  pageSubtitle:{ fontSize: 13, color: '#6b7280', margin: '4px 0 0' },
  sectionTitle:{ fontSize: 13, fontWeight: 600, color: '#111' },
  label:       { fontSize: 11, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '.07em', color: '#9ca3af' },
  value:       { fontSize: 22, fontWeight: 700, color: '#111' },
  sub:         { fontSize: 11, color: '#9ca3af' },
}

// ── Common button styles ──────────────────────────────────────
export const BTN = {
  primary: {
    padding: '9px 18px', background: CC_DARK, color: 'white',
    border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  secondary: {
    padding: '8px 14px', background: 'white', color: '#374151',
    border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, cursor: 'pointer',
  },
  danger: {
    padding: '8px 14px', background: 'white', color: '#dc2626',
    border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, cursor: 'pointer',
  },
}

// ── Card style ────────────────────────────────────────────────
export const CARD: React.CSSProperties = {
  background:   'white',
  border:       '0.5px solid #e5e7eb',
  borderRadius: 12,
  padding:      '18px 20px',
}
