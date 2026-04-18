'use client'
// @ts-nocheck
export const dynamic = 'force-dynamic'

import AppShell from '@/components/AppShell'
import React, { useEffect, useState } from 'react'

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

const CATEGORIES = [
  { value: 'food_beverage', label: 'Food & Beverage' },
  { value: 'alcohol',       label: 'Alcohol' },
  { value: 'staff',         label: 'Staff' },
  { value: 'rent',          label: 'Rent & Premises' },
  { value: 'cleaning',      label: 'Cleaning' },
  { value: 'repairs',       label: 'Repairs & Maintenance' },
  { value: 'marketing',     label: 'Marketing' },
  { value: 'utilities',     label: 'Utilities' },
  { value: 'admin',         label: 'Administration' },
  { value: 'other',         label: 'Other' },
]

const RESTAURANT_TYPES = ['restaurant', 'bar', 'cafe', 'bakery', 'catering']

export default function SettingsPage() {
  const [mappings,    setMappings]    = useState<Mapping[]>([])
  const [businesses,  setBusinesses]  = useState<Business[]>([])
  const [loading,     setLoading]     = useState(true)
  const [newVendor,   setNewVendor]   = useState('')
  const [newCategory, setNewCategory] = useState('food_beverage')
  const [testVendor,  setTestVendor]  = useState('')
  const [testResult,  setTestResult]  = useState<Mapping | null | 'no_match'>(null)
  const [showAddBiz,  setShowAddBiz]  = useState(false)
  const [newBizName,  setNewBizName]  = useState('')
  const [newBizCity,  setNewBizCity]  = useState('')
  const [newBizType,  setNewBizType]  = useState('restaurant')
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
    if (!confirm('Delete this rule?')) return
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
    try {
      const res = await fetch('/api/businesses/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newBizName, city: newBizCity, type: newBizType }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? 'Failed')
      setBusinesses(prev => [...prev, data])
      setShowAddBiz(false)
      setNewBizName('')
      setNewBizCity('')
    } catch (e: any) {
      setBizError(e.message)
    }
    setSavingBiz(false)
  }

  async function deactivateBusiness(id: string, name: string, isActive: boolean) {
    const action = isActive ? 'deactivate' : 'reactivate'
    if (!window.confirm(`${action === 'deactivate' ? 'Deactivate' : 'Reactivate'} "${name}"?`)) return
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
    const action = window.confirm(`Delete or deactivate "${name}"?\n\nClick OK to PERMANENTLY DELETE (cannot be undone)\nClick Cancel to go back`)
    if (!action) return
    const confirm2 = window.confirm(`Are you sure you want to permanently delete "${name}"?\nAll data for this restaurant will be lost.`)
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
      const res = await fetch('/api/businesses/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ business_id: editingBiz.id, name: editingBiz.name, city: editingBiz.city, type: editingBiz.type }),
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
    card:   { background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '20px 24px', marginBottom: 20 },
    title:  { fontSize: 14, fontWeight: 700, color: '#111', marginBottom: 4 },
    sub:    { fontSize: 12, color: '#9ca3af', marginBottom: 16 },
    label:  { fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 6 },
    input:  { width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb', borderRadius: 8, fontSize: 13, boxSizing: 'border-box' as const, fontFamily: 'inherit' },
    btn:    { padding: '9px 18px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' },
    btnSm:  { padding: '5px 12px', background: '#f3f4f6', border: 'none', borderRadius: 6, fontSize: 12, cursor: 'pointer', color: '#374151' },
    btnRed: { padding: '4px 10px', background: 'none', border: '1px solid #fecaca', borderRadius: 6, fontSize: 11, color: '#dc2626', cursor: 'pointer' },
    row:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 },
  }

  return (
    <AppShell>
      <div style={{ padding: '28px', maxWidth: 800 }}>
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 500, color: '#111' }}>Settings</h1>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: '#6b7280' }}>Manage your restaurants and supplier mapping rules</p>
        </div>

        {/* Restaurants */}
        <div style={S.card}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={S.title}>Restaurants</div>
              <div style={{ fontSize: 12, color: '#9ca3af' }}>Manage your restaurant locations</div>
            </div>
            <button onClick={() => setShowAddBiz(true)} style={S.btn}>+ Add location</button>
          </div>

          {businesses.length === 0 ? (
            <div style={{ fontSize: 12, color: '#d1d5db', textAlign: 'center', padding: '20px 0' }}>No restaurants yet</div>
          ) : businesses.map(biz => {
            const isOpen = expandedBiz === biz.id
            const isEditing = editingBiz?.id === biz.id
            return (
              <div key={biz.id} style={{ borderBottom: '0.5px solid #f3f4f6' }}>
                {/* Row */}
                <div onClick={() => setExpandedBiz(isOpen ? null : biz.id)}
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 11, color: '#9ca3af' }}>{isOpen ? '▼' : '▶'}</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#111' }}>{biz.name}</div>
                      <div style={{ fontSize: 11, color: '#9ca3af' }}>{biz.city ?? 'No city'} · {biz.type ?? 'Restaurant'}</div>
                    </div>
                  </div>
                  <span style={{ fontSize: 11, background: biz.is_active !== false ? '#dcfce7' : '#fee2e2', color: biz.is_active !== false ? '#15803d' : '#dc2626', padding: '2px 8px', borderRadius: 4 }}>
                    {biz.is_active !== false ? 'Active' : 'Inactive'}
                  </span>
                </div>

                {/* Expanded panel */}
                {isOpen && (
                  <div style={{ background: '#f8f9fa', borderRadius: 8, padding: '14px 16px', marginBottom: 10 }}>
                    {isEditing ? (
                      /* Edit form */
                      <div>
                        <div style={{ ...S.row, marginBottom: 10 }}>
                          <div>
                            <label style={S.label}>Name</label>
                            <input value={editingBiz.name} onChange={e => setEditingBiz({...editingBiz, name: e.target.value})} style={S.input} />
                          </div>
                          <div>
                            <label style={S.label}>City</label>
                            <input value={editingBiz.city ?? ''} onChange={e => setEditingBiz({...editingBiz, city: e.target.value})} style={S.input} />
                          </div>
                        </div>
                        <div style={{ marginBottom: 12 }}>
                          <label style={S.label}>Type</label>
                          <select value={editingBiz.type ?? 'restaurant'} onChange={e => setEditingBiz({...editingBiz, type: e.target.value})} style={S.input}>
                            {RESTAURANT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase()+t.slice(1)}</option>)}
                          </select>
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button onClick={() => saveBizEdit()} style={S.btn}>Save changes</button>
                          <button onClick={() => setEditingBiz(null)} style={S.btnSm}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      /* Action buttons */
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={e => { e.stopPropagation(); setEditingBiz({...biz}) }} style={S.btnSm}>Edit details</button>
                        <button onClick={e => { e.stopPropagation(); deactivateBusiness(biz.id, biz.name, biz.is_active) }}
                          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', color: '#6b7280' }}>
                          {biz.is_active !== false ? 'Deactivate' : 'Reactivate'}
                        </button>
                        <button onClick={e => { e.stopPropagation(); deleteBusiness(biz.id, biz.name) }}
                          style={{ ...S.btnSm, background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }}>
                          Delete
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
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 199, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setShowAddBiz(false)}>
            <div style={{ background: '#fff', borderRadius: 14, padding: 28, width: 420, maxWidth: '94vw', border: '1px solid #e5e7eb', boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 20 }}>Add restaurant</div>
              <div style={{ marginBottom: 14 }}>
                <label style={S.label}>Restaurant name</label>
                <input value={newBizName} onChange={e => setNewBizName(e.target.value)}
                  placeholder="e.g. Vero Italiano" style={S.input} />
              </div>
              <div style={{ ...S.row, marginBottom: 14 }}>
                <div>
                  <label style={S.label}>City</label>
                  <input value={newBizCity} onChange={e => setNewBizCity(e.target.value)}
                    placeholder="Stockholm" style={S.input} />
                </div>
                <div>
                  <label style={S.label}>Type</label>
                  <select value={newBizType} onChange={e => setNewBizType(e.target.value)} style={S.input}>
                    {RESTAURANT_TYPES.map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
              </div>
              {bizError && <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 10 }}>{bizError}</div>}
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={saveNewBusiness} disabled={!newBizName.trim() || savingBiz}
                  style={{ ...S.btn, flex: 1, opacity: !newBizName.trim() ? 0.5 : 1 }}>
                  {savingBiz ? 'Saving...' : 'Add restaurant'}
                </button>
                <button onClick={() => setShowAddBiz(false)} style={{ ...S.btnSm, padding: '9px 16px' }}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* Supplier mapping */}
        <div style={S.card}>
          <div style={S.title}>Supplier Mapping</div>
          <div style={{ ...S.sub }}>Rules to automatically categorise supplier invoices when Fortnox syncs.</div>

          {/* Test a vendor */}
          <div style={{ background: '#f8f9fa', borderRadius: 8, padding: '14px 16px', marginBottom: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Test a vendor</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={testVendor} onChange={e => setTestVendor(e.target.value)}
                placeholder="Enter vendor name..." style={{ ...S.input, flex: 1 }} />
              <button onClick={testMapping} style={S.btn}>Test</button>
            </div>
            {testResult && testResult !== 'no_match' && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#15803d' }}>
                Match: <strong>{(testResult as Mapping).category_label ?? (testResult as Mapping).category}</strong>
              </div>
            )}
            {testResult === 'no_match' && (
              <div style={{ marginTop: 8, fontSize: 12, color: '#dc2626' }}>No matching rule found</div>
            )}
          </div>

          {/* Add rule */}
          <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 10 }}>Add entry rule</div>
          <form onSubmit={addRule}>
            <div style={{ ...S.row, marginBottom: 10 }}>
              <div>
                <label style={S.label}>If vendor name contains</label>
                <input value={newVendor} onChange={e => setNewVendor(e.target.value)}
                  placeholder="e.g. Systembolaget" style={S.input} />
              </div>
              <div>
                <label style={S.label}>Category</label>
                <select value={newCategory} onChange={e => setNewCategory(e.target.value)} style={S.input}>
                  {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                </select>
              </div>
            </div>
            <button type="submit" style={S.btnSm}>+ Add entry</button>
          </form>

          {/* Active rules */}
          <div style={{ marginTop: 20 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>
              Active rules ({mappings.length})
            </div>
            {loading ? (
              <div style={{ fontSize: 12, color: '#9ca3af' }}>Loading...</div>
            ) : mappings.length === 0 ? (
              <div style={{ fontSize: 12, color: '#d1d5db' }}>No rules yet. Add your first rule above.</div>
            ) : mappings.map(m => (
              <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '0.5px solid #f3f4f6' }}>
                <div style={{ fontSize: 13, color: '#111' }}>
                  <span style={{ color: '#9ca3af' }}>Contains </span>
                  <strong>"{m.vendor_contains}"</strong>
                  <span style={{ color: '#9ca3af' }}> → </span>
                  <span style={{ color: '#6366f1' }}>{m.category_label ?? m.category}</span>
                </div>
                <button onClick={() => deleteRule(m.id)} style={S.btnRed}>Delete</button>
              </div>
            ))}
            <div style={{ fontSize: 11, color: '#d1d5db', marginTop: 10 }}>
              Rules are applied in priority order. Higher priority = checked first.
            </div>
          </div>
        </div>

        {/* Weekly digest */}
        <div style={S.card}>
          <div style={S.title}>Weekly Digest Email</div>
          <div style={S.sub}>Every Monday at 07:00 you receive a summary of last week — revenue, costs, covers, and outstanding invoices for all your restaurants.</div>
          <button style={S.btnSm}>Send test digest to my email</button>
        </div>

      </div>
      {/* GDPR / Data & Privacy */}
      <GdprSection />

    </AppShell>
  )
}

