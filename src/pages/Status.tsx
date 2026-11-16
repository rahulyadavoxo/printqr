import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { errMsg, OrderStatus, supabase } from '../lib/supabase'
import { rupees } from '../lib/pricing'

type Info = { token: number; status: OrderStatus; total: number; created_at: string; shop_name: string; upi_id: string | null; file_count: number }

const LABEL: Record<OrderStatus, string> = {
  uploading: 'Upload adhoora hai',
  received: 'Shop ko mil gaya, line mein hai',
  printing: 'Print ho raha hai',
  ready: 'Ready hai, counter se le lo',
  done: 'Ho gaya, dhanyavaad!',
  cancelled: 'Cancel ho gaya'
}

const STEPS: OrderStatus[] = ['received', 'printing', 'ready']

export default function Status() {
  const { id = '', key = '' } = useParams()
  const [info, setInfo] = useState<Info | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let stop = false
    async function load() {
      const { data, error } = await supabase.rpc('get_order_status', { p_order_id: id, p_key: key })
      if (stop) return
      if (error) return setErr(errMsg(error))
      const row = (data as Info[] | null)?.[0]
      if (!row) return setErr('Order nahi mila.')
      setInfo(row)
    }
    void load()
    const t = setInterval(load, 5000)
    return () => {
      stop = true
      clearInterval(t)
    }
  }, [id, key])

  if (err) return <div className="page narrow"><div className="card"><p>{err}</p></div></div>
  if (!info) return <div className="page narrow"><p className="muted center">Loading...</p></div>

  const stepIdx = STEPS.indexOf(info.status === 'done' ? 'ready' : info.status)
  const upiLink = info.upi_id
    ? `upi://pay?pa=${encodeURIComponent(info.upi_id)}&pn=${encodeURIComponent(info.shop_name)}&am=${Number(info.total).toFixed(2)}&cu=INR&tn=${encodeURIComponent('Print token ' + info.token)}`
    : null

  return (
    <div className="page narrow">
      <div className="card center">
        <p className="muted">{info.shop_name}</p>
        <p className="muted small">Aapka token</p>
        <div className="token">#{info.token}</div>
        <p className={`status-pill s-${info.status}`}>{LABEL[info.status]}</p>
        {stepIdx >= 0 && (
          <div className="progress">
            {STEPS.map((s, i) => <span key={s} className={i <= stepIdx ? 'on' : ''} />)}
          </div>
        )}
        <p>{info.file_count} file · Total <strong>{rupees(Number(info.total))}</strong></p>
        <p className="small muted">Counter pe apna token number batao. Ye page apne aap update hota hai.</p>
        {upiLink && info.status !== 'cancelled' && (
          <a className="btn primary block" href={upiLink}>UPI se {rupees(Number(info.total))} pay karo</a>
        )}
      </div>
    </div>
  )
}
