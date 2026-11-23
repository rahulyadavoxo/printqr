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
          <svg className="ann-pop-ico" aria-hidden="true" viewBox="0 0 150 132" fill="currentColor">
            <path fillRule="evenodd" d="M74.1 128.0C73.7 127.8 72.9 127.2 72.1 126.3C71.4 125.5 69.3 123.2 67.5 121.1C65.6 119.1 63.0 116.1 61.7 114.6C60.1 112.9 58.9 111.8 58.4 111.6C57.8 111.4 52.4 111.3 37.1 111.3C17.3 111.3 16.5 111.2 14.6 110.7C10.0 109.5 6.8 106.8 4.9 102.4L4.1 100.6L4.1 78.5C4.0 56.4 4.0 56.3 4.5 55.7C5.1 54.9 6.5 54.6 7.4 55.0C8.9 55.6 8.9 54.4 9.0 78.0L9.1 99.6L9.9 101.2C10.9 103.1 12.8 104.8 14.8 105.5L16.4 106.1L38.5 106.2C57.6 106.4 60.7 106.4 61.1 106.8C61.4 107.0 62.7 108.2 63.9 109.6C65.1 111.0 66.9 113.0 67.9 114.0C68.9 115.0 70.4 116.7 71.3 117.8C74.1 120.9 74.7 121.5 75.0 121.5C75.2 121.5 76.7 120.1 78.3 118.3C84.2 111.6 85.2 110.6 86.7 108.9C87.6 107.9 88.6 107.0 88.9 106.8C89.3 106.4 92.4 106.4 111.5 106.2L133.6 106.1L135.2 105.5C138.2 104.4 140.6 101.5 140.9 98.3C141.2 95.8 142.3 94.8 144.1 95.1C146.1 95.5 146.5 97.8 145.4 101.4C143.9 106.2 140.4 109.4 135.3 110.7C133.5 111.2 132.7 111.3 112.9 111.3C97.8 111.3 92.2 111.4 91.6 111.6C91.1 111.8 89.9 112.9 88.4 114.6C81.3 122.7 77.1 127.3 76.6 127.6C75.9 128.1 75.0 128.2 74.1 128.0ZM37.8 98.8C36.9 98.6 36.0 97.0 35.6 94.7C35.4 93.5 35.1 92.3 35.0 91.9C34.9 91.6 34.6 90.2 34.4 89.0C34.2 87.8 33.9 86.5 33.7 86.1C33.6 85.8 33.3 84.4 33.1 83.2C32.9 81.9 32.6 80.5 32.5 80.1C32.4 79.8 32.1 78.7 32.0 77.7C31.8 76.7 31.5 75.3 31.3 74.5C31.1 73.8 30.8 72.3 30.6 71.3C30.1 68.3 29.3 68.5 41.8 68.5C51.6 68.5 52.5 68.5 53.0 68.9C53.5 69.4 54.7 73.9 54.7 75.2C54.7 75.5 55.0 76.9 55.3 78.3C55.7 79.7 56.1 81.5 56.2 82.4C56.6 84.9 57.2 88.0 57.9 91.0C58.3 92.6 58.6 94.7 58.6 95.7C58.6 97.3 58.6 97.5 57.9 98.2L57.2 98.9L47.8 98.9C42.6 98.9 38.1 98.9 37.8 98.8ZM102.9 79.7C101.5 78.6 100.3 77.6 97.9 75.8C97.5 75.5 96.3 74.8 95.4 74.2C94.4 73.7 93.0 72.8 92.2 72.4C91.5 71.9 90.6 71.4 90.2 71.3C89.9 71.1 89.5 70.9 89.2 70.7C88.9 70.5 88.4 70.3 85.9 69.1C82.0 67.4 79.2 66.4 77.7 66.0C77.1 65.9 76.3 65.6 75.9 65.5C73.8 64.7 67.7 63.7 63.9 63.6C60.2 63.4 59.9 63.4 59.6 62.9C59.3 62.4 59.3 59.5 59.3 43.0C59.4 25.1 59.4 23.7 59.8 23.4C60.1 23.2 61.6 23.0 63.9 22.9C66.0 22.8 68.3 22.6 69.1 22.4C70.0 22.2 71.2 22.0 72.0 21.9C73.9 21.7 80.2 19.7 83.2 18.5C91.0 15.2 97.9 11.0 103.3 6.3C104.7 5.1 106.8 5.2 107.6 6.6C107.8 7.0 107.9 10.9 108.0 23.7C108.1 38.1 108.2 40.3 108.5 40.5C108.7 40.6 109.4 40.8 110.1 40.9C111.2 41.1 111.4 41.2 111.9 42.0C112.8 43.9 111.6 45.7 109.4 45.8C108.9 45.8 108.4 45.9 108.3 46.1C108.1 46.3 108.0 51.4 107.9 62.9L107.9 79.5L107.1 80.2C106.0 81.5 104.8 81.3 102.9 79.7ZM122.1 67.5C121.1 66.9 119.0 64.9 117.7 63.4C116.2 61.6 116.1 60.4 117.2 59.2C118.6 57.8 119.6 58.2 122.8 61.4C125.2 63.8 125.8 64.6 125.8 65.6C125.8 67.1 123.5 68.2 122.1 67.5ZM27.4 63.1C25.6 62.6 24.2 61.7 23.0 60.5C21.9 59.4 21.5 58.5 20.4 55.5C20.0 54.4 19.8 54.3 18.2 53.4C15.2 51.9 13.7 50.2 12.4 47.2C10.4 42.1 12.9 35.5 17.6 33.3C19.8 32.3 20.4 31.6 20.6 30.5C21.0 28.1 23.1 25.3 25.6 24.0L27.1 23.1L40.2 23.1C53.0 23.0 53.2 23.0 53.7 23.5C54.2 24.0 54.2 24.2 54.2 43.4L54.2 62.7L53.7 63.1C52.9 63.6 29.0 63.7 27.4 63.1ZM4.8 31.1L4.1 30.5L4.1 22.6L4.1 14.6L4.8 13.0C6.4 9.4 8.7 6.9 12.2 5.2L14.4 4.1L50.5 4.1L86.5 4.1L87.1 4.8C88.2 6.0 87.8 7.8 86.4 8.6C86.0 8.8 78.3 8.9 50.8 9.0L15.6 9.1L14.2 9.8C12.4 10.7 10.7 12.4 9.8 14.2C9.1 15.6 9.1 15.6 9.0 22.9L8.9 30.2L8.1 31.0C7.2 32.0 5.9 32.0 4.8 31.1ZM117.7 27.6C116.9 27.2 116.4 26.0 116.6 24.8C116.8 23.7 120.4 19.9 122.1 19.0L123.2 18.4L124.2 18.9C124.7 19.2 125.3 19.7 125.5 20.1C126.1 21.4 125.5 22.4 122.8 25.1C119.7 28.0 119.1 28.4 117.7 27.6Z" />
          </svg>
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
