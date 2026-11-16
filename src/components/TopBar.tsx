import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n'

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--brand)" />
      <rect x="7" y="7" width="7" height="7" rx="1.5" fill="#fff" />
      <rect x="18" y="7" width="7" height="7" rx="1.5" fill="#fff" />
      <rect x="7" y="18" width="7" height="7" rx="1.5" fill="#fff" />
      <rect x="18" y="18" width="3" height="3" rx=".8" fill="#fff" />
      <rect x="22" y="22" width="3" height="3" rx=".8" fill="#fff" />
      <rect x="18" y="22" width="3" height="3" rx=".8" fill="#c7d2fe" />
      <rect x="22" y="18" width="3" height="3" rx=".8" fill="#c7d2fe" />
    </svg>
  )
}

export function Logo({ to = '/' }: { to?: string | null }) {
  const inner = (
    <>
      <LogoMark />
      <span>PrintQR</span>
    </>
  )
  return to ? <Link to={to} className="logo">{inner}</Link> : <span className="logo">{inner}</span>
}

export function LangToggle() {
  const { lang, setLang, t } = useI18n()
  return (
    <div className="lang no-print" role="group" aria-label={t('language')}>
      <button type="button" className={lang === 'en' ? 'on' : ''} aria-pressed={lang === 'en'} onClick={() => setLang('en')}>EN</button>
      <button type="button" className={lang === 'hi' ? 'on' : ''} aria-pressed={lang === 'hi'} onClick={() => setLang('hi')} lang="hi">हिं</button>
    </div>
  )
}

export function TopBar({ to = '/', children, wide = false }: { to?: string | null; children?: ReactNode; wide?: boolean }) {
  return (
    <header className="topbar no-print">
      <div className={`topbar-in${wide ? ' wide' : ''}`}>
        <Logo to={to} />
        <div className="topbar-right">
          {children}
          <LangToggle />
        </div>
      </div>
    </header>
  )
}
