// lib/inventory/count-duration.ts
//
// "Time to count" in seconds for a stock count. Prefers the accumulated
// active_seconds — wall-time the count page was actually open + visible +
// not completed (it pauses when the owner leaves the page and resumes when
// they return). Falls back to created_at -> completed_at for counts taken
// before active-time tracking existed (those can read high if a count was
// left open across days — the very thing active tracking fixes).

export function countDuration(c: {
  active_seconds?: number | null
  started_at?:     string | null
  completed_at?:   string | null
}): number | null {
  const active = Number(c.active_seconds)
  if (Number.isFinite(active) && active > 0) return Math.round(active)
  if (c.started_at && c.completed_at) {
    const ms = new Date(c.completed_at).getTime() - new Date(c.started_at).getTime()
    if (Number.isFinite(ms) && ms >= 0) return Math.round(ms / 1000)
  }
  return null
}
