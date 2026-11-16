import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { Order, OrderStatus, Rates, Shop, shopUrl, supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { rupees } from '../lib/pricing'
import { ding, unlockAudio } from '../lib/sound'
import { Key, useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'

type Tab = 'orders' | 'rates' | 'qr' | 'report' | 'settings'
const TABS: { id: Tab; label: Key }[] = [
  { id: 'orders', label: 'tabOrders' },
  { id: 'rates', label: 'tabRates' },
  { id: 'qr', label: 'tabQr' },
  { id: 'report', label: 'tabReport' },
  { id: 'settings', label: 'tabSettings' }
]

export default function Dashboard() {
  const { session, loading } = useSession()
  const { t } = useI18n()
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

  async function logout() {
    await supabase.auth.signOut()
    nav('/', { replace: true })
  }

  if (!shop) {
    return (
      <div className="app-page">
        <TopBar to={null} wide />
        <p className="muted center loading">{t('loading')}</p>
      </div>
    )
  }

  return (
    <div className="app-page dash" onClick={unlockAudio}>
      <TopBar to={null} wide>
        <button type="button" className={`toggle ${shop.is_open ? 'is-open' : 'is-closed'}`} onClick={toggleOpen} aria-pressed={shop.is_open}>
          <span className="toggle-dot" />
          <span className="toggle-label">{shop.is_open ? t('shopOpen') : t('shopClosed')}</span>
        </button>
        <button type="button" className="btn ghost small hide-xs" onClick={logout}>{t('logout')}</button>
      </TopBar>

      <div className="page wide">
        <div className="dash-head no-print">
          <h1>{shop.name}</h1>
          {shop.address && <p className="muted small">{shop.address}</p>}
        </div>
        <nav className="tabs no-print">
          {TABS.map((x) => (
            <button key={x.id} type="button" className={tab === x.id ? 'on' : ''} onClick={() => setParams({ tab: x.id })}>{t(x.label)}</button>
          ))}
        </nav>
        {tab === 'orders' && <Orders shop={shop} />}
        {tab === 'rates' && <RatesTab shop={shop} onSaved={setShop} />}
        {tab === 'qr' && <QrTab shop={shop} />}
        {tab === 'report' && <Report shop={shop} />}
        {tab === 'settings' && <Settings shop={shop} onSaved={setShop} onLogout={logout} />}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: Key }>> = {
  received: { to: 'printing', label: 'actStart' },
  printing: { to: 'ready', label: 'actReady' },
  ready: { to: 'done', label: 'actDone' }
}

const STATUS_TEXT: Record<OrderStatus, Key> = {
  uploading: 'dst_uploading',
  received: 'dst_received',
  printing: 'dst_printing',
  ready: 'dst_ready',
  done: 'dst_done',
  cancelled: 'dst_cancelled'
}

function timeText(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' })
}

function Orders({ shop }: { shop: Shop }) {
  const { t, te } = useI18n()
  const [orders, setOrders] = useState<Order[]>([])
  const [showDone, setShowDone] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const known = useRef<Set<string> | null>(null)
  // Keep the latest translators in refs so the realtime subscription does not restart on language change.
  const tRef = useRef(t)
  const teRef = useRef(te)
  tRef.current = t
  teRef.current = te

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString()
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_files(*)')
      .eq('shop_id', shop.id)
      .neq('status', 'uploading')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
    if (error) return setErr(teRef.current(error))
    const list = (data || []) as Order[]
    const ids = new Set(list.map((o) => o.id))
    if (known.current) {
      const fresh = list.filter((o) => o.status === 'received' && !known.current!.has(o.id))
      if (fresh.length) {
        ding()
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
          new Notification(tRef.current('newOrderNotif', { token: fresh[0].token }), {
            body: `${fresh[0].customer_name || tRef.current('customer')} · ${rupees(Number(fresh[0].total))}`
          })
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
    const timer = setInterval(load, 30000) // safety net if realtime drops
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    return () => {
      clearInterval(timer)
      void supabase.removeChannel(ch)
    }
  }, [shop.id, load])

  async function setStatus(o: Order, status: OrderStatus) {
    setOrders((l) => l.map((x) => (x.id === o.id ? { ...x, status } : x)))
    const { error } = await supabase.from('orders').update({ status, updated_at: new Date().toISOString() }).eq('id', o.id)
    if (error) {
      setErr(te(error))
      void load()
    }
  }

  async function openFile(path: string) {
    const w = window.open('', '_blank')
    const { data, error } = await supabase.storage.from('uploads').createSignedUrl(path, 600)
    if (error || !data) {
      w?.close()
      return setErr(error ? te(error) : t('fileOpenFail'))
    }
    if (w) w.location.href = data.signedUrl
    else window.location.href = data.signedUrl
  }

  async function downloadFile(path: string, name: string) {
    const { data, error } = await supabase.storage.from('uploads').download(path)
    if (error || !data) return setErr(error ? te(error) : t('downloadFail'))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(data)
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  }

  async function deleteFiles(o: Order) {
    if (!confirm(t('confirmDelete', { token: o.token }))) return
    const paths = (o.order_files || []).map((f) => f.storage_path)
    const { error } = await supabase.storage.from('uploads').remove(paths)
    if (error) return setErr(te(error))
    await supabase.from('orders').update({ files_deleted: true }).eq('id', o.id)
    void load()
  }

  const active = orders.filter((o) => ['received', 'printing', 'ready'].includes(o.status))
  const finished = orders.filter((o) => ['done', 'cancelled'].includes(o.status))

  return (
    <section>
      {err && <p className="notice error">{err}</p>}
      <div className="section-head">
        <h2>{t('dActive')}</h2>
        <span className="count-badge">{active.length}</span>
      </div>
      {!active.length && (
        <div className="card empty">
          <div className="empty-icon" aria-hidden="true">🔔</div>
          <strong>{t('noOrders')}</strong>
          <p className="muted small">{t('noOrdersSub')}</p>
        </div>
      )}
      <div className="orders-grid">
        {active.map((o) => (
          <OrderCard key={o.id} o={o} onStatus={setStatus} onOpen={openFile} onDownload={downloadFile} onDelete={deleteFiles} />
        ))}
      </div>
      {finished.length > 0 && (
        <button type="button" className="btn ghost block show-done" onClick={() => setShowDone(!showDone)}>
          {showDone ? t('hideFinished') : t('showFinished', { n: finished.length })}
        </button>
      )}
      {showDone && (
        <div className="orders-grid">
          {finished.map((o) => (
            <OrderCard key={o.id} o={o} onStatus={setStatus} onOpen={openFile} onDownload={downloadFile} onDelete={deleteFiles} />
          ))}
        </div>
      )}
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
  const { t } = useI18n()
  const next = NEXT[o.status]
  return (
    <div className={`card order s-${o.status}`}>
      <div className="order-top">
        <span className="token sm">#{o.token}</span>
        <div className="order-who">
          <strong>{o.customer_name || t('customer')}</strong>
          <div className="small muted">
            {timeText(o.created_at)} · <span className={`pill tiny s-${o.status}`}>{t(STATUS_TEXT[o.status])}</span>
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
              {f.color ? t('color') : t('bw')} · {f.duplex ? t('bothSides') : t('oneSide')} ·{' '}
              {t('calcLine', { p: f.pages_to_print, c: f.copies })}
              {f.page_range ? ` (${f.page_range})` : ''} · {rupees(Number(f.price))}
            </div>
            {!o.files_deleted && (
              <div className="file-actions">
                <button type="button" className="btn small soft" onClick={() => onOpen(f.storage_path)}>{t('openPrint')}</button>
                <button type="button" className="btn small" onClick={() => onDownload(f.storage_path, f.file_name)}>{t('download')}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {o.files_deleted && <p className="small muted">{t('filesDeleted')}</p>}
      <div className="order-actions">
        {next && <button type="button" className="btn primary" onClick={() => onStatus(o, next.to)}>{t(next.label)}</button>}
        {['received', 'printing', 'ready'].includes(o.status) && (
          <button type="button" className="btn danger-outline" onClick={() => confirm(t('confirmCancel')) && onStatus(o, 'cancelled')}>{t('cancel')}</button>
        )}
        {['done', 'cancelled'].includes(o.status) && !o.files_deleted && (
          <button type="button" className="btn" onClick={() => onDelete(o)}>{t('deleteNow')}</button>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RatesTab({ shop, onSaved }: { shop: Shop; onSaved: (s: Shop) => void }) {
  const { t, te } = useI18n()
  const [r, setR] = useState<Rates>(shop.rates)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const fields: { k: keyof Rates; label: Key }[] = [
    { k: 'bw_single', label: 'rate_bw_single' },
    { k: 'bw_double', label: 'rate_bw_double' },
    { k: 'color_single', label: 'rate_color_single' },
    { k: 'color_double', label: 'rate_color_double' }
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
    if (error) return setMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setMsg({ text: t('ratesSaved'), error: false })
  }
  return (
    <form className="card form-card" onSubmit={save}>
      <h2 className="card-title">{t('ratesTitle')}</h2>
      <p className="small muted">{t('ratesSub')}</p>
      <div className="rates-grid">
        {fields.map((f) => (
          <label className="field" key={f.k}>
            <span>{t(f.label)}</span>
            <div className="input-affix">
              <span className="affix">₹</span>
              <input type="number" step="0.5" min={0} value={r[f.k]} inputMode="decimal"
                onChange={(e) => setR({ ...r, [f.k]: e.target.value as unknown as number })} />
            </div>
            <small className="hint">{t('perPage')}</small>
          </label>
        ))}
      </div>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg">{t('save')}</button>
    </form>
  )
}

/* ------------------------------------------------------------------ */

function QrTab({ shop }: { shop: Shop }) {
  const { t } = useI18n()
  const url = shopUrl(shop.slug)
  const [img, setImg] = useState('')
  const [copied, setCopied] = useState(false)
  const [card, setCard] = useState('')
  useEffect(() => {
    QRCode.toDataURL(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' }).then(setImg)
  }, [url])
  // Downloadable PNG: shop name on top, QR in the middle, scan line + address below.
  useEffect(() => {
    if (!img) return
    const qr = new Image()
    qr.onload = () => {
      const W = 1000, H = 1350
      const c = document.createElement('canvas')
      c.width = W
      c.height = H
      const g = c.getContext('2d')
      if (!g) return
      const font = "'Inter', 'Noto Sans Devanagari', system-ui, sans-serif"
      g.fillStyle = '#ffffff'
      g.fillRect(0, 0, W, H)
      g.fillStyle = '#2348e0'
      g.fillRect(0, 0, W, 16)
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      // Shop name, shrink to fit
      let size = 76
      g.font = `800 ${size}px ${font}`
      while (g.measureText(shop.name).width > W - 100 && size > 36) {
        size -= 4
        g.font = `800 ${size}px ${font}`
      }
      g.fillStyle = '#0f172a'
      g.fillText(shop.name, W / 2, 120)
      if (shop.address) {
        g.font = `500 34px ${font}`
        g.fillStyle = '#64748b'
        g.fillText(shop.address, W / 2, 190, W - 120)
      }
      const q = 760
      const qx = (W - q) / 2, qy = 250
      g.strokeStyle = '#2348e0'
      g.lineWidth = 8
      g.strokeRect(qx - 24, qy - 24, q + 48, q + 48)
      g.drawImage(qr, qx, qy, q, q)
      g.fillStyle = '#2348e0'
      g.font = `800 50px ${font}`
      g.fillText(t('posterHeadline'), W / 2, qy + q + 100, W - 80)
      g.fillStyle = '#334155'
      g.font = `500 32px ${font}`
      g.fillText(t('posterSub'), W / 2, qy + q + 165, W - 80)
      if (shop.phone) {
        g.font = `600 32px ${font}`
        g.fillText('\u260E ' + shop.phone, W / 2, qy + q + 220)
      }
      g.fillStyle = '#94a3b8'
      g.font = `600 26px ${font}`
      g.fillText('PrintQR', W / 2, H - 40)
      setCard(c.toDataURL('image/png'))
    }
    qr.src = img
  }, [img, shop.name, shop.address, shop.phone, t])
  function copy() {
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <section>
      <div className="card no-print qr-actions">
        <p className="small muted">{t('qrHint')}</p>
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => window.print()}>{t('printPoster')}</button>
          {card && <a className="btn" href={card} download={`${shop.slug}-qr.png`}>{t('downloadQr')}</a>}
          <button type="button" className="btn" onClick={copy}>{copied ? t('linkCopied') : t('copyLink')}</button>
        </div>
      </div>
      <div className="poster">
        <div className="poster-brand"><LogoMark size={26} /> PrintQR</div>
        <div className="poster-top">{shop.name}</div>
        <h2>{t('posterHeadline')}</h2>
        <p className="poster-sub">{t('posterSub')}</p>
        <div className="poster-qr">{img && <img src={img} alt="Shop QR code" />}</div>
        <div className="poster-rates">
          <div><span>{t('bw')}</span><strong>{rupees(shop.rates.bw_single)}</strong><em>{t('perPageShort')}</em></div>
          <div><span>{t('color')}</span><strong>{rupees(shop.rates.color_single)}</strong><em>{t('perPageShort')}</em></div>
        </div>
        <ol className="poster-steps">
          <li><b>1</b><span>{t('posterStep1')}</span></li>
          <li><b>2</b><span>{t('posterStep2')}</span></li>
          <li><b>3</b><span>{t('posterStep3')}</span></li>
        </ol>
        {shop.phone && <div className="poster-phone">📞 {shop.phone}</div>}
        <div className="poster-url">{url}</div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function Report({ shop }: { shop: Shop }) {
  const { t, tn } = useI18n()
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

  const cards: { label: Key; v: { count: number; total: number }; accent?: boolean }[] = [
    { label: 'today', v: today, accent: true },
    { label: 'last7', v: week },
    { label: 'last30', v: month }
  ]

  return (
    <section>
      <div className="stats">
        {cards.map((s) => (
          <div className={`card stat${s.accent ? ' accent' : ''}`} key={s.label}>
            <div className="small stat-label">{t(s.label)}</div>
            <div className="big-num">{rupees(s.v.total)}</div>
            <div className="small stat-sub">{tn('orders_one', 'orders_other', s.v.count)}</div>
          </div>
        ))}
      </div>
      <p className="small muted">{t('reportNote')}</p>
    </section>
  )
}

/* ------------------------------------------------------------------ */

function Settings({ shop, onSaved, onLogout }: { shop: Shop; onSaved: (s: Shop) => void; onLogout: () => void }) {
  const { t, tn, te } = useI18n()
  const [f, setF] = useState({
    name: shop.name,
    address: shop.address || '',
    phone: shop.phone || '',
    upi_id: shop.upi_id || '',
    auto_delete_hours: shop.auto_delete_hours
  })
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
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
    if (error) return setMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setMsg({ text: t('saved'), error: false })
  }
  return (
    <form className="card form-card" onSubmit={save}>
      <h2 className="card-title">{t('settingsTitle')}</h2>
      <label className="field"><span>{t('shopName')}</span><input required minLength={2} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label className="field"><span>{t('address')}</span><input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></label>
      <div className="grid2">
        <label className="field"><span>{t('phone')}</span><input value={f.phone} inputMode="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        <label className="field"><span>{t('upiId')}</span><input value={f.upi_id} onChange={(e) => setF({ ...f, upi_id: e.target.value })} placeholder="shopname@okaxis" /></label>
      </div>
      <label className="field">
        <span>{t('autoDeleteLabel')}</span>
        <select value={f.auto_delete_hours} onChange={(e) => setF({ ...f, auto_delete_hours: Number(e.target.value) })}>
          {[1, 3, 6, 12, 24, 48].map((h) => <option key={h} value={h}>{tn('hours_one', 'hours_other', h)}</option>)}
        </select>
      </label>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg">{t('save')}</button>
      <button type="button" className="btn block lg" onClick={onLogout}>{t('logout')}</button>
    </form>
  )
}
