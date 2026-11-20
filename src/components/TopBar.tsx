import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '../lib/i18n'

export function LogoMark({ size = 30 }: { size?: number }) {
  return (
    <img src={import.meta.env.BASE_URL + 'icon.svg'} width={size} height={size} alt="" aria-hidden="true" style={{ display: 'block', borderRadius: size * 0.23 }} />
  )
}

/** The wordmark; the light-text version shows in dark mode (unless `light`, e.g. on the printed poster). */
export function Wordmark({ height = 36, light = false }: { height?: number; light?: boolean }) {
  const w = Math.round(height * 2.5)
  const img = (file: string, cls: string) => (
    <img src={import.meta.env.BASE_URL + file} height={height} width={w} alt="Print by Receipto" className={cls} style={{ display: 'block' }} />
  )
  if (light) return img('logo.svg', '')
  return <span className="wordmark">{img('logo.svg', 'wm-light')}{img('logo-dark.svg', 'wm-dark')}</span>
}

export function Logo({ to = '/' }: { to?: string | null }) {
  const inner = <Wordmark />
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

/** Plus shops (v17): their own logo + name in place of the PrintQR wordmark on customer pages. */
export function ShopBrand({ name, logo }: { name: string; logo?: string | null }) {
  return (
    <span className="logo own-brand">
      {logo ? <img src={logo} alt="" width={34} height={34} /> : <span className="own-brand-mark" aria-hidden="true">{name.trim().charAt(0).toUpperCase() || 'P'}</span>}
      <strong>{name}</strong>
    </span>
  )
}

export function TopBar({ to = '/', children, wide = false, lang = true, brand }: { to?: string | null; children?: ReactNode; wide?: boolean; lang?: boolean; brand?: ReactNode }) {
  return (
    <header className="topbar no-print">
      <div className={`topbar-in${wide ? ' wide' : ''}`}>
        {brand ?? <Logo to={to} />}
        <div className="topbar-right">
          {children}
          {lang && <LangToggle />}
        </div>
      </div>
    </header>
  )
}
