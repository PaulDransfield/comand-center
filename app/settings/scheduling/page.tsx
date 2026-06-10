'use client'
// app/settings/scheduling/page.tsx
//
// Scheduling labour-rules settings: which Swedish collective agreement binds
// the selected business, whether the under-18 (minderår) protections are
// enforced, and per-staff under-18 tagging. Feeds the scheduling AI prompt
// and the pre-publish compliance engine.
export const dynamic = 'force-dynamic'

import { useCallback, useEffect, useState } from 'react'
import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'

type Agreement = 'visita_hrf' | 'hangavtal_hrf' | 'none'
interface Config { agreement: Agreement; enforce_minor_rules: boolean }
interface StaffRow { staff_uid: string; name: string | null; is_minor: boolean; birth_date: string | null; age_known: boolean }

const AGREEMENT_OPTIONS: { value: Agreement; label: string; hint: string }[] = [
  { value: 'visita_hrf',    label: 'Visita–HRF (Gröna Riksavtalet)', hint: 'Member of Visita, bound by the collective agreement. Adds the 10h/24h cap + OB awareness on top of the law.' },
  { value: 'hangavtal_hrf', label: 'Hängavtal with HRF',             hint: 'Signed a hängavtal directly with HRF. Same rules as Gröna Riksavtalet.' },
  { value: 'none',          label: 'No collective agreement',         hint: 'Only Arbetstidslagen + LAS apply. The 10h/24h cap and OB premiums are not enforced.' },
]

