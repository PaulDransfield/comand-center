'use client'
// app/inventory/duplicates/page.tsx
//
// Finds duplicate products via shared supplier article codes. Two
// products that both have aliases pointing at MS article 105529 are
// objectively the same SKU per the supplier — the matcher's name-based
// normalisation occasionally creates siblings when the same SKU ships
// under slightly different descriptions.
//
// UI is intentionally simple: cluster cards, member rows inside,
// owner picks the "keep" and clicks Merge. The merge endpoint repoints
// all aliases from losers → keeper and auto-archives losers when no
// recipes reference them.

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { PageContainer } from '@/components/ui/Layout'
import { EmptyState } from '@/components/ui/EmptyState'

interface ClusterMember {
  product_id:          string
  product_name:        string
  product_category:    string | null
  archived_at:         string | null
  active_alias_count:  number
  recipe_use_count:    number
  latest_invoice_date: string | null
}

interface DuplicateCluster {
  supplier_fortnox_number: string
  supplier_name:           string | null
  article_number:          string
  member_count:            number
  members:                 ClusterMember[]
}

interface DuplicatesResponse {
  business_id:               string
  clusters:                  DuplicateCluster[]
  total_clusters:            number
  total_affected_products:   number
}

export default function DuplicatesPage() {
  const [bizId, setBizId] = useState<string | null>(null)
  const [data, setData] = useState<DuplicatesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Per-cluster: which product is the chosen winner ("keep"). Defaults
  // to the first member (sorted server-side by recipe count + recency).
  const [keepByCluster, setKeepByCluster] = useState<Record<string, string>>({})
  // Per-cluster busy + flash
  const [busyCluster, setBusyCluster] = useState<string | null>(null)
  const [flash, setFlash] = useState<{ cluster: string; msg: string; tone: 'good' | 'bad' } | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() {
      const next = localStorage.getItem('cc_selected_biz')
      if (next) setBizId(next)
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) return
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/duplicates?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      if (!r.ok) throw new Error((await r.json().catch(() => ({} as any))).error ?? `HTTP ${r.status}`)
      const j: DuplicatesResponse = await r.json()
      setData(j)
      // Seed default winners
      const seed: Record<string, string> = {}
      for (const c of j.clusters) {
        const key = `${c.supplier_fortnox_number}|${c.article_number}`
        seed[key] = c.members[0]?.product_id
      }
      setKeepByCluster(seed)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [bizId])

  useEffect(() => { if (bizId) load() }, [bizId, load])

  async function mergeCluster(cluster: DuplicateCluster) {
    const key = `${cluster.supplier_fortnox_number}|${cluster.article_number}`
    const winner = keepByCluster[key]
    if (!winner) return
    const losers = cluster.members.filter(m => m.product_id !== winner && !m.archived_at)
    if (losers.length === 0) {
      setFlash({ cluster: key, msg: 'Nothing to merge — only the winner is active.', tone: 'bad' })
      return
    }

    const winnerName = cluster.members.find(m => m.product_id === winner)?.product_name ?? '(winner)'
    const list = losers.map(l => `  - "${l.product_name}"${l.recipe_use_count > 0 ? ` (used by ${l.recipe_use_count} recipes — will stay in place)` : ''}`).join('\n')
    if (!confirm(`Merge into "${winnerName}":\n\n${list}\n\nAll supplier articles will move to "${winnerName}". Losers without recipe references will be auto-archived.`)) {
      return
    }

    setBusyCluster(key); setFlash(null)
    try {
      const results: Array<{ name: string; ok: boolean; archived?: boolean; reason?: string | null; err?: string }> = []
      for (const loser of losers) {
        try {
          const r = await fetch(`/api/inventory/products/${loser.product_id}/merge-into`, {
            method:  'POST', cache: 'no-store',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ target_product_id: winner }),
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok) {
            results.push({ name: loser.product_name, ok: false, err: j.error ?? `HTTP ${r.status}` })
          } else {
            results.push({ name: loser.product_name, ok: true, archived: j.source_archived, reason: j.source_archive_blocked_reason })
          }
        } catch (e: any) {
          results.push({ name: loser.product_name, ok: false, err: e.message })
        }
      }
      const ok = results.filter(r => r.ok).length
      const archived = results.filter(r => r.archived).length
      const blockedByRecipes = results.filter(r => r.reason === 'used_by_recipes').length
      const failed = results.filter(r => !r.ok).length
      let msg = `Merged ${ok}/${losers.length}. Auto-archived ${archived}.`
      if (blockedByRecipes > 0) msg += ` ${blockedByRecipes} kept (used by recipes).`
      if (failed > 0) msg += ` ${failed} failed.`
      setFlash({ cluster: key, msg, tone: failed > 0 ? 'bad' : 'good' })
      await load()
    } finally {
      setBusyCluster(null)
    }
  }

  return (
    <AppShell>
      <PageContainer>
        <div style={{ marginBottom: 14 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, color: UXP.ink1, margin: 0 }}>Duplicate articles</h1>
          <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4, maxWidth: 720 }}>
            Products that share a supplier article code are objectively the same SKU per the supplier. Pick which one to keep, click Merge — all supplier articles move over and the losers are auto-archived (unless used by recipes).
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`, borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {loading && (
          <div style={{ padding: 30, textAlign: 'center', color: UXP.ink3, fontSize: 13 }}>Scanning…</div>
        )}

        {!loading && data && data.clusters.length === 0 && (
          <EmptyState
            badge="No duplicates"
            tone="success"
            title="No duplicate articles found."
            description="Every supplier article code in your catalogue points at a unique product. New duplicates appear here automatically as Fortnox invoices arrive."
            secondary={{ label: 'Open articles', href: '/inventory/items' }}
            style={{ marginTop: 16 }}
          />
        )}

        {!loading && data && data.clusters.length > 0 && (
          <>
            <div style={{
              padding: '8px 12px', background: UXP.lavFill, border: `0.5px solid ${UXP.lavMid}`,
              borderRadius: 8, fontSize: 12, color: UXP.lavText, marginBottom: 14,
            }}>
              <strong>{data.total_clusters}</strong> duplicate cluster{data.total_clusters === 1 ? '' : 's'} found covering <strong>{data.total_affected_products}</strong> products. Largest clusters first.
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {data.clusters.map(c => {
                const key = `${c.supplier_fortnox_number}|${c.article_number}`
                const isBusy = busyCluster === key
                const f = flash?.cluster === key ? flash : null
                return (
                  <div key={key} style={{
                    background: UXP.cardBg, border: `0.5px solid ${UXP.border}`,
                    borderRadius: 10, overflow: 'hidden',
                  }}>
                    <div style={{ padding: '12px 16px', borderBottom: `0.5px solid ${UXP.borderSoft}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1 }}>
                          {c.supplier_name ?? '(unknown supplier)'} · article {c.article_number}
                        </div>
                        <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 2 }}>
                          {c.member_count} products share this article code
                        </div>
                      </div>
                      <button
                        onClick={() => mergeCluster(c)}
                        disabled={isBusy}
                        style={{
                          padding: '7px 14px', fontSize: 12, fontWeight: 600,
                          background: isBusy ? UXP.subtleBg : UXP.lavDeep,
                          color: isBusy ? UXP.ink3 : '#fff',
                          border: 'none', borderRadius: 6,
                          cursor: isBusy ? 'wait' : 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        {isBusy ? 'Merging…' : 'Merge into keeper'}
                      </button>
                    </div>

                    {f && (
                      <div style={{
                        padding: '8px 16px',
                        background: f.tone === 'good' ? UXP.greenFill : UXP.roseFill,
                        color:      f.tone === 'good' ? UXP.greenDeep : UXP.roseText,
                        fontSize:   11, fontWeight: 500,
                        borderBottom: `0.5px solid ${UXP.borderSoft}`,
                      }}>
                        {f.msg}
                      </div>
                    )}

                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: UXP.subtleBg }}>
                          <th style={th}>Keep</th>
                          <th style={th}>Product</th>
                          <th style={{ ...th, textAlign: 'right' }}>Articles</th>
                          <th style={{ ...th, textAlign: 'right' }}>Recipes</th>
                          <th style={{ ...th, textAlign: 'right' }}>Last invoice</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.members.map(m => {
                          const isWinner = keepByCluster[key] === m.product_id
                          return (
                            <tr key={m.product_id} style={{
                              borderTop: `0.5px solid ${UXP.borderSoft}`,
                              background: isWinner ? UXP.lavFill : 'transparent',
                              opacity: m.archived_at ? 0.55 : 1,
                            }}>
                              <td style={td}>
                                <input
                                  type="radio"
                                  name={`keep-${key}`}
                                  checked={isWinner}
                                  disabled={!!m.archived_at || isBusy}
                                  onChange={() => setKeepByCluster(prev => ({ ...prev, [key]: m.product_id }))}
                                />
                              </td>
                              <td style={td}>
                                <a href={`/inventory/items/${m.product_id}`} style={{ color: UXP.ink1, fontWeight: 500, textDecoration: 'none' }}>
                                  {m.product_name}
                                </a>
                                {m.archived_at && (
                                  <span style={{ marginLeft: 6, fontSize: 9, padding: '1px 5px', borderRadius: 3, background: UXP.slateFill, color: UXP.slate, fontWeight: 700, letterSpacing: '0.05em' }}>
                                    ARCHIVED
                                  </span>
                                )}
                                {m.product_category && (
                                  <span style={{ marginLeft: 6, fontSize: 10, color: UXP.ink4 }}>· {m.product_category}</span>
                                )}
                              </td>
                              <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{m.active_alias_count}</td>
                              <td style={{ ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                                {m.recipe_use_count > 0 ? (
                                  <span style={{ color: UXP.coral, fontWeight: 600 }}>{m.recipe_use_count}</span>
                                ) : (
                                  <span style={{ color: UXP.ink4 }}>0</span>
                                )}
                              </td>
                              <td style={{ ...td, textAlign: 'right', color: UXP.ink3, fontSize: 11 }}>{m.latest_invoice_date ?? '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </PageContainer>
    </AppShell>
  )
}

const th: React.CSSProperties = {
  padding: '8px 14px', textAlign: 'left' as const,
  fontSize: 10, fontWeight: 700, color: UXP.ink4,
  letterSpacing: '0.05em', textTransform: 'uppercase' as const,
}
const td: React.CSSProperties = {
  padding: '10px 14px', verticalAlign: 'middle' as const,
}
