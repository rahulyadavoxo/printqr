import { ReactElement, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { OrderStatus, supabase } from '../lib/supabase'
import { rupees } from '../lib/pricing'
import { Key, useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'

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

  if (err && !info) return shell(<div className="card center"><p>{err.notFound ? t('sNotFound') : err.text}</p></div>)
  if (!info) return shell(<p className="muted center loading">{t('loading')}</p>)

  const stepIdx = STEPS.findIndex((x) => x.s === (info.status === 'done' ? 'ready' : info.status))
  const upiLink = info.upi_id
    ? `upi://pay?pa=${encodeURIComponent(info.upi_id)}&pn=${encodeURIComponent(info.shop_name)}&am=${Number(info.total).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Print token ' + info.token)}`
    : null

  return shell(
    <>
      <div className={`card token-card s-${info.status}`}>
        <p className="token-shop">{info.shop_name}</p>
        <p className="muted small upper">{t('sYourToken')}</p>
        <div className="token">#{info.token}</div>
        <span className={`pill s-${info.status}`}>{t(LABEL[info.status])}</span>
        {stepIdx >= 0 && (
          <ol className="tracker">
            {STEPS.map((x, i) => (
              <li key={x.s} className={i < stepIdx ? 'done' : i === stepIdx ? 'current' : ''}>
                <span className="dot">{i < stepIdx || info.status === 'done' ? '✓' : i + 1}</span>
                <span className="lbl">{t(x.label)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="card summary">
        <div className="row between">
          <span className="muted">{tn('files_one', 'files_other', Number(info.file_count))}</span>
          <span>{t('total')} <strong className="amount">{rupees(Number(info.total))}</strong></span>
        </div>
        {upiLink && info.status !== 'cancelled' && (
          <a className="btn primary block lg" href={upiLink}>{t('sPay', { amount: rupees(Number(info.total)) })}</a>
        )}
      </div>
      <p className="small muted center">{t('sHint')}</p>
    </>
  )
}
