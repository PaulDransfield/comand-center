// lib/sync/with-timeout.ts
//
// Small shared helper used by every sync cron. Wraps a promise so it
// either resolves in time or rejects with a clear error, preventing a
// single slow integration from burning the whole cron's budget.
//
// Extracted because three crons had copy-pasted their own implementations
// (master-sync, catchup-sync) and one (personalkollen-sync) was missing
// the timeout entirely — a single slow Personalkollen API could delay
// the whole fleet's nightly sync.

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(v => { clearTimeout(t); resolve(v) })
     .catch(e => { clearTimeout(t); reject(e) })
  })
}
