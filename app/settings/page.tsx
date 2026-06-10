'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import AppShell from '@/components/AppShell'
import { UXP } from '@/lib/constants/tokens'
import React, { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'

interface Mapping {
  id: string
  vendor_contains: string
  category: string
  category_label: string | null
  priority: number
}

interface Business { [key: string]: any;
  id: string
  name: string
  city: string | null
  type: string | null
  is_active: boolean
}

const CATEGORY_VALUES = [
  'food_beverage', 'alcohol', 'staff', 'rent', 'cleaning',
  'repairs', 'marketing', 'utilities', 'admin', 'other',
] as const

const RESTAURANT_TYPES = ['restaurant', 'bar', 'cafe', 'bakery', 'catering']

export default function SettingsPage() {
  const t       = useTranslations('settings')
  const tCommon = useTranslations('common')
  const CATEGORIES = CATEGORY_VALUES.map(value => ({ value, label: t(`categories.${value}`) }))
  const [mappings,    setMappings]    = useState<Mapping[]>([])
  const [businesses,  setBusinesses]  = useState<Business[]>([])
  const [loading,     setLoading]     = useState(true)
  const [newVendor,   setNewVendor]   = useState('')
  const [newCategory, setNewCategory] = useState('food_beverage')
  const [testVendor,  setTestVendor]  = useState('')
  const [testResult,  setTestResult]  = useState<Mapping | null | 'no_match'>(null)
  const [showAddBiz,    setShowAddBiz]    = useState(false)
  const [newBizName,    setNewBizName]    = useState('')
  const [newBizCity,    setNewBizCity]    = useState('')
  const [newBizType,    setNewBizType]    = useState('restaurant')
  // M046 fields — captured at add time so the budget AI, scheduling AI,
  // and Fortnox onboarding all have what they need from day 1.
  const [newBizAddress, setNewBizAddress] = useState('')
  const [newBizOrgNr,   setNewBizOrgNr]   = useState('')
  const [newBizStage,   setNewBizStage]   = useState<'new' | 'established_1y' | 'established_3y'>('established_1y')
  const [newBizCountry, setNewBizCountry] = useState<'SE' | 'NO' | 'GB'>('SE')
  const [newBizOpenDays, setNewBizOpenDays] = useState<Record<string, boolean>>({
    mon: true, tue: true, wed: true, thu: true, fri: true, sat: true, sun: true,
  })
  const [planLimitInfo, setPlanLimitInfo] = useState<{ current_plan: string; cap: number; upgrade_to: string } | null>(null)
  const [savingBiz,   setSavingBiz]   = useState(false)
  const [bizError,    setBizError]    = useState('')
  const [expandedBiz, setExpandedBiz] = useState<any>(null)
  const [editingBiz,  setEditingBiz]  = useState<any>(null)

  useEffect(() => {
    loadMappings()
    fetch('/api/businesses?all=true')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setBusinesses(d) })
      .catch(() => {})
  }, [])

  async function loadMappings() {
    setLoading(true)
    const res  = await fetch('/api/supplier-mappings')
    const data = await res.json()
    if (Array.isArray(data)) setMappings(data)
    setLoading(false)
  }

  async function addRule(e: React.FormEvent) {
    e.preventDefault()
    if (!newVendor.trim()) return
    await fetch('/api/supplier-mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vendor_contains: newVendor, category: newCategory }),
    })
    setNewVendor('')
    loadMappings()
  }

  async function deleteRule(id: string) {
    if (!confirm(t('supplier.deleteRule'))) return
    await fetch(`/api/supplier-mappings?id=${id}`, { method: 'DELETE' })
    loadMappings()
  }

  async function testMapping() {
    if (!testVendor.trim()) return
    const res  = await fetch(`/api/supplier-mappings/test?vendor=${encodeURIComponent(testVendor)}`)
    const data = await res.json()
    setTestResult(data.match ?? 'no_match')
  }

  async function saveNewBusiness() {
    if (!newBizName.trim()) return
    setSavingBiz(true)
    setBizError('')
    setPlanLimitInfo(null)
    try {
      // Strip non-digits from org_nr client-side; server validates length + checksum.
      const orgNr = newBizOrgNr.trim() ? newBizOrgNr.replace(/\D/g, '') : null
      const res = await fetch('/api/businesses/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name:            newBizName,
          city:            newBizCity,
          type:            newBizType,
          address:         newBizAddress.trim() || null,
          org_number:      orgNr,
          business_stage:  newBizStage,
          country:         newBizCountry,
          opening_days:    newBizOpenDays,
        }),
      })
      const data = await res.json()
      if (res.status === 402 && data?.error === 'plan_limit_reached') {
        setPlanLimitInfo({ current_plan: data.current_plan, cap: data.cap, upgrade_to: data.upgrade_to })
        setBizError(data.message)
        setSavingBiz(false)
        return
      }
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      setBusinesses(prev => [...prev, data])
      setShowAddBiz(false)
      setNewBizName(''); setNewBizCity(''); setNewBizAddress(''); setNewBizOrgNr('')
      // Stitch the integration step into the journey: switch the sidebar
      // to the new business and route to /integrations so the owner
      // immediately connects Fortnox / Personalkollen instead of being
      // left on the settings page wondering what to do next.
      try { localStorage.setItem('cc_selected_biz', data.id) } catch {}
      window.location.href = '/integrations?from=add_business&business_id=' + encodeURIComponent(data.id)
    } catch (e: any) {
      setBizError(e.message)
    }
    setSavingBiz(false)
  }

  async function deactivateBusiness(id: string, name: string, isActive: boolean) {
    if (!window.confirm(isActive ? t('restaurants.confirm.deactivate', { name }) : t('restaurants.confirm.reactivate', { name }))) return
    try {
      await fetch('/api/businesses/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, is_active: !isActive }),
      })
      setBusinesses(prev => prev.map(b => b.id === id ? { ...b, is_active: !isActive } : b))
    } catch (e: any) {
      alert('Failed: ' + e.message)
    }
  }

  async function deleteBusiness(id: string, name: string) {
    const action = window.confirm(t('restaurants.confirm.deleteOrDeactivate', { name }))
    if (!action) return
    const confirm2 = window.confirm(t('restaurants.confirm.deletePermanent', { name }))
    if (!confirm2) return
    try {
      const res = await fetch('/api/businesses/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, permanent: true }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      setBusinesses(prev => prev.filter(b => b.id !== id))
    } catch (e: any) {
      alert('Failed to delete: ' + e.message)
    }
  }

  async function saveBizEdit() {
    if (!editingBiz?.id) return
    try {
      // Normalise org_number client-side: strip non-digits. Server validates
      // length + checksum and rejects if bad.
      const orgNumber = editingBiz.org_number != null
        ? String(editingBiz.org_number).replace(/\D/g, '') || null
        : null
      const res = await fetch('/api/businesses/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          business_id: editingBiz.id,
          name: editingBiz.name,
          city: editingBiz.city,
          type: editingBiz.type,
          org_number: orgNumber,
        }),
      })
      if (res.ok) {
        setBusinesses(prev => prev.map(b => b.id === editingBiz.id ? { ...b, ...editingBiz } : b))
        setEditingBiz(null)
      } else {
        const d = await res.json()
        alert(d.error ?? 'Failed to save')
      }
    } catch (e) {
      alert('Failed to save')
    }
  }

  const S = {
    card:   { background: 'white', border: `0.5px solid ${UXP.border}`, borderRadius: 12, padding: '20px 24px', marginBottom: 20 },
    title:  { fontSize: 14, fontWeight: 700, color: UXP.ink1, marginBottom: 4 },
    sub:    { fontSize: 12, color: UXP.ink4, marginBottom: 16 },
    label:  { fontSize: 12, fontWeight: 600, color: UXP.ink2, display: 'block', marginBottom: 6 },
    input:  { width: '100%', padding: '9px 12px', border: `1px solid ${UXP.border}`, borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const, fontFamily: 'inherit' },
    btn:    { padding: '9px 18px', background: UXP.ink1, color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    btnSm:  { padding: '5px 12px', background: UXP.subtleBg, border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: UXP.ink2 },
    btnRed: { padding: '4px 10px', background: 'none', border: `1px solid ${UXP.rose}`, borderRadius: 6, fontSize: 11, color: UXP.roseText, cursor: 'pointer' },
    row:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  }

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 800 }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: UXP.ink1 }}>{t('page.title')}</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: UXP.ink3 }}>{t('page.subtitle')}</p>
        </div>

        {/* Team & access — link card */}
        <a
          href="/settings/team"
          style={{
            ...S.card,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <div>
            <div style={S.title}>Team &amp; access</div>
            <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 2 }}>
              Invite managers or your revisor. Managers see operations; revisors see read-only month-end data per business.
            </div>
          </div>
          <span style={{ fontSize: 13, color: UXP.lavDeep, fontWeight: 500 }}>Manage →</span>
        </a>

        {/* AI agents — link card to /settings/ai-agents */}
        <a
          href="/settings/ai-agents"
          style={{
            ...S.card,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <div>
            <div style={S.title}>AI agents</div>
            <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 2 }}>
              Six AI agents work in the background on your data. View status, last run, cost, and toggle any of them on or off.
            </div>
          </div>
          <span style={{ fontSize: 13, color: UXP.lavDeep, fontWeight: 500 }}>Manage →</span>
        </a>

        {/* Scheduling labour rules — link card to /settings/scheduling */}
        <a
          href="/settings/scheduling"
          style={{
            ...S.card,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <div>
            <div style={S.title}>Scheduling — labour rules</div>
            <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 2 }}>
              Set which Swedish collective agreement applies (Visita–HRF), enforce under-18 rules, and tag minor staff. Drives the scheduling AI and the pre-publish compliance check.
            </div>
          </div>
          <span style={{ fontSize: 13, color: UXP.lavDeep, fontWeight: 500 }}>Manage →</span>
        </a>

        {/* Integrations — link card to /integrations */}
        <a
          href="/integrations"
          style={{
            ...S.card,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            textDecoration: 'none',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <div>
            <div style={S.title}>Integrations</div>
            <div style={{ fontSize: 12, color: UXP.ink3, marginTop: 2 }}>
              Connect Fortnox, Personalkollen, POS systems and other tools per business. Reconnect when an integration drops.
            </div>
          </div>
          <span style={{ fontSize: 13, color: UXP.lavDeep, fontWeight: 500 }}>Manage →</span>
        </a>

        {/* Restaurants */}
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={S.title}>{t('restaurants.card')}</div>
              <div style={{ fontSize: 12, color: UXP.ink4 }}>{t('restaurants.subtitle')}</div>
            </div>
            <button onClick={() => setShowAddBiz(true)} style={S.btn}>{t('restaurants.addLocation')}</button>
          </div>

          {businesses.length === 0 ? (
            <div style={{ fontSize: 12, color: UXP.ink4, textAlign: 'center', padding: '20px 0' }}>{t('restaurants.empty')}</div>
          ) : businesses.map(biz => {
            const isOpen = expandedBiz === biz.id
            const isEditing = editingBiz?.id === biz.id
            return (
              <div key={biz.id} style={{ borderBottom: `0.5px solid ${UXP.subtleBg}` }}>
                {/* Row */}
                <div onClick={() => setExpandedBiz(isOpen ? null : biz.id)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 11, color: UXP.ink4 }}>{isOpen ? '▼' : '▶'}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1 }}>{biz.name}</div>
                      <div style={{ fontSize: 11, color: UXP.ink4 }}>{biz.city ?? t('restaurants.noCity')} · {biz.type ?? t('restaurants.defaultType')}</div>
                    </div>
                  </div>
                  <span style={{ fontSize: 11, background: biz.is_active !== false ? UXP.greenFill : UXP.roseFill, color: biz.is_active !== false ? UXP.greenDeep : UXP.roseText, padding: '2px 8px', borderRadius: 4 }}>
                    {biz.is_active !== false ? t('restaurants.active') : t('restaurants.inactive')}
                  </span>
                </div>

                {/* Expanded panel */}
                {isOpen && (
                  <div style={{ background: UXP.subtleBg, borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
                    {isEditing ? (
                      /* Edit form */
                      <div>
                        <div style={{ ...S.row, marginBottom: 10 }}>
                          <div>
                            <label style={S.label}>{t('restaurants.edit_form.name')}</label>
                            <input value={editingBiz.name} onChange={e => setEditingBiz({...editingBiz, name: e.target.value})} style={S.input} />
                          </div>
                          <div>
                            <label style={S.label}>{t('restaurants.edit_form.city')}</label>
                            <input value={editingBiz.city ?? ''} onChange={e => setEditingBiz({...editingBiz, city: e.target.value})} style={S.input} />
                          </div>
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={S.label}>{t('restaurants.edit_form.type')}</label>
                          <select value={editingBiz.type ?? 'restaurant'} onChange={e => setEditingBiz({...editingBiz, type: e.target.value})} style={S.input}>
                            {RESTAURANT_TYPES.map(rt => <option key={rt} value={rt}>{rt.charAt(0).toUpperCase()+rt.slice(1)}</option>)}
                          </select>
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={S.label}>{t('restaurants.edit_form.orgNumber')}</label>
                          <input
                            value={editingBiz.org_number ?? ''}
                            onChange={e => setEditingBiz({...editingBiz, org_number: e.target.value})}
                            placeholder="556677-8899"
                            inputMode="numeric"
                            style={{ ...S.input, fontFamily: 'ui-monospace, monospace' }}
                          />
                          <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 4 }}>
                            {t('restaurants.edit_form.orgNumberHint')}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => saveBizEdit()} style={S.btn}>{t('restaurants.edit_form.save')}</button>
                          <button onClick={() => setEditingBiz(null)} style={S.btnSm}>{tCommon('actions.cancel')}</button>
                        </div>
                      </div>
                    ) : (
                      /* Action buttons */
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={e => { e.stopPropagation(); setEditingBiz({...biz}) }} style={S.btnSm}>{t('restaurants.edit')}</button>
                        <button onClick={e => { e.stopPropagation(); deactivateBusiness(biz.id, biz.name, biz.is_active) }}
                          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: `1px solid ${UXP.border}`, background: 'white', cursor: 'pointer', color: UXP.ink3 }}>
                          {biz.is_active !== false ? t('restaurants.deactivate') : t('restaurants.reactivate')}
                        </button>
                        <button onClick={e => { e.stopPropagation(); deleteBusiness(biz.id, biz.name) }}
                          style={{ ...S.btnSm, background: UXP.roseFill, color: UXP.roseText, border: `1px solid ${UXP.rose}` }}>
                          {t('restaurants.delete')}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        {/* Add business modal */}
        {showAddBiz && (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 199, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, overflowY: 'auto' }}
            onClick={() => setShowAddBiz(false)}>
            <div style={{ background: UXP.cardBg, borderRadius: 14, padding: 28, width: 520, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', border: `1px solid ${UXP.border}`, boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 16, fontWeight: 700, color: UXP.ink1, marginBottom: 6 }}>{t('restaurants.modal.title')}</div>
              <div style={{ fontSize: 12, color: UXP.ink3, marginBottom: 18 }}>
                Same data we collect at onboarding — drives budget AI, scheduling AI, Fortnox connection and holiday calendar from day one.
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>{t('restaurants.modal.name')} *</label>
                <input value={newBizName} onChange={e => setNewBizName(e.target.value)}
                  placeholder={t('restaurants.modal.namePlaceholder')} style={S.input} />
              </div>

              <div style={{ ...S.row, marginBottom: 14 }}>
                <div>
                  <label style={S.label}>{t('restaurants.modal.city')}</label>
                  <input value={newBizCity} onChange={e => setNewBizCity(e.target.value)}
                    placeholder={t('restaurants.modal.cityPlaceholder')} style={S.input} />
                </div>
                <div>
                  <label style={S.label}>{t('restaurants.modal.type')}</label>
                  <select value={newBizType} onChange={e => setNewBizType(e.target.value)} style={S.input}>
                    {RESTAURANT_TYPES.map(rt => <option key={rt} value={rt}>{rt.charAt(0).toUpperCase() + rt.slice(1)}</option>)}
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Street address</label>
                <input value={newBizAddress} onChange={e => setNewBizAddress(e.target.value)}
                  placeholder="Engelbrektsgatan 8" style={S.input} />
              </div>

              <div style={{ ...S.row, marginBottom: 14 }}>
                <div>
                  <label style={S.label}>Organisationsnummer</label>
                  <input value={newBizOrgNr} onChange={e => setNewBizOrgNr(e.target.value)}
                    placeholder="556677-8899" style={S.input} />
                  <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>Required to connect Fortnox for this business.</div>
                </div>
                <div>
                  <label style={S.label}>Country</label>
                  <select value={newBizCountry} onChange={e => setNewBizCountry(e.target.value as any)} style={S.input}>
                    <option value="SE">Sweden</option>
                    <option value="NO">Norway</option>
                    <option value="GB">United Kingdom</option>
                  </select>
                </div>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Business stage</label>
                <select value={newBizStage} onChange={e => setNewBizStage(e.target.value as any)} style={S.input}>
                  <option value="new">New (opened &lt; 12 months ago) — budget AI skips historical anchor</option>
                  <option value="established_1y">Established (1-3 years) — anchor on one prior year</option>
                  <option value="established_3y">Established (3+ years) — full prior-year history</option>
                </select>
              </div>

              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Open days</label>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {(['mon','tue','wed','thu','fri','sat','sun'] as const).map(d => (
                    <button
                      type="button"
                      key={d}
                      onClick={() => setNewBizOpenDays(s => ({ ...s, [d]: !s[d] }))}
                      style={{
                        padding: '6px 14px', fontSize: 12, fontWeight: 500,
                        background: newBizOpenDays[d] ? UXP.lavFill : 'transparent',
                        color:      newBizOpenDays[d] ? UXP.lavText : UXP.ink3,
                        border:     `0.5px solid ${newBizOpenDays[d] ? UXP.lav : UXP.border}`,
                        borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                        textTransform: 'uppercase' as const,
                      }}
                    >{d}</button>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: UXP.ink4, marginTop: 4 }}>Closed days are skipped by forecast + scheduling AI.</div>
              </div>

              {bizError && (
                <div style={{
                  fontSize: 12, color: UXP.roseText, marginBottom: 10,
                  padding: 10, background: UXP.roseFill, borderRadius: 6,
                  border: `0.5px solid ${UXP.rose}`,
                }}>
                  {bizError}
                  {planLimitInfo && (
                    <div style={{ marginTop: 8 }}>
                      <a href={`/upgrade?from=add_business&to=${planLimitInfo.upgrade_to}`} style={{ color: UXP.roseText, fontWeight: 600, textDecoration: 'underline' }}>
                        Upgrade to {planLimitInfo.upgrade_to} →
                      </a>
                    </div>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={saveNewBusiness} disabled={!newBizName.trim() || savingBiz || !!planLimitInfo}
                  style={{ ...S.btn, flex: 1, opacity: !newBizName.trim() || planLimitInfo ? 0.5 : 1 }}>
                  {savingBiz ? t('restaurants.modal.saving') : 'Save + connect integrations →'}
                </button>
                <button onClick={() => setShowAddBiz(false)} style={{ ...S.btnSm, padding: '9px 16px' }}>{tCommon('actions.cancel')}</button>
              </div>
            </div>
          </div>
        )}

        {/* Supplier mapping */}
        <div style={S.card}>
          <div style={S.title}>{t('supplier.title')}</div>
          <div style={{ ...S.sub }}>{t('supplier.subtitle')}</div>

          {/* Test a vendor */}
          <div style={{ background: UXP.subtleBg, borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink2, marginBottom: 8 }}>{t('supplier.testHeader')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={testVendor} onChange={e => setTestVendor(e.target.value)}
                placeholder={t('supplier.testPlaceholder')} style={{ ...S.input, flex: 1 }} />
              <button onClick={testMapping} style={S.btn}>{t('supplier.test')}</button>
            </div>
            {testResult && testResult !== 'no_match' && (
              <div style={{ marginTop: 8, fontSize: 12, color: UXP.greenDeep }}>
                {t('supplier.match')}<strong>{(testResult as Mapping).category_label ?? (testResult as Mapping).category}</strong>
              </div>
            )}
            {testResult === 'no_match' && (
              <div style={{ marginTop: 8, fontSize: 12, color: UXP.roseText }}>{t('supplier.noMatch')}</div>
            )}
          </div>

          {/* Add rule */}
          <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink2, marginBottom: 10 }}>{t('supplier.addHeader')}</div>
          <form onSubmit={addRule}>
            <div style={{ ...S.row, marginBottom: 10 }}>
              <div>
                <label style={S.label}>{t('supplier.ifContains')}</label>
                <input value={newVendor} onChange={e => setNewVendor(e.target.value)}
                  placeholder={t('supplier.vendorPlaceholder')} style={S.input} />
              </div>
              <div>
                <label style={S.label}>{t('supplier.categoryLabel')}</label>
                <select value={newCategory} onChange={e => setNewCategory(e.target.value)} style={S.input}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <button type="submit" style={S.btnSm}>{t('supplier.addEntry')}</button>
          </form>

          {/* Active rules */}
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink2, marginBottom: 8 }}>
              {t('supplier.activeRules', { count: mappings.length })}
            </div>
            {loading ? (
              <div style={{ fontSize: 12, color: UXP.ink4 }}>{t('supplier.loading')}</div>
            ) : mappings.length === 0 ? (
              <div style={{ fontSize: 12, color: UXP.ink4 }}>{t('supplier.emptyRules')}</div>
            ) : mappings.map(m => (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `0.5px solid ${UXP.subtleBg}` }}>
                <div style={{ fontSize: 13, color: UXP.ink1 }}>
                  <span style={{ color: UXP.ink4 }}>{t('supplier.contains')}</span>
                  <strong>"{m.vendor_contains}"</strong>
                  <span style={{ color: UXP.ink4 }}>{t('supplier.ruleArrow')}</span>
                  <span style={{ color: UXP.lavDeep }}>{m.category_label ?? m.category}</span>
                </div>
                <button onClick={() => deleteRule(m.id)} style={S.btnRed}>{t('restaurants.delete')}</button>
              </div>
            ))}
            <div style={{ fontSize: 11, color: UXP.ink4, marginTop: 10 }}>
              {t('supplier.footnote')}
            </div>
          </div>
        </div>

        {/* Weekly digest */}
        <div style={S.card}>
          <div style={S.title}>{t('digest.title')}</div>
          <div style={S.sub}>{t('digest.subtitle')}</div>
          <button style={S.btnSm}>{t('digest.send')}</button>
        </div>

      </div>
      {/* GDPR / Data & Privacy */}
      <GdprSection />

    </AppShell>
  )
}

function GdprSection() {
  const t       = useTranslations('settings.gdpr')
  const tCancel = useTranslations('common')
  const [loading,    setLoading]    = React.useState(false)
  const [delLoading, setDelLoading] = React.useState(false)
  const [consents,   setConsents]   = React.useState<any[]>([])
  const [delStatus,  setDelStatus]  = React.useState('')
  const [showConfirm, setShowConfirm] = React.useState(false)
  const [aiPrivacy,  setAiPrivacy]  = React.useState<boolean | null>(null)
  const [aiSaving,   setAiSaving]   = React.useState(false)

  React.useEffect(() => {
    fetch('/api/gdpr/consent').then(r => r.json()).then(d => {
      if (d.consents) setConsents(d.consents)
    })
    fetch('/api/settings/ai-privacy', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setAiPrivacy(d.log_ai_questions !== false) })
      .catch(() => {})
  }, [])

  async function toggleAiPrivacy(next: boolean) {
    setAiSaving(true)
    try {
      const r = await fetch('/api/settings/ai-privacy', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ log_ai_questions: next }),
      })
      if (r.ok) setAiPrivacy(next)
    } catch {}
    setAiSaving(false)
  }

  async function exportData() {
    setLoading(true)
    const res = await fetch('/api/gdpr')
    const blob = await res.blob()
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `commandcenter-export-${new Date().toISOString().slice(0,10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setLoading(false)
  }

  async function requestDeletion() {
    setDelLoading(true)
    const res  = await fetch('/api/gdpr', { method: 'DELETE' })
    const data = await res.json()
    setDelStatus(data.message ?? t('delete.submitted'))
    setShowConfirm(false)
    setDelLoading(false)
  }

  const privacyConsent = consents.find((c: any) => c.consent_type === 'privacy_policy')

  return (
    <div style={{ background: 'white', border: `0.5px solid ${UXP.border}`, borderRadius: 12, padding: '24px', marginBottom: 20 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: UXP.ink1, marginBottom: 4 }}>{t('title')}</div>
      <div style={{ fontSize: 13, color: UXP.ink3, marginBottom: 20 }}>
        {t('subtitle')}{' '}
        <a href="/privacy" target="_blank" style={{ color: UXP.lavDeep }}>{t('privacyPolicyLink')}</a>.
      </div>

      {/* Consent status */}
      <div style={{ background: UXP.subtleBg, borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: UXP.ink2, marginBottom: 8 }}>{t('consentHeader')}</div>
        {privacyConsent ? (
          <div style={{ fontSize: 12, color: UXP.ink3 }}>
            {t('consentLine', {
              version: privacyConsent.version,
              date: new Date(privacyConsent.consented_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
            })}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: UXP.ink4 }}>{t('noConsent')}</div>
        )}
      </div>

      {/* AI question logging toggle — per-org privacy control */}
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: `1px solid ${UXP.subtleBg}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, marginBottom: 4 }}>{t('ai.title')}</div>
            <div style={{ fontSize: 12, color: UXP.ink3, lineHeight: 1.55 }}>
              {t('ai.subtitle')}
            </div>
          </div>
          <label style={{ position: 'relative' as const, display: 'inline-block', width: 44, height: 24, flexShrink: 0, marginTop: 3 }}>
            <input
              type="checkbox"
              checked={aiPrivacy === true}
              onChange={e => toggleAiPrivacy(e.target.checked)}
              disabled={aiPrivacy === null || aiSaving}
              style={{ opacity: 0, width: 0, height: 0 }}
            />
            <span style={{
              position: 'absolute' as const, inset: 0, cursor: aiSaving ? 'wait' : 'pointer',
              background: aiPrivacy === true ? UXP.ink1 : UXP.border,
              borderRadius: 24, transition: 'background .2s',
            }}>
              <span style={{
                position: 'absolute' as const, top: 3, left: aiPrivacy === true ? 23 : 3,
                width: 18, height: 18, background: 'white', borderRadius: '50%', transition: 'left .2s',
              }} />
            </span>
          </label>
        </div>
      </div>

      {/* Export */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, marginBottom: 4 }}>{t('export.title')}</div>
        <div style={{ fontSize: 12, color: UXP.ink3, marginBottom: 10 }}>
          {t('export.subtitle')}
        </div>
        <button onClick={exportData} disabled={loading}
          style={{ padding: '9px 18px', background: UXP.ink1, color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {loading ? t('export.preparing') : t('export.button')}
        </button>
      </div>

      {/* Deletion */}
      <div style={{ paddingTop: 16, borderTop: `1px solid ${UXP.subtleBg}` }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: UXP.ink1, marginBottom: 4 }}>{t('delete.title')}</div>
        <div style={{ fontSize: 12, color: UXP.ink3, marginBottom: 10 }}>
          {t('delete.subtitle')}
        </div>

        {delStatus ? (
          <div style={{ background: UXP.greenFill, border: `1px solid ${UXP.green}`, borderRadius: 8, padding: '10px 14px', fontSize: 13, color: UXP.greenDeep }}>
            {delStatus}
          </div>
        ) : !showConfirm ? (
          <button onClick={() => setShowConfirm(true)}
            style={{ padding: '9px 18px', background: 'white', color: UXP.roseText, border: `1px solid ${UXP.rose}`, borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {t('delete.button')}
          </button>
        ) : (
          <div style={{ background: UXP.roseFill, border: `1px solid ${UXP.rose}`, borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: UXP.roseText, marginBottom: 8 }}>{t('delete.confirmTitle')}</div>
            <div style={{ fontSize: 12, color: UXP.ink3, marginBottom: 12 }}>
              {t('delete.confirmBody')}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={requestDeletion} disabled={delLoading}
                style={{ padding: '8px 16px', background: UXP.roseText, color: 'white', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {delLoading ? t('delete.submitting') : t('delete.submit')}
              </button>
              <button onClick={() => setShowConfirm(false)}
                style={{ padding: '8px 16px', background: UXP.subtleBg, border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', color: UXP.ink2 }}>
                {tCancel('actions.cancel')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
