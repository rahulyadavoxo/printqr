import { useLocation } from 'react-router-dom'
import { IN_APP, nativeBridge } from '../lib/app'
import { useAppSettings, versionLess } from '../lib/appSettings'
import { useI18n } from '../lib/i18n'
import Icon from './Icon'

const RELEASES = 'https://github.com/rahulyadavoxo/printqr/releases/latest'

/* Admin-controlled notices: minimum app version (app only), maintenance, and the announcement for owners. */
export default function AppNotices() {
  const s = useAppSettings()
  const { t, lang } = useI18n()
  const { pathname } = useLocation()
  const bridge = IN_APP ? nativeBridge() : undefined
  const cur = bridge?.appVersion ? bridge.appVersion() : ''

  if (cur && s.min_app_version && versionLess(cur, s.min_app_version)) {
    return (
      <div className="update-gate" role="dialog" aria-modal="true" aria-labelledby="minv-title">
        <div className="update-icon" aria-hidden="true">↑</div>
        <h2 id="minv-title">{t('minVerTitle')}</h2>
        <p>{t('minVerBody', { v: s.min_app_version })}</p>
        <p className="muted small">{t('updCurrent', { v: cur })}</p>
        <button type="button" className="btn primary lg" onClick={() => (bridge?.openExternal ? bridge.openExternal(RELEASES) : window.open(RELEASES, '_blank'))}>
          {t('minVerBtn')}
        </button>
      </div>
    )
  }

  if (pathname.startsWith('/admin')) return null
  const note = lang === 'hi' ? s.announcement_hi || s.announcement : s.announcement || s.announcement_hi
  const owner = pathname.startsWith('/dashboard')
  if (!s.maintenance && !(owner && note)) return null
  return (
    <div className="app-notices no-print">
      {s.maintenance && (
        <div className="app-notice warn" role="status">
          <Icon name="info" size={18} />
          <span>{s.maintenance_msg || t('maintDefault')}</span>
        </div>
      )}
      {owner && note && (
        <div className="app-notice" role="status">
          <Icon name="info" size={18} />
          <span>{note}</span>
        </div>
      )}
    </div>
  )
}
