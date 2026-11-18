import { AppDownloadBanner } from '../components/AppDownload'
import { FormEvent, TouchEvent as RTouchEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { Counter, DEFAULT_PASSPORT_RATE, FREE_COUNTER_LIMIT, Order, OrderStatus, plansReady, QrLink, qrCodeUrl, Rates, Shop, shopIsPro, shopUrl, supabase } from '../lib/supabase'
import { useSession } from '../lib/useSession'
import { rupees } from '../lib/pricing'
import { ding, unlockAudio } from '../lib/sound'
import { Key, useI18n } from '../lib/i18n'
import { LangToggle, LogoMark, TopBar, Wordmark } from '../components/TopBar'
import { ThemePref, useTheme } from '../lib/theme'
import AdSlot from '../components/AdSlot'
import Icon from '../components/Icon'
import { Period, PLAN_PRICES, startUpgrade, callFn } from '../lib/billing'

type Tab = 'orders' | 'rates' | 'qr' | 'report' | 'settings' | 'plan'
const TABS: { id: Tab; label: Key; icon: string }[] = [
  { id: 'orders', label: 'tabOrders', icon: 'inbox' },
  { id: 'rates', label: 'tabRates', icon: 'rupee' },
  { id: 'qr', label: 'tabQr', icon: 'qr' },
  { id: 'report', label: 'tabReport', icon: 'chart' },
  { id: 'settings', label: 'tabSettings', icon: 'settings' },
  { id: 'plan', label: 'tabPlan', icon: 'star' }
]

const NAV: { group: Key; items: Tab[] }[] = [
  { group: 'navShop', items: ['orders', 'rates', 'qr'] },
  { group: 'navBusiness', items: ['report', 'plan'] },
  { group: 'navAccount', items: ['settings'] }
]

function greeting(t: (k: Key) => string): string {
  const h = new Date().getHours()
  return t(h < 12 ? 'goodMorning' : h < 17 ? 'goodAfternoon' : 'goodEvening')
}
function today(lang: string): string {
  return new Date().toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
}

function ShopAvatar({ shop, size }: { shop: Shop; size: number }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [shop.logo_url])
  if (!shop.logo_url || broken) return <LogoMark size={size} />
  return (
    <img src={shop.logo_url} width={size} height={size} alt="" onError={() => setBroken(true)}
      style={{ display: 'block', flex: 'none', width: size, height: size, borderRadius: size * 0.23, objectFit: 'cover' }} />
  )
}

