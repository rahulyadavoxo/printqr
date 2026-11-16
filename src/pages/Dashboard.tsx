import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { errMsg, Order, OrderStatus, Rates, Shop, shopUrl, supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { rupees } from '../lib/pricing'
import { ding, unlockAudio } from '../lib/sound'

type Tab = 'orders' | 'rates' | 'qr' | 'report' | 'settings'
const TABS: { id: Tab; label: string }[] = [
  { id: 'orders', label: 'Orders' },
  { id: 'rates', label: 'Rate' },
  { id: 'qr', label: 'QR' },
  { id: 'report', label: 'Hisaab' },
  { id: 'settings', label: 'Settings' }
]

export default function Dashboard() {
  const { session, loading } = useSession()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'orders'
  const [shop, setShop] = useState<Shop | null>(null)

  const loadShop = useCallback(async () => {
    if (!session) return
    const { data } = await supabase.from('shops').select('*').eq('owner_id', session.user.id).maybeSingle()
    if (!data) nav('/setup', { replace: true })
    else setShop(data as Shop)
  }, [session, nav])

  useEffect(() => {
    if (loading) return
    if (!session) nav('/login', { replace: true })
    else void loadShop()
  }, [session, loading, nav, loadShop])

  async function toggleOpen() {
    if (!shop) return
    const { data, error } = await supabase.from('shops').update({ is_open: !shop.is_open }).eq('id', shop.id).select().single()
    if (!error && data) setShop(data as Shop)
  }

  if (!shop) return <div className="page"><p className="muted center">Loading...</p></div>

  return (
    <div className="page dash" onClick={unlockAudio}>
      <header className="dash-head no-print">
        <div>
          <div className="logo">PrintQR</div>
          <strong>{shop.name}</strong>
        </div>
        <button className={`btn small ${shop.is_open ? 'open' : 'closed'}`} onClick={toggleOpen}>
          {shop.is_open ? '● Shop khuli' : '○ Shop band'}
        </button>
      </header>
      <nav className="tabs no-print">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'on' : ''} onClick={() => setParams({ tab: t.id })}>{t.label}</button>
        ))}
      </nav>
      {tab === 'orders' && <Orders shop={shop} />}
      {tab === 'rates' && <RatesTab shop={shop} onSaved={setShop} />}
      {tab === 'qr' && <QrTab shop={shop} />}
      {tab === 'report' && <Report shop={shop} />}
      {tab === 'settings' && <Settings shop={shop} onSaved={setShop} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }>> = {
  received: { to: 'printing', label: 'Print shuru' },
  printing: { to: 'ready', label: 'Ready hai' },
  ready: { to: 'done', label: 'De diya (Done)' }
}

const STATUS_TEXT: Record<OrderStatus, string> = {
  uploading: 'Upload ho raha',
  received: 'Naya',
  printing: 'Printing',
  ready: 'Ready',
  done: 'Done',
  cancelled: 'Cancel'
}

function timeText(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

function Orders({ shop }: { shop: Shop }) {
  const [orders, setOrders] = useState<Order[]>([])
  const [showDone, setShowDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const known = useRef<Set<string> | null>(null)

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString()
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_files(*)')
      .eq('shop_id', shop.id)
      .neq('status', 'uploading')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
    if (error) return setErr(errMsg(error))
    const list = (data || []) as Order[]
    const ids = new Set(list.map((o) => o.id))
    if (known.current) {
      const fresh = list.filter((o) => o.status === 'received' && !known.current!.has(o.id))
      if (fresh.length) {
        ding()
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
          new Notification(`Naya order #${fresh[0].token}`, { body: `${fresh[0].customer_name || 'Customer'} · ${rupees(Number(fresh[0].total))}` })
        }
      }
    }
    known.current = ids
    setOrders(list)
    setErr(null)
  }, [shop.id])

  useEffect(() => {
    void load()
    const ch = supabase
      .channel('orders-' + shop.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `shop_id=eq.${shop.id}` }, () => void load())
      .subscribe()
    const t = setInterval(load, 30000) // safety net if realtime drops
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    return () => {
      clearInterval(t)
      void supabase.removeChannel(ch)
    }
  }, [shop.id, load])

  async function setStatus(o: Order, status: OrderStatus) {
    setOrders((l) => l.map((x) => (x.id === o.id ? { ...x, status } : x)))
    const { error } = await supabase.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('id', o.id)
    if (error) {
      setErr(errMsg(error))
      void load()
    }
  }

  async function openFile(path: string) {
    const w = window.open('', '_blank')
    const { data, error } = await supabase.storage.from('uploads').createSignedUrl(path, 600)
    if (error || !data) {
      w?.close()
      return setErr(error ? errMsg(error) : 'File nahi khuli')
    }
    if (w) w.location.href = data.signedUrl
    else window.location.href = data.signedUrl
  }

  async function downloadFile(path: string, name: string) {
    const { data, error } = await supabase.storage.from('uploads').download(path)
    if (error || !data) return setErr(error ? errMsg(error) : 'Download nahi hua')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(data)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  async function deleteFiles(o: Order) {
    if (!confirm(`Token #${o.token} ki files abhi delete karein?`)) return
    const paths = (o.order_files || []).map((f) => f.storage_path)
    const { error } = await supabase.storage.from('uploads').remove(paths)
    if (error) return setErr(errMsg(error))
    await supabase.from('orders').update({ files_deleted: true }).eq('id', o.id)
    void load()
  }

  const active = orders.filter((o) => ['received', 'printing', 'ready'].includes(o.status))
  const finished = orders.filter((o) => ['done', 'cancelled'].includes(o.status))

  return (
    <section>
      {err && <p className="notice error">{err}</p>}
      {!active.length && <div className="card center muted">Abhi koi naya order nahi. Naya order aate hi yahan dikhega aur ding bajega.</div>}
      {active.map((o) => (
        <OrderCard key={o.id} o={o} onStatus={setStatus} onOpen={openFile} onDownload={downloadFile} onDelete={deleteFiles} />
      ))}
      {finished.length > 0 && (
        <button className="link block" onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Purane chhupao' : `Done / cancel orders (${finished.length})`}
        </button>
      )}
      {showDone && finished.map((o) => (
        <OrderCard key={o.id} o={o} onStatus={setStatus} onOpen={openFile} onDownload={downloadFile} onDelete={deleteFiles} />
      ))}
    </section>
  )
}

