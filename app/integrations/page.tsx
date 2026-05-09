// @ts-nocheck
'use client'
export const dynamic = 'force-dynamic'

import AppShell from '@/components/AppShell'
import { useState, useEffect } from 'react'
import { useSearchParams }     from 'next/navigation'
import { useTranslations }     from 'next-intl'
import { createClient }        from '@/lib/supabase/client'
import { track }               from '@/lib/analytics/posthog'

interface Integration {
  id:           string | null
  provider:     string
  status:       'connected' | 'error' | 'warning' | 'disconnected' | 'not_connected'
  last_sync_at: string | null
}

// Static structural manifest. Display strings (description, features,
// configField labels/placeholders) live in locales/<lang>/integrations.json
// under providers.<key>.* — extend both together when adding a provider.
const PROVIDERS = [
  { key: 'fortnox',        name: 'Fortnox',              category: 'Accounting', icon: 'F',
    authType: 'oauth2',  docsUrl: 'https://developer.fortnox.se',
    configFields: [] },
  { key: 'visma',          name: 'Visma eEkonomi',       category: 'Accounting', icon: 'V',
    authType: 'oauth2',  docsUrl: 'https://developer.visma.com',
    configFields: [] },
  { key: 'ancon',          name: 'Ancon',                category: 'POS', icon: 'A',
    authType: 'api_key', docsUrl: 'https://ancon.se',
    configFields: [{ key: 'unit_id' }] },
  { key: 'trivec',         name: 'Trivec',               category: 'POS', icon: 'T',
    authType: 'api_key', docsUrl: 'https://mytrivec.com',
    configFields: [{ key: 'unit_id' }] },
  { key: 'zettle',         name: 'Zettle by PayPal',     category: 'POS', icon: 'Z',
    authType: 'api_key', docsUrl: 'https://developer.zettle.com',
    configFields: [{ key: 'client_id' }, { key: 'client_secret' }] },
  { key: 'quinyx',         name: 'Quinyx',               category: 'Staff', icon: 'Q',
    authType: 'api_key', docsUrl: 'https://api.quinyx.com',
    configFields: [{ key: 'group_id' }] },
  { key: 'caspeco',        name: 'Caspeco Personal',     category: 'Staff', icon: 'C',
    authType: 'api_key', docsUrl: 'https://caspeco.se',
    configFields: [{ key: 'unit_id' }] },
  { key: 'personalkollen', name: 'Personalkollen',       category: 'Staff', icon: 'P',
    authType: 'api_key', docsUrl: 'https://personalkollen.se',
    configFields: [] },
  { key: 'planday',        name: 'Planday',              category: 'Staff', icon: 'P',
    authType: 'api_key', docsUrl: 'https://developer.planday.com',
    configFields: [] },
  { key: 'wolt',           name: 'Wolt',                 category: 'Delivery', icon: 'W',
    authType: 'api_key', docsUrl: 'https://developer.wolt.com',
    configFields: [{ key: 'venue_id' }] },
  { key: 'foodora',        name: 'Foodora',              category: 'Delivery', icon: 'F',
    authType: 'api_key', docsUrl: 'https://partner.foodora.se',
    configFields: [{ key: 'restaurant_id' }] },
  { key: 'thefork',        name: 'TheFork',              category: 'Booking', icon: 'TF',
    authType: 'oauth2',  docsUrl: 'https://docs.thefork.io',
    configFields: [{ key: 'client_id' }, { key: 'client_secret' }, { key: 'restaurant_id' }] },
  { key: 'bokad',          name: 'Bokad.se',             category: 'Booking', icon: 'B',
    authType: 'api_key', docsUrl: 'https://bokad.se',
    configFields: [{ key: 'restaurant_id' }] },
  { key: 'bokabord',       name: 'BokaBord / WaiterAid', category: 'Booking', icon: 'BB',
    authType: 'api_key', docsUrl: 'https://waiteraid.com',
    configFields: [{ key: 'restaurant_id' }] },
]

