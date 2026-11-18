import { ReactElement, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { OrderStatus, supabase } from '../lib/supabase'
import { rupees } from '../lib/pricing'
import { Key, useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'
import Icon from '../components/Icon'

type Info = { token: number; status: OrderStatus; total: number; created_at: string; shop_name: string; upi_id: string | null; file_count: number }

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
  { s: 'printing', label: 'step_printing' },
  { s: 'ready', label: 'step_ready' }
]

export default function Status() {
  const { id = '', key = '' } = useParams()
  const { t, tn, te } = useI18n()
  const [info, setInfo] = useState<Info | null>(null)
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

  const shell = (body: ReactElement) => (
    <div className="app-page">
      <TopBar to={null} />
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

  const stepIdx = STEPS.findIndex((x) => x.s === (info.status === 'done' ? 'ready' : info.status))
  const upiLink = info.upi_id
    ? `upi://pay?pa=${encodeURIComponent(info.upi_id)}&pn=${encodeURIComponent(info.shop_name)}&am=${Number(info.total).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Print token ' + info.token)}`
    : null

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
        {stepIdx >= 0 && (
          <ol className="tracker">
            {STEPS.map((x, i) => (
              <li key={x.s} className={i < stepIdx || info.status === 'done' ? 'done' : i === stepIdx ? 'current' : ''}>
                <span className="dot">{i < stepIdx || info.status === 'done' ? <Icon name="check" size={16} stroke={3} /> : i + 1}</span>
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
      <p className="hint-line"><Icon name="clock" size={18} /> <span>{t('sHint')}</span></p>
    </>
  )
}
