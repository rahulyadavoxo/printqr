import { useEffect, useRef } from 'react'
import { useI18n } from '../lib/i18n'

const CLIENT = (import.meta.env.VITE_ADSENSE_CLIENT || '').trim()
const SLOT = (import.meta.env.VITE_ADSENSE_SLOT || '').trim()
const SCRIPT_ID = 'adsbygoogle-js'

declare global {
  interface Window {
    adsbygoogle?: unknown[]
  }
}

function loadScript() {
  if (document.getElementById(SCRIPT_ID)) return
  const s = document.createElement('script')
  s.id = SCRIPT_ID
  s.async = true
  s.crossOrigin = 'anonymous'
  s.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(CLIENT)}`
  document.head.appendChild(s)
}

/**
 * Google AdSense display ad. Renders nothing unless VITE_ADSENSE_CLIENT and VITE_ADSENSE_SLOT are set
 * at build time. Callers decide whether the shop is on the free plan. An unfilled ad hides itself (CSS).
 */
export default function AdSlot({ className = '' }: { className?: string }) {
  const { t } = useI18n()
  const ref = useRef<HTMLModElement>(null)
  useEffect(() => {
    if (!CLIENT || !SLOT || !ref.current) return
    loadScript()
    try {
      if (!ref.current.getAttribute('data-adsbygoogle-status')) (window.adsbygoogle = window.adsbygoogle || []).push({})
    } catch {
      /* ad blockers etc. – ignore */
    }
  }, [])
  if (!CLIENT || !SLOT) return null
  return (
    <aside className={`ad-slot no-print ${className}`} aria-label={t('adLabel')}>
      <span className="ad-label">{t('adLabel')}</span>
      <ins ref={ref} className="adsbygoogle" style={{ display: 'block' }}
        data-ad-client={CLIENT} data-ad-slot={SLOT} data-ad-format="auto" data-full-width-responsive="true" />
    </aside>
  )
}
