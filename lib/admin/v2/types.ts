// lib/admin/v2/types.ts
//
// Shared types for the /admin/v2 surface. All shapes pulled from existing
// API routes (don't invent — these need to match the wire format the v2
// pages will consume from existing or new endpoints).
//
// Keep this file thin. Per-page detail types belong in that page's
// component file. Anything reused across ≥2 pages lives here.

// ── Auth helpers ───────────────────────────────────────────────────────────

/** Result of the client-side admin-auth check (sessionStorage probe). */
export type AdminGuardResult =
  | { ok: true;  secret: string }
  | { ok: false; redirectTo: string }

// ── Customer-list shapes (from /api/admin/customers + /api/admin/orgs) ─────

/** Org row as the customers list / customer detail header consumes it. */
export interface OrgSummary {
  id:               string
  name:             string
  plan:             string
  is_active:        boolean
  trial_ends_at?:   string | null
  stripe_customer_id?: string | null
  business_count?:  number
  owner_email?:     string | null
  created_at?:      string
  last_login_at?:   string | null
  health_score?:    number | null
  mrr_sek?:         number | null
}

// ── Integration shapes (from /api/admin/customers/[orgId]) ─────────────────

export type IntegrationStatus = 'connected' | 'needs_reauth' | 'error' | 'disconnected'

export interface IntegrationSummary {
  id:                 string
  business_id:        string
  provider:           string
  status:             IntegrationStatus
  last_sync_at?:      string | null
  reauth_notified_at?: string | null
  needs_reauth_since?: string | null
}

// ── Health probes (from /api/admin/health) ────────────────────────────────

export type HealthSeverity = 'ok' | 'info' | 'warn' | 'critical'

export interface HealthProbe {
  name:        string
  severity:    HealthSeverity
  message:     string
  details?:    Record<string, any>
  link?:       string
}

// ── Incident strip (new — /api/admin/v2/incidents in PR 2) ─────────────────

export type IncidentKind =
  | 'stuck_integration'
  | 'token_expiring'
  | 'data_stale'
  | 'ai_cost_outlier'
  | 'stripe_webhook_backlog'
  | 'pending_migration'

export interface Incident {
  kind:       IncidentKind
  severity:   HealthSeverity
  org_id?:    string
  org_name?:  string
  title:      string
  detail:     string
  href:       string                 // jump link
  detected_at: string                // ISO
}

// ── KPI strip (reused on overview + customer detail) ──────────────────────

export interface KpiStat {
  label:    string
  value:    string                   // pre-formatted; the strip is dumb
  sub?:     string
  tone?:    'neutral' | 'good' | 'warn' | 'bad'
  href?:    string                   // optional click-through
}
