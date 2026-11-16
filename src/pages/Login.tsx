import { FormEvent, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'

export default function Login() {
  const [params] = useSearchParams()
  const { t, te } = useI18n()
  const [mode, setMode] = useState<'login' | 'signup'>(params.get('mode') === 'signup' ? 'signup' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const nav = useNavigate()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) nav('/dashboard', { replace: true })
    })
  }, [nav])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL }
        })
        if (error) throw error
        if (!data.session) {
          setMsg({ text: t('confirmSent'), error: false })
          setMode('login')
          return
        }
        nav('/setup')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) throw error
        nav('/dashboard')
      }
    } catch (e) {
      setMsg({ text: te(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  const signup = mode === 'signup'

  return (
    <div className="auth-page">
      <TopBar />
      <main className="auth-wrap">
        <form className="card auth-card" onSubmit={submit}>
          <div className="auth-logo"><LogoMark size={44} /></div>
          <h1 className="auth-title">{signup ? t('signupTitle') : t('loginTitle')}</h1>
          <p className="muted center">{signup ? t('signupSub') : t('loginSub')}</p>
          <label className="field">
            <span>{t('email')}</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
          </label>
          <label className="field">
            <span>{t('password')}</span>
            <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={signup ? 'new-password' : 'current-password'} />
            {signup && <small className="hint">{t('passwordHint')}</small>}
          </label>
          {msg && <p className={`notice${msg.error ? ' error' : ''}`}>{msg.text}</p>}
          <button className="btn primary block lg" disabled={busy}>
            {busy ? t('pleaseWait') : signup ? t('createAccount') : t('login')}
          </button>
          <p className="center small switch-line">
            <span className="muted">{signup ? t('haveAccount') : t('noAccount')}</span>{' '}
            <button type="button" className="link" onClick={() => { setMode(signup ? 'login' : 'signup'); setMsg(null) }}>
              {signup ? t('login') : t('switchSignup')}
            </button>
          </p>
        </form>
      </main>
    </div>
  )
}
