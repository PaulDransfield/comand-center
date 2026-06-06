'use client'
// app/inventory/recipes/menus/[id]/page.tsx
//
// Set menu editor. Header carries name + price + VAT + GP summary;
// body is the course list (each row a recipe with qty + per-line cost).
// Add-course picker filters by menu.type (food menus take food recipes,
// drink menus take drink recipes).

export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter, useParams } from 'next/navigation'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import { PageContainer } from '@/components/ui/Layout'
import { fmtKr } from '@/lib/format'
import { DRINK_TYPES } from '@/lib/categoryColors'

interface MenuItem {
  id:                    string
  recipe_id:             string
  recipe_name:           string
  recipe_type:           string | null
  recipe_image:          string | null
  course_position:       number
  qty:                   number
  note:                  string | null
  food_cost_per_portion: number
  line_food_cost:        number
  incomplete:            boolean
}
interface Menu {
  id: string; name: string; type: 'food' | 'drink'
  selling_price_ex_vat: number | null
  menu_price: number | null
  vat_rate: number | null
  channel: 'dine_in' | 'takeaway' | null
  notes: string | null
  image_url: string | null
}
interface Summary {
  item_count: number
  food_cost: number
  gp_kr: number | null
  gp_pct: number | null
  cost_pct: number | null
  incomplete: boolean
}

interface RecipeOption { id: string; name: string; type: string | null }

