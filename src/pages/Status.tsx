import { ReactElement, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { DEFAULT_IDCARD_RATE, DEFAULT_PASSPORT_RATE, OrderStatus, Rates, supabase } from '../lib/supabase'
import { filePrice, rupees } from '../lib/pricing'
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

/** "Print again" (v23, public.reorder_info): the old order's files and the shop's rates today. */
type ReFile = {
  id: string; file_name: string; item_kind: 'print' | 'passport' | 'idcard'; pages: number; copies: number
  color: boolean; duplex: boolean; binding: boolean; lamination: boolean; photos: number | null; allowed: boolean
}
type ReInfo = { can: boolean; is_open: boolean; rates: Rates; files: ReFile[] }
type ReChoice = { on: boolean; copies: number; color: boolean }

/** Same rules as public.reorder(): extras only while the shop still has a rate for them. */
function rePrice(rates: Rates, f: ReFile, c: ReChoice): number {
  if (f.item_kind === 'passport') return f.pages * c.copies * Number(rates.passport_sheet ?? DEFAULT_PASSPORT_RATE)
  if (f.item_kind === 'idcard') return c.copies * Number(rates.idcard_sheet ?? DEFAULT_IDCARD_RATE)
  return filePrice(rates, f.pages, c.copies, c.color, f.duplex,
    f.binding && Number(rates.binding ?? 0) > 0, f.lamination && Number(rates.lamination ?? 0) > 0)
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

// A new order ("print again") opens a fresh page, so no state carries over from the old order.
export default function Status() {
  const { id = '', key = '' } = useParams()
  return <StatusPage key={id} id={id} orderKey={key} />
}

function StatusPage({ id, orderKey: key }: { id: string; orderKey: string }) {
  const { t, tn, te, lang } = useI18n()
  const nav = useNavigate()
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

  // "Print again" (v23): a new order with the same files, without uploading them again.
  const [re, setRe] = useState<ReInfo | null>(null)
  const [reOpen, setReOpen] = useState(false)
  const [reChoice, setReChoice] = useState<Record<string, ReChoice>>({})
  const [reBusy, setReBusy] = useState(false)
  const [reMsg, setReMsg] = useState<string | null>(null)
  const reEligible = !!info && !info.files_deleted && ['received', 'printing', 'ready', 'done'].includes(info.status)
  useEffect(() => {
    if (!reEligible) return
    let stop = false
    // Before the v23 database update this RPC does not exist: the button simply stays hidden.
    supabase.rpc('reorder_info', { p_order_id: id, p_key: key }).then(({ data, error }) => {
      if (stop || error || !data) return
      const r = data as ReInfo
      setRe(r)
      setReChoice(Object.fromEntries(r.files.map((f) => [f.id, { on: f.allowed, copies: f.copies, color: f.item_kind === 'passport' ? true : f.color }])))
    }, () => {})
    return () => { stop = true }
  }, [reEligible, id, key])

  async function sendAgain() {
    if (!re || !info) return
    const items = re.files.filter((f) => f.allowed && reChoice[f.id]?.on)
      .map((f) => ({ file_id: f.id, copies: reChoice[f.id].copies, color: reChoice[f.id].color }))
    if (!items.length) return setReMsg(t('reNone'))
    setReBusy(true)
    setReMsg(null)
    try {
      const { data, error } = await supabase.rpc('reorder', { p_order_id: id, p_key: key, p_items: items })
      if (error) throw error
      const order = (data as { order_id: string; access_key: string }[])[0]
      void supabase.rpc('set_order_lang', { p_order_id: order.order_id, p_key: order.access_key, p_lang: lang === 'hi' ? 'hi' : 'en' }).then(() => {}, () => {})
      // The server copies the stored files to the new order and sends it to the shop.
      const fin = await supabase.functions.invoke('reorder', { body: { order_id: order.order_id, key: order.access_key } })
      if (fin.error) {
        const ctx = (fin.error as { context?: Response }).context
        let body: { message?: string } | undefined
        try { body = (await ctx?.json()) as { message?: string } } catch { /* none */ }
        throw new Error(body?.message || t('uFinalizeFail'))
      }
      const saved = JSON.parse(localStorage.getItem('pq_orders') || '[]') as unknown[]
      localStorage.setItem('pq_orders', JSON.stringify([{ id: order.order_id, key: order.access_key, shop: info.shop_name, at: Date.now() }, ...saved].slice(0, 10)))
      nav(`/o/${order.order_id}/${order.access_key}`)
    } catch (e) {
      setReMsg(te(e))
    } finally {
      setReBusy(false)
    }
  }

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
      {reEligible && re?.can && !reOpen && (
        <button type="button" className="btn block lg" onClick={() => setReOpen(true)}>
          <Icon name="printer" size={19} /> {t('reButton')}
        </button>
      )}
      {reEligible && re?.can && reOpen && (() => {
        const total = re.files.reduce((n, f) => n + (f.allowed && reChoice[f.id]?.on ? rePrice(re.rates, f, reChoice[f.id]) : 0), 0)
        const set = (fid: string, p: Partial<ReChoice>) => setReChoice((c) => ({ ...c, [fid]: { ...c[fid], ...p } }))
        return (
          <div className="card form-card reorder-card">
            <h2 className="card-title">{t('reTitle')}</h2>
            <p className="small muted">{t('reSub')}</p>
            {re.files.map((f) => {
              const c = reChoice[f.id]
              if (!c) return null
              const off = !f.allowed || !c.on
              return (
                <div key={f.id} className={`re-file${off ? ' is-off' : ''}`}>
                  <label className="re-name">
                    <input type="checkbox" checked={c.on && f.allowed} disabled={!f.allowed || reBusy} onChange={(e) => set(f.id, { on: e.target.checked })} aria-label={t('reInclude')} />
                    <strong>{f.item_kind === 'passport' ? t('ppSheetLabel') : f.item_kind === 'idcard' ? t('idSheetLabel') : f.file_name}</strong>
                  </label>
                  {!f.allowed ? <span className="small muted">🔒 {t('reLocked')}</span> : (
                    <div className="re-opts">
                      <span className="small muted">
                        {f.item_kind === 'passport' ? t('ppCalc', { n: f.photos ?? '?', s: f.pages })
                          : f.item_kind === 'idcard' ? t('idSub')
                          : `${tn('uPages_one', 'uPages_other', f.pages)} · ${f.duplex ? t('bothSides') : t('oneSide')}`}
                      </span>
                      <div className="field">
                        <span>{t('uCopies')}</span>
                        <div className="stepper">
                          <button type="button" aria-label={`${t('uCopies')} −`} disabled={off || reBusy || c.copies <= 1} onClick={() => set(f.id, { copies: Math.max(1, c.copies - 1) })}>−</button>
                          <input type="number" min={1} max={100} value={c.copies} aria-label={t('uCopies')} disabled={off || reBusy}
                            onChange={(e) => set(f.id, { copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
                          <button type="button" aria-label={`${t('uCopies')} +`} disabled={off || reBusy || c.copies >= 100} onClick={() => set(f.id, { copies: Math.min(100, c.copies + 1) })}>+</button>
                        </div>
                      </div>
                      {f.item_kind !== 'passport' && (
                        <div className="seg" role="group" aria-label={t('optPrint')}>
                          <button type="button" className={!c.color ? 'on' : ''} aria-pressed={!c.color} disabled={off || reBusy} onClick={() => set(f.id, { color: false })}>
                            <span className="swatch sw-bw" aria-hidden="true" />{t('bw')}
                          </button>
                          <button type="button" className={c.color ? 'on' : ''} aria-pressed={c.color} disabled={off || reBusy} onClick={() => set(f.id, { color: true })}>
                            <span className="swatch sw-color" aria-hidden="true" />{t('color')}
                          </button>
                        </div>
                      )}
                      <div className="file-price"><span /><strong>{rupees(rePrice(re.rates, f, c))}</strong></div>
                    </div>
                  )}
                </div>
              )
            })}
            {reMsg && <p className="notice error" role="alert"><Icon name="alert" size={18} /> <span>{reMsg}</span></p>}
            <div className="file-price"><span className="muted">{t('total')}</span><strong>{rupees(total)}</strong></div>
            <button type="button" className="btn primary block lg" disabled={reBusy || !re.files.some((f) => f.allowed && reChoice[f.id]?.on)} onClick={() => void sendAgain()}>
              {reBusy ? <><span className="spinner" aria-hidden="true" />{t('pleaseWait')}</> : <>{t('reSend')} · {rupees(total)}</>}
            </button>
            <button type="button" className="btn ghost block" disabled={reBusy} onClick={() => { setReOpen(false); setReMsg(null) }}>{t('cancel')}</button>
          </div>
        )
      })()}
    </>
  )
}
