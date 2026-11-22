import { PUBLIC_BASE, offerSavePassword, pickSavedPassword } from '../lib/app'
import PasswordInput from '../components/PasswordInput'
import { googleAvailable, signInWithGoogle } from '../lib/google'
import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { clearAuthUrlError, peekAuthUrlError, sendResetEmail } from '../lib/recovery'
import { useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'
import { isCaptchaError, Turnstile } from '../components/Turnstile'

type Via = 'email' | 'phone'
const VIA_KEY = 'pq-login-via'
const INDIAN_MOBILE = /^[6-9]\d{9}$/

/** Keeps the 10-digit number; a pasted "+91 98765 43210" or "098765 43210" works too. */
function cleanMobile(v: string): string {
  let d = v.replace(/\D/g, '')
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return d.slice(0, 10)
}

function initialVia(param: string | null): Via {
  if (param === 'phone' || param === 'email') return param
  try { return localStorage.getItem(VIA_KEY) === 'phone' ? 'phone' : 'email' } catch { return 'email' }
}

export default function Login() {
  const [params] = useSearchParams()
  const { t, te, lang } = useI18n()
  const initialMode = params.get('mode')
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>(
    initialMode === 'signup' ? 'signup' : initialMode === 'forgot' ? 'forgot' : 'login'
  )
  const [email, setEmail] = useState('')
  // Email + password, or mobile number + SMS code (one flow: a new number gets an account automatically).
  const [via, setVia] = useState<Via>(() => initialVia(params.get('via')))
  const [mobile, setMobile] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Signup step 2: the 6-digit code from the email (proves the email is real).
  const [codeStep, setCodeStep] = useState(false)
  const [code, setCode] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const [captcha, setCaptcha] = useState<string | null>(null)
  const [captchaReset, setCaptchaReset] = useState(0)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(() => {
    const e = peekAuthUrlError()
    return e ? { text: e, error: true } : null
  })
  const nav = useNavigate()

  useEffect(() => clearAuthUrlError(), [])

  // App: offer saved logins from Google Password Manager (once, on the login form)
  useEffect(() => {
    if (initialMode === 'signup' || initialMode === 'forgot') return
    return pickSavedPassword((id, pw) => { setEmail(id); setPassword(pw) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (cooldown <= 0) return
    const id = window.setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => window.clearTimeout(id)
  }, [cooldown])

  async function verifyCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.replace(/\s/g, ''), type: 'email' })
      if (error) throw error
      if (!data.session) throw new Error(t('codeBad'))
      void supabase.functions.invoke('send-welcome', { body: {} }).catch(() => undefined)
      if (password) offerSavePassword(email.trim(), password)
      nav('/setup')
    } catch (e) {
      setMsg({ text: /expired|invalid|otp|token/i.test(String((e as Error)?.message)) ? t('codeBad') : te(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function resendCode() {
    if (cooldown > 0) return
    setBusy(true)
    setMsg(null)
    try {
      const { error } = await supabase.auth.resend({ type: 'signup', email: email.trim(), options: { emailRedirectTo: PUBLIC_BASE, captchaToken: captcha || undefined } })
      if (error) throw error
      setMsg({ text: t('codeResent'), error: false })
      setCooldown(60)
    } catch (e) {
      setMsg({ text: isCaptchaError(e) ? t('captchaFail') : te(e), error: true })
    } finally {
      setBusy(false)
      setCaptchaReset((n) => n + 1)
    }
  }

  /** Friendly text for the mobile flow's errors (Supabase Auth codes, then its messages). */
  function phoneErr(e: unknown, verifying = false): string {
    if (isCaptchaError(e)) return t('captchaFail')
    const code = String((e as { code?: string } | null)?.code || '')
    const status = Number((e as { status?: number } | null)?.status || 0)
    const m = String((e as Error | null)?.message || '')
    if (verifying && (code === 'otp_expired' || /expired|invalid|otp|token/i.test(m))) return t('phCodeBad')
    const wait = /after (\d+) seconds?/i.exec(m)
    if (wait) return t('phWait', { s: wait[1] })
    if (code === 'over_sms_send_rate_limit' || code === 'over_request_rate_limit' || status === 429 || /rate limit/i.test(m)) return t('phRate')
    if (code === 'phone_provider_disabled' || code === 'sms_provider_disabled' || /unsupported phone provider|phone.*(disabled|not enabled)|signups not allowed for otp/i.test(m)) return t('phOff')
    if (code === 'validation_failed' && /phone/i.test(m)) return t('phBad')
    if (/invalid phone|phone number.*(invalid|format)/i.test(m)) return t('phBad')
    if (code === 'sms_send_failed' || code.startsWith('hook_') || /sms|hook|provider/i.test(m)) return t('phSendFail')
    return te(e)
  }

  async function sendPhoneCode(e?: FormEvent) {
    e?.preventDefault()
    const resend = !e
    if (resend && cooldown > 0) return
    if (!INDIAN_MOBILE.test(mobile)) {
      setMsg({ text: t('phBad'), error: true })
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const { error } = await supabase.auth.signInWithOtp({
        phone: `+91${mobile}`,
        options: { captchaToken: captcha || undefined, shouldCreateUser: true }
      })
      if (error) throw error
      try { localStorage.setItem(VIA_KEY, 'phone') } catch { /* ignore */ }
      if (resend) setMsg({ text: t('phCodeResent'), error: false })
      else { setCode(''); setCodeStep(true) }
      setCooldown(60)
    } catch (err) {
      setMsg({ text: phoneErr(err), error: true })
    } finally {
      setBusy(false)
      setCaptchaReset((n) => n + 1)
    }
  }

  async function verifyPhoneCode(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    try {
      const { data, error } = await supabase.auth.verifyOtp({ phone: `+91${mobile}`, token: code.replace(/\s/g, ''), type: 'sms' })
      if (error) throw error
      if (!data.session) throw new Error(t('phCodeBad'))
      // A number seen for the first time just got its account: shop setup. Others: dashboard
      // (both pages send the user to the right place anyway).
      const created = Date.parse(data.user?.created_at || '')
      nav(Number.isFinite(created) && Date.now() - created < 10 * 60 * 1000 ? '/setup' : '/dashboard')
    } catch (err) {
      setMsg({ text: phoneErr(err, true), error: true })
    } finally {
      setBusy(false)
    }
  }

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
        const { error } = await sendResetEmail(email, captcha)
        if (error) throw error
        setMsg({ text: t('fpSent'), error: false })
        return
      }
      if (mode === 'signup') {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: { emailRedirectTo: PUBLIC_BASE, captchaToken: captcha || undefined }
        })
        if (error) throw error
        if (!data.session) {
          // Email confirmation is on: ask for the code we just mailed.
          setCode('')
          setCodeStep(true)
          setCooldown(60)
          return
        }
        offerSavePassword(email.trim(), password)
        nav('/setup')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken: captcha || undefined } })
        if (error) throw error
        offerSavePassword(email.trim(), password)
        nav('/dashboard')
      }
    } catch (e) {
      setMsg({ text: isCaptchaError(e) ? t('captchaFail') : te(e), error: true })
    } finally {
      setBusy(false)
      setCaptchaReset((n) => n + 1)
    }
  }

  async function google() {
    setBusy(true)
    setMsg(null)
    try {
      const r = await signInWithGoogle(PUBLIC_BASE, captcha)
      if (r === 'done') nav('/dashboard')
      // 'redirect': the browser goes to Google now, keep the button busy
      else return
    } catch (e) {
      const m = String((e as Error)?.message || '')
      if (m !== 'cancel') setMsg({ text: isCaptchaError(e) ? t('captchaFail') : t('googleFail') + (m && m !== 'google' ? ` (${m.slice(0, 160)})` : ''), error: true })
      setCaptchaReset((n) => n + 1)
    }
    setBusy(false)
  }

  const signup = mode === 'signup'
  const forgot = mode === 'forgot'
  const switchTo = (m: 'login' | 'signup' | 'forgot') => {
    setMode(m)
    setMsg(null)
  }
  const phoneMode = via === 'phone'
  const switchVia = (v: Via) => {
    if (v === via) return
    setVia(v)
    setMsg(null)
    try { localStorage.setItem(VIA_KEY, v) } catch { /* ignore */ }
  }

  if (codeStep) {
    return (
      <div className="auth-page">
        <TopBar />
        <main className="auth-wrap">
          <form className="card auth-card" onSubmit={phoneMode ? verifyPhoneCode : verifyCode}>
            <div className="auth-logo"><LogoMark size={44} /></div>
            <h1 className="auth-title">{phoneMode ? t('phCodeTitle') : t('codeTitle')}</h1>
            <p className="muted center">{phoneMode ? t('phCodeSub', { phone: `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}` }) : t('codeSub', { email: email.trim() })}</p>
            <label className="field">
              <span>{t('codeLabel')}</span>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" required minLength={6} maxLength={10}
                pattern="[0-9 ]{6,10}" value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))}
                placeholder="123456" className="code-input" autoFocus />
            </label>
            {msg && <p className={`notice${msg.error ? ' error' : ' success'}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
            <button className="btn primary block lg" disabled={busy || code.replace(/\s/g, '').length < 6}>{busy ? t('pleaseWait') : t('codeVerify')}</button>
            <Turnstile key="resend" action={phoneMode ? 'login' : 'signup'} onToken={setCaptcha} resetKey={captchaReset} lang={lang} />
            <p className="center small switch-line">
              <button type="button" className="link" disabled={busy || cooldown > 0} onClick={phoneMode ? () => sendPhoneCode() : resendCode}>
                {cooldown > 0 ? t('codeWait', { s: cooldown }) : t('codeResend')}
              </button>
              {' · '}
              <button type="button" className="link" onClick={() => { setCodeStep(false); setMsg(null) }}>{phoneMode ? t('phChange') : t('codeChangeEmail')}</button>
            </p>
          </form>
        </main>
      </div>
    )
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
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} name="email" autoComplete="username" placeholder="you@example.com" />
            </label>
            <Turnstile key="reset" action="reset" onToken={setCaptcha} resetKey={captchaReset} lang={lang} />
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
        <form className="card auth-card" onSubmit={phoneMode ? sendPhoneCode : submit}>
          <div className="auth-logo"><LogoMark size={44} /></div>
          <h1 className="auth-title">{signup ? t('signupTitle') : t('loginTitle')}</h1>
          <p className="muted center">{signup ? t('signupSub') : t('loginSub')}</p>
          <div className="seg auth-via" role="group" aria-label={t('viaLabel')}>
            <button type="button" className={phoneMode ? '' : 'on'} aria-pressed={!phoneMode} onClick={() => switchVia('email')}>{t('viaEmail')}</button>
            <button type="button" className={phoneMode ? 'on' : ''} aria-pressed={phoneMode} onClick={() => switchVia('phone')}>{t('viaMobile')}</button>
          </div>
          {phoneMode ? (
            <label className="field">
              <span>{t('mobileLabel')}</span>
              <span className="phone-input">
                <span className="phone-cc" aria-hidden="true">+91</span>
                <input type="tel" inputMode="numeric" required autoComplete="tel-national" name="mobile" value={mobile}
                  onChange={(e) => setMobile(cleanMobile(e.target.value))} placeholder="98765 43210" maxLength={16}
                  aria-label={`${t('mobileLabel')} (+91)`} />
              </span>
              <small className="hint">{t('mobileHint')}</small>
            </label>
          ) : (
            <>
              <label className="field">
                <span>{t('email')}</span>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} name="email" autoComplete="username" placeholder="you@example.com" />
              </label>
              <label className="field">
                <span>{t('password')}</span>
                <PasswordInput name="password" required minLength={signup ? 8 : 6} value={password} onChange={(e) => setPassword(e.target.value)}
                  autoComplete={signup ? 'new-password' : 'current-password'} />
                {signup && <small className="hint">{t('passwordHint')}</small>}
              </label>
              {!signup && (
                <p className="forgot-line">
                  <button type="button" className="link small" onClick={() => switchTo('forgot')}>{t('forgotLink')}</button>
                </p>
              )}
            </>
          )}
          <Turnstile key={mode} action={signup ? 'signup' : 'login'} onToken={setCaptcha} resetKey={captchaReset} lang={lang} />
          {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
          {(signup || phoneMode) && (
            <p className="small muted center">
              {t('agreePre')} <Link to="/legal/terms">{t('agreeTerms')}</Link>, <Link to="/legal/refund">{t('agreeRefund')}</Link> {t('agreeAnd')} <Link to="/legal/privacy">{t('agreePrivacy')}</Link>{t('agreePost')}
            </p>
          )}
          <button className="btn primary block lg" disabled={busy}>
            {busy ? t('pleaseWait') : phoneMode ? t('mobileSend') : signup ? t('createAccount') : t('login')}
          </button>
          {googleAvailable() && (
            <>
              <div className="or-line"><span>{t('orWord')}</span></div>
              <button type="button" className="btn block lg google-btn" disabled={busy} onClick={google}>
                <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
                {t('googleBtn')}
              </button>
            </>
          )}
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