export default function MenuEditorPage() {
  const router = useRouter()
  const params = useParams<{ id: string }>()
  const menuId = String(params?.id ?? '')

  const [menu, setMenu] = useState<Menu | null>(null)
  const [items, setItems] = useState<MenuItem[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [recipeOptions, setRecipeOptions] = useState<RecipeOption[]>([])
  const [lightbox, setLightbox] = useState<{ url: string; name: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}`, { cache: 'no-store' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setMenu(j.menu); setItems(j.items ?? []); setSummary(j.summary)
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [menuId])

  useEffect(() => { if (menuId) load() }, [menuId, load])

  // Load recipe picker options when picker opens.
  useEffect(() => {
    if (!picker || !menu) return
    const bizId = typeof window !== 'undefined' ? localStorage.getItem('cc_selected_biz') : null
    if (!bizId) return
    fetch(`/api/inventory/recipes?business_id=${bizId}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(j => {
        // DRINK_TYPES imported from lib/categoryColors.ts — single source of truth.
        const all: RecipeOption[] = (j.recipes ?? []).map((r: any) => ({ id: r.id, name: r.name, type: r.type }))
        const filtered = all.filter(r => {
          const isDrink = DRINK_TYPES.has(String(r.type ?? '').toLowerCase())
          return menu.type === 'drink' ? isDrink : !isDrink
        })
        setRecipeOptions(filtered)
      })
      .catch(() => {})
  }, [picker, menu])

  async function patchMenu(patch: Record<string, any>) {
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function addCourse(recipeId: string) {
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}/items`, {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recipe_id: recipeId }),
      })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setPicker(false); setPickerQuery('')
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function patchItem(itemId: string, patch: Record<string, any>) {
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}/items/${itemId}`, {
        method: 'PATCH', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function deleteItem(itemId: string) {
    if (!window.confirm('Remove this course?')) return
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}/items/${itemId}`, { method: 'DELETE', cache: 'no-store' })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      await load()
    } catch (e: any) { alert(e.message) }
  }

  async function deleteMenu() {
    if (!window.confirm('Archive this menu? It will be hidden from the list but its data is preserved.')) return
    try {
      const r = await fetch(`/api/inventory/menus/${menuId}`, { method: 'DELETE', cache: 'no-store' })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
      router.push('/inventory/recipes/menus')
    } catch (e: any) { alert(e.message) }
  }

  const filteredOptions = recipeOptions.filter(r =>
    !pickerQuery.trim() || r.name.toLowerCase().includes(pickerQuery.toLowerCase()),
  )

  return (
    <AppShell>
      <PageContainer>
        <button onClick={() => router.push('/inventory/recipes/menus')}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: UXP.ink3, fontSize: 12, padding: 0, marginBottom: 10, fontFamily: 'inherit' }}>
          ← Back to set menus
        </button>

        {error && (
          <div style={{ padding: '10px 14px', background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`,
                        borderRadius: 8, color: UXP.roseText, fontSize: 12, marginBottom: 12 }}>{error}</div>
        )}
        {loading && <div style={{ padding: 24, textAlign: 'center' as const, color: UXP.ink3 }}>Loading…</div>}

        {menu && !loading && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
              <div style={{ display: 'flex', gap: 12, flex: 1, minWidth: 240, alignItems: 'flex-start' }}>
                <MenuImageEditor menuId={menu.id} imageUrl={menu.image_url} onChange={load} />
                <div style={{ flex: 1 }}>
                  <input
                    defaultValue={menu.name}
                    onBlur={e => { if (e.target.value.trim() !== menu.name) patchMenu({ name: e.target.value.trim() }) }}
                    style={{ ...inputStyle, fontSize: 22, fontWeight: 600, color: UXP.ink1, width: '100%', border: 'none', padding: 0, background: 'transparent' }}
                  />
                  <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 4 }}>
                    {menu.type === 'food' ? 'Food menu' : 'Drink menu'} · {items.length} course{items.length === 1 ? '' : 's'}
                  </div>
                </div>
              </div>
              <button onClick={deleteMenu}
                style={{ padding: '6px 12px', fontSize: 11, background: 'transparent', color: UXP.coral, border: `0.5px solid ${UXP.coral}`, borderRadius: 5, cursor: 'pointer', fontFamily: 'inherit' }}>
                Archive menu
              </button>
            </div>

            {/* Cost summary strip */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12, marginBottom: 16, padding: '14px 16px', background: UXP.subtleBg, borderRadius: 8 }}>
              <Stat label="Food cost"  value={summary ? fmtKr(summary.food_cost) : '—'} />
              <Stat label="Cost %"     value={summary?.incomplete ? '—' : (summary?.cost_pct != null ? `${summary.cost_pct.toFixed(1)} %` : '—')} />
              <Stat label="GP %"       value={summary?.incomplete ? '—' : (summary?.gp_pct != null ? `${summary.gp_pct.toFixed(1)} %` : '—')}
                    color={summary?.gp_pct != null ? (summary.gp_pct < 65 ? UXP.coral : UXP.greenDeep) : undefined} />
              <Stat label="GP kr"      value={summary?.incomplete ? '—' : (summary?.gp_kr != null ? fmtKr(summary.gp_kr) : '—')} />
              <Stat label="Menu price" value={menu.menu_price != null ? fmtKr(menu.menu_price) : (menu.selling_price_ex_vat != null ? fmtKr(menu.selling_price_ex_vat) : '—')} />
            </div>

            {/* Price + VAT editor */}
            <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, padding: 14, marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2, marginBottom: 8 }}>Price & VAT</div>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' as const }}>
                <Field label="Price ex-VAT">
                  <input type="number" min="0" step="0.01" defaultValue={menu.selling_price_ex_vat ?? ''}
                    onBlur={e => {
                      const v = e.target.value.trim() === '' ? null : Number(e.target.value)
                      if (v !== menu.selling_price_ex_vat) patchMenu({ selling_price_ex_vat: v })
                    }} style={{ ...inputStyle, width: 110 }} />
                </Field>
                <Field label="Menu price (inc-VAT)">
                  <input type="number" min="0" step="1" defaultValue={menu.menu_price ?? ''}
                    onBlur={e => {
                      const v = e.target.value.trim() === '' ? null : Number(e.target.value)
                      if (v !== menu.menu_price) patchMenu({ menu_price: v })
                    }} style={{ ...inputStyle, width: 110 }} />
                </Field>
                <Field label="VAT %">
                  <select defaultValue={menu.vat_rate ?? 12}
                    onChange={e => patchMenu({ vat_rate: Number(e.target.value) })}
                    style={{ ...inputStyle, width: 80 }}>
                    <option value="6">6 %</option>
                    <option value="12">12 %</option>
                    <option value="25">25 %</option>
                  </select>
                </Field>
                <Field label="Channel">
                  <select defaultValue={menu.channel ?? 'dine_in'}
                    onChange={e => patchMenu({ channel: e.target.value })}
                    style={{ ...inputStyle, width: 110 }}>
                    <option value="dine_in">Dine-in</option>
                    <option value="takeaway">Takeaway</option>
                  </select>
                </Field>
              </div>
            </div>

            {/* Courses */}
            <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderBottom: `0.5px solid ${UXP.border}` }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: UXP.ink2 }}>Courses</div>
                <button onClick={() => setPicker(true)}
                  style={{ padding: '4px 10px', fontSize: 11, background: UXP.lavMid, color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit' }}>
                  + Add {menu.type === 'food' ? 'course' : 'pour'}
                </button>
              </div>
              {items.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center' as const, color: UXP.ink3, fontSize: 12 }}>
                  No {menu.type === 'food' ? 'courses' : 'pours'} yet. Add one to start building the menu.
                </div>
              )}
              {items.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                  <thead>
                    <tr style={{ background: UXP.subtleBg }}>
                      <Th label="#" />
                      <Th label="" />
                      <Th label="Recipe" />
                      <Th label="Qty" align="right" />
                      <Th label="Cost / portion" align="right" />
                      <Th label="Line cost" align="right" />
                      <Th label="" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, idx) => (
                      <tr key={it.id} style={{ borderTop: `0.5px solid ${UXP.border}` }}>
                        <td style={td}>{idx + 1}</td>
                        <td style={{ ...td, width: 56 }}>
                          {it.recipe_image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={it.recipe_image} alt=""
                              onClick={() => setLightbox({ url: it.recipe_image!, name: it.recipe_name })}
                              title="Click to enlarge"
                              loading="lazy"
                              style={{
                                width: 40, height: 40, borderRadius: 5, objectFit: 'cover' as const,
                                border: `0.5px solid ${UXP.border}`, background: '#fff', display: 'block', cursor: 'zoom-in',
                              }}
                            />
                          ) : (
                            <div style={{ width: 40, height: 40, borderRadius: 5, background: UXP.subtleBg, border: `0.5px dashed ${UXP.border}` }} />
                          )}
                        </td>
                        <td style={td}>
                          <div style={{ color: UXP.ink1, fontWeight: 500 }}>{it.recipe_name}</div>
                          {it.recipe_type && <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{it.recipe_type}</div>}
                          {it.incomplete && <div style={{ fontSize: 10, color: UXP.coral, marginTop: 1 }}>Incomplete cost</div>}
                        </td>
                        <td style={{ ...td, textAlign: 'right' as const }}>
                          <input type="number" min="0.01" step="0.5" defaultValue={it.qty}
                            onBlur={e => { const v = Number(e.target.value); if (v > 0 && v !== it.qty) patchItem(it.id, { qty: v }) }}
                            style={{ ...inputStyle, width: 70, textAlign: 'right' as const }} />
                        </td>
                        <td style={numTd}>{fmtKr(it.food_cost_per_portion)}</td>
                        <td style={numTd}>{fmtKr(it.line_food_cost)}</td>
                        <td style={{ ...td, textAlign: 'right' as const }}>
                          <button onClick={() => deleteItem(it.id)}
                            style={{ background: 'transparent', border: 'none', color: UXP.ink4, cursor: 'pointer', fontSize: 14, padding: 0 }} aria-label="Remove">×</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            {/* Connected sales articles — parallel to recipes' section.
                POS link is parked per CLAUDE.md M097 / POS-RECIPE-MAPPING-PLAN.md;
                this is the placeholder so the surface exists and matches the
                recipe-editor pattern. When the menu_id ↔ pos_menu_items wire
                ships, this section will list connected POS articles. */}
            <ConnectedSalesArticlesCard menu={menu} />
          </>
        )}

        {/* Course picker modal */}
        {picker && menu && (
          <div style={{ position: 'fixed' as const, inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
            <div style={{ background: '#fff', borderRadius: 8, maxWidth: 520, width: '100%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' as const, overflow: 'hidden' }}>
              <div style={{ padding: '12px 16px', borderBottom: `0.5px solid ${UXP.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1 }}>
                  Add {menu.type === 'food' ? 'a course' : 'a pour'}
                </div>
                <button onClick={() => { setPicker(false); setPickerQuery('') }}
                  style={{ background: 'transparent', border: 'none', color: UXP.ink3, fontSize: 18, cursor: 'pointer', padding: 0 }}>×</button>
              </div>
              <div style={{ padding: 12, borderBottom: `0.5px solid ${UXP.border}` }}>
                <input
                  type="text" autoFocus placeholder={menu.type === 'food' ? 'Search food recipes…' : 'Search drink recipes…'}
                  value={pickerQuery} onChange={e => setPickerQuery(e.target.value)}
                  style={{ ...inputStyle, width: '100%' }}
                />
              </div>
              <div style={{ overflowY: 'auto' as const, flex: 1 }}>
                {filteredOptions.length === 0 && (
                  <div style={{ padding: 16, textAlign: 'center' as const, color: UXP.ink4, fontSize: 12 }}>No matching recipes.</div>
                )}
                {filteredOptions.map(r => (
                  <button key={r.id} onClick={() => addCourse(r.id)}
                    style={{ display: 'block', width: '100%', textAlign: 'left' as const, padding: '10px 16px', background: 'transparent', border: 'none', borderBottom: `0.5px solid ${UXP.border}`, cursor: 'pointer', fontFamily: 'inherit' }}>
                    <div style={{ fontSize: 12, color: UXP.ink1, fontWeight: 500 }}>{r.name}</div>
                    {r.type && <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 1 }}>{r.type}</div>}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </PageContainer>

      {/* Click-to-enlarge dish photo. Backdrop click or Esc closes. */}
      {lightbox && <CourseLightbox url={lightbox.url} name={lightbox.name} onClose={() => setLightbox(null)} />}
    </AppShell>
  )
}

// ── MenuImageEditor ───────────────────────────────────────────────────
// Mirrors RecipeImageEditor from components/RecipeEditor.tsx — same UX
// (square tile, click to upload, × to remove). POST/DELETE land at
// /api/inventory/menus/[id]/image which writes menus.image_url.
function MenuImageEditor({ menuId, imageUrl, onChange }: {
  menuId: string
  imageUrl: string | null
  onChange: () => void
}) {
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  async function upload(file: File) {
    setBusy(true)
    const fd = new FormData()
    fd.append('file', file)
    const r = await fetch(`/api/inventory/menus/${menuId}/image`, { method: 'POST', cache: 'no-store', body: fd })
    const j = await r.json().catch(() => ({}))
    setBusy(false)
    if (!r.ok) { alert(j.error ?? `HTTP ${r.status}`); return }
    onChange()
  }

  async function remove() {
    if (!confirm('Remove this image?')) return
    setBusy(true)
    const r = await fetch(`/api/inventory/menus/${menuId}/image`, { method: 'DELETE', cache: 'no-store' })
    setBusy(false)
    if (!r.ok) { alert('Failed to remove'); return }
    onChange()
  }

  return (
    <div style={{ position: 'relative' as const, flexShrink: 0 }}>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={e => { const f = e.target.files?.[0]; if (f) upload(f); e.currentTarget.value = '' }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title={imageUrl ? 'Click to replace' : 'Click to upload a photo'}
        style={{
          width: 90, height: 90, borderRadius: 8,
          background: imageUrl ? '#fff' : UXP.subtleBg,
          border: `0.5px solid ${UXP.border}`,
          cursor: busy ? 'wait' : 'pointer', padding: 0, overflow: 'hidden',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: 'inherit',
        }}
      >
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imageUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' as const }} />
        ) : (
          <span style={{ fontSize: 10, color: UXP.ink4, textAlign: 'center' as const, lineHeight: 1.3, padding: 4 }}>
            {busy ? 'Uploading…' : '+ Add photo'}
          </span>
        )}
      </button>
      {imageUrl && !busy && (
        <button
          type="button" onClick={remove} aria-label="Remove image"
          style={{
            position: 'absolute' as const, top: -6, right: -6,
            width: 20, height: 20, borderRadius: '50%' as const,
            background: '#fff', border: `0.5px solid ${UXP.border}`,
            cursor: 'pointer', fontSize: 12, lineHeight: 1, color: UXP.ink3,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, fontFamily: 'inherit',
          }}>×</button>
      )}
    </div>
  )
}

// ── ConnectedSalesArticlesCard ────────────────────────────────────────
// Placeholder section mirroring the recipes' "Connected sales articles"
// card. POS link (M097 / pos_menu_items.menu_id) is parked; this is the
// surface that'll fill in once the wire ships. Owners can open the
// section but can't promote yet — the action is gated to "Coming soon"
// so the menu editor feels parallel to the recipe editor today.
function ConnectedSalesArticlesCard({ menu }: { menu: { id: string; type: 'food' | 'drink' } }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ background: UXP.cardBg, border: `0.5px solid ${UXP.border}`, borderRadius: 8, marginTop: 16, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ width: '100%', textAlign: 'left' as const, padding: '12px 14px',
                 background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                 display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink1 }}>Connected sales articles</div>
          <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 2 }}>
            Not promoted — POS link coming so this menu is sellable as a single article from your till.
          </div>
        </div>
        <span style={{ color: UXP.ink3, fontSize: 14 }}>{open ? '▾' : '▸'} {open ? 'Close' : 'Open'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 14px 14px', borderTop: `0.5px solid ${UXP.border}` }}>
          <div style={{ padding: '10px 12px', background: UXP.subtleBg, borderRadius: 6, marginTop: 10, fontSize: 11, color: UXP.ink3, lineHeight: 1.5 }}>
            When your POS connector (Personalkollen, Onslip, Ancon, etc.) lands a sales article
            that matches this menu, it'll appear here and you can confirm the mapping. Once
            confirmed, every sale of "{menu.type === 'food' ? 'this food menu' : 'this drink menu'}"
            on the POS flows through to demand prediction and food-cost reporting.
            <div style={{ marginTop: 8, fontSize: 10, color: UXP.ink4 }}>
              POS-to-menu wiring is parked. Trigger: customer asks or first POS sync after the
              parallel POS-to-recipe link is in production use.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function CourseLightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div onClick={onClose} role="dialog" aria-label={`Image: ${name}`}
      style={{
        position: 'fixed' as const, inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24, cursor: 'zoom-out',
      }}>
      <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 12, maxWidth: '100%', maxHeight: '100%' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} onClick={e => e.stopPropagation()}
          style={{ maxWidth: '100%', maxHeight: 'calc(100vh - 100px)', objectFit: 'contain' as const, borderRadius: 6, background: '#fff', cursor: 'default' }} />
        <div style={{ color: '#fff', fontSize: 14, fontWeight: 500, textAlign: 'center' as const }}>{name}</div>
      </div>
      <button type="button" onClick={onClose} aria-label="Close"
        style={{ position: 'absolute' as const, top: 16, right: 16, background: 'rgba(255,255,255,0.15)', color: '#fff', border: '0.5px solid rgba(255,255,255,0.3)', borderRadius: 999, width: 32, height: 32, fontSize: 18, cursor: 'pointer', fontFamily: 'inherit' }}>
        ×
      </button>
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: UXP.ink4, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: color ?? UXP.ink1, fontVariantNumeric: 'tabular-nums' as const }}>{value}</div>
    </div>
  )
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: UXP.ink4, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' as const, marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}
function Th({ label, align = 'left' }: { label: string; align?: 'left' | 'right' }) {
  return (
    <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 600, color: UXP.ink4, letterSpacing: '0.04em', textTransform: 'uppercase' as const, textAlign: align }}>{label}</th>
  )
}
const inputStyle: React.CSSProperties = {
  padding: '5px 8px', fontSize: 12, border: `0.5px solid ${UXP.border}`, borderRadius: 4,
  background: '#fff', color: UXP.ink1, fontFamily: 'inherit', outline: 'none',
}
const td: React.CSSProperties = { padding: '10px 12px', fontSize: 12, color: UXP.ink2 }
const numTd: React.CSSProperties = { ...td, textAlign: 'right' as const, fontVariantNumeric: 'tabular-nums' as const, color: UXP.ink1 }
