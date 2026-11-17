import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { Counter, DEFAULT_PASSPORT_RATE, FREE_COUNTER_LIMIT, Order, OrderStatus, plansReady, Rates, Shop, shopIsPro, shopUrl, supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { rupees } from '../lib/pricing'
import { ding, unlockAudio } from '../lib/sound'
import { Key, useI18n } from '../lib/i18n'
import { LogoMark, TopBar } from '../components/TopBar'
import AdSlot from '../components/AdSlot'
import { Period, PLAN_PRICES, startUpgrade, callFn } from '../lib/billing'

type Tab = 'orders' | 'rates' | 'qr' | 'report' | 'settings' | 'plan'
const TABS: { id: Tab; label: Key }[] = [
  { id: 'orders', label: 'tabOrders' },
  { id: 'rates', label: 'tabRates' },
  { id: 'qr', label: 'tabQr' },
  { id: 'report', label: 'tabReport' },
  { id: 'settings', label: 'tabSettings' },
  { id: 'plan', label: 'tabPlan' }
]

export default function Dashboard() {
  const { session, loading } = useSession()
  const { t } = useI18n()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'orders'
  const [shop, setShop] = useState<Shop | null>(null)
  const [counters, setCounters] = useState<Counter[]>([])
  // false until the v2 database update (supabase/migrations/2026-11-17-v2.sql) has been run
  const [v2, setV2] = useState(false)

  const loadCounters = useCallback(async (shopId: string) => {
    const { data, error } = await supabase.from('counters').select('*').eq('shop_id', shopId).order('created_at')
    if (error) {
      setV2(false)
      setCounters([])
    } else {
      setV2(true)
      setCounters((data || []) as Counter[])
    }
  }, [])

  const loadShop = useCallback(async () => {
    if (!session) return
    const { data } = await supabase.from('shops').select('*').eq('owner_id', session.user.id).maybeSingle()
    if (!data) nav('/setup', { replace: true })
    else {
      setShop(data as Shop)
      void loadCounters((data as Shop).id)
    }
  }, [session, nav, loadCounters])

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

  // Before the v3 database update there are no plans: no ads, no locks (old behaviour).
  const ready = plansReady(shop)
  const pro = shopIsPro(shop)
  const free = ready && !pro
  // Free shops can use only the first FREE_COUNTER_LIMIT counters (the rest show a lock).
  const usable = free ? counters.slice(0, FREE_COUNTER_LIMIT) : counters
  const goPlan = () => setParams({ tab: 'plan' })

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
        {tab === 'orders' && <Orders shop={shop} counters={counters} />}
        {tab === 'rates' && <RatesTab shop={shop} v2={v2} passportLocked={free} onUpgrade={goPlan} onSaved={setShop} />}
        {tab === 'qr' && (
          <QrTab shop={shop} counters={usable} counterId={params.get('c') || ''}
            onCounter={(c) => setParams(c ? { tab: 'qr', c } : { tab: 'qr' }, { replace: true })} />
        )}
        {tab === 'report' && <Report shop={shop} />}
        {tab === 'settings' && (
          <>
            <Settings shop={shop} onSaved={setShop} onLogout={logout} />
            <CountersCard shop={shop} counters={counters} usable={usable.length} locked={free} v2={v2}
              onChanged={() => loadCounters(shop.id)} onUpgrade={goPlan}
              onShowQr={(c) => setParams({ tab: 'qr', c })} />
          </>
        )}
        {tab === 'plan' && <PlanTab shop={shop} email={session?.user.email} onChanged={loadShop} />}
        {free && <AdSlot className="dash-ad" />}
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

const FILTER_KEY = 'pq_counter_filter'
/** 'all', 'none' (orders from the main QR, no counter) or a counter id */
function matchesCounter(o: Order, filter: string) {
  if (filter === 'all') return true
  if (filter === 'none') return !o.counter_id
  return o.counter_id === filter
}

function Orders({ shop, counters }: { shop: Shop; counters: Counter[] }) {
  const { t, te } = useI18n()
  const [orders, setOrders] = useState<Order[]>([])
  const [filter, setFilterState] = useState<string>(() => localStorage.getItem(FILTER_KEY) || 'all')
  function setFilter(f: string) {
    setFilterState(f)
    try {
      localStorage.setItem(FILTER_KEY, f)
    } catch {
      /* ignore */
    }
  }
  // A saved filter for a counter that was deleted falls back to all orders.
  const activeFilter = filter === 'all' || filter === 'none' || counters.some((c) => c.id === filter) ? filter : 'all'
  const filterRef = useRef(activeFilter)
  filterRef.current = activeFilter
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
      // Ring only for orders this screen shows (counter filter, saved per device)
      const f = filterRef.current
      const fresh = list.filter((o) => o.status === 'received' && !known.current!.has(o.id) && matchesCounter(o, f))
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

  const shown = orders.filter((o) => matchesCounter(o, activeFilter))
  const active = shown.filter((o) => ['received', 'printing', 'ready'].includes(o.status))
  const finished = shown.filter((o) => ['done', 'cancelled'].includes(o.status))

  return (
    <section>
      {err && <p className="notice error">{err}</p>}
      {counters.length > 0 && (
        <div className="counter-filter">
          <label className="small muted" htmlFor="counter-filter">{t('cFilter')}</label>
          <select id="counter-filter" value={activeFilter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">{t('cAll')}</option>
            <option value="none">{t('cMain')}</option>
            {counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      )}
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
            {o.counter_name && <> <span className="pill tiny counter-pill">🧾 {o.counter_name}</span></>}
          </div>
        </div>
        <strong className="amt">{rupees(Number(o.total))}</strong>
      </div>
      {o.note && <p className="note">📝 {o.note}</p>}
      <ul className="files">
        {(o.order_files || []).map((f) => (
          <li key={f.id}>
            <div className="fname">{f.file_name}</div>
            {f.item_kind === 'passport' ? (
              <div className="small muted">
                <span className="pill tiny pp-pill">🪪 {t('ppSheetLabel')}</span>{' '}
                {t('ppCalc', { n: f.photos ?? '?', s: f.pages_to_print })} · {rupees(Number(f.price))}
              </div>
            ) : (
              <div className="small muted">
                {f.color ? t('color') : t('bw')} · {f.duplex ? t('bothSides') : t('oneSide')} ·{' '}
                {t('calcLine', { p: f.pages_to_print, c: f.copies })}
                {f.page_range ? ` (${f.page_range})` : ''} · {rupees(Number(f.price))}
              </div>
            )}
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

function RatesTab({ shop, v2, passportLocked, onUpgrade, onSaved }: {
  shop: Shop
  v2: boolean
  passportLocked: boolean
  onUpgrade: () => void
  onSaved: (s: Shop) => void
}) {
  const { t, te } = useI18n()
  const [r, setR] = useState<Rates>({ ...shop.rates, passport_sheet: shop.rates.passport_sheet ?? DEFAULT_PASSPORT_RATE })
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const fields: { k: keyof Rates; label: Key; hint: Key }[] = [
    { k: 'bw_single', label: 'rate_bw_single', hint: 'perPage' },
    { k: 'bw_double', label: 'rate_bw_double', hint: 'perPage' },
    { k: 'color_single', label: 'rate_color_single', hint: 'perPage' },
    { k: 'color_double', label: 'rate_color_double', hint: 'perPage' }
  ]
  // The passport rate is only used by the server after the v2 database update.
  // Free plan: passport sheet is a Pro feature (shown locked below, not editable).
  if (v2 && !passportLocked) fields.push({ k: 'passport_sheet', label: 'rate_passport_sheet', hint: 'perSheet' })
  async function save(e: FormEvent) {
    e.preventDefault()
    const clean: Rates = {
      ...shop.rates,
      bw_single: Math.max(0, Number(r.bw_single) || 0),
      bw_double: Math.max(0, Number(r.bw_double) || 0),
      color_single: Math.max(0, Number(r.color_single) || 0),
      color_double: Math.max(0, Number(r.color_double) || 0)
    }
    if (v2 && !passportLocked) clean.passport_sheet = Math.max(0, Number(r.passport_sheet) || 0)
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
              <input type="number" step="0.5" min={0} value={r[f.k] ?? 0} inputMode="decimal"
                onChange={(e) => setR({ ...r, [f.k]: e.target.value as unknown as number })} />
            </div>
            <small className="hint">{t(f.hint)}</small>
          </label>
        ))}
        {v2 && passportLocked && (
          <div className="field locked-field">
            <span>{t('rate_passport_sheet')} <span className="pro-badge">{t('planPro')}</span></span>
            <div className="input-affix">
              <span className="affix">🔒</span>
              <input value="" disabled placeholder={t('proFeature')} aria-label={t('rate_passport_sheet')} />
            </div>
            <small className="hint">
              {t('ppProOnly')}{' '}
              <button type="button" className="link small" onClick={onUpgrade}>{t('seePlans')}</button>
            </small>
          </div>
        )}
      </div>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg">{t('save')}</button>
    </form>
  )
}

/* ------------------------------------------------------------------ */

function QrTab({ shop, counters, counterId, onCounter }: {
  shop: Shop
  counters: Counter[]
  counterId: string
  onCounter: (id: string) => void
}) {
  const { t } = useI18n()
  const counter = counters.find((c) => c.id === counterId) || null
  const counterName = counter?.name || ''
  const url = shopUrl(shop.slug, counter?.id)
  const [img, setImg] = useState('')
  const [copied, setCopied] = useState(false)
  const [card, setCard] = useState('')
  const [logoEl, setLogoEl] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    const im = new Image()
    im.onload = () => setLogoEl(im)
    im.src = import.meta.env.BASE_URL + 'icon.svg'
  }, [])
  useEffect(() => {
    QRCode.toDataURL(url, { width: 900, margin: 1, errorCorrectionLevel: 'M' }).then(setImg)
  }, [url])
  // Downloadable PNG: a styled QR card (gradient, rounded QR, shop name, rates, steps).
  useEffect(() => {
    let qr: ReturnType<typeof QRCode.create>
    try {
      qr = QRCode.create(url, { errorCorrectionLevel: 'H' })
    } catch {
      return
    }
    const m = qr.modules as unknown as { size: number; data: ArrayLike<number> }
    const n = m.size
    const dark = (r: number, c: number) => !!m.data[r * n + c]
    // Extra band for the counter name when this is a counter QR
    const off = counterName ? 80 : 0
    const W = 1080, H = 1500 + off
    const c = document.createElement('canvas')
    c.width = W
    c.height = H
    const g = c.getContext('2d')
    if (!g) return
    const font = "'Inter', 'Noto Sans Devanagari', system-ui, sans-serif"
    const rr = (x: number, y: number, w: number, h: number, r: number) => {
      g.beginPath()
      g.moveTo(x + r, y)
      g.arcTo(x + w, y, x + w, y + h, r)
      g.arcTo(x + w, y + h, x, y + h, r)
      g.arcTo(x, y + h, x, y, r)
      g.arcTo(x, y, x + w, y, r)
      g.closePath()
    }
    const fitText = (text: string, weight: number, max: number, min: number, width: number) => {
      let size = max
      g.font = `${weight} ${size}px ${font}`
      while (g.measureText(text).width > width && size > min) {
        size -= 2
        g.font = `${weight} ${size}px ${font}`
      }
    }

    // Light background, pastel blobs, thin brand strips
    g.fillStyle = '#f8fafc'
    g.fillRect(0, 0, W, H)
    const blob = (x: number, y: number, r: number, col: string) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r)
      rg.addColorStop(0, col)
      rg.addColorStop(1, 'rgba(248,250,252,0)')
      g.fillStyle = rg
      g.fillRect(x - r, y - r, r * 2, r * 2)
    }
    blob(960, 140, 420, 'rgba(191,219,254,0.9)')
    blob(100, 1380, 460, 'rgba(221,214,254,0.85)')
    blob(1000, 1200, 260, 'rgba(254,243,199,0.8)')
    const strip = g.createLinearGradient(0, 0, W, 0)
    strip.addColorStop(0, '#2348e0')
    strip.addColorStop(1, '#7c3aed')
    g.fillStyle = strip
    g.fillRect(0, 0, W, 14)
    g.fillRect(0, H - 14, W, 14)

    g.textAlign = 'center'
    g.textBaseline = 'middle'

    // Tag pill
    const tag = 'PrintQR · ' + t('cardTag')
    g.font = `700 30px ${font}`
    const tw = g.measureText(tag).width + 60
    rr((W - tw) / 2, 60, tw, 60, 30)
    g.fillStyle = '#e0e7ff'
    g.fill()
    g.fillStyle = '#3730a3'
    g.fillText(tag, W / 2, 91)

    // Shop name + address
    fitText(shop.name, 800, 84, 40, W - 120)
    g.fillStyle = '#0f172a'
    g.fillText(shop.name, W / 2, 200)
    if (shop.address) {
      g.font = `500 36px ${font}`
      g.fillStyle = '#64748b'
      g.fillText('📍 ' + shop.address, W / 2, 268, W - 140)
    }

    // Counter name pill
    if (counterName) {
      const label = '🧾 ' + counterName
      fitText(label, 800, 40, 26, W - 260)
      const cw = Math.min(g.measureText(label).width + 80, W - 160)
      const grad = g.createLinearGradient((W - cw) / 2, 0, (W + cw) / 2, 0)
      grad.addColorStop(0, '#2348e0')
      grad.addColorStop(1, '#7c3aed')
      rr((W - cw) / 2, 300, cw, 68, 34)
      g.fillStyle = grad
      g.fill()
      g.fillStyle = '#ffffff'
      g.fillText(label, W / 2, 335, cw - 50)
    }

    // White QR card with shadow
    const cardS = 760, cx = (W - cardS) / 2, cy = 320 + off
    g.save()
    g.shadowColor = 'rgba(35,72,224,0.18)'
    g.shadowBlur = 50
    g.shadowOffsetY = 20
    rr(cx, cy, cardS, cardS, 48)
    g.fillStyle = '#ffffff'
    g.fill()
    g.restore()
    rr(cx, cy, cardS, cardS, 48)
    g.strokeStyle = '#e2e8f0'
    g.lineWidth = 3
    g.stroke()

    // QR modules: rounded dots + custom eyes
    const pad = 60
    const cell = (cardS - pad * 2) / n
    const ox = cx + pad, oy = cy + pad
    const inEye = (r: number, col: number) =>
      (r < 7 && col < 7) || (r < 7 && col >= n - 7) || (r >= n - 7 && col < 7)
    const logo = Math.ceil(n * 0.22) | 1
    const ls = Math.floor((n - logo) / 2)
    const inLogo = (r: number, col: number) => r >= ls && r < ls + logo && col >= ls && col < ls + logo
    g.fillStyle = '#0f172a'
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (!dark(r, col) || inEye(r, col) || inLogo(r, col)) continue
        g.beginPath()
        g.arc(ox + col * cell + cell / 2, oy + r * cell + cell / 2, cell * 0.46, 0, Math.PI * 2)
        g.fill()
      }
    }
    const eye = (r: number, col: number) => {
      const x = ox + col * cell, y = oy + r * cell
      rr(x, y, cell * 7, cell * 7, cell * 2)
      g.fillStyle = '#2348e0'
      g.fill()
      rr(x + cell, y + cell, cell * 5, cell * 5, cell * 1.4)
      g.fillStyle = '#ffffff'
      g.fill()
      rr(x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell)
      g.fillStyle = '#0f172a'
      g.fill()
    }
    eye(0, 0)
    eye(0, n - 7)
    eye(n - 7, 0)
    // Center badge
    const bs = cell * logo, bx = ox + ls * cell, by = oy + ls * cell
    if (logoEl) {
      g.drawImage(logoEl, bx + cell * 0.4, by + cell * 0.4, bs - cell * 0.8, bs - cell * 0.8)
    } else {
      rr(bx + cell * 0.4, by + cell * 0.4, bs - cell * 0.8, bs - cell * 0.8, cell * 1.6)
      g.fillStyle = '#2348e0'
      g.fill()
    }

    // Headline
    let y = cy + cardS + 90
    g.fillStyle = '#0f172a'
    fitText(t('posterHeadline'), 800, 52, 30, W - 100)
    g.fillText(t('posterHeadline'), W / 2, y)

    // Steps row
    y += 100
    const steps = ['📷  ' + t('cardScan'), '📄  ' + t('cardUpload'), '🖨️  ' + t('cardCollect')]
    g.font = `700 32px ${font}`
    const widths = steps.map((s) => g.measureText(s).width + 56)
    const gap = 40
    let x = (W - (widths.reduce((a, b) => a + b, 0) + gap * (steps.length - 1))) / 2
    steps.forEach((s, i) => {
      rr(x, y - 36, widths[i], 72, 36)
      g.fillStyle = '#eff6ff'
      g.fill()
      g.strokeStyle = '#bfdbfe'
      g.lineWidth = 2
      g.stroke()
      g.fillStyle = '#1d4ed8'
      g.fillText(s, x + widths[i] / 2, y + 1)
      if (i < steps.length - 1) {
        g.fillStyle = '#94a3b8'
        g.fillText('›', x + widths[i] + gap / 2, y)
      }
      x += widths[i] + gap
    })

    // Rates
    y += 100
    const rates = `${t('bw')} ${rupees(shop.rates.bw_single)}  ·  ${t('color')} ${rupees(shop.rates.color_single)}  ${t('perPageShort')}`
    g.font = `700 34px ${font}`
    const rw = Math.min(g.measureText(rates).width + 70, W - 80)
    rr((W - rw) / 2, y - 40, rw, 80, 40)
    g.fillStyle = '#fef3c7'
    g.fill()
    g.fillStyle = '#92400e'
    g.fillText(rates, W / 2, y + 1, W - 130)

    setCard(c.toDataURL('image/png'))
  }, [url, counterName, shop.name, shop.address, shop.rates.bw_single, shop.rates.color_single, t, logoEl])
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
        {counters.length > 0 && (
          <label className="field">
            <span>{t('cQrFor')}</span>
            <select value={counter?.id || ''} onChange={(e) => onCounter(e.target.value)}>
              <option value="">{t('cMain')}</option>
              {counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => window.print()}>{t('printPoster')}</button>
          {card && (
            <a className="btn" href={card}
              download={`${shop.slug}${counterName ? '-' + (counterName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'counter') : ''}-qr.png`}>
              {t('downloadQr')}
            </a>
          )}
          <button type="button" className="btn" onClick={copy}>{copied ? t('linkCopied') : t('copyLink')}</button>
        </div>
      </div>
      <div className="poster">
        <div className="poster-brand"><LogoMark size={26} /> PrintQR</div>
        <div className="poster-top">{shop.name}</div>
        {counterName && <div className="poster-counter">🧾 {counterName}</div>}
        <h2>{t('posterHeadline')}</h2>
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

/* ------------------------------------------------------------------ */

const MAX_COUNTERS = 20

function CountersCard({ shop, counters, usable, locked, v2, onChanged, onUpgrade, onShowQr }: {
  shop: Shop
  counters: Counter[]
  /** How many of `counters` (oldest first) can be used. The rest are locked on the Free plan. */
  usable: number
  /** Free plan: no new counters beyond the free limit. */
  locked: boolean
  v2: boolean
  onChanged: () => Promise<void> | void
  onUpgrade: () => void
  onShowQr: (id: string) => void
}) {
  const { t, te } = useI18n()
  const [names, setNames] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)

  async function run(fn: () => PromiseLike<{ error: unknown }>, ok: Key): Promise<boolean> {
    setBusy(true)
    setMsg(null)
    const { error } = await fn()
    setBusy(false)
    if (error) {
      setMsg({ text: te(error), error: true })
      return false
    }
    setMsg({ text: t(ok), error: false })
    await onChanged()
    return true
  }

  function add(e: FormEvent) {
    e.preventDefault()
    const name = newName.trim().slice(0, 40)
    if (!name) return
    void run(() => supabase.from('counters').insert({ shop_id: shop.id, name }), 'cAdded').then((ok) => ok && setNewName(''))
  }

  function rename(c: Counter) {
    const name = (names[c.id] ?? c.name).trim().slice(0, 40)
    if (!name || name === c.name) return
    void run(() => supabase.from('counters').update({ name }).eq('id', c.id), 'saved')
  }

  function remove(c: Counter) {
    if (!confirm(t('cConfirmDelete', { name: c.name }))) return
    void run(() => supabase.from('counters').delete().eq('id', c.id), 'cDeleted')
  }

  return (
    <div className="card form-card">
      <h2 className="card-title">{t('cTitle')}</h2>
      <p className="small muted">{t('cSub')}</p>
      {!v2 ? (
        <p className="notice">{t('cNeedsUpdate')}</p>
      ) : (
        <>
          {counters.length > 0 && (
            <ul className="counter-list">
              {counters.map((c, i) => i < usable ? (
                <li key={c.id}>
                  <input value={names[c.id] ?? c.name} maxLength={40} aria-label={t('cName')}
                    onChange={(e) => setNames({ ...names, [c.id]: e.target.value })}
                    onBlur={() => rename(c)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rename(c) } }} />
                  <div className="counter-actions">
                    <button type="button" className="btn small soft" onClick={() => onShowQr(c.id)}>{t('cQr')}</button>
                    <button type="button" className="btn small danger-outline" onClick={() => remove(c)} disabled={busy}>{t('cDelete')}</button>
                  </div>
                </li>
              ) : (
                <li key={c.id} className="counter-locked">
                  <span className="counter-locked-name">🔒 {c.name} <span className="small muted">· {t('cLocked')}</span></span>
                  <div className="counter-actions">
                    <button type="button" className="btn small soft" onClick={onUpgrade}>{t('seePlans')}</button>
                    <button type="button" className="btn small danger-outline" onClick={() => remove(c)} disabled={busy}>{t('cDelete')}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {locked && counters.length >= FREE_COUNTER_LIMIT ? (
            <div className="upgrade-prompt">
              <span>🔒 {t('cUpgradePrompt')} <span className="pro-badge">{t('planPro')}</span></span>
              <button type="button" className="btn primary small" onClick={onUpgrade}>{t('seePlans')}</button>
            </div>
          ) : counters.length < MAX_COUNTERS && (
            <form className="counter-add" onSubmit={add}>
              <input value={newName} maxLength={40} placeholder={t('cNamePh')} aria-label={t('cName')}
                onChange={(e) => setNewName(e.target.value)} />
              <button className="btn primary" disabled={busy || !newName.trim()}>{t('cAdd')}</button>
            </form>
          )}
          <p className="small muted">{t('cMainHint')}</p>
        </>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ */

const ENDED = ['cancelled', 'completed', 'expired']

function PlanTab({ shop, email, onChanged }: { shop: Shop; email?: string; onChanged: () => Promise<void> | void }) {
  const { t, lang } = useI18n()
  const [busy, setBusy] = useState<Period | 'cancel' | null>(null)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)

  if (!plansReady(shop)) {
    return (
      <div className="card form-card">
        <h2 className="card-title">{t('planTitle')}</h2>
        <p className="notice">{t('planNeedsUpdate')}</p>
      </div>
    )
  }

  const pro = shopIsPro(shop)
  const ended = ENDED.includes(shop.subscription_status || '')
  const until = shop.plan_expires_at
    ? new Date(shop.plan_expires_at).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
    : ''
  const periodText = shop.plan_period === 'yearly' ? t('planYearly') : t('planMonthly')

  function errText(e: unknown): string {
    const code = (e as { code?: string }).code
    if (code === 'already_pro') return t('planAlreadyPro')
    if (code === 'needs_migration') return t('planNeedsUpdate')
    if (code === 'checkout_load_failed') return t('planCheckoutFail')
    if (code === 'not_deployed' || code === 'missing_env') return t('planNotReady')
    return (e as Error)?.message || t('errGeneric')
  }

  async function upgrade(period: Period) {
    setBusy(period)
    setMsg(null)
    try {
      const desc = `PrintQR Pro · ${period === 'yearly' ? t('planYearly') : t('planMonthly')}`
      const ok = await startUpgrade(period, { email, description: desc })
      if (ok) {
        setMsg({ text: t('planActivated'), error: false })
        await onChanged()
      }
    } catch (e) {
      setMsg({ text: errText(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  async function cancel() {
    if (!confirm(t('planConfirmCancel', { date: until }))) return
    setBusy('cancel')
    setMsg(null)
    try {
      await callFn('cancel-subscription')
      setMsg({ text: t('planCancelledUntil', { date: until }), error: false })
      await onChanged()
    } catch (e) {
      setMsg({ text: errText(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  const options: { p: Period; label: string; per: string; save?: boolean }[] = [
    { p: 'monthly', label: t('planMonthly'), per: t('perMonth') },
    { p: 'yearly', label: t('planYearly'), per: t('perYear'), save: true }
  ]

  return (
    <section>
      <div className={`card plan-current${pro ? ' is-pro' : ''}`}>
        <div className="plan-current-top">
          <div>
            <div className="small muted">{t('planTitle')}</div>
            <h2 className="plan-name">{pro ? t('planPro') : t('planFree')} {pro && <span className="pro-badge">{periodText}</span>}</h2>
          </div>
          <span className="plan-icon" aria-hidden="true">{pro ? '⭐' : '🆓'}</span>
        </div>
        {pro ? (
          <>
            <p>{ended ? t('planCancelledUntil', { date: until }) : t('planProUntil', { date: until })}</p>
            {!ended && <p className="small muted">{t('planRenews', { period: periodText })}</p>}
            {ended && <p className="small muted">{t('planResubNote')}</p>}
          </>
        ) : (
          <p className="muted">{t('planFreeSub')}</p>
        )}
      </div>

      {!pro && (
        <div className="plan-grid">
          {options.map((o) => (
            <div key={o.p} className={`card plan-card${o.save ? ' best' : ''}`}>
              {o.save && <span className="plan-save">{t('oneMonthFree')}</span>}
              <div className="small muted plan-period">{o.label}</div>
              <div className="plan-price">₹{PLAN_PRICES[o.p]}<span>{o.per}</span></div>
              <ul className="plan-feats">
                <li>✓ {t('planFeatNoAds')}</li>
                <li>✓ {t('planFeatCounters')}</li>
                <li>✓ {t('planFeatPassport')}</li>
              </ul>
              <button type="button" className={`btn block lg${o.save ? ' primary' : ''}`} disabled={busy !== null}
                onClick={() => void upgrade(o.p)}>
                {busy === o.p ? t('pleaseWait') : `${t('planGetPro')} · ₹${PLAN_PRICES[o.p]}${o.per}`}
              </button>
            </div>
          ))}
        </div>
      )}

      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      {!pro && <p className="small muted">{t('planPayNote')}</p>}

      {pro && !ended && shop.razorpay_subscription_id && (
        <button type="button" className="btn danger-outline" disabled={busy !== null} onClick={() => void cancel()}>
          {busy === 'cancel' ? t('pleaseWait') : t('planCancel')}
        </button>
      )}
    </section>
  )
}
