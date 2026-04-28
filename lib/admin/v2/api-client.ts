// lib/admin/v2/api-client.ts
//
// Thin fetch wrapper for /admin/v2 pages. Replaces the boilerplate every
// existing admin page repeats:
//   - Reads x-admin-secret from sessionStorage
//   - Sends as `x-admin-secret` header on every request
//   - On 401 → redirects to /admin/login?next=<current>
//   - Throws Error('HTTP ${status}') on non-OK so callers can catch + display
//
// Auth pattern follows the plan's hard rule: sessionStorage only, never
// localStorage. Clears on tab close — limits exposure if Paul leaves his
// laptop unlocked for a moment.

const SECRET_KEY = 'admin_auth'

/** Read the admin secret. Returns '' on server (SSR) or when missing. */
export function readAdminSecret(): string {
  if (typeof window === 'undefined') return ''
  try { return window.sessionStorage.getItem(SECRET_KEY) ?? '' } catch { return '' }
}

/** Clear the admin secret (used on logout + on 401 response). */
export function clearAdminSecret(): void {
  if (typeof window === 'undefined') return
  try { window.sessionStorage.removeItem(SECRET_KEY) } catch {}
}

/**
 * Bounce the browser to the admin login, preserving the current path as
 * `?next=` so the login page can redirect back after re-auth.
 */
function redirectToLogin(reason: 'missing' | 'expired'): never {
  if (typeof window === 'undefined') {
    throw new Error('redirectToLogin called on server — should be unreachable')
  }
  const next = encodeURIComponent(window.location.pathname + window.location.search)
  window.location.href = `/admin/login?next=${next}${reason === 'expired' ? '&reason=expired' : ''}`
  // location.href triggers nav but doesn't unwind the call stack. Throw
  // so callers don't try to keep processing the never-arriving response.
  throw new Error('redirecting to /admin/login')
}

export interface AdminFetchOptions extends RequestInit {
  /** Set to true when the response is expected to be JSON (default). */
  expectJson?: boolean
}

/**
 * The single client every /admin/v2 page should use.
 *
 * Usage:
 *   const data = await adminFetch<MyShape>('/api/admin/v2/incidents')
 *   await adminFetch('/api/admin/v2/customers/x/notes', { method: 'POST', body: JSON.stringify(...) })
 */
export async function adminFetch<T = any>(
  url:  string,
  opts: AdminFetchOptions = {},
): Promise<T> {
  const secret = readAdminSecret()
  if (!secret) redirectToLogin('missing')

  const headers = new Headers(opts.headers)
  headers.set('x-admin-secret', secret)
  // JSON body? Set the content type once so callers don't have to.
  if (opts.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(url, {
    ...opts,
    headers,
    cache: opts.cache ?? 'no-store',
  })

  if (res.status === 401) {
    clearAdminSecret()
    redirectToLogin('expired')
  }

  if (!res.ok) {
    let body: any = null
    try { body = await res.json() } catch {}
    const msg = body?.error ?? `HTTP ${res.status}`
    throw new Error(msg)
  }

  if (opts.expectJson === false) return undefined as unknown as T
  return res.json() as Promise<T>
}
