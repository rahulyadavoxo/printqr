import { PUBLIC_BASE } from '../lib/app'
import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { clearAuthUrlError, peekAuthUrlError, sendResetEmail } from '../lib/recovery'
import { useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'

export default function Login() {
  const [params] = useSearchParams()
  const { t, te } = useI18n()
  const initialMode = params.get('mode')
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>(
    initialMode === 'signup' ? 'signup' : initialMode === 'forgot' ? 'forgot' : 'login'
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(() => {
    const e = peekAuthUrlError()
    return e ? { text: e, error: true } : null
  })
  const nav = useNavigate()

  useEffect(() => clearAuthUrlError(), [])

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
      if (mode === 'forgot') {
        const { error } = await sendResetEmail(email)
        if (error) throw error
        setMsg({ text: t('fpSent'), error: false })
        return
      }
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: PUBLIC_BASE }
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
  const forgot = mode === 'forgot'
  const switchTo = (m: 'login' | 'signup' | 'forgot') => {
    setMode(m)
    setMsg(null)
  }

  if (forgot) {
    return (
      <div className="auth-page">
        <TopBar />
        <main className="auth-wrap">
          <form className="card auth-card" onSubmit={submit}>
            <div className="auth-logo"><LogoMark size={44} /></div>
            <h1 className="auth-title">{t('fpTitle')}</h1>
            <p className="muted center">{t('fpSub')}</p>
            <label className="field">
              <span>{t('email')}</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" placeholder="you@example.com" />
            </label>
            {msg && <p className={`notice${msg.error ? ' error' : ' success'}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
            <button className="btn primary block lg" disabled={busy}>{busy ? t('pleaseWait') : t('fpSend')}</button>
            <p className="center small switch-line">
              <button type="button" className="link" onClick={() => switchTo('login')}>{t('fpBack')}</button>
            </p>
          </form>
        </main>
      </div>
    )
  }

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
          {!signup && (
            <p className="forgot-line">
              <button type="button" className="link small" onClick={() => switchTo('forgot')}>{t('forgotLink')}</button>
            </p>
          )}
          {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
          {signup && (
            <p className="small muted center">
              {t('agreePre')} <Link to="/legal/terms">{t('agreeTerms')}</Link>, <Link to="/legal/refund">{t('agreeRefund')}</Link> {t('agreeAnd')} <Link to="/legal/privacy">{t('agreePrivacy')}</Link>{t('agreePost')}
            </p>
          )}
          <button className="btn primary block lg" disabled={busy}>
            {busy ? t('pleaseWait') : signup ? t('createAccount') : t('login')}
          </button>
          <p className="center small switch-line">
            <span className="muted">{signup ? t('haveAccount') : t('noAccount')}</span>{' '}
            <button type="button" className="link" onClick={() => switchTo(signup ? 'login' : 'signup')}>
              {signup ? t('login') : t('switchSignup')}
            </button>
          </p>
        </form>
      </main>
    </div>
  )
}
