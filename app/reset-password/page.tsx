// app/reset-password/page.tsx
//
// RESET PASSWORD PAGE
// User lands here after clicking the reset link in their email.
// The URL contains a code that Supabase exchanges for a session,
// then we show a form to set a new password.

'use client'

import { useState, useEffect } from 'react'
import { useRouter }           from 'next/navigation'
import { useTranslations }     from 'next-intl'
import { createClient }        from '@/lib/supabase/client'

export default function ResetPasswordPage() {
  const router   = useRouter()
  const supabase = createClient()
  const t        = useTranslations('auth.reset')

  const [password,  setPassword]  = useState('')
  const [password2, setPassword2] = useState('')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [ready,     setReady]     = useState(false)

  // The callback route already exchanged the code for a session.
  // By the time the user reaches this page, they're authenticated.
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) {
        // No session — link expired or already used
        router.push('/login?error=' + encodeURIComponent(t('linkExpired')))
      } else {
        setReady(true)
      }
    })
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) { setError(t('tooShort')); return }
    if (password !== password2) { setError(t('mismatch')); return }

    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })

    if (error) {
      setError(error.message)
      setLoading(false)
      return
    }

    // Password updated — sign out all other sessions and go to dashboard
    router.push('/dashboard?message=Password+updated+successfully')
  }

  if (!ready) {
    return (
      <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <span className="spin" style={{ fontSize:24, color:'var(--ink-4)' }}>⟳</span>
      </div>
    )
  }

  return (
    <div style={{ minHeight:'100vh', background:'var(--parchment)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'var(--white)', border:'1px solid var(--border)', borderRadius:16, padding:36, width:400, maxWidth:'100%', boxShadow:'0 4px 24px rgba(0,0,0,.08)' }}>

        <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:24 }}>
          <div style={{ width:28,height:28,borderRadius:7,background:'var(--navy)',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'var(--display)',fontSize:12,fontWeight:700,color:'white' }}>CC</div>
          <span style={{ fontFamily:'var(--display)',fontSize:14,fontWeight:600,color:'var(--navy)' }}>CommandCenter</span>
        </div>

        <h1 style={{ fontFamily:'var(--display)',fontSize:22,fontWeight:300,fontStyle:'italic',color:'var(--navy)',marginBottom:6 }}>{t('title')}</h1>
        <p style={{ fontSize:13,color:'var(--ink-3)',marginBottom:22,lineHeight:1.5 }}>{t('subtitle')}</p>

        {error && (
          <div style={{ background:'var(--red-lt)',border:'1px solid var(--red-mid)',borderRadius:8,padding:'10px 14px',fontSize:13,color:'var(--red)',marginBottom:16 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display:'flex',flexDirection:'column',gap:14 }}>
          <div>
            <label style={{ display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.08em',color:'var(--ink-4)',marginBottom:5 }}>
              {t('newPassword')}
            </label>
            <input
              className="input" type="password" placeholder={t('newPasswordPlaceholder')} required minLength={8}
              value={password} onChange={e => setPassword(e.target.value)} autoFocus autoComplete="new-password"
            />
          </div>
          <div>
            <label style={{ display:'block',fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'.08em',color:'var(--ink-4)',marginBottom:5 }}>
              {t('confirm')}
            </label>
            <input
              className="input" type="password" placeholder={t('confirmPlaceholder')} required
              value={password2} onChange={e => setPassword2(e.target.value)} autoComplete="new-password"
            />
          </div>
          <button type="submit" className="btn btn-primary btn-full" disabled={loading} style={{ marginTop:4 }}>
            {loading ? <><span className="spin">⟳</span> {t('submitting')}</> : t('submit')}
          </button>
        </form>

      </div>
    </div>
  )
}