function OrderCard(props: {
  o: Order
  onStatus: (o: Order, s: OrderStatus) => void
  onOpen: (path: string) => void
  onDownload: (path: string, name: string) => void
  onDelete: (o: Order) => void
}) {
  const { o, onStatus, onOpen, onDownload, onDelete } = props
  const next = NEXT[o.status]
  return (
    <div className={`card order s-${o.status}`}>
      <div className="row between">
        <div className="row gap">
          <span className="token sm">#{o.token}</span>
          <div>
            <strong>{o.customer_name || 'Customer'}</strong>
            <div className="small muted">{timeText(o.created_at)} · {STATUS_TEXT[o.status]}</div>
          </div>
        </div>
        <strong className="amt">{rupees(Number(o.total))}</strong>
      </div>
      {o.note && <p className="note">📝 {o.note}</p>}
      <ul className="files">
        {(o.order_files || []).map((f) => (
          <li key={f.id}>
            <div className="fname">{f.file_name}</div>
            <div className="small muted">
              {f.color ? 'Color' : 'B/W'} · {f.duplex ? 'Dono side' : 'Ek side'} · {f.pages_to_print} page
              {f.page_range ? ` (${f.page_range})` : ''} × {f.copies} copy · {rupees(Number(f.price))}
            </div>
            {!o.files_deleted && (
              <div className="row gap">
                <button className="btn small" onClick={() => onOpen(f.storage_path)}>Kholo / Print</button>
                <button className="btn small" onClick={() => onDownload(f.storage_path, f.file_name)}>Download</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {o.files_deleted && <p className="small muted">Files delete ho chuki hain.</p>}
      <div className="row gap wrap">
        {next && <button className="btn primary" onClick={() => onStatus(o, next.to)}>{next.label}</button>}
        {['received', 'printing', 'ready'].includes(o.status) && (
          <button className="btn danger-outline" onClick={() => confirm('Order cancel karein?') && onStatus(o, 'cancelled')}>Cancel</button>
        )}
        {['done', 'cancelled'].includes(o.status) && !o.files_deleted && (
          <button className="btn" onClick={() => onDelete(o)}>Files abhi delete karo</button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RatesTab({ shop, onSaved }: { shop: Shop; onSaved: (s: Shop) => void }) {
  const [r, setR] = useState<Rates>(shop.rates)
  const [msg, setMsg] = useState<string | null>(null)
  const fields: { k: keyof Rates; label: string }[] = [
    { k: 'bw_single', label: 'B/W, ek side (per page)' },
    { k: 'bw_double', label: 'B/W, dono side (per page)' },
    { k: 'color_single', label: 'Color, ek side (per page)' },
    { k: 'color_double', label: 'Color, dono side (per page)' }
  ]
  async function save(e: FormEvent) {
    e.preventDefault()
    const clean: Rates = {
      bw_single: Math.max(0, Number(r.bw_single) || 0),
      bw_double: Math.max(0, Number(r.bw_double) || 0),
      color_single: Math.max(0, Number(r.color_single) || 0),
      color_double: Math.max(0, Number(r.color_double) || 0)
    }
    const { data, error } = await supabase.from('shops').update({ rates: clean }).eq('id', shop.id).select().single()
    if (error) return setMsg(errMsg(error))
    onSaved(data as Shop)
    setMsg('Rate save ho gaya ✓')
  }
  return (
    <form className="card" onSubmit={save}>
      <h3>Print rate (A4)</h3>
      <p className="small muted">Customer ko upload karte waqt isi rate se total dikhega.</p>
      {fields.map((f) => (
        <label key={f.k}>
          {f.label} ₹
          <input type="number" step="0.5" min={0} value={r[f.k]} onChange={(e) => setR({ ...r, [f.k]: e.target.value as unknown as number })} />
        </label>
      ))}
      {msg && <p className="notice">{msg}</p>}
      <button className="btn primary block">Save</button>
    </form>
  )
}

/* ------------------------------------------------------------------ */

function QrTab({ shop }: { shop: Shop }) {
  const url = shopUrl(shop.slug)
  const [img, setImg] = useState('')
  useEffect(() => {
    QRCode.toDataURL(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' }).then(setImg)
  }, [url])
  return (
    <section>
      <div className="row gap no-print">
        <button className="btn primary" onClick={() => window.print()}>Poster print karo</button>
        {img && <a className="btn" href={img} download={`${shop.slug}-qr.png`}>QR download</a>}
        <button className="btn" onClick={() => navigator.clipboard?.writeText(url)}>Link copy</button>
      </div>
      <div className="poster">
        <div className="poster-top">{shop.name}</div>
        <h2>Print karana hai?</h2>
        <p className="poster-sub">QR scan karo, file bhejo. WhatsApp number save karne ki zaroorat nahi.</p>
        {img && <img src={img} alt="Shop QR code" />}
        <div className="poster-rates">
          B/W {rupees(shop.rates.bw_single)}/page · Color {rupees(shop.rates.color_single)}/page
        </div>
        <ol className="poster-steps">
          <li>Phone ke camera se QR scan karo</li>
          <li>PDF ya photo chuno, total wahin dikhega</li>
          <li>Token number counter pe batao</li>
        </ol>
        {shop.phone && <div className="small">📞 {shop.phone}</div>}
        <div className="poster-url">{url}</div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function Report({ shop }: { shop: Shop }) {
  const [rows, setRows] = useState<{ status: OrderStatus; total: number; created_at: string }[]>([])
  useEffect(() => {
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
    supabase
      .from('orders')
      .select('status,total,created_at')
      .eq('shop_id', shop.id)
      .in('status', ['received', 'printing', 'ready', 'done'])
      .gte('created_at', since)
      .then(({ data }) => setRows((data || []) as typeof rows))
  }, [shop.id])

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const sum = (from: number) => {
    const list = rows.filter((r) => new Date(r.created_at).getTime() >= from)
    return { count: list.length, total: list.reduce((s, r) => s + Number(r.total), 0) }
  }
  const today = sum(startOfDay.getTime())
  const week = sum(startOfDay.getTime() - 6 * 86400 * 1000)
  const month = sum(startOfDay.getTime() - 29 * 86400 * 1000)

  return (
    <section className="stats">
      {[
        { label: 'Aaj', v: today },
        { label: 'Pichhle 7 din', v: week },
        { label: 'Pichhle 30 din', v: month }
      ].map((s) => (
        <div className="card stat" key={s.label}>
          <div className="small muted">{s.label}</div>
          <div className="big-num">{rupees(s.v.total)}</div>
          <div className="small">{s.v.count} orders</div>
        </div>
      ))}
      <p className="small muted">Cancel kiye orders hisaab mein nahi gine jaate.</p>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function Settings({ shop, onSaved }: { shop: Shop; onSaved: (s: Shop) => void }) {
  const nav = useNavigate()
  const [f, setF] = useState({
    name: shop.name,
    address: shop.address || '',
    phone: shop.phone || '',
    upi_id: shop.upi_id || '',
    auto_delete_hours: shop.auto_delete_hours
  })
  const [msg, setMsg] = useState<string | null>(null)
  async function save(e: FormEvent) {
    e.preventDefault()
    const { data, error } = await supabase
      .from('shops')
      .update({
        name: f.name.trim(),
        address: f.address.trim() || null,
        phone: f.phone.trim() || null,
        upi_id: f.upi_id.trim() || null,
        auto_delete_hours: Number(f.auto_delete_hours)
      })
      .eq('id', shop.id)
      .select()
      .single()
    if (error) return setMsg(errMsg(error))
    onSaved(data as Shop)
    setMsg('Save ho gaya ✓')
  }
  async function logout() {
    await supabase.auth.signOut()
    nav('/', { replace: true })
  }
  return (
    <form className="card" onSubmit={save}>
      <h3>Shop settings</h3>
      <label>Shop ka naam<input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Address<input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      <label>Phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
      <label>UPI ID<input value={f.upi_id} onChange={(e) => setF({ ...f, upi_id: e.target.value })} placeholder="shopname@okaxis" /></label>
      <label>
        Files apne aap delete kab hon
        <select value={f.auto_delete_hours} onChange={(e) => setF({ ...f, auto_delete_hours: Number(e.target.value) })}>
          {[1, 3, 6, 12, 24, 48].map((h) => <option key={h} value={h}>{h} ghante baad</option>)}
        </select>
      </label>
      {msg && <p className="notice">{msg}</p>}
      <button className="btn primary block">Save</button>
      <button type="button" className="btn block" onClick={logout}>Logout</button>
    </form>
  )
}
