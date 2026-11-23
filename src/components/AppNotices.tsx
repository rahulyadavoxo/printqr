import { useEffect, useRef, useState } from 'react'
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
  if (IN_APP && owner && note && !s.maintenance) return <AnnPopup note={note} secs={s.announcement_secs} />
  if (!s.maintenance && !(owner && note && !IN_APP)) return null
  return (
    <div className="app-notices no-print">
      {s.maintenance && (
        <div className="app-notice warn" role="status">
          <Icon name="info" size={18} />
          <span title={s.maintenance_msg || t('maintDefault')}>{s.maintenance_msg || t('maintDefault')}</span>
        </div>
      )}
      {IN_APP && owner && note && <AnnPopup note={note} secs={s.announcement_secs} />}
      {owner && note && !IN_APP && (
        <div className="app-notice" role="status">
          <Icon name="info" size={18} />
          <span title={note}>{note}</span>
        </div>
      )}
    </div>
  )
}

/* Android app: the announcement opens as a popup once per app open, closes by itself after `secs`
 * (admin setting, v37). While a finger holds the screen the timer stops; it carries on after release. */
let annShown = ''
function AnnPopup({ note, secs }: { note: string; secs: number }) {
  const { t } = useI18n()
  const total = Math.max(3, Math.min(120, secs || 8)) * 1000
  const [open, setOpen] = useState(() => annShown !== note)
  const [left, setLeft] = useState(total)
  const held = useRef(false)
  useEffect(() => { if (open) annShown = note }, [open, note])
  useEffect(() => {
    if (!open) return
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now(); const dt = now - last; last = now
      if (held.current) return
      setLeft((l) => { const n = l - dt; if (n <= 0) setOpen(false); return Math.max(0, n) })
    }, 100)
    return () => window.clearInterval(id)
  }, [open])
  if (!open) return null
  const hold = (v: boolean) => () => { held.current = v }
  return (
    <div className="ann-pop-wrap" onPointerDown={hold(true)} onPointerUp={hold(false)} onPointerCancel={hold(false)} onPointerLeave={hold(false)}>
      <div className="ann-pop" role="dialog" aria-modal="true" aria-labelledby="ann-pop-title">
        <div className="ann-pop-ico" aria-hidden="true"><Icon name="info" size={24} /></div>
        <h2 id="ann-pop-title">{t('annTitle')}</h2>
        <p>{note}</p>
        <button type="button" className="btn btn-primary ann-pop-ok" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)}>{t('annOk')}</button>
        <div className="ann-pop-bar" aria-hidden="true"><i style={{ width: `${(left / total) * 100}%` }} /></div>
        <div className="small muted ann-pop-hint">{t('annHold')} · {Math.ceil(left / 1000)}s</div>
      </div>
    </div>
  )
}