export default function IntegrationsPage() {
  const t = useTranslations('integrations')
  const searchParams = useSearchParams()
  const [integrations, setIntegrations] = useState<Record<string, Integration>>({})
  const [loading,      setLoading]      = useState(true)
  const [modal,        setModal]        = useState<string | null>(null)
  const [apiKey,     setApiKey]     = useState('')
  const [unitId,     setUnitId]     = useState('')
  const [bizForPOS,    setBizForPOS]    = useState('')
  const [configValues, setConfigValues] = useState<Record<string,string>>({})
  const [saving,     setSaving]     = useState(false)
  const [businesses,   setBusinesses]   = useState<any[]>([])
  const [selectedBiz,  setSelectedBiz]  = useState<string>(
    typeof window !== 'undefined' ? (localStorage.getItem('cc_selected_biz') ?? '') : ''
  )

  const justConnected = searchParams.get('connected')
  const connectError  = searchParams.get('error')

  useEffect(() => {
    fetch('/api/businesses').then(r => r.json()).then(data => {
      if (Array.isArray(data)) {
        setBusinesses(data)
        const syncSelected = () => {
          const saved = localStorage.getItem('cc_selected_biz')
          if (saved && data.find((b: any) => b.id === saved)) {
            setSelectedBiz(saved)
            setBizForPOS(saved)
          } else if (data.length > 0) {
            setSelectedBiz(data[0].id)
            setBizForPOS(data[0].id)
          }
        }
        syncSelected()
        // Listen for sidebar business switches
        window.addEventListener('storage', syncSelected)
        return () => window.removeEventListener('storage', syncSelected)
      }
    }).catch(() => {})
  }, [])

  useEffect(() => {
    fetchIntegrations()
  }, [])

  async function fetchIntegrations() {
    setLoading(true)
    const supabase = createClient()

    const { data } = await supabase
      .from('integrations')
      .select('id, provider, status, last_sync_at, last_error, token_expires_at, business_id, backfill_status, backfill_progress')

    const allData = data ?? []
    const map: Record<string, any> = {}

    // Store raw array for multi-business lookups
    map['__all__'] = allData

    // Also key by provider for backward compat (last one wins)
    for (const integ of allData) {
      map[integ.provider] = { ...integ, status: integ.status ?? 'disconnected' }
      // Also key by provider+business_id
      const bizKey = `${integ.provider}__${integ.business_id ?? 'none'}`
      map[bizKey] = { ...integ, status: integ.status ?? 'disconnected' }
    }

    setIntegrations(map)
    setLoading(false)
  }

  function connectFortnox(businessId?: string) {
    track('integration_connected' as any, { provider: 'fortnox' })
    // Redirect to our OAuth initiation route, which redirects to Fortnox
    // Pass business_id so this connection is linked to a specific restaurant
    const url = businessId
      ? `/api/integrations/fortnox?action=connect&business_id=${businessId}`
      : '/api/integrations/fortnox?action=connect'
    window.location.href = url
  }

  async function saveApiKey(provider: string) {
    if (!apiKey.trim()) return
    setSaving(true)

    // POS/Staff systems — generic API key connect flow
    if (['personalkollen', 'caspeco', 'ancon', 'swess'].includes(provider)) {
      try {
        // Test connection
        let testOk = false
        let testMsg = ''
        if (provider === 'personalkollen') {
          const testRes = await fetch('/api/integrations/personalkollen', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'test', api_key: apiKey.trim() }),
          })
          const testData = await testRes.json()
          if (!testRes.ok || !testData.ok) throw new Error(testData.error ?? t('errors.testFailed'))
          testOk = true; testMsg = testData.message
        } else {
          // For other providers, just save and try sync
          testOk = true; testMsg = t('errors.credentialsSaved', { provider })
        }

        // Save to integrations table
        const db = (await import('@supabase/supabase-js')).createClient(
          process.env.NEXT_PUBLIC_SUPABASE_URL!,
          process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
        )

        if (provider === 'personalkollen') {
          const saveRes = await fetch('/api/integrations/personalkollen', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'connect', api_key: apiKey.trim(), business_id: bizForPOS }),
          })
          const saveData = await saveRes.json()
          if (!saveRes.ok || !saveData.ok) throw new Error(saveData.error ?? t('errors.saveFailed'))
        } else {
          // Generic save via sync API
          const saveRes = await fetch('/api/integrations/generic', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, api_key: apiKey.trim(), business_id: bizForPOS }),
          })
          const saveData = await saveRes.json()
          if (!saveRes.ok || !saveData.ok) throw new Error(saveData.error ?? t('errors.saveFailed'))
        }

        // Trigger immediate historical sync
        fetch('/api/sync', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider }),
        }).catch(() => {})

        setModal(null); setApiKey(''); setBizForPOS('')
        window.location.href = `/integrations?connected=${provider}`
      } catch (e: any) { alert(t('errors.providerFailed', { provider, message: e.message })) }
      setSaving(false); return
    }

    // Personalkollen legacy path (kept for safety)
    if (provider === 'personalkollen_legacy') {
      try {
        // First test the connection
        const testRes = await fetch('/api/integrations/personalkollen', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'test', api_key: apiKey.trim() }),
        })
        const testData = await testRes.json()
        if (!testRes.ok || !testData.ok) throw new Error(testData.error ?? t('errors.connectionTestFailed'))

        // Save credentials
        const saveRes = await fetch('/api/integrations/personalkollen', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ action: 'connect', api_key: apiKey.trim(), business_id: bizForPOS }),
        })
        const saveData = await saveRes.json()
        if (!saveRes.ok || !saveData.ok) throw new Error(saveData.error ?? t('errors.failedToSave'))

        setModal(null); setApiKey(''); setBizForPOS('')
        window.location.href = '/integrations?connected=personalkollen'
      } catch (e: any) {
        alert(t('errors.personalkollenFailed', { message: e.message }))
      }
      setSaving(false)
      return
    }

    // For POS systems, save to pos_connections table instead
    if (provider === 'ancon' || provider === 'caspeco') {
      try {
        const res = await fetch('/api/pos-connections', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            pos_system:  provider,
            business_id: bizForPOS,
            api_key:     apiKey.trim(),
            ...configValues,
          }),
        })
        setSaving(false)
        if (res.ok) {
          setModal(null); setApiKey(''); setUnitId(''); setBizForPOS(''); setConfigValues({})
          window.location.href = '/integrations?connected=' + provider
        }
      } catch { setSaving(false) }
      return
    }
    track('integration_connected' as any, { provider })

    const supabase = createClient()
    const { data: { session } } = await supabase.auth.getSession()

    // In production: POST to /api/integrations/{provider} to encrypt and save the key
    // For now: direct Supabase upsert (in real app, use server route to encrypt first)
    const { error } = await supabase.from('integrations').upsert({
      provider,
      status:   'connected',
      config:   { api_key_hint: apiKey.slice(-4) },  // store only last 4 chars as hint
      updated_at: new Date().toISOString(),
    }, { onConflict: 'org_id,provider' })

    if (error) {
      alert(t('errors.saveGeneric'))
    } else {
      setModal(null)
      setApiKey('')
      fetchIntegrations()
    }
    setSaving(false)
  }

  async function disconnect(provider: string) {
    if (!confirm(t('confirms.disconnect', { provider }))) return

    const supabase = createClient()
    await supabase.from('integrations')
      .update({ status: 'disconnected', credentials_enc: null })
      .eq('provider', provider)

    fetchIntegrations()
  }

  if (loading) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'60vh' }}><span className="spin" style={{fontSize:24,color:'#9ca3af'}}></span></div>

  return (
    <AppShell>
    <div style={{ padding: 24, maxWidth: 800 }}>

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily:'Georgia, serif', fontSize:24, fontWeight:400, fontStyle:'italic', color:'#1a1f2e', marginBottom:6 }}>
          {t('title')}
        </h1>
        <p style={{ fontSize:13, color:'#6b7280', lineHeight:1.6 }}>
          {t('subtitle')}
        </p>
      </div>

      {/* Status messages */}
      {justConnected && (
        <div style={{ background:'#f0fdf4', border:'1px solid #bbf7d0', borderRadius:10, padding:'12px 16px', fontSize:13, color:'#15803d', marginBottom:20, fontWeight:500 }}>
           {t('banners.connected', { provider: justConnected.charAt(0).toUpperCase() + justConnected.slice(1) })}
        </div>
      )}
      {connectError && (
        <div style={{ background:'#fef2f2', border:'1px solid #fecaca', borderRadius:10, padding:'12px 16px', fontSize:13, color:'#dc2626', marginBottom:20 }}>
           {t('banners.connectionError', { error: connectError.replace(/_/g,' ') })}
        </div>
      )}

      {/* Integration cards */}
      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {PROVIDERS.map(provider => {
          // Find integration for this provider + selected business
          const allIntegs: any[] = (integrations['__all__'] ?? []).filter((i: any) => i.provider === provider.key)
          const bizInteg = selectedBiz
            ? allIntegs.find((i: any) => i.business_id === selectedBiz)
            : allIntegs.find((i: any) => !i.business_id) ?? allIntegs[0]
          const integ  = bizInteg ?? null
          const status = integ?.status ?? 'not_connected'
          // Show management actions (Sync / Run-backfill / Disconnect / Reconnect)
          // for any active integration row. status='error' means the credentials
          // exist but the last operation failed — the user must be able to retry,
          // reconnect, or disconnect from this state, otherwise they're stuck.
          const isConnected = status === 'connected' || status === 'error' || status === 'warning'

          const statusColour = {
            connected:     '#15803d',
            error:         '#dc2626',
            warning:       '#d97706',
            disconnected:  '#9ca3af',
            not_connected: '#9ca3af',
          }[status]

          const statusLabel = {
            connected:     t('status.connected'),
            error:         t('status.error'),
            warning:       t('status.warning'),
            disconnected:  t('status.disconnected'),
            not_connected: t('status.not_connected'),
          }[status]

          // Token expiry warning
          let expiryWarning = ''
          if (integ?.token_expires_at) {
            const daysLeft = Math.ceil((new Date(integ.token_expires_at).getTime() - Date.now()) / 86400000)
            if (daysLeft <= 7) expiryWarning = t('tokenExpiry', { count: daysLeft })
          }

          return (
            <div key={provider.key} style={{ background:'#ffffff', border:`1px solid ${isConnected ? '#bbf7d0' : '#e5e7eb'}`, borderRadius:12, padding:'18px 20px' }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:14 }}>
                <span style={{ fontSize:28, flexShrink:0 }}>{provider.icon}</span>

                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4, flexWrap:'wrap' }}>
                    <span style={{ fontSize:15, fontWeight:600, color:'#111827' }}>{provider.name}</span>
                    <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:8, background:'#fafafa', color:'#9ca3af', border:'1px solid #e5e7eb', textTransform:'uppercase', letterSpacing:'.06em' }}>{t(`categories.${provider.category}`)}</span>
                    <span style={{ fontSize:11, fontWeight:600, color:statusColour, display:'flex', alignItems:'center', gap:4 }}>
                      <span style={{ width:6, height:6, borderRadius:'50%', background:statusColour, display:'inline-block' }} />
                      {statusLabel}
                    </span>
                    {provider.authType === 'oauth2' && (
                      <span style={{ fontSize:10, color:'#9ca3af', fontFamily:'monospace' }}>{t('oauthBadge')}</span>
                    )}
                  </div>

                  <p style={{ fontSize:13, color:'#6b7280', marginBottom:10, lineHeight:1.5 }}>{t(`providers.${provider.key}.description`)}</p>

                  {/* Features */}
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:isConnected ? 12 : 0 }}>
                    {(t.raw(`providers.${provider.key}.features`) as string[]).map(f => (
                      <span key={f} style={{ fontSize:11, padding:'2px 9px', background:'#fafafa', border:'1px solid #e5e7eb', borderRadius:8, color:'#6b7280' }}>{f}</span>
                    ))}
                  </div>

                  {/* Connection status — always shown */}
                  <div style={{ marginTop: 10, padding: '10px 12px', background: isConnected ? '#f0fdf4' : status === 'error' ? '#fef2f2' : '#f8f9fa', borderRadius: 8, fontSize: 12, border: `1px solid ${isConnected ? '#bbf7d0' : status === 'error' ? '#fecaca' : '#e5e7eb'}` }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: isConnected ? '#10b981' : status === 'error' ? '#dc2626' : '#d1d5db', display: 'inline-block' }} />
                        <span style={{ fontWeight: 600, color: isConnected ? '#15803d' : status === 'error' ? '#dc2626' : '#6b7280' }}>
                          {isConnected ? t('status.connected') : status === 'error' ? t('status.connectionError') : t('status.not_connected')}
                        </span>
                        {integ?.business_id && businesses.find((b: any) => b.id === integ.business_id) && (
                          <span style={{ background: '#eff6ff', color: '#3b82f6', padding: '1px 7px', borderRadius: 3, fontWeight: 600, fontSize: 11 }}>
                            {businesses.find((b: any) => b.id === integ.business_id)?.name}
                          </span>
                        )}
                      </div>
                      {integ?.last_sync_at && (
                        <span style={{ color: '#9ca3af', fontSize: 11 }}>
                          {t('syncedAt', { date: new Date(integ.last_sync_at).toLocaleString('en-GB', { day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) })}
                        </span>
                      )}
                    </div>
                  {isConnected && (
                    <div style={{ marginTop: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: integ?.last_error ? 6 : 0 }}>
                        <span style={{ color: '#6b7280' }}>
                        </span>
                      </div>
                      {integ?.last_error && (
                        <div style={{ color: '#dc2626', marginTop: 4, padding: '6px 8px', background: '#fef2f2', borderRadius: 6 }}>
                          {integ.last_error.slice(0, 120)}{integ.last_error.length > 120 ? '...' : ''}
                        </div>
                      )}
                      {/* PK canonical override — only relevant when both PK
                          and Fortnox are present and disagreeing. Owner
                          flips this when Fortnox is stale (e.g. last PDF
                          was 6 months ago) and PK is the live truth.
                          Stored on integrations.config; aggregator reads
                          it on every run. */}
                      {provider.key === 'personalkollen' && (
                        <label style={{ marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer', fontSize: 12, color: '#374151', lineHeight: 1.4 }}>
                          <input
                            type="checkbox"
                            checked={!!integ?.config?.canonical_for_staff_cost}
                            onChange={async e => {
                              const value = e.target.checked
                              await fetch('/api/integrations/canonical', {
                                method:  'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                  provider:    'personalkollen',
                                  business_id: integ?.business_id,
                                  field:       'canonical_for_staff_cost',
                                  value,
                                }),
                              })
                              load()
                            }}
                            style={{ marginTop: 2, accentColor: '#1a1f2e' }}
                          />
                          <span>
                            <strong>{t('pk.label')}</strong>{t('pk.body')}
                          </span>
                        </label>
                      )}
                    </div>
                  )}
                  {expiryWarning && (
                    <div style={{ fontSize:11, color:'#d97706', marginTop:4 }}>{expiryWarning}</div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display:'flex', gap:7, flexShrink:0, flexDirection:'column', alignItems:'flex-end' }}>
                  </div>

                  {!isConnected && provider.authType === 'oauth2' && (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={!selectedBiz}
                      title={!selectedBiz ? t('actions.connectDisabledNoBusiness') : undefined}
                      onClick={() => connectFortnox(selectedBiz)}
                    >
                      {t('actions.connect')}
                    </button>
                  )}
                  {!isConnected && provider.authType === 'api_key' && (
                    <button className="btn btn-primary btn-sm" onClick={() => { setModal(provider.key); setApiKey(''); setBizForPOS(selectedBiz) }}>
                      {t('actions.connect')}
                    </button>
                  )}
                  {isConnected && (
                    <>
                      <button className="btn btn-sm" onClick={async () => {
                        await fetch('/api/sync', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ provider: provider.key }) })
                        fetchIntegrations()
                      }}>{t('actions.syncNow')}</button>
                      {provider.key === 'fortnox' && (() => {
                        const bf = integ?.backfill_status as ('pending' | 'running' | 'completed' | 'failed' | null | undefined)
                        const inFlight = bf === 'pending' || bf === 'running'
                        const label    = inFlight ? t('actions.backfillRunning') : t('actions.runBackfill')
                        return (
                          <button
                            className="btn btn-sm"
                            disabled={inFlight}
                            title={inFlight ? t('actions.backfillRunningTitle') : t('actions.runBackfillTitle')}
                            onClick={async () => {
                              await fetch('/api/integrations/fortnox/run-backfill', {
                                method:  'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body:    JSON.stringify({ business_id: integ?.business_id ?? null }),
                              })
                              fetchIntegrations()
                            }}
                          >
                            {label}
                          </button>
                        )
                      })()}
                      {status === 'error' && (
                        <button className="btn btn-sm" style={{ color:'#d97706', borderColor:'#fde68a', background:'#fffbeb' }} onClick={async () => {
                          await fetch('/api/integrations/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ provider: provider.key }) })
                          fetchIntegrations()
                        }}>{t('actions.reconnect')}</button>
                      )}
                      <button className="btn btn-sm" style={{ color:'#dc2626', borderColor:'#fecaca' }} onClick={() => disconnect(provider.key)}>{t('actions.disconnect')}</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* API Key modal */}
      {modal && (
        <>
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.4)', zIndex:199 }} onClick={() => setModal(null)} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'#ffffff', borderRadius:14, width:460, maxWidth:'94vw', zIndex:200, padding:'28px', boxShadow:'0 25px 60px rgba(0,0,0,0.3)', border:'1px solid #e5e7eb' }}>
            <h2 style={{ fontFamily:'Georgia, serif', fontSize:18, fontStyle:'italic', color:'#1a1f2e', marginBottom:6 }}>
              {t('modal.title', { name: PROVIDERS.find(p=>p.key===modal)?.name ?? '' })}
            </h2>
            <p style={{ fontSize:13, color:'#6b7280', marginBottom:18, lineHeight:1.5 }}>
              {t('modal.subtitle')}
            </p>
            {/* Business selector for POS systems */}
            {PROVIDERS.find(p=>p.key===modal)?.category === 'POS' && businesses.length > 0 && (
              <div style={{ marginBottom:14 }}>
                <label style={{ display:'block', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', color:'#9ca3af', marginBottom:5 }}>
                  {t('modal.restaurantLabel')}
                </label>
                <select className="input" value={bizForPOS} onChange={e => setBizForPOS(e.target.value)}>
                  <option value="">{t('modal.restaurantPlaceholder')}</option>
                  {businesses.map((b:any) => (
                    <option key={b.id} value={b.id}>{b.name}{b.city ? ` (${b.city})` : ''}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', color:'#9ca3af', marginBottom:5 }}>{t('modal.apiKey')}</label>
              <input
                className="input"
                type="password"
                placeholder={t('modal.apiKeyPlaceholder')}
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                autoFocus
              />
            </div>

            {/* Dynamic config fields per integration */}
            {PROVIDERS.find(p=>p.key===modal)?.configFields?.map((field:any) => (
              <div key={field.key} style={{ marginBottom:14 }}>
                <label style={{ display:'block', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', color:'#9ca3af', marginBottom:5 }}>
                  {t(`providers.${modal}.configFields.${field.key}.label`)}
                </label>
                <input
                  className="input"
                  type={field.key.includes('secret') ? 'password' : 'text'}
                  placeholder={t(`providers.${modal}.configFields.${field.key}.placeholder`)}
                  value={configValues[field.key] ?? ''}
                  onChange={e => setConfigValues((v:any) => ({ ...v, [field.key]: e.target.value }))}
                />
              </div>
            ))}

            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-sm" onClick={() => { setModal(null); setUnitId(''); setBizForPOS('') }}>{t('modal.cancel')}</button>
              <button className="btn btn-sm btn-primary"
                disabled={!apiKey.trim() || saving}
                onClick={() => saveApiKey(modal!)}>
                {saving ? <><span className="spin"></span> {t('modal.saving')}</> : t('modal.save')}
              </button>
            </div>
          </div>
        </>
      )}

    </div>
    </AppShell>
  )
}
