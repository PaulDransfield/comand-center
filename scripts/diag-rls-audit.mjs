// scripts/diag-rls-audit.mjs
//
// A3.2 — RLS audit. Walks every table in the `public` schema and reports:
//   - tables with RLS DISABLED
//   - tables with RLS ENABLED but NO policies (effectively closed —
//     fine for service-role-only tables but worth flagging)
//   - tables with RLS ENABLED whose policies don't reference
//     current_user_org_ids() (the canonical multi-tenant scope helper)
//
// Read-only. Run via:
//   $env:NEXT_PUBLIC_SUPABASE_URL='...'; $env:SUPABASE_SERVICE_ROLE_KEY='...'; node scripts/diag-rls-audit.mjs
//
// Tables intentionally exempt from tenant RLS (single-tenant or admin-only):
//   - fx_rates, holidays, weather_forecast (cross-tenant reference data)
//   - cron_run_log, ai_request_log, ai_request_log_archive (admin-only)
//   - stripe_processed_events, integrations, organisations (auth-adjacent)
//
// The script prints them under "intentional exemptions" so the audit
// can be read in one pass.

import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env')
  process.exit(1)
}
const db = createClient(url, key, { auth: { persistSession: false } })

// Intentional exemptions — these never need tenant RLS:
//   - reference / cross-tenant data shared by every customer
//   - admin-only / auth-adjacent tables we always access via service role
const EXEMPT = new Set([
  // Reference data
  'fx_rates',
  'holidays',
  'weather_forecast',
  'industry_benchmarks',
  'supplier_articles',                  // global supplier catalogue (M121)
  'brand_classifications_learned',      // global brand learner (M138)
  'global_product_enrichment',          // global GTIN enrichment (M132)
  // Admin-only
  'cron_run_log',
  'ai_request_log',
  'ai_request_log_archive',
  'stripe_processed_events',
  'live_api_probes',
  'live_api_findings',
  'ai_forecast_outcomes_archive',
  'integration_health_log',
  'overhead_drilldown_cache',
  // Auth-adjacent
  'integrations',
  'organisations',
  'organisation_members',
  'businesses',
  'profiles',
  'user_settings',
  // Background-job state
  'extraction_jobs',
  'inventory_backfill_state',
  'fortnox_uploads',
  'fortnox_supersede_links',
  'product_aliases',  // service-role write path; reads via parent product RLS
  'org_rate_limits',
])

async function listPublicTables() {
  // information_schema is accessible to service_role.
  const { data, error } = await db.rpc('exec_sql', {
    query: `
      SELECT
        t.tablename,
        c.relrowsecurity AS rls_enabled,
        (SELECT COUNT(*) FROM pg_policies p WHERE p.schemaname='public' AND p.tablename=t.tablename) AS policy_count
      FROM pg_tables t
      JOIN pg_class c ON c.relname = t.tablename AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname='public')
      WHERE t.schemaname='public'
      ORDER BY t.tablename;
    `,
  }).catch(() => ({ data: null, error: 'no_rpc' }))

  if (data) return data

  // Fallback: direct SELECT from pg_tables via PostgREST. supabase-js
  // exposes the `information_schema` views by default on service-role.
  const { data: tables, error: tErr } = await db.from('pg_tables').select('tablename, schemaname').eq('schemaname', 'public')
  if (tErr) throw new Error('Cannot list tables: ' + tErr.message)

  // We need RLS state too; without exec_sql RPC, we report all as unknown.
  return (tables ?? []).map(t => ({ tablename: t.tablename, rls_enabled: null, policy_count: null }))
}

async function listPolicies() {
  const { data, error } = await db.rpc('exec_sql', {
    query: `
      SELECT tablename, policyname, cmd, qual::text AS using_expr, with_check::text AS with_check_expr
      FROM pg_policies
      WHERE schemaname = 'public'
      ORDER BY tablename, policyname;
    `,
  }).catch(() => ({ data: null, error: 'no_rpc' }))
  return data ?? []
}

const tables   = await listPublicTables()
const policies = await listPolicies()

// Index policies by table
const polByTable = new Map()
for (const p of policies) {
  if (!polByTable.has(p.tablename)) polByTable.set(p.tablename, [])
  polByTable.get(p.tablename).push(p)
}

const flagged = {
  rls_disabled:               [],
  rls_enabled_no_policies:    [],
  rls_no_orgids_reference:    [],
  ok:                         [],
  exempt:                     [],
}

for (const t of tables) {
  const name    = t.tablename
  const enabled = t.rls_enabled
  const pcount  = Number(t.policy_count ?? 0)
  const pols    = polByTable.get(name) ?? []

  if (EXEMPT.has(name)) { flagged.exempt.push({ name, enabled, pcount }); continue }

  if (enabled === false) {
    flagged.rls_disabled.push({ name })
    continue
  }
  if (pcount === 0) {
    flagged.rls_enabled_no_policies.push({ name })
    continue
  }
  // Check policies for current_user_org_ids() reference
  const hasOrgIds = pols.some(p =>
    (p.using_expr      && p.using_expr.includes('current_user_org_ids')) ||
    (p.with_check_expr && p.with_check_expr.includes('current_user_org_ids'))
  )
  if (!hasOrgIds) {
    flagged.rls_no_orgids_reference.push({
      name,
      policy_count: pcount,
      policies: pols.map(p => p.policyname),
    })
    continue
  }
  flagged.ok.push({ name })
}

// Print report
function header(s) {
  console.log()
  console.log('═'.repeat(s.length + 4))
  console.log(`  ${s}`)
  console.log('═'.repeat(s.length + 4))
}

header('A3.2 RLS audit')
console.log(`Scanned ${tables.length} tables in public schema.`)
console.log()
console.log('Summary:')
console.log(`  OK (RLS + current_user_org_ids policy):  ${flagged.ok.length}`)
console.log(`  RLS DISABLED (BAD):                       ${flagged.rls_disabled.length}`)
console.log(`  RLS enabled, NO policies:                  ${flagged.rls_enabled_no_policies.length}`)
console.log(`  RLS enabled, no current_user_org_ids ref: ${flagged.rls_no_orgids_reference.length}`)
console.log(`  Exempt (intentional):                      ${flagged.exempt.length}`)

if (flagged.rls_disabled.length > 0) {
  header('RLS DISABLED — must enable')
  for (const t of flagged.rls_disabled) console.log(`  - ${t.name}`)
}
if (flagged.rls_enabled_no_policies.length > 0) {
  header('RLS enabled but no policies — review (may be intentional service-role-only)')
  for (const t of flagged.rls_enabled_no_policies) console.log(`  - ${t.name}`)
}
if (flagged.rls_no_orgids_reference.length > 0) {
  header('RLS policies do NOT reference current_user_org_ids() — verify scope')
  for (const t of flagged.rls_no_orgids_reference) {
    console.log(`  - ${t.name} (${t.policy_count} policies: ${t.policies.join(', ')})`)
  }
}
if (flagged.exempt.length > 0) {
  header('Exempt (intentional — reference / admin-only / auth-adjacent)')
  for (const t of flagged.exempt) console.log(`  - ${t.name}`)
}

console.log()
console.log('Audit complete.')
process.exit(flagged.rls_disabled.length > 0 || flagged.rls_no_orgids_reference.length > 0 ? 2 : 0)
