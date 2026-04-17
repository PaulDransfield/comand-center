'use client'
// @ts-nocheck
// app/admin/login/page.tsx — sole entry point for admin auth.
// All other /admin/* pages redirect here when sessionStorage.admin_auth is missing.

export const dynamic = 'force-dynamic'

import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

export default function AdminLoginPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: '100vh', background: '#f5f6f8' }} />}>
      <LoginForm />
    </Suspense>
  )
}

function LoginForm() {
  const router = useRouter()
  const params = useSearchParams()
  const next = params.get('next') || '/admin/overview'

  const [password, setPassword] = useState('')
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState('')

  // If already authed, skip login and go straight to overview
  useEffect(() => {
    if (typeof window !== 'undefined' && sessionStorage.getItem('admin_auth')) {
      router.push(next)
    }
  }, [router, next])

  async function login() {
    setLoading(true); setError('')
    try {
      const res  = await fetch('/api/admin/auth', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      })
      const data = await res.json()
      if (data.ok) {
        sessionStorage.setItem('admin_auth', password)
        router.push(next)
      } else {
        setError('Wrong password')
      }
    } catch (e: any) {
      setError(e.message)
    }
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f5f6f8', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div style={{ background: 'white', borderRadius: 14, padding: '36px 32px', width: '100%', maxWidth: 380, boxShadow: '0 4px 32px rgba(0,0,0,0.08)' }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: '#9ca3af', marginBottom: 8 }}>CommandCenter</div>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#111', letterSpacing: '-0.02em' }}>Admin panel</h1>
        <p style={{ margin: '4px 0 24px', fontSize: 13, color: '#6b7280' }}>Enter the admin password to continue.</p>

        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !loading && password && login()}
          placeholder="Admin password"
          autoFocus
          style={{ width: '100%', padding: '11px 14px', border: '1px solid #e5e7eb', borderRadius: 9, fontSize: 14, marginBottom: 12, fontFamily: 'ui-monospace, monospace', boxSizing: 'border-box' }}
        />

        {error && (
          <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#dc2626', marginBottom: 12 }}>
            {error}
          </div>
        )}

        <button
          onClick={login}
          disabled={loading || !password}
          style={{ width: '100%', padding: 12, background: '#1a1f2e', color: 'white', border: 'none', borderRadius: 9, fontSize: 14, fontWeight: 600, cursor: loading || !password ? 'not-allowed' : 'pointer', opacity: loading || !password ? 0.6 : 1 }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>

        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <a href="/dashboard" style={{ fontSize: 12, color: '#6366f1', textDecoration: 'none' }}>← Back to app</a>
        </div>
      </div>
    </div>
  )
}
