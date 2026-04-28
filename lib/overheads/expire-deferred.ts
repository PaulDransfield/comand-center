// lib/overheads/expire-deferred.ts
//
// Inline sweep that flips deferred flags back to 'pending' when their
// defer_until timestamp has passed. Called at the top of every read path
// (/api/overheads/flags + /api/overheads/projection + the contextBuilder
// slice) so the user always sees a fresh state without needing a cron.
//
// Why inline over cron: cron-driven sweeps + a UI that doesn't trigger
// the cron means users may see stale "deferred" flags for up to 24 h
// after their snooze expires. Inline guarantees the queue is current
// the moment the owner opens it. Cost is one tiny UPDATE per page load,
// scoped to a single business — sub-millisecond at the row counts we run.
//
// Best-effort: errors are logged and swallowed. Failure to expire a flag
// just means it stays deferred for one more page load — not catastrophic.

export async function expireDeferredFlags(
  db: any,
  orgId: string,
  businessId: string,
): Promise<{ expired: number }> {
  try {
    const { data, error } = await db
      .from('overhead_flags')
      .update({ resolution_status: 'pending', defer_until: null })
      .eq('org_id', orgId)
      .eq('business_id', businessId)
      .eq('resolution_status', 'deferred')
      .lt('defer_until', new Date().toISOString())
      .select('id')   // Supabase JS returns { data } only when .select() is called
    if (error) {
      console.warn('[overhead] expire-deferred failed:', error.message)
      return { expired: 0 }
    }
    return { expired: (data ?? []).length }
  } catch (e: any) {
    console.warn('[overhead] expire-deferred threw:', e?.message)
    return { expired: 0 }
  }
}
