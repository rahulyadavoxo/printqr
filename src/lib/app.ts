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
}
export function nativeBridge(): NativeBridge | undefined {
  return (window as unknown as { PQ?: NativeBridge }).PQ
}
