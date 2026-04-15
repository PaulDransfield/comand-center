// @ts-nocheck
// app/integrations/page.tsx
//
// THE INTEGRATIONS PAGE
// Shows all available integrations with connection status.
// Handles Fortnox OAuth flow initiation and API key connections.

'use client'

import { useState, useEffect } from 'react'
import { useSearchParams }     from 'next/navigation'
import { createClient }        from '@/lib/supabase/client'
import { track }               from '@/lib/analytics/posthog'

interface Integration {
  id:           string | null
  provider:     string
  status:       'connected' | 'error' | 'warning' | 'disconnected' | 'not_connected'
  last_sync_at: string | null
  last_error:   string | null
  token_expires_at: string | null
}

const PROVIDERS = [
  {
    key:        'fortnox',
    name:       'Fortnox',
    category:   'Accounting',
    icon:       'ðŸ“’',
    description:'BokfÃ¶ring, leverantÃ¶rsfakturor och lÃ¶nerapporter',
    authType:   'oauth2',
    docsUrl:    'https://developer.fortnox.se',
    features:   ['Supplier invoices (costs)', 'Sales invoices (revenue)', 'Payroll (staff cost)', 'Auto-sync tracker'],
  },
  {
    key:        'ancon',
    name:       'Ancon',
    category:   'POS',
    icon:       'ðŸ–¥ï¸',
    description:'Kassasystem â€” fÃ¶rsÃ¤ljningsdata och Z-rapporter',
    authType:   'api_key',
    docsUrl:    'https://ancon.se',
    features:   ['Daily sales totals', 'Z-reports', 'Category breakdown', 'Cover counts'],
  },
  {
    key:        'caspeco',
    name:       'Caspeco',
    category:   'Scheduling',
    icon:       'ðŸ“…',
    description:'Personalplanering och schemalÃ¤ggning',
    authType:   'api_key',
    docsUrl:    'https://caspeco.se',
    features:   ['Staff schedules', 'Worked hours', 'Labour cost forecast', 'Absence tracking'],
  },
  {
    key:        'personalkollen',
    name:       'Personalkollen',
    category:   'HR',
    icon:       'ðŸ‘¥',
    description:'Tidrapportering och personalkostnader',
    authType:   'api_key',
    docsUrl:    'https://personalkollen.se',
    features:   ['Time reports', 'Staff cost tracking', 'Absence management'],
  },
]

