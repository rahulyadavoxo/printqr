import { PUBLIC_BASE, offerSavePassword, pickSavedPassword, startOtpAutoRead } from '../lib/app'
import PasswordInput from '../components/PasswordInput'
import OtpInput, { EMAIL_OTP_LENGTH, EMAIL_OTP_MAX, SMS_OTP_LENGTH } from '../components/OtpInput'
import { googleAvailable, signInWithGoogle } from '../lib/google'
import { FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { clearAuthUrlError, peekAuthUrlError, sendResetEmail } from '../lib/recovery'
import { useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'
import { isCaptchaError, Turnstile } from '../components/Turnstile'

type Via = 'email' | 'phone'
const VIA_KEY = 'pq-login-via'
const INDIAN_MOBILE = /^[6-9]\d{9}$/

/** Resend countdown as m:ss ("0:42"). */
function mmss(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Keeps the 10-digit number; a pasted "+91 98765 43210" or "098765 43210" works too. */
function cleanMobile(v: string): string {
  let d = v.replace(/\D/g, '')
  if (d.length > 10 && d.startsWith('91')) d = d.slice(2)
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1)
  return d.slice(0, 10)
}

function initialVia(param: string | null): Via {
  if (param === 'phone' || param === 'email') return param
  // Mobile number first; email only for people who picked it before (or open ?via=email / signup / forgot links).
  try { return localStorage.getItem(VIA_KEY) === 'email' ? 'email' : 'phone' } catch { return 'phone' }
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
  const [via, setVia] = useState<Via>(() => initialMode === 'forgot' ? 'email' : initialVia(params.get('via')))
  const [mobile, setMobile] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  // Signup step 2: the 6-digit code from the email (proves the email is real).
  const [codeStep, setCodeStep] = useState(false)
  const [code, setCode] = useState('')
  // Bumped after a wrong code: the boxes shake, clear and focus the first box.
  const [codeShake, setCodeShake] = useState(0)
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

  /** A wrong code: clear the boxes, shake them and focus the first one (the error text shows too). */
  function codeFailed() {
    setCode('')
    setCodeShake((n) => n + 1)
  }

  /** Email code: form submit, or the boxes filling up (onComplete). One check at a time. */
  const verifying = useRef(false)
  async function verifyCode(e?: FormEvent, typed?: string) {
    e?.preventDefault()
    const token = (typed ?? code).replace(/\s/g, '')
    if (verifying.current || token.length < EMAIL_OTP_LENGTH) return
    verifying.current = true
    setBusy(true)
    setMsg(null)
    try {
      const { data, error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' })
      if (error) throw error
      if (!data.session) throw new Error(t('codeBad'))
      void supabase.functions.invoke('send-welcome', { body: {} }).catch(() => undefined)
      if (password) offerSavePassword(email.trim(), password)
      nav('/setup')
    } catch (e) {
      setMsg({ text: /expired|invalid|otp|token/i.test(String((e as Error)?.message)) ? t('codeBad') : te(e), error: true })
      codeFailed()
    } finally {
      verifying.current = false
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
      setCode('')
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

  // App: Google's SMS Retriever reads the OTP SMS by itself (no tap) and we verify it straight away.
  // Started just before the SMS is requested, so a fast SMS is not missed. Website / older app: no-op.
  const otpStop = useRef<(() => void) | null>(null)
  const verifyPhoneRef = useRef<(e?: FormEvent, autoCode?: string) => Promise<void>>(async () => {})
  function stopOtpAutoRead() {
    otpStop.current?.()
    otpStop.current = null
  }
  useEffect(() => stopOtpAutoRead, [])
  useEffect(() => {
    if (!codeStep || via !== 'phone') stopOtpAutoRead()
  }, [codeStep, via])

  async function sendPhoneCode(e?: FormEvent, num?: string) {
    e?.preventDefault()
    const resend = !e
    if (resend && cooldown > 0) return
    const number = num ?? mobile
    if (!INDIAN_MOBILE.test(number)) {
      setMsg({ text: t('phBad'), error: true })
      return
    }
    setBusy(true)
    setMsg(null)
    stopOtpAutoRead()
    otpStop.current = startOtpAutoRead((c) => {
      otpStop.current = null
      setCode(c)
      void verifyPhoneRef.current(undefined, c)
    })
    try {
      const { error } = await supabase.auth.signInWithOtp({
        phone: `+91${number}`,
        options: { captchaToken: captcha || undefined, shouldCreateUser: true }
      })
      if (error) throw error
      try { localStorage.setItem(VIA_KEY, 'phone') } catch { /* ignore */ }
      if (num) { setMobile(num); setVia('phone') }
      if (resend) { setMsg({ text: t('phCodeResent'), error: false }); setCode('') }
      else { setCode(''); setCodeStep(true) }
      setCooldown(60)
    } catch (err) {
      if (!resend) stopOtpAutoRead()
      setMsg({ text: phoneErr(err), error: true })
    } finally {
      setBusy(false)
      setCaptchaReset((n) => n + 1)
    }
  }

  /** Typed code (form submit) or the code the app read from the SMS (autoCode). One check at a time. */
  async function verifyPhoneCode(e?: FormEvent, autoCode?: string) {
    e?.preventDefault()
    const token = (autoCode ?? code).replace(/\s/g, '')
    if (verifying.current || token.length < SMS_OTP_LENGTH) return
    verifying.current = true
    setBusy(true)
    setMsg(null)
    try {
      const { data, error } = await supabase.auth.verifyOtp({ phone: `+91${mobile}`, token, type: 'sms' })
      if (error) throw error
      if (!data.session) throw new Error(t('phCodeBad'))
      // A number seen for the first time just got its account: shop setup. Others: dashboard
      // (both pages send the user to the right place anyway).
      const created = Date.parse(data.user?.created_at || '')
      nav(Number.isFinite(created) && Date.now() - created < 10 * 60 * 1000 ? '/setup' : '/dashboard')
    } catch (err) {
      setMsg({ text: phoneErr(err, true), error: true })
      codeFailed()
    } finally {
      verifying.current = false
      setBusy(false)
    }
  }
  verifyPhoneRef.current = verifyPhoneCode

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
    const codeLen = phoneMode ? SMS_OTP_LENGTH : EMAIL_OTP_LENGTH
    return (
      <div className="auth-page">
        <TopBar />
        <main className="auth-wrap">
          <form className="card auth-card" onSubmit={phoneMode ? verifyPhoneCode : verifyCode}>
            <h1 className="auth-title">{phoneMode ? t('phCodeTitle') : t('codeTitle')}</h1>
            <p className="muted center">{phoneMode ? t('phCodeSub', { phone: `+91 ${mobile.slice(0, 5)} ${mobile.slice(5)}` }) : t('codeSub', { email: email.trim() })}</p>
            <div className="field">
              <span aria-hidden="true">{t('codeLabel')}</span>
              <OtpInput value={code} onChange={setCode} length={codeLen} maxLength={phoneMode ? SMS_OTP_LENGTH : EMAIL_OTP_MAX}
                onComplete={(v) => { void (phoneMode ? verifyPhoneCode(undefined, v) : verifyCode(undefined, v)) }}
                disabled={busy} error={!!msg?.error && !code} shakeKey={codeShake} autoFocus
                ariaLabel={t('otpAria', { n: codeLen })} ariaDescribedBy={msg ? 'otp-msg' : undefined} />
            </div>
            {msg && <p id="otp-msg" className={`notice${msg.error ? ' error' : ' success'}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
            <button className="btn primary block lg" disabled={busy || code.length < codeLen}>{busy ? t('pleaseWait') : t('codeVerify')}</button>
            <Turnstile key="resend" action={phoneMode ? 'login' : 'signup'} onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
            <p className="center small switch-line">
              {cooldown > 0 ? (
                <span className="otp-timer" role="timer" aria-live="off">{t('codeWait', { s: mmss(cooldown) })}</span>
              ) : (
                <button type="button" className="link" disabled={busy} onClick={phoneMode ? () => sendPhoneCode() : resendCode}>
                  {t('codeResend')}
                </button>
              )}
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
            <h1 className="auth-title">{t('fpTitle')}</h1>
            <p className="muted center">{t('fpSub')}</p>
            <label className="field">
              <span>{t('email')}</span>
              <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} name="email" autoComplete="username" placeholder="you@example.com" />
            </label>
            <Turnstile key="reset" action="reset" onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
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

  const googleButton = googleAvailable() ? (
    <>
      <button type="button" className="btn block lg google-btn top" disabled={busy} onClick={google}>
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        {t('googleBtn')}
      </button>
      <div className="or-line top"><span>{t('orWord')}</span></div>
    </>
  ) : null
  const terms = (pre: string) => (
    <p className="auth-terms">
      {pre} <Link to="/legal/terms">{t('agreeTerms')}</Link>, <Link to="/legal/refund">{t('agreeRefund')}</Link> {t('agreeAnd')} <Link to="/legal/privacy">{t('agreePrivacy')}</Link>{t('agreePost')}
    </p>
  )

  // One screen for login and signup: Google, then mobile number + OTP (a new number gets an account by itself).
  if (phoneMode) {
    return (
      <div className="auth-page">
        <TopBar />
        <main className="auth-wrap">
          <form className="card auth-card" onSubmit={sendPhoneCode}>
            <h1 className="auth-title">{t('authTitle')}</h1>
            <p className="muted center">{t('authSub')}</p>
            {googleButton}
            <label className="field">
              <span>{t('mobileLabel')}</span>
              <span className="phone-input">
                <span className="phone-cc" aria-hidden="true">+91</span>
                <input type="tel" inputMode="numeric" required autoComplete="tel-national" name="mobile" value={mobile}
                  onChange={(e) => setMobile(cleanMobile(e.target.value))} placeholder="98765 43210" maxLength={16}
                  aria-label={`${t('mobileLabel')} (+91)`} />
              </span>
              <small className="hint">{t('mobileHintShort')}</small>
            </label>
            <Turnstile key="phone" action="login" onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
            {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
            <button className="btn primary block lg" disabled={busy}>{busy ? t('pleaseWait') : t('mobileSend')}</button>
            <p className="auth-alt small">
              <button type="button" className="link" onClick={() => switchVia('email')}>{t('useEmail')}</button>
            </p>
            {terms(t('agreeAnyPre'))}
          </form>
        </main>
      </div>
    )
  }

  // A 10-digit mobile number typed in the Email / Mobile box: no password, an OTP is sent instead.
  const idIsPhone = !/[@a-z]/i.test(email) && INDIAN_MOBILE.test(cleanMobile(email))

  // "Use email instead": the old email + password form (login / create account / forgot password).
  return (
    <div className="auth-page">
      <TopBar />
      <main className="auth-wrap">
        <form className="card auth-card" onSubmit={idIsPhone ? (e) => sendPhoneCode(e, cleanMobile(email)) : submit}>
          <h1 className="auth-title">{signup ? t('signupTitle') : t('loginTitle')}</h1>
          <p className="muted center">{signup ? t('signupSub') : t('loginSub')}</p>
          {googleButton}
          <label className="field">
            <span>{t('idLabel')}</span>
            <input type="text" inputMode={idIsPhone ? 'tel' : 'email'} required value={email} onChange={(e) => setEmail(e.target.value)} name="email"
              autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t('idPlaceholder')} />
            {idIsPhone && <small className="hint">{t('mobileHintShort')}</small>}
          </label>
          {!idIsPhone && (
            <label className="field">
              <span>{t('password')}</span>
              <PasswordInput name="password" required minLength={signup ? 8 : 6} value={password} onChange={(e) => setPassword(e.target.value)}
                autoComplete={signup ? 'new-password' : 'current-password'} />
              {signup && <small className="hint">{t('passwordHint')}</small>}
            </label>
          )}
          {!signup && !idIsPhone && (
            <p className="forgot-line">
              <button type="button" className="link small" onClick={() => switchTo('forgot')}>{t('forgotLink')}</button>
            </p>
          )}
          <Turnstile key={mode} action={signup ? 'signup' : 'login'} onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
          {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
          <button className="btn primary block lg" disabled={busy}>
            {busy ? t('pleaseWait') : idIsPhone ? t('mobileSend') : signup ? t('createAccount') : t('login')}
          </button>
          <p className="center small switch-line">
            <span className="muted">{signup ? t('haveAccount') : t('noAccount')}</span>{' '}
            <button type="button" className="link" onClick={() => switchTo(signup ? 'login' : 'signup')}>
              {signup ? t('login') : t('switchSignup')}
            </button>
          </p>
          <p className="auth-alt small">
            <button type="button" className="link" onClick={() => switchVia('phone')}>{t('useMobile')}</button>
          </p>
          {terms(signup ? t('agreePre') : t('agreeAnyPre'))}
        </form>
      </main>
    </div>
  )
}
