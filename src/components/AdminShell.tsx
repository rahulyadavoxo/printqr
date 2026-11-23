import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Key, useI18n } from '../lib/i18n'
import Icon from './Icon'
import { LangToggle, TopBar } from './TopBar'
import { setTopColor } from '../lib/theme'

/* Admin page frame. Computer: the normal top bar + tab row (inside the page).
   Phone/tablet (< 1024px): app-style bar (back, title, refresh) and a bottom bar like the Dashboard,
   with the less used tabs in a "More" sheet. Shared by the Admin page and its loading skeleton. */

export type AdminTab = 'overview' | 'shops' | 'users' | 'orders' | 'payments' | 'spam' | 'settings' | 'log'
export const ADMIN_TABS: AdminTab[] = ['overview', 'shops', 'users', 'orders', 'payments', 'spam', 'settings', 'log']
export const ADMIN_TAB_KEYS: Record<AdminTab, Key> = {
  overview: 'admOverview', shops: 'admShops', users: 'admUsers', orders: 'admOrders', payments: 'admPayments',
  spam: 'admSpam', settings: 'admSettings', log: 'admLog'
}
const ICONS: Record<AdminTab, string> = {
  overview: 'chart', shops: 'store', users: 'user', orders: 'inbox', payments: 'rupee', spam: 'shield', settings: 'settings', log: 'note'
}
/** Bottom bar, left to right (Orders in the centre); the rest live behind More. */
const BOTTOM: AdminTab[] = ['overview', 'shops', 'orders', 'users']
const MORE: AdminTab[] = ['payments', 'spam', 'settings', 'log']

export function AdminShell({ children, tab, onTab, onRefresh, refreshing = false, bell, save }: {
  children: ReactNode; tab?: AdminTab; onTab?: (t: AdminTab) => void; onRefresh?: () => void; refreshing?: boolean
  /** v30: health alerts bell left of refresh; count = open problems */
  bell?: { count: number; onClick: () => void }
  /** The open tab has unsaved changes: its bottom-bar button (or More, for More tabs) turns into Save. */
  save?: { run: () => void; busy: boolean } | null
}) {
  const { t } = useI18n()
  const nav = useNavigate()
  const [more, setMore] = useState(false)
  // Phone/tablet: status bar (app) and browser bar match the grey admin top bar, like the Dashboard.
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023.98px)')
    const sync = () => setTopColor(mq.matches ? { light: '#e6e1d6', dark: '#070b09' } : null)
    sync()
    mq.addEventListener?.('change', sync)
    return () => { mq.removeEventListener?.('change', sync); setTopColor(null) }
  }, [])
  useEffect(() => {
    if (!more) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMore(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [more])
  const pick = (x: AdminTab) => { setMore(false); onTab?.(x); window.scrollTo(0, 0) }
  const moreOn = !!tab && MORE.includes(tab)
  const saveBtn = (key: string) => (
    <button key={key} type="button" className={`bnav-item adm-save on${key === 'orders' ? ' bnav-main' : ''}`}
      onClick={() => save?.run()} disabled={save?.busy} aria-busy={save?.busy}>
      <span className="bnav-ic"><Icon name="check" size={key === 'orders' ? 26 : 22} /></span>
      <span className="bnav-lbl">{save?.busy ? '…' : t('save')}</span>
    </button>
  )

  return (
    <div className={`app-page admin-app${tab ? ' has-bnav' : ''}`}>
      <div className="adm-d"><TopBar to="/dashboard" wide /></div>
      <header className="topbar adm-bar no-print">
        <div className="topbar-in wide">
          <button type="button" className="menu-btn" onClick={() => nav('/dashboard')} aria-label={t('admHome')}>
            <Icon name="homeStack" size={22} />
          </button>
          <div className="adm-bar-title"><Icon name="shield" size={18} /><span>{t('admTitle')}</span></div>
          {bell && (
            <button type="button" className="menu-btn adm-bell" onClick={bell.onClick} aria-label={t('admNotifs')}>
              <Icon name="bell" size={21} />
              {bell.count > 0 && <span className="adm-badge">{bell.count}</span>}
            </button>
          )}
          {onRefresh && (
            <button type="button" className={`menu-btn adm-refresh${refreshing ? ' is-busy' : ''}`} onClick={onRefresh}
              disabled={refreshing} aria-busy={refreshing} aria-label={t('admRefresh')}>
              <Icon name="retake" size={20} />
            </button>
          )}
        </div>
      </header>

      <main className="page">{children}</main>

      {tab && (
        <nav className="bnav adm-bnav no-print" aria-label={t('admTitle')}>
          {BOTTOM.map((id) => (save && tab === id) ? saveBtn(id) : (
            <button key={id} type="button" className={`bnav-item${id === 'orders' ? ' bnav-main' : ''}${tab === id ? ' on' : ''}`}
              aria-current={tab === id ? 'page' : undefined} onClick={() => pick(id)}>
              <span className="bnav-ic"><Icon name={ICONS[id]} size={id === 'orders' ? 26 : 22} /></span>
              <span className="bnav-lbl">{t(ADMIN_TAB_KEYS[id])}</span>
            </button>
          ))}
          {save && moreOn ? saveBtn('more') : <button type="button" className={`bnav-item${moreOn ? ' on' : ''}`} aria-expanded={more} onClick={() => setMore(true)}>
            <span className="bnav-ic"><Icon name="menu" size={22} /></span>
            <span className="bnav-lbl">{t('admNavMore')}</span>
          </button>}
        </nav>
      )}

      {more && (
        <div className="adm-sheet-back no-print" onClick={() => setMore(false)}>
          <div className="adm-sheet" role="dialog" aria-modal="true" aria-label={t('admNavMore')} onClick={(e) => e.stopPropagation()}>
            <span className="adm-sheet-grab" aria-hidden="true" />
            {MORE.map((id) => (
              <button key={id} type="button" className={`adm-sheet-item${tab === id ? ' on' : ''}`}
                aria-current={tab === id ? 'page' : undefined} onClick={() => pick(id)}>
                <span className="adm-sheet-ic"><Icon name={ICONS[id]} size={20} /></span>
                <span>{t(ADMIN_TAB_KEYS[id])}</span>
                <Icon name="chevr" size={18} />
              </button>
            ))}
            <div className="adm-sheet-foot"><LangToggle /></div>
          </div>
        </div>
      )}
    </div>
  )
}
