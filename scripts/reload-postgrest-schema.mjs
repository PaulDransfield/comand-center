// scripts/reload-postgrest-schema.mjs
//
// Forces PostgREST to reload its schema cache. Use when a freshly-created
// table comes back as "Could not find the table 'public.X' in the schema
// cache" from supabase-js calls — Supabase caches the schema and a new
// table can take minutes to appear without a kick.
//
// Run: node --env-file=.env.production.local scripts/reload-postgrest-schema.mjs

import { createClient } from '@supabase/supabase-js'
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// Verify the table exists at the DB level first (rules out apply-skip).
const { data, error } = await db
  .from('fx_rates')
  .select('rate_date, currency, rate_to_sek')
  .limit(3)
if (error) {
  console.log('Direct query also fails:', error.message)
  console.log('(If "table not found", M088 didn\'t apply. Re-run sql/M088-FX-RATES.sql.)')
} else {
  console.log('Direct query OK. fx_rates has', data?.length ?? 0, 'rows currently.')
  console.log(data)
}

// Reload PostgREST cache via NOTIFY. Need a Postgres connection — use
// the service-role role via the SQL Editor would normally do this, but
// from a Node script we don't have direct pg access without the conn
// string. Easiest: call the Supabase Management API's "reload-schema"
// is not public. Workaround: any ALTER TABLE no-op DDL triggers reload.
// We'll try a harmless ALTER.

const { error: ddlErr } = await db.rpc('reload_postgrest_schema')
if (ddlErr) {
  console.log('\nreload_postgrest_schema RPC not present.')
  console.log('Fallback: wait ~60s for Supabase auto-refresh, or run')
  console.log("  NOTIFY pgrst, 'reload schema';")
  console.log('in the Supabase SQL Editor.')
} else {
  console.log('\nNOTIFY sent — cache reload triggered.')
}
