/**
 * Android app support. Inside the PrintQR Android app the site is bundled in the APK and served from
 * https://appassets.androidplatform.net, so links that people share must point to the public site.
 */
export const IN_APP = typeof navigator !== 'undefined' && /PrintQRApp\/Android/.test(navigator.userAgent)

/** The public site (QR codes, share links, email redirects always use this). */
export const PUBLIC_BASE = IN_APP ? 'https://print.receipto.in/' : window.location.origin + import.meta.env.BASE_URL

/** Native bridge added by the Android app (MainActivity.Bridge). */
export type NativeBridge = {
  print?: (title: string) => void
  openExternal?: (url: string) => void
  toast?: (msg: string) => void
  razorpay?: (optionsJson: string) => void
  // in-app update (UpdateGate); results come back through window.__pqUpd
  appVersion?: () => string
  checkUpdate?: () => void
  downloadUpdate?: (version: string) => void
  canInstall?: () => boolean
  installUpdate?: () => string
  setBars?: (dark: boolean) => void
  // status bar colour to match a page's top bar (app 1.5.47+)
  setStatusColor?: (hex: string, darkIcons: boolean) => void
  // push notifications (app 1.5.21+); a new token also arrives through window.__pqPush
  pushToken?: () => string
  askNotify?: () => void
  pushError?: () => string
  notifyAllowed?: () => boolean
  // UI language for the app's own notifications and channel names (app 1.5.34+)
  setLang?: (lang: string) => void
  // Google Password Manager save sheet (app 1.5.71+)
  savePassword?: (id: string, password: string) => void
  // Pick a saved login (app 1.5.73+); fills through window.__pqFill
  getPassword?: () => void
  // Google sign-in sheet (app 1.5.74+); answers through window.__pqGoogle(idToken, error)
  googleSignIn?: (clientId: string, nonceHash: string) => void
  // SMS OTP auto-read with Google's SMS Retriever (app newer than 1.5.77); the code arrives as the
  // window event 'printqr-otp' (detail { code, error }). Needs the app hash at the end of the SMS (send-sms, SMS_APP_HASH).
  startSmsRetriever?: () => void
  stopSmsRetriever?: () => void
}
export function nativeBridge(): NativeBridge | undefined {
  return (window as unknown as { PQ?: NativeBridge }).PQ
}

/** Any Android device: the PrintQR app or a browser on an Android phone/tablet. */
export const ON_ANDROID = IN_APP || (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent))

/** After a successful login/signup: offer to save the email + password (app: Google Password Manager sheet; Chrome: its save prompt). */
export function offerSavePassword(id: string, password: string) {
  try {
    const b = nativeBridge()
    if (b?.savePassword) { b.savePassword(id, password); return }
    const W = window as unknown as { PasswordCredential?: new (d: { id: string; password: string }) => Credential }
    if (W.PasswordCredential && navigator.credentials?.store) {
      void navigator.credentials.store(new W.PasswordCredential({ id, password })).catch(() => {})
    }
  } catch { /* ignore */ }
}

/** App only: show Google Password Manager's saved logins; the chosen one is passed to fill(). */
export function pickSavedPassword(fill: (id: string, password: string) => void): () => void {
  const b = nativeBridge()
  if (!b?.getPassword) return () => {}
  const W = window as unknown as { __pqFill?: (id: string, pw: string) => void }
  W.__pqFill = fill
  try { b.getPassword() } catch { /* ignore */ }
  return () => { if (W.__pqFill === fill) delete W.__pqFill }
}

/** Window event the app fires when the SMS Retriever read an OTP SMS (MainActivity.otpEvent). */
export const OTP_EVENT = 'printqr-otp'

/**
 * App only: read the next OTP SMS by itself (Google SMS Retriever, no permission, no tap; waits up to 5 minutes).
 * Call it just before the SMS is requested; onCode gets the digits once. Returns a stop function.
 * On the website, or an older app without the bridge method, it does nothing (the keyboard still suggests the code).
 */
export function startOtpAutoRead(onCode: (code: string) => void): () => void {
  const b = nativeBridge()
  if (!b?.startSmsRetriever) return () => {}
  let done = false
  const onEvent = (e: Event) => {
    const code = String((e as CustomEvent<{ code?: string }>).detail?.code || '')
    if (done || !/^\d{4,10}$/.test(code)) return // timeout / error: just type it
    done = true
    window.removeEventListener(OTP_EVENT, onEvent)
    onCode(code)
  }
  window.addEventListener(OTP_EVENT, onEvent)
  try { b.startSmsRetriever() } catch { /* ignore */ }
  return () => {
    window.removeEventListener(OTP_EVENT, onEvent)
    if (!done) { done = true; try { b.stopSmsRetriever?.() } catch { /* ignore */ } }
  }
}

/** What identifies a login on screen: the email, or the mobile number for OTP accounts ("+91 98765 43210"). */
export function accountLabel(u?: { email?: string | null; phone?: string | null } | null): string {
  if (!u) return ''
  if (u.email) return u.email
  const d = String(u.phone || '').replace(/[^\d]/g, '')
  if (d.length === 12 && d.startsWith('91')) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`
  return d ? `+${d}` : ''
}

/** E.164 phone of an OTP account ("+919876543210"), or undefined. */
export function accountPhone(u?: { phone?: string | null } | null): string | undefined {
  const d = String(u?.phone || '').replace(/[^\d]/g, '')
  return d ? `+${d}` : undefined
}