function GdprSection() {
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
    setDelStatus(data.message ?? 'Request submitted')
    setShowConfirm(false)
    setDelLoading(false)
  }

  const privacyConsent = consents.find((c: any) => c.consent_type === 'privacy_policy')

  return (
    <div style={{ background: 'white', border: '0.5px solid #e5e7eb', borderRadius: 12, padding: '24px', marginBottom: 20 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: '#111', marginBottom: 4 }}>Data & Privacy</div>
      <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 20 }}>
        Manage your data in accordance with GDPR. View our{' '}
        <a href="/privacy" target="_blank" style={{ color: '#6366f1' }}>Privacy Policy</a>.
      </div>

      {/* Consent status */}
      <div style={{ background: '#f8f9fa', borderRadius: 8, padding: '12px 16px', marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 8 }}>Consent records</div>
        {privacyConsent ? (
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            Privacy Policy v{privacyConsent.version} accepted on{' '}
            {new Date(privacyConsent.consented_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: '#9ca3af' }}>No consent recorded</div>
        )}
      </div>

      {/* AI question logging toggle — per-org privacy control */}
      <div style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #f3f4f6' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Store AI question text</div>
            <div style={{ fontSize: 12, color: '#6b7280', lineHeight: 1.55 }}>
              When on, we save the first 100 characters of each AI question for quality debugging — retained 365 days, visible only to our support team. When off, we keep the model, token counts and cost (needed for billing) but the question text itself is never stored.
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
              background: aiPrivacy === true ? '#1a1f2e' : '#e5e7eb',
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
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Export your data</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Download a complete copy of all data we hold for your organisation — restaurants, P&L, staff logs, forecasts and invoices — in JSON format.
        </div>
        <button onClick={exportData} disabled={loading}
          style={{ padding: '9px 18px', background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
          {loading ? 'Preparing export...' : 'Download data export'}
        </button>
      </div>

      {/* Deletion */}
      <div style={{ paddingTop: 16, borderTop: '1px solid #f3f4f6' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 4 }}>Delete your account</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          Request permanent deletion of all your data. This cannot be undone. We will process your request within 30 days and send a confirmation email.
          Note: billing records are retained for 7 years as required by Swedish law.
        </div>

        {delStatus ? (
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#15803d' }}>
            {delStatus}
          </div>
        ) : !showConfirm ? (
          <button onClick={() => setShowConfirm(true)}
            style={{ padding: '9px 18px', background: 'white', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            Request account deletion
          </button>
        ) : (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '14px 16px' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#dc2626', marginBottom: 8 }}>Are you sure?</div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
              This will permanently delete all restaurants, financial data, staff logs, forecasts and integration connections. This cannot be undone.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={requestDeletion} disabled={delLoading}
                style={{ padding: '8px 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                {delLoading ? 'Submitting...' : 'Yes, delete all my data'}
              </button>
              <button onClick={() => setShowConfirm(false)}
                style={{ padding: '8px 16px', background: '#f3f4f6', border: 'none', borderRadius: 7, fontSize: 13, cursor: 'pointer', color: '#374151' }}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
