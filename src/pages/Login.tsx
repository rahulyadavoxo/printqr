import { PUBLIC_BASE, offerSavePassword, pickSavedPassword, startOtpAutoRead } from '../lib/app'
import PasswordInput from '../components/PasswordInput'
import OtpInput, { EMAIL_OTP_LENGTH, EMAIL_OTP_MAX, SMS_OTP_LENGTH } from '../components/OtpInput'
import { googleAvailable, signInWithGoogle } from '../lib/google'
import { CSSProperties, FormEvent, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { clearAuthUrlError, peekAuthUrlError, sendResetEmail } from '../lib/recovery'
import { useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'
import { isCaptchaError, Turnstile } from '../components/Turnstile'
import { LOGIN_DESIGNS, LoginDesign, loginDesignFor, useAppSettings } from '../lib/appSettings'

type Via = 'email' | 'phone'
type PhoneKind = 'signup' | 'reset'
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

export default function Login() {
  const [params] = useSearchParams()
  const { t, te, lang, setLang } = useI18n()
  // Admin picks the design (Settings > Login page design); ?design=modern|classic previews one.
  const settings = useAppSettings()
  const designParam = params.get('design')
  const design: LoginDesign = designParam && (LOGIN_DESIGNS as readonly string[]).includes(designParam) ? designParam as LoginDesign : loginDesignFor(settings)
  const [fullName, setFullName] = useState('')
  const initialMode = params.get('mode')
  const [mode, setMode] = useState<'login' | 'signup' | 'forgot'>(
    initialMode === 'signup' ? 'signup' : initialMode === 'forgot' ? 'forgot' : 'login'
  )
  const [email, setEmail] = useState('')
  // Email + password, or mobile number + SMS code (one flow: a new number gets an account automatically).
  // Which code the code step checks: 'phone' only after an SMS OTP was sent from the Email / Mobile box.
  const [via, setVia] = useState<Via>('email')
  const [mobile, setMobile] = useState('')
  // What the SMS code is for: a new account (password already typed) or "forgot password".
  const [phoneKind, setPhoneKind] = useState<PhoneKind>('signup')
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
  // A 10-digit mobile number typed in the Email / Mobile box (no @ or letters).
  const idIsPhone = !/[@a-z]/i.test(email) && INDIAN_MOBILE.test(cleanMobile(email))

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

  /**
   * SMS code for a mobile number. 'signup': creates the account with the typed password (Supabase sends the
   * confirmation code). 'reset': forgot password, signs in by code (only existing numbers) so a new password can be set.
   * No number = resend for the code step.
   */
  async function sendPhoneCode(num?: string, kind?: PhoneKind) {
    const resend = !num
    if (resend && cooldown > 0) return
    const number = num ?? mobile
    const k = kind ?? phoneKind
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
    const phone = `+91${number}`
    const captchaToken = captcha || undefined
    try {
      if (k === 'signup' && !resend) {
        const { data, error } = await supabase.auth.signUp({ phone, password, options: { captchaToken, data: fullName.trim() ? { full_name: fullName.trim() } : undefined } })
        if (error) throw error
        if (data.session) {
          // Phone confirmation switched off in Supabase: the account is ready already.
          stopOtpAutoRead()
          offerSavePassword(phone, password)
          nav('/setup')
          return
        }
      } else if (k === 'signup') {
        const { error } = await supabase.auth.resend({ type: 'sms', phone, options: { captchaToken } })
        if (error) throw error
      } else {
        const { error } = await supabase.auth.signInWithOtp({ phone, options: { captchaToken, shouldCreateUser: false } })
        if (error) throw error
      }
      if (!resend) { setMobile(number); setPhoneKind(k); setVia('phone') }
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
      if (phoneKind === 'reset') {
        nav('/reset')
      } else {
        offerSavePassword(`+91${mobile}`, password)
        nav('/setup')
      }
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
    // Email or a 10-digit mobile number in the same box. A number never gets a password check by email.
    const number = idIsPhone ? cleanMobile(email) : ''
    if (idIsPhone && mode !== 'login') {
      await sendPhoneCode(number, mode === 'signup' ? 'signup' : 'reset')
      return
    }
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
          options: { emailRedirectTo: PUBLIC_BASE, captchaToken: captcha || undefined, data: fullName.trim() ? { full_name: fullName.trim() } : undefined }
        })
        if (error) throw error
        if (!data.session) {
          // Email confirmation is on: ask for the code we just mailed.
          setVia('email')
          setCode('')
          setCodeStep(true)
          setCooldown(60)
          return
        }
        offerSavePassword(email.trim(), password)
        nav('/setup')
      } else {
        const creds = idIsPhone ? { phone: `+91${number}`, password } : { email, password }
        const { error } = await supabase.auth.signInWithPassword({ ...creds, options: { captchaToken: captcha || undefined } })
        if (error) throw error
        offerSavePassword(idIsPhone ? `+91${number}` : email.trim(), password)
        nav('/dashboard')
      }
    } catch (e) {
      const bad = /invalid login credentials/i.test(String((e as Error)?.message || ''))
      setMsg({ text: isCaptchaError(e) ? t('captchaFail') : idIsPhone && bad ? t('phNoPass') : bad ? t('badOrNew') : te(e), error: true })
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
                <button type="button" className="link" disabled={busy} onClick={phoneMode ? () => { void sendPhoneCode() } : resendCode}>
                  {t('codeResend')}
                </button>
              )}
              {' · '}
              <button type="button" className="link" onClick={() => { if (phoneMode) setEmail(mobile); setCodeStep(false); setMsg(null) }}>{phoneMode ? t('phChange') : t('codeChangeEmail')}</button>
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
            <p className="muted center">{t('fpSubAny')}</p>
            <label className="field">
              <span>{t('idLabel')}</span>
              <input type="text" inputMode={idIsPhone ? 'tel' : 'email'} required value={email} onChange={(e) => setEmail(e.target.value)} name="email"
                autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t('idPlaceholder')} />
            </label>
            <Turnstile key="reset" action="reset" onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
            {msg && <p className={`notice${msg.error ? ' error' : ' success'}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
            <button className="btn primary block lg" disabled={busy}>{busy ? t('pleaseWait') : idIsPhone ? t('mobileSend') : t('fpSend')}</button>
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

  const qrSvg = (
    <svg viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true"><g fill="#0d1210"><rect x="0" y="0" width="3" height="3"/><rect x="4" y="0" width="3" height="3"/><rect x="0" y="4" width="3" height="3"/><rect x="4" y="4" width="1" height="1"/><rect x="6" y="5" width="1" height="2"/><rect x="5" y="6" width="1" height="1"/></g><g fill="#fff"><rect x=".7" y=".7" width="1.6" height="1.6"/><rect x="4.7" y=".7" width="1.6" height="1.6"/><rect x=".7" y="4.7" width="1.6" height="1.6"/></g></svg>
  )
  const lxLogo = <div className="lx-logo"><i>P</i><div><b>print</b><small>BY RECEIPTO</small></div></div>
  const lxLang = (
    <div className="lx-lang" role="group" aria-label={t('language')}>
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
      <button type="button" aria-pressed={lang === 'hi'} onClick={() => setLang('hi')} lang="hi">हि</button>
    </div>
  )
  // "Scan. Upload. Print." word by word (the desktop designs highlight one word at a time).
  const pitchWords = t('lxPitch').split(' ').flatMap((w, i) => [
    i ? ' ' : null,
    <span key={i} className="w" style={{ ['--i' as string]: i } as CSSProperties}>{w}</span>
  ])
  const lxForm = (
    <>
      <div className="lx-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={!signup} onClick={() => switchTo('login')}>{t('signInUp')}</button>
        <button type="button" role="tab" aria-selected={signup} onClick={() => switchTo('signup')}>{t('lxTabUp')}</button>
      </div>
      <h1 className="lx-title">{signup ? t('signupTitle') : t('loginTitle')}</h1>
      <p className="lx-sub">{signup ? t('lxSubUp') : t('lxSubIn')}</p>
      <form onSubmit={submit}>
        {signup && (
          <label className="lx-field">
            <span>{t('lxName')}</span>
            <input type="text" required autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder={t('lxNamePh')} maxLength={80} />
          </label>
        )}
        <label className="lx-field">
          <span>{t('idLabel')}</span>
          <input type="text" inputMode={idIsPhone ? 'tel' : 'email'} required value={email} onChange={(e) => setEmail(e.target.value)} name="email"
            autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t('idPlaceholder')} />
          {signup && idIsPhone && <small className="hint">{t('mobileHintShort')}</small>}
        </label>
        <div className="lx-field">
          <div className="lx-row">
            <label htmlFor="lx-password">{t('password')}</label>
            {!signup && <button type="button" className="lx-forgot" onClick={() => switchTo('forgot')}>{t('forgotLink')}</button>}
          </div>
          <PasswordInput id="lx-password" name="password" required minLength={signup ? 8 : 6} value={password} onChange={(e) => setPassword(e.target.value)}
            autoComplete={signup ? 'new-password' : 'current-password'} placeholder={signup ? t('lxPwPh') : '••••••••'} />
        </div>
        <Turnstile key={mode} action={signup ? 'signup' : 'login'} onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
        {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
        <button className="lx-cta" disabled={busy}>{busy ? t('pleaseWait') : signup ? t('createAccount') : t('signInUp')}</button>
      </form>
      {googleAvailable() && (
        <>
          <div className="lx-or">{t('orWord')}</div>
          <button type="button" className="lx-g" disabled={busy} onClick={google}>
            <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            {t('googleBtn')}
          </button>
        </>
      )}
      {terms(signup ? t('agreePre') : t('agreeAnyPre'))}
    </>
  )
  // Illustration tiles of the "bento" designs (sample numbers, decoration only).
  const bentoTiles = (
    <>
      <div className="lxb-t lxb-t1">
        <div><h2>{pitchWords}</h2>{design === 'bentofull' && <p>{t('lxPitchFull')}</p>}</div>
        {qrSvg}
      </div>
      <div className="lxb-t lxb-t2">
        <h3>{t('lxBOrders')}</h3>
        <div className="n">24<small>+18%</small></div>
        <div className="bars"><i /><i /><i /><i /><i /><i /><i /></div>
      </div>
      <div className="lxb-t lxb-t3">
        <h3>{t('lxBQueue')}</h3>
        <div className="qs">
          <div className="q"><div className="ic">PDF</div><div><b>Notes_Unit3.pdf</b><span>12 pages · B/W</span></div><em>{t('lxJPrint')}</em></div>
          <div className="q"><div className="ic">JPG</div><div><b>Passport_photo.jpg</b><span>4 copies · Colour</span></div><em className="w">{t('lxJQueue')}</em></div>
          <div className="q"><div className="ic">DOC</div><div><b>Resume_Rahul.docx</b><span>2 pages · B/W</span></div><em className="w">{t('lxJQueue')}</em></div>
          {design === 'bentofull' && <div className="q"><div className="ic">PDF</div><div><b>Form_Aadhaar.pdf</b><span>1 page · B/W</span></div><em className="w">{t('lxJQueue')}</em></div>}
        </div>
      </div>
      <div className="lxb-t lxb-t4">
        <div><h3>{t('lxBColl')}</h3><div className="n">₹1,240</div><p>{t('lxBUpi')}</p></div>
        <span className="upi">UPI</span>
        {design === 'bentofull' && <div className="pay"><span>₹48 · Rahul</span><span>₹120 · Anjali</span><span>₹30 · Sumit</span></div>}
      </div>
    </>
  )

  if (design === 'split') {
    return (
      <div className="lx lxd lxd-split">
        <aside className="lxs-brand">
          {lxLogo}
          <div className="lxs-copy">
            <h2>{pitchWords}</h2>
            <p>{t('lxPitch2')}</p>
            <ul className="lxs-pts"><li>{t('lxP1')}</li><li>{t('lxP2')}</li><li>{t('lxP3')}</li></ul>
          </div>
          <div className="lxs-foot">© Receipto</div>
          <div className="lxs-receipt" aria-hidden="true">
            <div className="rh"><b>print</b><span>#1024</span></div>
            <div className="l" /><div className="l s" /><div className="l" /><div className="l s" />
            <div className="tot"><span>{t('lxTotal')}</span><b>₹48</b></div>
            <div className="chip">{t('lxPrinted')}</div>
            {qrSvg}
          </div>
        </aside>
        <section className="lxs-side">
          <div className="lxs-bar">{lxLang}</div>
          <div className="lxd-center"><main className="lxd-card">{lxForm}</main></div>
        </section>
      </div>
    )
  }

  if (design === 'bento') {
    return (
      <div className="lx lxd lxd-bento">
        <div className="lxb-page">
          <nav className="lxd-nav">{lxLogo}{lxLang}</nav>
          <div className="lxb-grid">
            <main className="lxd-card">{lxForm}</main>
            <aside className="lxb-bento" aria-hidden="true">{bentoTiles}</aside>
          </div>
        </div>
      </div>
    )
  }

  if (design === 'bentofull') {
    return (
      <div className="lx lxd lxd-bentofull">
        <section className="lxf-left">
          <nav className="lxd-nav">{lxLogo}{lxLang}</nav>
          <div className="lxd-center"><main className="lxf-sheet">{lxForm}</main></div>
        </section>
        <aside className="lxf-right" aria-hidden="true"><div className="lxb-bento">{bentoTiles}</div></aside>
      </div>
    )
  }

  if (design === 'modern') {
    return (
      <div className="lx">
        <div className="lx-wrap">
          <header className="lx-hero">
            <div className="lx-top">{lxLogo}{lxLang}</div>
            <div className="lx-pitch"><h2>{t('lxPitch')}</h2><p>{t('lxPitch2')}</p></div>
            <div className="lx-receipt" aria-hidden="true">
              <div className="l" /><div className="l s" />
              {qrSvg}
            </div>
          </header>
          <main className="lx-sheet">{lxForm}</main>
          <div style={{ height: 28 }} />
        </div>
      </div>
    )
  }

  // One box for email or mobile: email + password, or a mobile number that gets an OTP (new number = new account).
  return (
    <div className="auth-page">
      <TopBar />
      <main className="auth-wrap">
        <form className="card auth-card" onSubmit={submit}>
          <h1 className="auth-title">{signup ? t('signupTitle') : t('loginTitle')}</h1>
          <p className="muted center">{signup ? t('signupSub') : t('loginSub')}</p>
          {googleButton}
          <label className="field">
            <span>{t('idLabel')}</span>
            <input type="text" inputMode={idIsPhone ? 'tel' : 'email'} required value={email} onChange={(e) => setEmail(e.target.value)} name="email"
              autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder={t('idPlaceholder')} />
            {signup && idIsPhone && <small className="hint">{t('mobileHintShort')}</small>}
          </label>
          <div className="field">
            <div className="field-head">
              <label htmlFor="login-password">{t('password')}</label>
              {!signup && (
                <button type="button" className="forgot-link" onClick={() => switchTo('forgot')}>{t('forgotLink')}</button>
              )}
            </div>
            <PasswordInput id="login-password" name="password" required minLength={signup ? 8 : 6} value={password} onChange={(e) => setPassword(e.target.value)}
              autoComplete={signup ? 'new-password' : 'current-password'} placeholder="••••••••" />
            {signup && <small className="hint">{t('passwordHint')}</small>}
          </div>
          <Turnstile key={mode} action={signup ? 'signup' : 'login'} onToken={setCaptcha} resetKey={captchaReset} lang={lang} quiet />
          {msg && <p className={`notice${msg.error ? ' error' : ''}`} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}
          <button className="btn primary block lg" disabled={busy}>
            {busy ? t('pleaseWait') : signup ? t('createAccount') : t('signInUp')}
          </button>
          <p className="center small switch-line">
            <span className="muted">{signup ? t('haveAccount') : t('noAccount')}</span>{' '}
            <button type="button" className="link" onClick={() => switchTo(signup ? 'login' : 'signup')}>
              {signup ? t('login') : t('switchSignup')}
            </button>
          </p>
          {terms(signup ? t('agreePre') : t('agreeAnyPre'))}
        </form>
      </main>
    </div>
  )
}