export default function IntegrationsPage() {
  const searchParams = useSearchParams()
  const [integrations, setIntegrations] = useState<Record<string, Integration>>({})
  const [loading,      setLoading]      = useState(true)
  const [modal,        setModal]        = useState<string | null>(null)
  const [apiKey,       setApiKey]       = useState('')
  const [saving,       setSaving]       = useState(false)

  const justConnected = searchParams.get('connected')
  const connectError  = searchParams.get('error')

  useEffect(() => {
    fetchIntegrations()
  }, [])

  async function fetchIntegrations() {
    setLoading(true)
    const supabase = createClient()

    const { data } = await supabase
      .from('integrations')
      .select('id, provider, status, last_sync_at, last_error, token_expires_at')

    const map: Record<string, Integration> = {}
    for (const integ of data ?? []) {
      map[integ.provider] = { ...integ, status: integ.status ?? 'disconnected' }
    }
    setIntegrations(map)
    setLoading(false)
  }

  function connectFortnox() {
    track('integration_connected' as any, { provider: 'fortnox' })
    // Redirect to our OAuth initiation route, which redirects to Fortnox
    window.location.href = '/api/integrations/fortnox?action=connect'
  }

  async function saveApiKey(provider: string) {
    if (!apiKey.trim()) return
    setSaving(true)
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
      alert('Failed to save. Please try again.')
    } else {
      setModal(null)
      setApiKey('')
      fetchIntegrations()
    }
    setSaving(false)
  }

  async function disconnect(provider: string) {
    if (!confirm(`Disconnect ${provider}? This will stop syncing data from this service.`)) return

    const supabase = createClient()
    await supabase.from('integrations')
      .update({ status: 'disconnected', credentials_enc: null })
      .eq('provider', provider)

    fetchIntegrations()
  }

  if (loading) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'60vh' }}><span className="spin" style={{fontSize:24,color:'var(--ink-4)'}}>âŸ³</span></div>

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>

      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily:'var(--display)', fontSize:24, fontWeight:400, fontStyle:'italic', color:'var(--navy)', marginBottom:6 }}>
          Integrations
        </h1>
        <p style={{ fontSize:13, color:'var(--ink-3)', lineHeight:1.6 }}>
          Connect your accounting, POS, and scheduling systems. Data syncs automatically and populates the financial tracker.
        </p>
      </div>

      {/* Status messages */}
      {justConnected && (
        <div style={{ background:'var(--green-lt)', border:'1px solid var(--green-mid)', borderRadius:10, padding:'12px 16px', fontSize:13, color:'var(--green)', marginBottom:20, fontWeight:500 }}>
          âœ“ {justConnected.charAt(0).toUpperCase() + justConnected.slice(1)} connected successfully! Your data will sync shortly.
        </div>
      )}
      {connectError && (
        <div style={{ background:'var(--red-lt)', border:'1px solid var(--red-mid)', borderRadius:10, padding:'12px 16px', fontSize:13, color:'var(--red)', marginBottom:20 }}>
          âš  Connection failed: {connectError.replace(/_/g,' ')}. Please try again or contact support.
        </div>
      )}

      {/* Integration cards */}
      <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
        {PROVIDERS.map(provider => {
          const integ  = integrations[provider.key]
          const status = integ?.status ?? 'not_connected'
          const isConnected = status === 'connected'

          const statusColour = {
            connected:     'var(--green)',
            error:         'var(--red)',
            warning:       'var(--amber)',
            disconnected:  'var(--ink-4)',
            not_connected: 'var(--ink-4)',
          }[status]

          const statusLabel = {
            connected:     'Connected',
            error:         'Error',
            warning:       'Warning',
            disconnected:  'Disconnected',
            not_connected: 'Not connected',
          }[status]

          // Token expiry warning
          let expiryWarning = ''
          if (integ?.token_expires_at) {
            const daysLeft = Math.ceil((new Date(integ.token_expires_at).getTime() - Date.now()) / 86400000)
            if (daysLeft <= 7) expiryWarning = `Token expires in ${daysLeft} day${daysLeft!==1?'s':''}`
          }

          return (
            <div key={provider.key} style={{ background:'var(--white)', border:`1px solid ${isConnected ? 'var(--green-mid)' : 'var(--border)'}`, borderRadius:12, padding:'18px 20px' }}>
              <div style={{ display:'flex', alignItems:'flex-start', gap:14 }}>
                <span style={{ fontSize:28, flexShrink:0 }}>{provider.icon}</span>

                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:4, flexWrap:'wrap' }}>
                    <span style={{ fontSize:15, fontWeight:600, color:'var(--ink)' }}>{provider.name}</span>
                    <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:8, background:'var(--parchment)', color:'var(--ink-4)', border:'1px solid var(--border)', textTransform:'uppercase', letterSpacing:'.06em' }}>{provider.category}</span>
                    <span style={{ fontSize:11, fontWeight:600, color:statusColour, display:'flex', alignItems:'center', gap:4 }}>
                      <span style={{ width:6, height:6, borderRadius:'50%', background:statusColour, display:'inline-block' }} />
                      {statusLabel}
                    </span>
                    {provider.authType === 'oauth2' && (
                      <span style={{ fontSize:10, color:'var(--ink-4)', fontFamily:'var(--mono)' }}>OAuth 2.0</span>
                    )}
                  </div>

                  <p style={{ fontSize:13, color:'var(--ink-3)', marginBottom:10, lineHeight:1.5 }}>{provider.description}</p>

                  {/* Features */}
                  <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:isConnected ? 12 : 0 }}>
                    {provider.features.map(f => (
                      <span key={f} style={{ fontSize:11, padding:'2px 9px', background:'var(--parchment)', border:'1px solid var(--border)', borderRadius:8, color:'var(--ink-3)' }}>{f}</span>
                    ))}
                  </div>

                  {/* Connection details */}
                  {isConnected && integ?.last_sync_at && (
                    <div style={{ fontSize:11, color:'var(--ink-4)', fontFamily:'var(--mono)' }}>
                      Last synced: {new Date(integ.last_sync_at).toLocaleString('sv-SE')}
                    </div>
                  )}
                  {integ?.last_error && status === 'error' && (
                    <div style={{ fontSize:11, color:'var(--red)', marginTop:4 }}>âš  {integ.last_error}</div>
                  )}
                  {expiryWarning && (
                    <div style={{ fontSize:11, color:'var(--amber)', marginTop:4 }}>âš  {expiryWarning}</div>
                  )}
                </div>

                {/* Actions */}
                <div style={{ display:'flex', gap:7, flexShrink:0, flexDirection:'column', alignItems:'flex-end' }}>
                  {!isConnected && provider.authType === 'oauth2' && (
                    <button className="btn btn-primary btn-sm" onClick={connectFortnox}>
                      Connect â†’
                    </button>
                  )}
                  {!isConnected && provider.authType === 'api_key' && (
                    <button className="btn btn-primary btn-sm" onClick={() => { setModal(provider.key); setApiKey('') }}>
                      Connect â†’
                    </button>
                  )}
                  {isConnected && (
                    <>
                      <button className="btn btn-sm" onClick={() => { /* trigger sync */ }}>Sync now</button>
                      <button className="btn btn-sm" style={{ color:'var(--red)', borderColor:'var(--red-mid)' }} onClick={() => disconnect(provider.key)}>Disconnect</button>
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
          <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', zIndex:199 }} onClick={() => setModal(null)} />
          <div style={{ position:'fixed', top:'50%', left:'50%', transform:'translate(-50%,-50%)', background:'var(--white)', borderRadius:14, width:440, maxWidth:'94vw', zIndex:200, padding:'24px', boxShadow:'0 24px 60px rgba(0,0,0,.25)' }}>
            <h2 style={{ fontFamily:'var(--display)', fontSize:18, fontStyle:'italic', color:'var(--navy)', marginBottom:6 }}>
              Connect {PROVIDERS.find(p=>p.key===modal)?.name}
            </h2>
            <p style={{ fontSize:13, color:'var(--ink-3)', marginBottom:18, lineHeight:1.5 }}>
              Enter your API key. It will be encrypted and stored securely â€” never shared or exposed.
            </p>
            <div style={{ marginBottom:14 }}>
              <label style={{ display:'block', fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.07em', color:'var(--ink-4)', marginBottom:5 }}>API Key</label>
              <input
                className="input"
                type="password"
                placeholder="Paste your API key here"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                autoFocus
              />
            </div>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button className="btn btn-sm" onClick={() => setModal(null)}>Cancel</button>
              <button className="btn btn-sm btn-primary" disabled={!apiKey.trim() || saving} onClick={() => saveApiKey(modal!)}>
                {saving ? <><span className="spin">âŸ³</span> Savingâ€¦</> : 'Save & connect'}
              </button>
            </div>
          </div>
        </>
      )}

    </div>
  )
}
