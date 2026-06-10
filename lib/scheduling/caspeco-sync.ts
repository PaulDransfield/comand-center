// lib/scheduling/caspeco-sync.ts
//
// Phase 1 of the Caspeco scheduling integration
// (docs/CASPECO-SCHEDULING-INTEGRATION-PLAN.md).
//
// Brings the Caspeco roster (caspeco_employees) into the canonical
// staff_profiles table that the scheduling grid, AI recommender and
// compliance engine all read. Mirrors what lib/scheduling/pk-sync.ts'
// refreshStaffProfiles does for Personalkollen, so downstream code stays
// 100% source-agnostic.
//
// staff_uid / pk_staff_url = 'caspeco-<id>' (same convention staff_logs
// already uses) so Caspeco rows never collide with PK rows if a business
// somehow has both.
//
// Phase 1 = ROSTER ONLY. Planned shifts (staff_shifts) + templates come in
// Phase 2, which is blocked on a Caspeco schedule endpoint (see the plan).
// is_minor / birth_date (M150) flow straight through.

import type { SupabaseClient } from '@supabase/supabase-js'

export async function syncCaspecoStaffProfiles(
  db:         SupabaseClient,
  orgId:      string,
  businessId: string,
): Promise<{ upserted: number }> {
  const { data: emps, error } = await db
    .from('caspeco_employees')
    .select('caspeco_employee_id, full_name, email, is_minor, birth_date, employment_start_date, employment_end_date, is_active')
    .eq('business_id', businessId)
  if (error) throw new Error(`caspeco_employees read: ${error.message}`)
  if (!emps || emps.length === 0) return { upserted: 0 }

  const now = new Date().toISOString()
  const rows = emps.map((e: any) => ({
    org_id:            orgId,
    business_id:       businessId,
    pk_staff_url:      `caspeco-${e.caspeco_employee_id}`,
    staff_uid:         `caspeco-${e.caspeco_employee_id}`,
    display_name:      e.full_name || null,
    full_name:         e.full_name || null,
    email:             e.email ?? null,
    is_minor:          e.is_minor === true,
    birth_date:        e.birth_date ?? null,
    hired_at:          e.employment_start_date ?? null,
    contract_end_at:   e.employment_end_date ?? null,
    is_active:         e.is_active ?? true,
    last_refreshed_at: now,
  }))

  // Upsert against the non-partial unique index (business_id, pk_staff_url).
  // Columns not in the payload (primary_section, typical_days, …) are left
  // untouched on update — Phase 2 fills primary_section from the schedule.
  const BATCH = 100
  for (let i = 0; i < rows.length; i += BATCH) {
    const { error: upErr } = await db
      .from('staff_profiles')
      .upsert(rows.slice(i, i + BATCH), { onConflict: 'business_id,pk_staff_url' })
    if (upErr) throw new Error(`staff_profiles upsert: ${upErr.message}`)
  }

  // Mark the business's scheduling source (only if not already set, so an
  // explicit owner choice is never overwritten).
  await db.from('businesses')
    .update({ scheduling_source: 'caspeco' })
    .eq('id', businessId)
    .is('scheduling_source', null)

  return { upserted: rows.length }
}
