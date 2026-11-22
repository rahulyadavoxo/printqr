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
