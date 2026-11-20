import { ReactElement, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { OrderStatus, supabase } from '../lib/supabase'
import { rupees } from '../lib/pricing'
import { Key, useI18n } from '../lib/i18n'
import { ShopBrand, TopBar } from '../components/TopBar'
import { brandStyle } from '../lib/brand'
import { ding, unlockAudio } from '../lib/sound'
import { notifyWhenReady, webPushSupported } from '../lib/webpush'
import { appNotifyAllowed, appNotifyWhenReady, appPushSupported, appReadyOptedIn } from '../lib/push'
import Icon from '../components/Icon'
import hourglass from '../assets/hourglass.svg'
import readyAnim from '../assets/ready-collect.svg'
import doneAnim from '../assets/order-done-thank-you.svg'

type Info = {
  token: number; status: OrderStatus; total: number; created_at: string; shop_name: string; upi_id: string | null; file_count: number
  /** v17 */
  files_deleted?: boolean; files_expire_at?: string | null; is_plus?: boolean; logo_url?: string | null; brand_color?: string | null
}

const READY_KEY = 'pq-ready-push'
function pushAsked(id: string): boolean {
  try { return (JSON.parse(localStorage.getItem(READY_KEY) || '[]') as string[]).includes(id) } catch { return false }
}
function markPushAsked(id: string) {
  try {
    const l = JSON.parse(localStorage.getItem(READY_KEY) || '[]') as string[]
    localStorage.setItem(READY_KEY, JSON.stringify([id, ...l.filter((x) => x !== id)].slice(0, 20)))
  } catch { /* ignore */ }
}

const LABEL: Record<OrderStatus, Key> = {
  uploading: 'st_uploading',
  received: 'st_received',
  printing: 'st_printing',
  ready: 'st_ready',
  done: 'st_done',
  cancelled: 'st_cancelled'
}

const STEPS: { s: OrderStatus; label: Key }[] = [
  { s: 'received', label: 'step_received' },
  { s: 'printing', label: 'step_printing' }
]

export default function Status() {
  const { id = '', key = '' } = useParams()
  const { t, tn, te, lang } = useI18n()
  const [info, setInfo] = useState<Info | null>(null)
  // "Ready" alert (v17): web push when the page is closed, sound + vibration while it is open.
  const [push, setPush] = useState<'off' | 'asking' | 'on' | 'denied'>(() => (pushAsked(id) ? 'on' : 'off'))
  const lastStatus = useRef<OrderStatus | null>(null)
  useEffect(() => {
    if (!info) return
    const prev = lastStatus.current
    lastStatus.current = info.status
    if (prev && prev !== 'ready' && info.status === 'ready') {
      ding()
      try { navigator.vibrate?.([300, 120, 300, 120, 300]) } catch { /* ignore */ }
    }
  }, [info])
  // Permission already given on an earlier order: register this one quietly.
  // Inside the Android app (v18) the alert is a native FCM notification instead of web push.
  const inApp = appPushSupported()
  useEffect(() => {
    if (!info || push !== 'off') return
    if (!['uploading', 'received', 'printing'].includes(info.status)) return
    if (inApp) {
      if (!appReadyOptedIn() || !appNotifyAllowed()) return
      void appNotifyWhenReady(id, key, false).then((r) => { if (r === 'on') { markPushAsked(id); setPush('on') } })
      return
    }
    if (!webPushSupported() || Notification.permission !== 'granted') return
    void notifyWhenReady(id, key, false).then((ok) => { if (ok) { markPushAsked(id); setPush('on') } })
  }, [info, push, id, key, inApp])
  async function askPush() {
    unlockAudio()
    setPush('asking')
    if (inApp) {
      const r = await appNotifyWhenReady(id, key, true)
      if (r === 'on') markPushAsked(id)
      setPush(r)
      return
    }
    const ok = await notifyWhenReady(id, key, true)
    if (ok) markPushAsked(id)
    setPush(ok ? 'on' : Notification.permission === 'denied' ? 'denied' : 'off')
  }
  const [err, setErr] = useState<{ text?: string; notFound?: boolean } | null>(null)

  useEffect(() => {
    let stop = false
    async function load() {
      const { data, error } = await supabase.rpc('get_order_status', { p_order_id: id, p_key: key })
      if (stop) return
      if (error) return setErr({ text: te(error) })
      const row = (data as Info[] | null)?.[0]
      if (!row) return setErr({ notFound: true })
      setErr(null)
      setInfo(row)
    }
    void load()
    const timer = setInterval(load, 5000)
    return () => {
      stop = true
      clearInterval(timer)
    }
    // te changes with language; the poll does not need to restart for that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, key])

  const own = info?.is_plus ? brandStyle(info.brand_color) : undefined
  const shell = (body: ReactElement) => (
    <div className={`app-page${own ? ' branded' : ''}`} style={own} onClick={unlockAudio}>
      <TopBar to={null} brand={info?.is_plus ? <ShopBrand name={info.shop_name} logo={info.logo_url} /> : undefined} />
      <main className="page narrow">{body}</main>
    </div>
  )

  if (err && !info) {
    return shell(
      <div className="card state-card">
        <span className="state-icon is-error" aria-hidden="true"><Icon name={err.notFound ? 'file' : 'wifi'} size={28} /></span>
        <p className="state-title">{err.notFound ? t('sNotFound') : err.text}</p>
      </div>
    )
  }
  if (!info) {
    return shell(
      <div className="skeleton-wrap" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <div className="card skel-card ticket-skel"><div className="skel skel-line w40" /><div className="skel skel-token" /><div className="skel skel-line w60" /></div>
      </div>
    )
  }

  const isReady = info.status === 'ready' || info.status === 'done'
  const stepIdx = isReady ? -1 : STEPS.findIndex((x) => x.s === info.status)
  const upiLink = info.upi_id
    ? `upi://pay?pa=${encodeURIComponent(info.upi_id)}&pn=${encodeURIComponent(info.shop_name)}&am=${Number(info.total).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Print token ' + info.token)}`
    : null

  const waiting = ['uploading', 'received', 'printing'].includes(info.status)
  const canPush = waiting && (inApp || webPushSupported())
  const expires = info.files_expire_at ? new Date(info.files_expire_at) : null
  const sameDay = expires && expires.toDateString() === new Date().toDateString()
  const expText = expires
    ? expires.toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', sameDay ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : ''

  return shell(
    <>
      <div className={`card token-card s-${info.status}`}>
        <div className="ticket-band">
          <span className="ticket-shop">{info.shop_name}</span>
          {!['done', 'cancelled'].includes(info.status) && (
            <span className="live-chip"><span className="live-dot" aria-hidden="true" />{t('sLive')}</span>
          )}
        </div>
        <p className="token-label">{t('sYourToken')}</p>
        <div className="token" aria-live="polite">#{info.token}</div>
        <span className={`pill status-pill s-${info.status}`} role="status">{t(LABEL[info.status])}</span>
        {isReady && <img className="ready-anim" src={info.status === 'done' ? doneAnim : readyAnim} alt="" />}
        {stepIdx >= 0 && (
          <ol className="tracker">
            {STEPS.map((x, i) => (
              <li key={x.s} className={i < stepIdx ? 'done' : i === stepIdx ? 'current' : ''}>
                <span className="dot">{i < stepIdx ? <Icon name="check" size={16} stroke={3} /> : i === stepIdx ? <img className="dot-wait" src={hourglass} alt="" /> : i + 1}</span>
                <span className="lbl">{t(x.label)}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="ticket-cut" aria-hidden="true" />
        <div className="ticket-foot">
          <span className="ticket-files"><Icon name="file" size={18} /> {tn('files_one', 'files_other', Number(info.file_count))}</span>
          <span className="ticket-total"><span className="muted">{t('total')}</span> <strong className="amount">{rupees(Number(info.total))}</strong></span>
        </div>
        {upiLink && info.status !== 'cancelled' && (
          <a className="btn primary block lg pay-btn" href={upiLink}><Icon name="rupee" size={20} /> {t('sPay', { amount: rupees(Number(info.total)) })}</a>
        )}
      </div>
      {canPush && push !== 'on' && (
        <button type="button" className="btn block notify-btn" disabled={push === 'asking' || push === 'denied'} onClick={() => void askPush()}>
          <Icon name="bell" size={18} /> {push === 'denied' ? t(inApp ? 'sNotifyBlockedApp' : 'sNotifyBlocked') : push === 'asking' ? t('pleaseWait') : t('sNotifyMe')}
        </button>
      )}
      {waiting && push === 'on' && <p className="hint-line"><Icon name="bell" size={18} /> <span>{t('sNotifyOn')}</span></p>}
      <p className="hint-line"><Icon name="clock" size={18} /> <span>{t('sHint')}</span></p>
      {info.files_deleted
        ? <p className="hint-line"><Icon name="shield" size={18} /> <span>{t('sFilesDeleted')}</span></p>
        : expText && <p className="hint-line"><Icon name="shield" size={18} /> <span>{t('sFilesExpire', { time: expText })}</span></p>}
    </>
  )
}
