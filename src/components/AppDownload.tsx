import { useState } from 'react'
import { useI18n } from '../lib/i18n'

// Fixed-name files on the latest GitHub Release (built by .github/workflows/apps.yml).
const BASE = 'https://github.com/rahulyadavoxo/printqr/releases/latest/download/'
const FILES = { android: BASE + 'PrintQR.apk', windows: BASE + 'PrintQR-Setup.exe' }
const HIDE_KEY = 'pq_app_banner_hidden'

type Platform = 'android' | 'windows' | null

/** Which app suits this device, or null when there is none or we are already inside the app. */
export function appPlatform(): Platform {
  if (typeof navigator === 'undefined') return null
  const ua = navigator.userAgent || ''
  const inApp =
    /Electron/i.test(ua) ||
    document.referrer.startsWith('android-app://') ||
    window.matchMedia?.('(display-mode: standalone)').matches
  if (inApp) return null
  if (/Android/i.test(ua)) return 'android'
  if (/Windows/i.test(ua)) return 'windows'
  return null
}

/** A download button for the app that fits this device (Android APK or Windows installer). */
export function AppDownloadButton({ className = 'btn soft' }: { className?: string }) {
  const { t } = useI18n()
  const p = appPlatform()
  if (!p) return null
  return (
    <a className={className} href={FILES[p]} rel="noopener">
      {p === 'android' ? t('appAndroid') : t('appWindows')}
    </a>
  )
}

/** A slim, dismissible banner for the shop dashboard. */
export function AppDownloadBanner() {
  const { t } = useI18n()
  const [hidden, setHidden] = useState(() => {
    try { return localStorage.getItem(HIDE_KEY) === '1' } catch { return false }
  })
  if (hidden || !appPlatform()) return null
  const close = () => {
    try { localStorage.setItem(HIDE_KEY, '1') } catch { /* ignore */ }
    setHidden(true)
  }
  return (
    <div className="app-banner no-print">
      <span>{t('appBanner')}</span>
      <AppDownloadButton className="btn primary small" />
      <button type="button" className="app-banner-x" onClick={close} aria-label={t('appHide')}>×</button>
    </div>
  )
}
