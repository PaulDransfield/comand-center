// app/api/admin/v2/search/route.ts
//
// Unified search for the Admin v2 command palette (Cmd-K).
// Single GET → three result sections: customers, saved investigations,
// and static page links (filtered server-side so the wire format is
// uniform).
//
// Empty q → recent items (last 10 customers, last 5 saved). Non-empty q
// → ilike on org name + ilike on saved label OR query.
//
// No keyset pagination — palette caps each section at 10 items, and
// admins typically narrow with the search term anyway.

import { NextRequest, NextResponse } from 'next/server'
import { requireAdmin }              from '@/lib/admin/require-admin'
import { createAdminClient }         from '@/lib/supabase/server'

export const dynamic     = 'force-dynamic'
export const maxDuration = 10

const PER_SECTION = 10

interface PageEntry { key: string; label: string; href: string; hint?: string }

const PAGES: PageEntry[] = [
  { key: 'overview',  label: 'Overview',           href: '/admin/v2/overview',  hint: 'snapshot of every customer' },
  { key: 'customers', label: 'Customers',          href: '/admin/v2/customers', hint: 'sortable list, search inline' },
  { key: 'agents',    label: 'Agents',             href: '/admin/v2/agents',    hint: 'kill switch + last run' },
  { key: 'health',    label: 'Health',             href: '/admin/v2/health',    hint: 'crons / RLS / Sentry / Anthropic / Stripe' },
  { key: 'audit',     label: 'Audit log',          href: '/admin/v2/audit',     hint: 'filter + CSV export' },
  { key: 'tools',     label: 'Tools — SQL runner', href: '/admin/v2/tools',     hint: 'read-only SELECT + saved investigations' },
]

function tokenMatch(haystack: string | null | undefined, q: string): boolean {
  if (!haystack) return false
  return haystack.toLowerCase().includes(q.toLowerCase())
}

const isMissingTable = (err: any) => {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  const msg = String(err.message ?? '').toLowerCase()
  return msg.includes('does not exist') || msg.includes('could not find the table')
}

export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req)
  if ('ok' in guard === false) return guard as NextResponse

  const url = new URL(req.url)
  const q   = (url.searchParams.get('q') ?? '').trim()
  const db  = createAdminClient()

  // ── Customers ──────────────────────────────────────────────────────
  // Three match types:
  //   1. UUID-shaped query → id.eq exact
  //   2. 10-digit numeric query → org_number exact (paste from external tool)
  //   3. otherwise → name ilike substring
  let custQ = db.from('organisations')
                .select('id, name, plan, org_number, created_at')
                .order('created_at', { ascending: false })
                .limit(PER_SECTION)
  if (q.length > 0) {
    const digitsOnly = q.replace(/\D/g, '')
    if (q.length >= 8 && /^[0-9a-f-]+$/i.test(q) && q.includes('-')) {
      // UUID
      custQ = db.from('organisations')
                .select('id, name, plan, org_number, created_at')
                .or(`name.ilike.%${q}%,id.eq.${q}`)
                .limit(PER_SECTION)
    } else if (digitsOnly.length === 10) {
      // Looks like a Swedish org-nr (10 digits, possibly with dash)
      custQ = db.from('organisations')
                .select('id, name, plan, org_number, created_at')
                .or(`name.ilike.%${q}%,org_number.eq.${digitsOnly}`)
                .limit(PER_SECTION)
    } else {
      custQ = db.from('organisations')
                .select('id, name, plan, org_number, created_at')
                .ilike('name', `%${q}%`)
                .limit(PER_SECTION)
    }
  }
  const { data: custRows, error: custErr } = await custQ
  const customers = !custErr && custRows ? custRows.map((r: any) => ({
    id:         r.id,
    name:       r.name ?? r.id.slice(0, 8),
    plan:       r.plan ?? null,
    org_number: r.org_number ?? null,
  })) : []

  // ── Saved investigations ──────────────────────────────────────────
  let saved: Array<{ id: string; label: string; org_id: string | null; org_name: string | null; query_preview: string }> = []
  let savedTableMissing = false
  {
    const { data: rows, error } = await db
      .from('admin_saved_queries')
      .select('id, label, query, org_id, last_used_at, created_at')
      .order('last_used_at', { ascending: false, nullsFirst: false })
      .order('created_at',   { ascending: false })
      .limit(50)   // pull more than we need; client-side narrow

    if (error) {
      if (isMissingTable(error)) savedTableMissing = true
      // else: silently empty — palette is best-effort
    } else if (rows && rows.length) {
      const filtered = q.length === 0
        ? rows.slice(0, PER_SECTION / 2)
        : rows.filter(r => tokenMatch(r.label, q) || tokenMatch(r.query, q)).slice(0, PER_SECTION)

      // Org-name enrichment
      const orgIds = [...new Set(filtered.map((r: any) => r.org_id).filter(Boolean))] as string[]
      const orgMap: Record<string, string> = {}
      if (orgIds.length) {
        const { data: orgs } = await db.from('organisations').select('id, name').in('id', orgIds)
        for (const o of orgs ?? []) orgMap[o.id] = o.name
      }

      saved = filtered.map((r: any) => ({
        id:            r.id,
        label:         r.label,
        org_id:        r.org_id,
        org_name:      r.org_id ? (orgMap[r.org_id] ?? null) : null,
        query_preview: (r.query ?? '').replace(/\s+/g, ' ').slice(0, 80),
      }))
    }
  }

  // ── Pages ─────────────────────────────────────────────────────────
  const pages = q.length === 0
    ? PAGES
    : PAGES.filter(p => tokenMatch(p.label, q) || tokenMatch(p.hint, q) || tokenMatch(p.key, q))

  return NextResponse.json({
    q,
    customers,
    saved,
    pages,
    saved_table_missing: savedTableMissing,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