/** Square-crops and shrinks a picked photo to a 320px JPEG (small, fast to load). */
async function squareJpeg(file: File, px = 320): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, bad) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = bad
      i.src = url
    })
    const side = Math.min(img.naturalWidth, img.naturalHeight)
    if (!side) throw new Error('bad image')
    const c = document.createElement('canvas')
    c.width = px
    c.height = px
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, px, px)
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, px, px)
    return await new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('encode'))), 'image/jpeg', 0.85))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function ShopPhotoField({ shop, onSaved }: { shop: Shop; onSaved: (s: Shop) => void }) {
  const { t, te } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)

  async function clearOld(keep?: string) {
    const { data } = await supabase.storage.from('shop-logos').list(shop.id)
    const old = (data || []).map((o) => `${shop.id}/${o.name}`).filter((p) => p !== keep)
    if (old.length) await supabase.storage.from('shop-logos').remove(old)
  }
  async function pick(file: File | undefined) {
    if (!file) return
    setMsg(null)
    setBusy(true)
    try {
      let blob: Blob
      try {
        blob = await squareJpeg(file)
      } catch {
        return setMsg({ text: t('shopPhotoBad'), error: true })
      }
      const path = `${shop.id}/logo-${Date.now()}.jpg`
      const up = await supabase.storage.from('shop-logos').upload(path, blob, { contentType: 'image/jpeg', upsert: true })
      if (up.error) return setMsg({ text: te(up.error), error: true })
      const url = supabase.storage.from('shop-logos').getPublicUrl(path).data.publicUrl
      const { data, error } = await supabase.from('shops').update({ logo_url: url }).eq('id', shop.id).select().single()
      if (error) return setMsg({ text: te(error), error: true })
      onSaved(data as Shop)
      setMsg({ text: t('shopPhotoSaved'), error: false })
      void clearOld(path)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  async function remove() {
    setMsg(null)
    setBusy(true)
    try {
      const { data, error } = await supabase.from('shops').update({ logo_url: null }).eq('id', shop.id).select().single()
      if (error) return setMsg({ text: te(error), error: true })
      onSaved(data as Shop)
      void clearOld()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="field">
      <span>{t('shopPhoto')}</span>
      <div className="photo-row">
        <ShopAvatar shop={shop} size={64} />
        <div className="photo-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? t('shopPhotoUploading') : shop.logo_url ? t('shopPhotoChange') : t('shopPhotoAdd')}
          </button>
          {shop.logo_url && !busy && (
            <button type="button" className="btn ghost" onClick={remove}>{t('shopPhotoRemove')}</button>
          )}
        </div>
        <input ref={input} type="file" accept="image/*" hidden onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      <small className="hint">{t('shopPhotoHint')}</small>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
    </div>
  )
}

export function ThemeToggle() {
  const { t } = useI18n()
  const { pref, setTheme } = useTheme()
  const opts: { id: ThemePref; label: Key; icon: string }[] = [
    { id: 'light', label: 'themeLight', icon: 'sun' },
    { id: 'dark', label: 'themeDark', icon: 'moon' },
    { id: 'system', label: 'themeAuto', icon: 'auto' }
  ]
  return (
    <div className="theme-seg" role="group" aria-label={t('theme')}>
      {opts.map((o) => (
        <button key={o.id} type="button" className={pref === o.id ? 'on' : ''} aria-pressed={pref === o.id} onClick={() => setTheme(o.id)}>
          <Icon name={o.icon} size={16} /> {t(o.label)}
        </button>
      ))}
    </div>
  )
}

export default function Dashboard() {
  const { session, loading } = useSession()
  const { t, lang } = useI18n()
  const [menu, setMenu] = useState(false)
  // Swipe left on the open menu to close it (the menu follows the finger).
  const drawerRef = useRef<HTMLElement>(null)
  const swipe = useRef<{ x: number; y: number; dx: number; horiz: boolean | null } | null>(null)
  function swipeStart(e: RTouchEvent) {
    const p = e.touches[0]
    swipe.current = { x: p.clientX, y: p.clientY, dx: 0, horiz: null }
  }
  function swipeMove(e: RTouchEvent) {
    const s = swipe.current
    const el = drawerRef.current
    if (!s || !el) return
    const p = e.touches[0]
    const dx = p.clientX - s.x
    const dy = p.clientY - s.y
    if (s.horiz === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      s.horiz = Math.abs(dx) > Math.abs(dy)
    }
    if (!s.horiz) return
    s.dx = Math.min(0, dx)
    el.style.transition = 'none'
    el.style.transform = `translateX(${s.dx}px)`
  }
  function swipeEnd() {
    const s = swipe.current
    const el = drawerRef.current
    swipe.current = null
    if (!s || !el || !s.horiz) return
    el.style.transition = ''
    el.style.transform = ''
    if (s.dx < -Math.min(80, el.offsetWidth * 0.25)) setMenu(false)
  }
  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    window.addEventListener('keydown', onKey)
    document.body.classList.add('no-scroll')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('no-scroll')
    }
  }, [menu])
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
        <TopBar to={null} wide lang={false} />
        <div className="page wide skeleton-wrap" aria-busy="true">
          <span className="sr-only">{t('loading')}</span>
          <div className="skel skel-line w40 skel-title" />
          <div className="skel skel-tabs" />
          <div className="orders-grid">
            <div className="card skel-card"><div className="skel skel-line w60" /><div className="skel skel-block" /></div>
            <div className="card skel-card"><div className="skel skel-line w60" /><div className="skel skel-block" /></div>
          </div>
        </div>
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

  const current = TABS.find((x) => x.id === tab) || TABS[0]
  const go = (id: Tab) => {
    setMenu(false)
    setParams({ tab: id })
    window.scrollTo(0, 0)
  }
  const openToggle = (
    <button type="button" className={`toggle ${shop.is_open ? 'is-open' : 'is-closed'}`} onClick={toggleOpen} aria-pressed={shop.is_open}>
      <span className="toggle-dot" />
      <span className="toggle-label">{shop.is_open ? t('shopOpen') : t('shopClosed')}</span>
    </button>
  )

  return (
    <div className={`app-page dash${menu ? ' menu-open' : ''}`} onClick={unlockAudio}>
      <header className="topbar dash-bar no-print">
        <div className="topbar-in wide">
          <button type="button" className="menu-btn" onClick={() => setMenu(true)} aria-label={t('menu')} aria-expanded={menu}>
            <Icon name="menu" size={24} />
          </button>
        </div>
      </header>

      <div className="drawer-scrim no-print" onClick={() => setMenu(false)} aria-hidden="true" />
      <aside className="drawer no-print" aria-label={t('menu')} ref={drawerRef}
        onTouchStart={swipeStart} onTouchMove={swipeMove} onTouchEnd={swipeEnd} onTouchCancel={swipeEnd}>
        <div className="drawer-head">
          <ShopAvatar shop={shop} size={44} />
          <div className="drawer-title">
            <strong>{shop.name}</strong>
            {ready && <span className={`plan-chip${pro ? ' is-pro' : ''}`}>{pro ? t('planPro') : t('planFree')}</span>}
          </div>
          <button type="button" className="drawer-close" onClick={() => setMenu(false)} aria-label={t('close')}>
            <Icon name="x" size={24} />
          </button>
        </div>
        <nav className="drawer-nav">
          {NAV.map((g) => (
            <div className="drawer-group" key={g.group}>
              <div className="drawer-label">{t(g.group)}</div>
              {g.items.map((id) => {
                const x = TABS.find((y) => y.id === id)!
                return (
                  <button key={id} type="button" className={`drawer-item${tab === id ? ' on' : ''}`}
                    aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}>
                    <Icon name={x.icon} size={22} />
                    <span>{t(x.label)}</span>
                  </button>
                )
              })}
            </div>
          ))}
        </nav>
        <div className="drawer-foot">
          <div className="drawer-foot-row">
            {openToggle}
            <LangToggle />
          </div>
          <ThemeToggle />
          <button type="button" className="btn block" onClick={logout}><Icon name="logout" size={18} /> {t('logout')}</button>
        </div>
      </aside>

      <div className="page wide dash-main">
        <div className="dash-head no-print">
          <div className="dash-title">
            <h1>{t(current.label)}</h1>
            <p className="muted dash-sub">{greeting(t)} · {today(lang)} · {shop.name}</p>
          </div>
        </div>
        <AppDownloadBanner />
        {tab === 'orders' && <Orders shop={shop} counters={counters} />}
        {tab === 'rates' && <RatesTab shop={shop} v2={v2} passportLocked={free} onUpgrade={goPlan} onSaved={setShop} />}
        {tab === 'qr' && (
          <QrTab shop={shop} counters={usable} counterId={params.get('c') || ''} pro={pro} free={free} onUpgrade={goPlan}
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
      {err && <p className="notice error" role="alert"><Icon name="alert" size={18} /> <span>{err}</span></p>}
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
        {active.length > 0 && (
          <div className="queue-summary" aria-hidden="true">
            {(['received', 'printing', 'ready'] as OrderStatus[]).map((st) => {
              const n = active.filter((o) => o.status === st).length
              return n ? <span key={st} className={`pill tiny s-${st}`}>{t(STATUS_TEXT[st])} · {n}</span> : null
            })}
          </div>
        )}
      </div>
      {!active.length && (
        <div className="card empty">
          <span className="state-icon" aria-hidden="true"><Icon name="bell" size={28} /></span>
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
  const nextIcon = o.status === 'received' ? 'printer' : o.status === 'printing' ? 'check' : 'user'
  return (
    <article className={`card order s-${o.status}`}>
      <div className="order-top">
        <span className="token-chip" aria-label={`${t('sYourToken')} ${o.token}`}>#{o.token}</span>
        <div className="order-who">
          <strong>{o.customer_name || t('customer')}</strong>
          <div className="order-meta">
            <span className="order-time"><Icon name="clock" size={14} /> {timeText(o.created_at)}</span>
            {o.counter_name && <span className="pill tiny counter-pill">🧾 {o.counter_name}</span>}
          </div>
        </div>
        <div className="order-right">
          <span className={`pill tiny s-${o.status}`}>{t(STATUS_TEXT[o.status])}</span>
          <strong className="amt">{rupees(Number(o.total))}</strong>
        </div>
      </div>
      {o.note && <p className="note"><Icon name="note" size={16} /> <span>{o.note}</span></p>}
      <ul className="files">
        {(o.order_files || []).map((f) => (
          <li key={f.id}>
            <div className="fname">{f.file_name}</div>
            {f.item_kind === 'passport' ? (
              <div className="file-meta">
                <span className="pill tiny pp-pill">🪪 {t('ppSheetLabel')}</span>
                <span>{t('ppCalc', { n: f.photos ?? '?', s: f.pages_to_print })}</span>
                <b>{rupees(Number(f.price))}</b>
              </div>
            ) : (
              <div className="file-meta">
                <span className={`mchip${f.color ? ' is-color' : ''}`}>{f.color ? t('color') : t('bw')}</span>
                <span className="mchip">{f.duplex ? t('bothSides') : t('oneSide')}</span>
                <span>{t('calcLine', { p: f.pages_to_print, c: f.copies })}{f.page_range ? ` (${f.page_range})` : ''}</span>
                <b>{rupees(Number(f.price))}</b>
              </div>
            )}
            {!o.files_deleted && (
              <div className="file-actions">
                <button type="button" className="btn small soft" onClick={() => onOpen(f.storage_path)}><Icon name="printer" size={17} /> {t('openPrint')}</button>
                <button type="button" className="btn small" onClick={() => onDownload(f.storage_path, f.file_name)}><Icon name="download" size={17} /> {t('download')}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {o.files_deleted && <p className="small muted files-gone"><Icon name="trash" size={15} /> {t('filesDeleted')}</p>}
      <div className="order-actions">
        {next && <button type="button" className={`btn primary next-${o.status}`} onClick={() => onStatus(o, next.to)}><Icon name={nextIcon} size={19} /> {t(next.label)}</button>}
        {['received', 'printing', 'ready'].includes(o.status) && (
          <button type="button" className="btn danger-outline" onClick={() => confirm(t('confirmCancel')) && onStatus(o, 'cancelled')}>{t('cancel')}</button>
        )}
        {['done', 'cancelled'].includes(o.status) && !o.files_deleted && (
          <button type="button" className="btn" onClick={() => onDelete(o)}><Icon name="trash" size={17} /> {t('deleteNow')}</button>
        )}
      </div>
    </article>
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

function QrTab({ shop, counters, counterId, onCounter, pro, free, onUpgrade }: {
  shop: Shop
  counters: Counter[]
  counterId: string
  onCounter: (id: string) => void
  pro: boolean
  free: boolean
  onUpgrade: () => void
}) {
  const { t, te } = useI18n()
  const counter = counters.find((c) => c.id === counterId) || null
  const counterName = counter?.name || ''
  // Pro: the poster carries a short code (dynamic). Before the v5 update, or on Free, it is the plain shop link.
  const [dyn, setDyn] = useState<QrLink | null>(null)
  const [dynMsg, setDynMsg] = useState<{ text: string; error: boolean } | null>(null)
  const slot = counter?.id || 'main'
  useEffect(() => {
    setDyn(null)
    setDynMsg(null)
    let alive = true
    // Look up an existing code first (works even if Pro lapsed), then create one when Pro.
    supabase.from('qr_links').select('*').eq('shop_id', shop.id).eq('slot', slot).maybeSingle()
      .then(async ({ data, error }) => {
        if (!alive || error) return
        if (data) return setDyn(data as QrLink)
        if (!pro) return
        const r = await supabase.rpc('ensure_qr_link', { p_shop: shop.id, p_counter: counter?.id ?? null })
        if (alive && !r.error && r.data) setDyn(r.data as QrLink)
      })
    return () => { alive = false }
  }, [shop.id, slot, pro, counter?.id])
  const url = dyn ? qrCodeUrl(dyn.code) : shopUrl(shop.slug, counter?.id)
  async function updateDyn(patch: Partial<Pick<QrLink, 'target_counter_id' | 'paused'>>) {
    if (!dyn) return
    const { data, error } = await supabase.from('qr_links').update(patch).eq('code', dyn.code).select().single()
    if (error) return setDynMsg({ text: te(error), error: true })
    setDyn(data as QrLink)
    setDynMsg({ text: t('dynSaved'), error: false })
  }
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
    blob(960, 140, 420, 'rgba(217,242,160,0.9)')
    blob(100, 1380, 460, 'rgba(230,246,198,0.85)')
    blob(1000, 1200, 260, 'rgba(254,243,199,0.8)')
    const strip = g.createLinearGradient(0, 0, W, 0)
    strip.addColorStop(0, '#a6e22e')
    strip.addColorStop(1, '#6fa012')
    g.fillStyle = strip
    g.fillRect(0, 0, W, 14)
    g.fillRect(0, H - 14, W, 14)

    g.textAlign = 'center'
    g.textBaseline = 'middle'

    // Tag pill
    const tag = 'Print by Receipto · ' + t('cardTag')
    g.font = `700 30px ${font}`
    const tw = g.measureText(tag).width + 60
    rr((W - tw) / 2, 60, tw, 60, 30)
    g.fillStyle = '#ecf8d2'
    g.fill()
    g.fillStyle = '#2b4310'
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
      grad.addColorStop(0, '#0b1210')
      grad.addColorStop(1, '#2b4310')
      rr((W - cw) / 2, 300, cw, 68, 34)
      g.fillStyle = grad
      g.fill()
      g.fillStyle = '#ffffff'
      g.fillText(label, W / 2, 335, cw - 50)
    }

    // White QR card with shadow
    const cardS = 760, cx = (W - cardS) / 2, cy = 320 + off
    g.save()
    g.shadowColor = 'rgba(11,18,16,0.16)'
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
      g.fillStyle = '#0b1210'
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
      g.fillStyle = '#0b1210'
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
      g.fillStyle = '#f2fbe0'
      g.fill()
      g.strokeStyle = '#c9ec8a'
      g.lineWidth = 2
      g.stroke()
      g.fillStyle = '#3f6212'
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
        {dyn && (
          <div className="dyn-qr">
            <div className="dyn-head">
              <strong>{t('dynQr')} <span className="pro-badge">{t('planPro')}</span></strong>
              <span className="small muted">{t('dynScans')}: <b>{dyn.scans}</b>{dyn.paused ? ` · ${t('dynPaused')}` : ''}</span>
            </div>
            <p className="small muted">{t('dynQrSub')}</p>
            <div className="dyn-row">
              <label className="field">
                <span>{t('dynOpens')}</span>
                <select value={dyn.target_counter_id || ''} disabled={!pro}
                  onChange={(e) => void updateDyn({ target_counter_id: e.target.value || null })}>
                  <option value="">{t('cMain')}</option>
                  {counters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <button type="button" className={`btn small${dyn.paused ? ' primary' : ''}`} disabled={!pro}
                onClick={() => void updateDyn({ paused: !dyn.paused })}>
                {dyn.paused ? t('dynResume') : t('dynPause')}
              </button>
            </div>
            <p className="small muted">{t('dynOld')}</p>
            {dynMsg && <p className={`notice${dynMsg.error ? ' error' : ' success'}`}>{dynMsg.text}</p>}
          </div>
        )}
        {free && !dyn && (
          <p className="small muted">
            <span className="pro-badge">{t('planPro')}</span> {t('dynFreeHint')}{' '}
            <button type="button" className="link small" onClick={onUpgrade}>{t('seePlans')}</button>
          </p>
        )}
        <div className="btn-row">
          <button type="button" className="btn primary" onClick={() => window.print()}><Icon name="printer" size={18} /> {t('printPoster')}</button>
          {card && (
            <a className="btn" href={card}
              download={`${shop.slug}${counterName ? '-' + (counterName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'counter') : ''}-qr.png`}>
              <Icon name="download" size={18} /> {t('downloadQr')}
            </a>
          )}
          <button type="button" className="btn" onClick={copy}><Icon name={copied ? 'check' : 'copy'} size={18} /> {copied ? t('linkCopied') : t('copyLink')}</button>
        </div>
      </div>
      <div className="poster">
        <div className="poster-brand"><Wordmark height={34} light /></div>
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
            <div className="small stat-label"><Icon name={s.accent ? 'rupee' : 'chart'} size={16} /> {t(s.label)}</div>
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
      <ShopPhotoField shop={shop} onSaved={onSaved} />
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
      <button type="button" className="btn block lg" onClick={onLogout}><Icon name="logout" size={18} /> {t('logout')}</button>
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
          <span className="plan-icon" aria-hidden="true"><Icon name={pro ? 'star' : 'store'} size={26} /></span>
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
                <li><Icon name="check" size={16} stroke={3} /> {t('planFeatNoAds')}</li>
                <li><Icon name="check" size={16} stroke={3} /> {t('planFeatCounters')}</li>
                <li><Icon name="check" size={16} stroke={3} /> {t('planFeatPassport')}</li>
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
