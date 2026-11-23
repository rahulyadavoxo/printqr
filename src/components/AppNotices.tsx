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
        <div className="ann-pop-bar" aria-hidden="true"><i style={{ width: `${(left / total) * 100}%` }} /></div>
        <div className="ann-pop-head">
          <div className="ann-pop-ico" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 10v4h3.5l6.5 4V6L7.5 10H4Z" /><path d="M7.2 14.5l1.1 4.2" /><path d="M17 9.5a3.5 3.5 0 0 1 0 5" /><path d="M19.5 7a7 7 0 0 1 0 10" />
            </svg>
          </div>
          <div className="ann-pop-who">
            <h2 id="ann-pop-title">{t('annTitle')}</h2>
            <span>{t('annNow')}</span>
          </div>
          <button type="button" className="ann-pop-x" aria-label={t('annClose')} onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M2 2l10 10M12 2L2 12" /></svg>
          </button>
        </div>
        <p>{note}</p>
        <button type="button" className="ann-pop-ok" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen(false)}>
          <span className="ann-pop-chk" aria-hidden="true">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.2l2.5 2.5 4.5-5" /></svg>
          </span>
          {t('annOk')}
        </button>
        <div className="ann-pop-hint"><span className="ann-pop-pause" aria-hidden="true"><i /><i /></span>{t('annHold')} · {Math.ceil(left / 1000)}s</div>
      </div>
    </div>
  )
}
