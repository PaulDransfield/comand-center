'use client'

import { useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const supabase = createClient()
  const searchParams = useSearchParams()

  // Landing page "Start free trial" sends users here with ?mode=signup so they
  // land on the signup form instead of the login form.
  const initialMode = searchParams.get('mode') === 'signup' ? 'signup'
                    : searchParams.get('mode') === 'forgot' ? 'forgot'
                    : 'login'
  const [mode,     setMode]     = useState<'login'|'signup'|'forgot'>(initialMode)
  const [loading,  setLoading]  = useState(false)
  const [message,  setMessage]  = useState('')
  const [error,    setError]    = useState('')
  const [email,    setEmail]    = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [orgName,  setOrgName]  = useState('')

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    if (data.session) {
      // Session established — do a full page reload to /dashboard
      // This ensures the session cookie is read fresh by the server
      window.location.replace('/dashboard')
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res  = await fetch('/api/auth/signup', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ email, password, fullName, orgName }),
    })
    const data = await res.json()

    if (!res.ok) {
      setError(data.error || 'Signup failed')
      setLoading(false)
      return
    }

    // Auto sign in after signup
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError || !signInData.session) {
      setMessage('Account created! Please sign in.')
      setMode('login')
      setLoading(false)
      return
    }

    window.location.replace('/onboarding')
  }

  async function handleForgot(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/api/auth/callback?next=/reset-password`,
    })
    if (error) setError(error.message)
    else setMessage('Reset link sent! Check your email.')
    setLoading(false)
  }

  return (
    <div style={{ minHeight:'100vh', background:'var(--parchment)', display:'flex', alignItems:'center', justifyContent:'center', padding:'20px' }}>
      <div style={{ background:'var(--white)', border:'1px solid var(--border)', borderRadius:'16px', padding:'36px', width:'400px', maxWidth:'100%', boxShadow:'0 4px 24px rgba(0,0,0,.08)' }}>

        <div style={{ display:'flex', alignItems:'center', gap:'10px', marginBottom:'24px' }}>
          <div style={{ width:'32px', height:'32px', borderRadius:'8px', background:'var(--navy)', color:'white', display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'var(--display)', fontSize:'13px', fontWeight:'700' }}>CC</div>
          <span style={{ fontFamily:'var(--display)', fontSize:'16px', fontWeight:'600', color:'var(--navy)' }}>CommandCenter</span>
        </div>

        <h1 style={{ fontFamily:'var(--display)', fontSize:'24px', fontWeight:'300', fontStyle:'italic', color:'var(--navy)', marginBottom:'6px' }}>
          {mode === 'login' ? 'Welcome back' : mode === 'signup' ? 'Create your account' : 'Reset your password'}
        </h1>
        <p style={{ fontSize:'13px', color:'var(--ink-3)', marginBottom:'24px' }}>
          {mode === 'login' ? 'Sign in to your restaurant command center' : mode === 'signup' ? '30-day free trial · No credit card required' : "We'll send a reset link to your email"}
        </p>

        {message && <div style={{ background:'var(--green-lt)', border:'1px solid var(--green-mid)', borderRadius:'8px', padding:'10px 14px', fontSize:'13px', color:'var(--green)', marginBottom:'16px' }}>✓ {message}</div>}
        {error   && <div style={{ background:'var(--red-lt)',   border:'1px solid var(--red-mid)',   borderRadius:'8px', padding:'10px 14px', fontSize:'13px', color:'var(--red)',   marginBottom:'16px' }}>{error}</div>}

        <form onSubmit={mode === 'login' ? handleLogin : mode === 'signup' ? handleSignup : handleForgot}>
          {mode === 'signup' && (
            <div style={{ marginBottom:'14px' }}>
              <label style={{ display:'block', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'.08em', color:'var(--ink-4)', marginBottom:'5px' }}>Your name</label>
              <input className="input" type="text" placeholder="Paul Dransfield" value={fullName} onChange={e => setFullName(e.target.value)} required />
            </div>
          )}
          {mode === 'signup' && (
            <div style={{ marginBottom:'14px' }}>
              <label style={{ display:'block', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'.08em', color:'var(--ink-4)', marginBottom:'5px' }}>Restaurant / company name</label>
              <input className="input" type="text" placeholder="Vero Italiano AB" value={orgName} onChange={e => setOrgName(e.target.value)} required />
            </div>
          )}
          <div style={{ marginBottom:'14px' }}>
            <label style={{ display:'block', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'.08em', color:'var(--ink-4)', marginBottom:'5px' }}>Email address</label>
            <input className="input" type="email" placeholder="paul@veroitaliano.se" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
          </div>
          {mode !== 'forgot' && (
            <div style={{ marginBottom:'14px' }}>
              <label style={{ display:'block', fontSize:'11px', fontWeight:'700', textTransform:'uppercase', letterSpacing:'.08em', color:'var(--ink-4)', marginBottom:'5px' }}>Password</label>
              <input className="input" type="password" placeholder={mode === 'signup' ? 'At least 8 characters' : 'Enter your password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={mode === 'signup' ? 8 : 1} autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
            </div>
          )}
          {mode === 'login' && (
            <div style={{ textAlign:'right', marginBottom:'16px' }}>
              <button type="button" style={{ background:'none', border:'none', cursor:'pointer', color:'var(--blue)', fontSize:'13px', fontFamily:'var(--font)', padding:'0', textDecoration:'underline' }} onClick={() => { setMode('forgot'); setError(''); setMessage('') }}>Forgot password?</button>
            </div>
          )}
          <button type="submit" className="btn btn-primary btn-full" disabled={loading} style={{ marginTop:'4px' }}>
            {loading ? <><span className="spin">⟳</span> Please wait…</> : mode === 'login' ? 'Sign in' : mode === 'signup' ? 'Create account' : 'Send reset link'}
          </button>
        </form>

        <div style={{ textAlign:'center', marginTop:'20px', fontSize:'13px', color:'var(--ink-3)' }}>
          {mode === 'login' ? (<>Don't have an account? <button style={{ background:'none', border:'none', cursor:'pointer', color:'var(--blue)', fontSize:'13px', fontFamily:'var(--font)', padding:'0', textDecoration:'underline' }} onClick={() => { setMode('signup'); setError(''); setMessage('') }}>Sign up free</button></>) 
          : mode === 'signup' ? (<>Already have an account? <button style={{ background:'none', border:'none', cursor:'pointer', color:'var(--blue)', fontSize:'13px', fontFamily:'var(--font)', padding:'0', textDecoration:'underline' }} onClick={() => { setMode('login'); setError(''); setMessage('') }}>Sign in</button></>) 
          : (<button style={{ background:'none', border:'none', cursor:'pointer', color:'var(--blue)', fontSize:'13px', fontFamily:'var(--font)', padding:'0', textDecoration:'underline' }} onClick={() => { setMode('login'); setError(''); setMessage('') }}>← Back to login</button>)}
        </div>

      </div>
    </div>
  )
}