export default function SchedulingSettingsPage() {
  const [bizId, setBizId]     = useState<string | null>(null)
  const [config, setConfig]   = useState<Config | null>(null)
  const [staff, setStaff]     = useState<StaffRow[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    const s = localStorage.getItem('cc_selected_biz')
    if (s) setBizId(s)
    function onStorage() { const n = localStorage.getItem('cc_selected_biz'); if (n) setBizId(n) }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const load = useCallback(async () => {
    if (!bizId) { setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const r = await fetch(`/api/settings/labor-rules?business_id=${encodeURIComponent(bizId)}`, { cache: 'no-store' })
      const j = await r.json()
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setConfig({ agreement: j.config.agreement, enforce_minor_rules: !!j.config.enforce_minor_rules })
      setStaff(j.staff ?? [])
    } catch (e: any) { setError(e.message) } finally { setLoading(false) }
  }, [bizId])
  useEffect(() => { if (bizId) load(); else setLoading(false) }, [bizId, load])

  async function saveConfig(patch: Partial<Config>) {
    if (!bizId || !config) return
    const next = { ...config, ...patch }
    setConfig(next)   // optimistic
    setSaving(true); setError(null)
    try {
      const r = await fetch('/api/settings/labor-rules', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, config: next }),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
    } catch (e: any) { setError(e.message); load() } finally { setSaving(false) }
  }

  async function toggleMinor(staff_uid: string, is_minor: boolean) {
    if (!bizId) return
    setStaff(prev => prev.map(s => s.staff_uid === staff_uid ? { ...s, is_minor } : s))   // optimistic
    try {
      const r = await fetch('/api/settings/labor-rules', {
        method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: bizId, staff_minor: { staff_uid, is_minor } }),
      })
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`) }
    } catch (e: any) { setError(e.message); load() }
  }

  const S = {
    card:  { background: 'white', border: `0.5px solid ${UXP.border}`, borderRadius: 12, padding: '20px 24px', marginBottom: 20 },
    title: { fontSize: 14, fontWeight: 700, color: UXP.ink1, marginBottom: 4 },
    sub:   { fontSize: 12, color: UXP.ink4, marginBottom: 16, lineHeight: 1.5 },
  }

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 760 }}>
        <a href="/settings" style={{ fontSize: 12, color: UXP.ink3, textDecoration: 'none' }}>← Settings</a>
        <div style={{ margin: '8px 0 24px' }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>Scheduling — labour rules</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: UXP.ink3 }}>
            Which Swedish rules the scheduling AI and the pre-publish compliance check enforce. See the{' '}
            <a href="/docs/SWEDISH-LABOUR-COMPLIANCE.md" style={{ color: UXP.lavDeep }}>full regulation guide</a>.
          </p>
        </div>

        {!bizId && <div style={{ ...S.card, color: UXP.ink3, fontSize: 13 }}>Select a business in the sidebar to configure its labour rules.</div>}
        {error && <div style={{ ...S.card, background: UXP.roseFill, border: `0.5px solid ${UXP.rose}`, color: UXP.roseText, fontSize: 12 }}>{error}</div>}
        {bizId && loading && <div style={{ ...S.card, color: UXP.ink3, fontSize: 13 }}>Loading…</div>}

        {bizId && !loading && config && (
          <>
            {/* Collective agreement */}
            <div style={S.card}>
              <div style={S.title}>Collective agreement</div>
              <div style={S.sub}>
                Statutory law (Arbetstidslagen: 11h daily rest, 36h weekly rest, 48h/week) always applies. The agreement adds rules on top.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {AGREEMENT_OPTIONS.map(opt => {
                  const active = config.agreement === opt.value
                  return (
                    <button key={opt.value} type="button" onClick={() => saveConfig({ agreement: opt.value })} disabled={saving}
                      style={{
                        textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                        background: active ? UXP.lavFill : 'transparent',
                        border: `1px solid ${active ? UXP.lav : UXP.border}`,
                      }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{
                          width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
                          border: `2px solid ${active ? UXP.lavDeep : UXP.border}`,
                          background: active ? UXP.lavDeep : 'transparent', boxShadow: active ? `inset 0 0 0 2px #fff` : 'none',
                        }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1 }}>{opt.label}</span>
                      </div>
                      <div style={{ fontSize: 11, color: UXP.ink3, marginTop: 4, marginLeft: 24, lineHeight: 1.5 }}>{opt.hint}</div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Minor enforcement */}
            <div style={S.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
                <div style={{ flex: 1 }}>
                  <div style={S.title}>Enforce under-18 (minderår) rules</div>
                  <div style={{ ...S.sub, marginBottom: 0 }}>
                    AFS 2012:3 — minors can't work 22:00–06:00, max 8h/day and 40h/week, with 12h daily rest. A collective agreement can never weaken these. When on, the compliance check hard-blocks any roster that breaks them for staff tagged below.
                  </div>
                </div>
                <Toggle on={config.enforce_minor_rules} disabled={saving} onChange={v => saveConfig({ enforce_minor_rules: v })} />
              </div>
            </div>

            {/* Per-staff under-18 tagging */}
            <div style={S.card}>
              <div style={S.title}>Under-18 staff</div>
              <div style={S.sub}>
                Tag staff who are under 18 so the minor rules apply to them. Auto-set from the staff feed when a birth date is available; otherwise set it here.
                {!config.enforce_minor_rules && <span style={{ color: UXP.coral }}> Minor rules are currently OFF — turn them on above for these tags to take effect.</span>}
              </div>
              {staff.length === 0 ? (
                <div style={{ fontSize: 12, color: UXP.ink4 }}>No staff synced yet for this business.</div>
              ) : staff.map(s => (
                <div key={s.staff_uid} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: `0.5px solid ${UXP.subtleBg}` }}>
                  <div>
                    <div style={{ fontSize: 13, color: UXP.ink1 }}>{s.name ?? s.staff_uid}</div>
                    <div style={{ fontSize: 11, color: UXP.ink4 }}>
                      {s.age_known ? `Born ${s.birth_date} · auto-detected` : 'No birth date on file'}
                    </div>
                  </div>
                  <Toggle on={s.is_minor} onChange={v => toggleMinor(s.staff_uid, v)} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </AppShell>
  )
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label style={{ position: 'relative', display: 'inline-block', width: 44, height: 24, flexShrink: 0 }}>
      <input type="checkbox" checked={on} disabled={disabled} onChange={e => onChange(e.target.checked)} style={{ opacity: 0, width: 0, height: 0 }} />
      <span style={{
        position: 'absolute', inset: 0, cursor: disabled ? 'wait' : 'pointer',
        background: on ? UXP.lavDeep : UXP.border, borderRadius: 24, transition: 'background .2s',
      }}>
        <span style={{ position: 'absolute', top: 3, left: on ? 23 : 3, width: 18, height: 18, background: 'white', borderRadius: '50%', transition: 'left .2s' }} />
      </span>
    </label>
  )
}
