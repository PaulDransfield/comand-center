// app/api/cron/inventory-audit-sampler/route.ts
//
// Daily audit-queue sampler (LEARNING-LOOP-PHASE1-PLAN.md D2).
//
// For each active business: find recent confident-auto-match aliases +
// any previously-demoted (times_demoted > 0) reactivated aliases.
// Score each candidate per `lib/inventory/audit-sampler.ts`. UPSERT
// the top-N (adaptive sample rate) into `inventory_audit_queue` —
// the UNIQUE(business_id, alias_id, reason) constraint makes this
// idempotent across re-runs.
//
// Schedule (vercel.json): daily at 03:15 UTC — sits between
// ai-log-retention (03:30 weekly) and recategorise-other (03:45).
//
// Cost: pure SQL — no AI calls. Cheap to run hourly if velocity demands
// it later, but daily is sufficient for the audit-pattern use case.

import { NextRequest, NextResponse } from 'next/server'
import { unstable_noStore as noStore } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/server'
import {
  pickSampleSet,
  type AliasCandidate,
  type ScoredCandidate,
} from '@/lib/inventory/audit-sampler'

export const runtime     = 'nodejs'
export const dynamic     = 'force-dynamic'
export const maxDuration = 60

// Window of "recent" candidates the sampler considers per run. Aliases
// older than this stop being eligible for fresh sampling unless they
// also satisfy a non-recency criterion (previously-demoted always
// eligible regardless of age).
const RECENT_WINDOW_DAYS = 14

export async function POST(req: NextRequest) { return handle(req) }
export async function GET(req: NextRequest)  { return handle(req) }

async function handle(req: NextRequest) {
  noStore()
  const cronSecret = process.env.CRON_SECRET
  const auth = req.headers.get('authorization') ?? ''
  if (cronSecret && auth !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const db = createAdminClient()
  const now = new Date()
  const windowStart = new Date(now.getTime() - RECENT_WINDOW_DAYS * 86_400_000).toISOString()

  // Find every active business that has any product_aliases at all.
  // Sampling on businesses with no aliases is a no-op; skip up-front to
  // avoid empty queries per business.
  const { data: businessRows } = await db
    .from('businesses')
    .select('id, org_id, name')
    .eq('is_active', true)
  const businesses = (businessRows ?? []) as Array<{ id: string; org_id: string; name: string }>

  const perBusiness: Array<{
    business_id:    string
    name:           string
    candidates:     number
    sampled:        number
    upserted:       number
    queue_total:    number
    errors:         string[]
  }> = []

  for (const biz of businesses) {
    const result = {
      business_id: biz.id,
      name:        biz.name,
      candidates:  0,
      sampled:     0,
      upserted:    0,
      queue_total: 0,
      errors:      [] as string[],
    }

    try {
      // ── Candidate set ────────────────────────────────────────────────
      //
      // Eligibility = (active alias) AND (
      //   match_method is fuzzy_* AND first_seen_at within window
      //   OR
      //   times_demoted > 0  (previously-demoted, always eligible)
      // )
      const { data: aliasRows, error: aliasErr } = await db
        .from('product_aliases')
        .select('id, business_id, product_id, match_method, match_confidence, times_demoted, first_seen_at')
        .eq('business_id', biz.id)
        .eq('is_active', true)
        .or(`and(match_method.in.(fuzzy_same_supplier,fuzzy_cross_supplier),first_seen_at.gte.${windowStart}),times_demoted.gt.0`)
        .limit(2000)
      if (aliasErr) { result.errors.push(`alias query: ${aliasErr.message}`); perBusiness.push(result); continue }

      const aliases = (aliasRows ?? []) as any[]
      if (aliases.length === 0) {
        perBusiness.push(result)
        continue
      }

      // ── Enrich with line-context (highest-value matched line per alias)
      const aliasIds = aliases.map(a => a.id)
      const { data: lineRows } = await db
        .from('supplier_invoice_lines')
        .select('id, product_alias_id, total_excl_vat')
        .in('product_alias_id', aliasIds)
        .eq('match_status', 'matched')
        .limit(5000)
      const lines = (lineRows ?? []) as Array<{ id: string; product_alias_id: string; total_excl_vat: number | null }>

      // Index for fast lookup
      const linesByAlias = new Map<string, typeof lines>()
      for (const l of lines) {
        const arr = linesByAlias.get(l.product_alias_id) ?? []
        arr.push(l)
        linesByAlias.set(l.product_alias_id, arr)
      }

      // Build candidate objects
      const candidates: AliasCandidate[] = aliases.map(a => {
        const refs = linesByAlias.get(a.id) ?? []
        let highest = { id: null as string | null, total: 0 }
        for (const l of refs) {
          const t = Math.abs(Number(l.total_excl_vat ?? 0))
          if (t > highest.total) highest = { id: l.id, total: t }
        }
        return {
          alias_id:                    a.id,
          business_id:                 a.business_id,
          org_id:                      biz.org_id,
          match_method:                a.match_method,
          match_confidence:            a.match_confidence,
          times_demoted:               a.times_demoted ?? 0,
          first_seen_at:               a.first_seen_at,
          highest_line_total_excl_vat: highest.total,
          highest_value_line_id:       highest.id,
          line_refs_count:             refs.length,
        }
      })
      result.candidates = candidates.length

      // ── Sample (adaptive rate based on candidate count) ──────────────
      const sample = pickSampleSet(candidates, now)
      result.sampled = sample.length
      if (sample.length === 0) {
        perBusiness.push(result)
        continue
      }

      // ── UPSERT into inventory_audit_queue ────────────────────────────
      // M106 UNIQUE(business_id, alias_id, reason) makes the upsert
      // idempotent — re-runs replace risk_score + snapshot fields with
      // fresh values WITHOUT clearing reviewed_at / reviewer_decision.
      const upserts = sample.map(s => ({
        org_id:                 s.org_id,
        business_id:            s.business_id,
        alias_id:               s.alias_id,
        line_id:                s.highest_value_line_id,
        reason:                 s.reason,
        risk_score:             s.risk_score,
        alias_match_method:     s.match_method,
        alias_match_confidence: s.match_confidence,
        alias_times_demoted:    s.times_demoted,
        sampled_at:             now.toISOString(),
      }))
      const { error: upErr } = await db
        .from('inventory_audit_queue')
        .upsert(upserts, {
          onConflict: 'business_id,alias_id,reason',
          ignoreDuplicates: false,
        })
      if (upErr) {
        result.errors.push(`queue upsert: ${upErr.message}`)
      } else {
        result.upserted = upserts.length   // upsert is all-or-nothing here
      }

      // ── Total queue depth (for telemetry) ─────────────────────────────
      const { count: queueTotal } = await db
        .from('inventory_audit_queue')
        .select('id', { count: 'exact', head: true })
        .eq('business_id', biz.id)
        .is('reviewed_at', null)
      result.queue_total = queueTotal ?? 0

    } catch (err: any) {
      result.errors.push(`unexpected: ${err?.message ?? err}`)
    }

    perBusiness.push(result)
  }

  return NextResponse.json({
    ok: true,
    ran_at: now.toISOString(),
    businesses_touched: perBusiness.length,
    per_business: perBusiness,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
