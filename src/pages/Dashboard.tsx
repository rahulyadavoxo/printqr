import { accountPhone, nativeBridge, IN_APP, ON_ANDROID } from '../lib/app'
import { setTopColor } from '../lib/theme'
import BarStory from '../components/BarStory'
import { AppDownloadBanner } from '../components/AppDownload'
import { CSSProperties, FormEvent, lazy, ReactNode, Suspense, PointerEvent as RPointerEvent, TouchEvent as RTouchEvent, WheelEvent as RWheelEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { Counter, isAuthError, recoverSession, DEFAULT_IDCARD_RATE, DEFAULT_PASSPORT_RATE, Order, OrderFile, OrderStatus, plansReady, PRO_COUNTER_LIMIT, QrDesign, QrLink, qrCodeUrl, Rates, Shop, shopIsPlus, shopIsPro, shopUrl, supabase } from '../lib/supabase'
import { fileHours, FILE_HOURS, HISTORY_DAYS, PlanTier, shopTier, tierFor } from '../lib/plans'
import { BRAND_SWATCHES, inkOn, validHex } from '../lib/brand'
import { DAY_ORDER, normHours, ShopHours } from '../lib/hours'
import AdSlot from '../components/AdSlot'
import { useSession } from '../lib/useSession'
import { rupees } from '../lib/pricing'
import { ding, unlockAudio } from '../lib/sound'
import { Key, useI18n } from '../lib/i18n'
import { useAppSettings } from '../lib/appSettings'
import { canDirectPrint, DesktopPrinter, desktopApi, savedPrinter, savePrinter } from '../lib/desktop'
import noOrdersArt from '../assets/no-orders-waiting.svg'
import { pushState, pushStatus, removePush, setupPush } from '../lib/push'
import { LangToggle, LogoMark, TopBar, Wordmark } from '../components/TopBar'
import { ThemePref, useTheme } from '../lib/theme'
import Icon from '../components/Icon'
import { ImageLightbox, isImageName, StoredImageThumb, ViewImg } from '../components/ImagePreview'
import { BOTTOM, isTab, NAV, savedSidebar, SbMode, Tab, TABS } from '../lib/dashNav'
import { DashSkeleton, EditorSkel, OrdersSkel } from '../components/Skeletons'
import { QrLoadBlock } from '../components/QrLoader'
import { Period, startUpgrade, callFn, Tier, TIER_PRICES, yearlyOff } from '../lib/billing'
import type { CouponDeal } from '../lib/billing'
import { ask as askConfirm } from '../components/ConfirmHost'
import { BillingPayment, downloadReceipt, money } from '../lib/receipt'
import { SELLER } from '../lib/seller'
import { FILE_REPORT_REASONS, FILE_REPORT_REASON_KEY, FileReportReason } from '../lib/fileReports'
import { AppLockCard, DevicesCard, LockOverlay, useAppLock } from '../components/AppLock'
import { CouponBox, ShopNotices, SupportCard, useNotices, readNotice } from '../components/ShopSupport'

// The document editor is a separate chunk, loaded only when the Edit tab opens.
const Editor = lazy(() => import('./editor/Editor'))

function ShopAvatar({ shop, size }: { shop: Shop; size: number }) {
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [shop.logo_url])
  if (!shop.logo_url || broken) return <LogoMark size={size} />
  return (
    <img src={shop.logo_url} width={size} height={size} alt="" onError={() => setBroken(true)}
      style={{ display: 'block', flex: 'none', width: size, height: size, borderRadius: size * 0.23, objectFit: 'cover' }} />
  )
}

function loadImage(file: File): Promise<{ img: HTMLImageElement; url: string }> {
  const url = URL.createObjectURL(file)
  return new Promise((ok, bad) => {
    const i = new Image()
    i.onload = () => (i.naturalWidth && i.naturalHeight ? ok({ img: i, url }) : bad(new Error('bad image')))
    i.onerror = () => {
      URL.revokeObjectURL(url)
      bad(new Error('bad image'))
    }
    i.src = url
  })
}

/** Draws the chosen square of the photo into a small JPEG (320px, fast to load). */
function cropJpeg(img: HTMLImageElement, sx: number, sy: number, side: number, px = 320): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = px
  c.height = px
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, px, px)
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, sx, sy, side, side, 0, 0, px, px)
  return new Promise<Blob>((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error('encode'))), 'image/jpeg', 0.88))
}

/** Square crop: drag to move, pinch / slider to zoom. */
function PhotoCropper({ img, onCancel, onDone }: {
  img: HTMLImageElement
  onCancel: () => void
  onDone: (sx: number, sy: number, side: number) => void
}) {
  const { t } = useI18n()
  const stageRef = useRef<HTMLDivElement>(null)
  const [S, setS] = useState(280)
  const w = img.naturalWidth
  const h = img.naturalHeight
  const base = S / Math.min(w, h)
  const [zoom, setZoom] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const scale = base * zoom
  const clamp = useCallback((x: number, y: number, sc: number) => ({
    x: Math.min(0, Math.max(S - w * sc, x)),
    y: Math.min(0, Math.max(S - h * sc, y))
  }), [S, w, h])

  useEffect(() => {
    const el = stageRef.current
    const size = el ? Math.round(el.getBoundingClientRect().width) : 280
    setS(size)
    const b = size / Math.min(w, h)
    setZoom(1)
    setPos({ x: (size - w * b) / 2, y: (size - h * b) / 2 })
  }, [img, w, h])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    document.body.classList.add('no-scroll')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('no-scroll')
    }
  }, [onCancel])

  function zoomTo(z: number, cx = S / 2, cy = S / 2) {
    const nz = Math.min(4, Math.max(1, z))
    const ns = base * nz
    // keep the point under (cx, cy) in place
    const ix = (cx - pos.x) / scale
    const iy = (cy - pos.y) / scale
    setZoom(nz)
    setPos(clamp(cx - ix * ns, cy - iy * ns, ns))
  }

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ dist: number; zoom: number } | null>(null)
  function down(e: RPointerEvent) {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      gesture.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom }
    }
  }
  function move(e: RPointerEvent) {
    const prev = pointers.current.get(e.pointerId)
    if (!prev) return
    const cur = { x: e.clientX, y: e.clientY }
    pointers.current.set(e.pointerId, cur)
    if (pointers.current.size === 2 && gesture.current) {
      const [a, b] = [...pointers.current.values()]
      const rect = stageRef.current!.getBoundingClientRect()
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      zoomTo(gesture.current.zoom * (d / gesture.current.dist), (a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top)
    } else if (pointers.current.size === 1) {
      setPos((p) => clamp(p.x + cur.x - prev.x, p.y + cur.y - prev.y, scale))
    }
  }
  function up(e: RPointerEvent) {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) gesture.current = null
  }
  function wheel(e: RWheelEvent) {
    const rect = stageRef.current!.getBoundingClientRect()
    zoomTo(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1), e.clientX - rect.left, e.clientY - rect.top)
  }

  return (
    <div className="crop-overlay" role="dialog" aria-modal="true" aria-label={t('cropTitle')}>
      <div className="crop-sheet">
        <h2 className="card-title">{t('cropTitle')}</h2>
        <div className="crop-stage" ref={stageRef} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel}>
          <img src={img.src} alt="" draggable={false}
            style={{ width: w * scale, height: h * scale, transform: `translate(${pos.x}px, ${pos.y}px)` }} />
          <div className="crop-frame" aria-hidden="true" />
        </div>
        <label className="crop-zoom">
          <Icon name="image" size={16} />
          <input type="range" min={1} max={4} step={0.01} value={zoom} aria-label={t('cropZoom')}
            onChange={(e) => zoomTo(Number(e.target.value))} />
          <Icon name="image" size={22} />
        </label>
        <p className="small muted center">{t('cropHint')}</p>
        <div className="crop-actions">
          <button type="button" className="btn lg" onClick={onCancel}>{t('cancel')}</button>
          <button type="button" className="btn primary lg" onClick={() => onDone(-pos.x / scale, -pos.y / scale, S / scale)}>{t('cropSave')}</button>
        </div>
      </div>
    </div>
  )
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
  const [crop, setCrop] = useState<{ img: HTMLImageElement; url: string } | null>(null)
  function closeCrop() {
    if (crop) URL.revokeObjectURL(crop.url)
    setCrop(null)
    if (input.current) input.current.value = ''
  }
  async function pick(file: File | undefined) {
    if (!file) return
    setMsg(null)
    try {
      setCrop(await loadImage(file))
    } catch {
      setMsg({ text: t('shopPhotoBad'), error: true })
      if (input.current) input.current.value = ''
    }
  }
  async function save(sx: number, sy: number, side: number) {
    if (!crop) return
    setBusy(true)
    try {
      let blob: Blob
      try {
        blob = await cropJpeg(crop.img, sx, sy, side)
      } catch {
        return setMsg({ text: t('shopPhotoBad'), error: true })
      } finally {
        closeCrop()
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
    }
  }
  async function remove() {
    if (!await askConfirm(t('shopPhotoRemoveAsk'), { icon: 'image' })) return
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
      {crop && <PhotoCropper img={crop.img} onCancel={closeCrop} onDone={(x, y, side) => void save(x, y, side)} />}
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

/** Small hover/tap menu: opens on mouse hover (desktop) or tap, closes on outside tap. */
function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  const hover = {
    onPointerEnter: (e: RPointerEvent) => { if (e.pointerType === 'mouse') setOpen(true) },
    onPointerLeave: (e: RPointerEvent) => { if (e.pointerType === 'mouse') setOpen(false) }
  }
  return { open, setOpen, ref, hover }
}

/** Shows only the current theme; hover or tap to pick Light / Dark / Auto. */
/** Desktop web/Windows: bell next to "Shop open" with what needs the owner's attention. */
function NotifyMenu({ active, paperLow, paperN, blocked, onGo, onHelp }: { active: number; paperLow: boolean; paperN: number; blocked: boolean; onGo: (t: Tab) => void; onHelp?: () => void }) {
  const { t } = useI18n()
  const p = usePopover()
  const push = pushState()
  const notices = useNotices()
  const items: { icon: string; text: string; sub?: string; tab?: Tab; warn?: boolean; run?: () => void }[] = []
  if (blocked) items.push({ icon: 'alert', text: t('blockedTitle'), warn: true })
  for (const n of notices) {
    const title = n.kind === 'support' ? t('ntSupportTitle') : n.kind === 'expiring' ? t('ntExpTitle') : n.kind === 'nudge' ? t('ntNudgeTitle') : (n.title || t('ntAdminTitle'))
    const body = n.kind === 'support' || n.kind === 'admin' ? (n.body || '') : ''
    items.push({ icon: n.kind === 'support' ? 'mail' : n.kind === 'expiring' ? 'star' : 'bell', text: title, sub: body.length > 90 ? body.slice(0, 88) + '…' : body,
      tab: n.kind === 'expiring' ? 'plan' as Tab : undefined,
      run: () => { readNotice(n.id); if (n.kind === 'support') onHelp?.() } })
  }
  if (active > 0) items.push({ icon: 'orders', text: `${t('dActive')}: ${active}`, tab: 'orders' })
  if (paperLow) items.push({ icon: 'alert', text: t('paperLow', { n: paperN }), tab: 'settings', warn: true })
  const badge = items.length
  if (push === 'blocked') items.push({ icon: 'bell', text: t('pushBlockedPc') })
  else if (push === 'pending') items.push({ icon: 'bell', text: t('pushNotReady') })
  return (
    <div className="pop-wrap notif-wrap" ref={p.ref}>
      <button type="button" className="bar-btn notif-btn" onClick={() => p.setOpen((v) => !v)} aria-label={t('notifTitle')} aria-expanded={p.open} title={t('notifTitle')}>
        <Icon name="bell" size={18} />
        {badge > 0 && <span className="notif-badge">{badge}</span>}
      </button>
      {p.open && (
        <div className="pop-menu notif-menu" role="menu">
          <div className="pop-title">{t('notifTitle')}</div>
          {items.length === 0 && <p className="notif-none">{t('notifNone')}</p>}
          {items.map((x, i) => (
            <button key={i} type="button" role="menuitem" className={x.warn ? 'warn' : ''} disabled={!x.tab && !x.run}
              onClick={() => { x.run?.(); if (x.tab) onGo(x.tab); if (x.tab || x.run) p.setOpen(false) }}>
              <Icon name={x.icon} size={16} /> <span>{x.text}{x.sub && <small className="notif-sub">{x.sub}</small>}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Computer top bar: lock button with its own popup. PIN on: Lock now + timer / change / turn off. No PIN yet: set one right here. */
function LockMenu({ uid, enabled, onLock }: { uid: string; enabled: boolean; onLock: () => boolean }) {
  const { t } = useI18n()
  const p = usePopover()
  return (
    <div className="pop-wrap" ref={p.ref}>
      <button type="button" className="bar-btn lock-btn" onClick={() => p.setOpen((v) => !v)} aria-label={t('lockCardTitle')}
        aria-expanded={p.open} aria-haspopup="dialog" title={t('lockCardTitle')}>
        <Icon name="lock" size={18} />
      </button>
      {p.open && (
        <div className="pop-menu lock-menu" role="dialog" aria-label={t('lockCardTitle')}>
          <div className="pop-title">{t('lockCardTitle')}</div>
          {enabled && (
            <div className="lock-now-row">
              <button type="button" className="btn primary block lock-now" onClick={() => { p.setOpen(false); onLock() }}>
                <Icon name="lock" size={18} /> {t('lockNow')}
              </button>
            </div>
          )}
          <AppLockCard uid={uid} compact />
        </div>
      )}
    </div>
  )
}

function ThemeMenu() {
  const { t } = useI18n()
  const { pref, setTheme } = useTheme()
  const p = usePopover()
  const opts: { id: ThemePref; label: Key; icon: string }[] = [
    { id: 'light', label: 'themeLight', icon: 'sun' },
    { id: 'dark', label: 'themeDark', icon: 'moon' },
    { id: 'system', label: 'themeAuto', icon: 'auto' }
  ]
  const cur = opts.find((o) => o.id === pref) || opts[2]
  return (
    <div className="pop-wrap" ref={p.ref} {...p.hover}>
      <button type="button" className="bar-btn" onClick={() => p.setOpen((v) => !v)} aria-label={t('theme')} aria-expanded={p.open} title={t(cur.label)}>
        <Icon name={cur.icon} size={20} />
      </button>
      {p.open && (
        <div className="pop-menu" role="menu">
          <div className="pop-title">{t('theme')}</div>
          {opts.map((o) => (
            <button key={o.id} type="button" role="menuitemradio" aria-checked={pref === o.id} className={pref === o.id ? 'on' : ''}
              onClick={() => { setTheme(o.id); p.setOpen(false) }}>
              <Icon name={o.icon} size={16} /> <span>{t(o.label)}</span>{pref === o.id && <span className="pop-dot" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Shows only the current language; hover or tap to switch EN / हिंदी. */
function LangMenu() {
  const { lang, setLang, t } = useI18n()
  const p = usePopover()
  const opts: { id: 'en' | 'hi'; short: string; label: string }[] = [
    { id: 'en', short: 'EN', label: 'English' },
    { id: 'hi', short: 'हिं', label: 'हिंदी' }
  ]
  const cur = opts.find((o) => o.id === lang) || opts[0]
  return (
    <div className="pop-wrap" ref={p.ref} {...p.hover}>
      <button type="button" className="bar-btn lang-btn" onClick={() => p.setOpen((v) => !v)} aria-label={t('language')} aria-expanded={p.open}>
        {cur.short}
      </button>
      {p.open && (
        <div className="pop-menu" role="menu">
          <div className="pop-title">{t('language')}</div>
          {opts.map((o) => (
            <button key={o.id} type="button" role="menuitemradio" aria-checked={lang === o.id} className={lang === o.id ? 'on' : ''}
              lang={o.id} onClick={() => { setLang(o.id); p.setOpen(false) }}>
              <span>{o.label}</span>{lang === o.id && <span className="pop-dot" />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Computer status bar: Help & support opens here as a popup (bottom right, above the bar). */
function HelpPopup({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="adm-notif-back help-pop-back no-print" onClick={onClose}>
      <div className="adm-notif help-pop" role="dialog" aria-modal="true" aria-label={t('supTitle')} onClick={(e) => e.stopPropagation()}>
        <div className="adm-notif-head">
          <b>{t('supTitle')}</b>
          <button type="button" className="menu-btn" onClick={onClose} aria-label={t('close')}><Icon name="x" size={20} /></button>
        </div>
        <div className="help-pop-body"><SupportCard /></div>
      </div>
    </div>
  )
}

/** Shop photo in the top-right corner; its menu holds open/closed, language, settings and log out. */
function ProfileMenu({ shop, planChip, onSettings, onLogout }: {
  shop: Shop; planChip: ReactNode; onSettings?: () => void; onLogout: () => void
}) {
  const { t } = useI18n()
  const p = usePopover()
  return (
    <div className="pop-wrap" ref={p.ref} {...p.hover}>
      <button type="button" className="avatar-btn" onClick={() => p.setOpen((v) => !v)} aria-label={shop.name} aria-expanded={p.open}>
        <ShopAvatar shop={shop} size={30} />
      </button>
      {p.open && (
        <div className="pop-menu profile-pop" role="menu">
          <div className="profile-head">
            <ShopAvatar shop={shop} size={40} />
            <div><strong>{shop.name}</strong>{planChip}</div>
          </div>
          {onSettings && <button type="button" onClick={() => { p.setOpen(false); onSettings() }}><Icon name="settings" size={16} /> <span>{t('tabSettings')}</span></button>}
          <button type="button" className="danger-item" onClick={onLogout}><Icon name="logout" size={16} /> <span>{t('logout')}</span></button>
        </div>
      )}
    </div>
  )
}

export default function Dashboard() {
  // Phone/tablet: status bar (app) and Android browser bar match the grey top bar (#e6e1d6 / dark #070b09).
  // Phone width (below 1024px): the bottom bar and the coloured top strip only exist here.
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1023.98px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023.98px)')
    const sync = () => {
      setNarrow(mq.matches)
      setTopColor(mq.matches ? { light: '#e6e1d6', dark: '#070b09' } : null)
    }
    sync()
    mq.addEventListener?.('change', sync)
    return () => { mq.removeEventListener?.('change', sync); setTopColor(null) }
  }, [])
  const { free_counter_limit: freeLimit } = useAppSettings()
  const { session, loading } = useSession()
  const { t, lang } = useI18n()
  const [menu, setMenu] = useState(false)
  // Shop PC app lock (PIN + idle timeout, this device only). The dashboard stays mounted under the lock.
  const appLock = useAppLock(session?.user.id)
  const [secOpen, setSecOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    if (appLock.locked) el.setAttribute('inert', '')
    else el.removeAttribute('inert')
  })
  const [sb, setSbState] = useState<SbMode>(savedSidebar)
  const [sbMenu, setSbMenu] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const supUnread = useNotices().filter((n) => n.kind === 'support').length
  const setSb = (m: SbMode) => {
    setSbState(m)
    setSbMenu(false)
    try { localStorage.setItem('pq_sidebar', m) } catch { /* ignore */ }
  }
  // Swipe left on the open menu to close it (the menu and the dim follow the finger, like Receipto).
  const drawerRef = useRef<HTMLElement>(null)
  const scrimRef = useRef<HTMLDivElement>(null)
  const swipe = useRef<{ x: number; y: number; dx: number; t: number; v: number; horiz: boolean | null } | null>(null)
  const swipeRaf = useRef(0)
  function swipeStart(e: RTouchEvent) {
    const p = e.touches[0]
    swipe.current = { x: p.clientX, y: p.clientY, dx: 0, t: e.timeStamp, v: 0, horiz: null }
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
      if (s.horiz) {
        el.style.transition = 'none'
        if (scrimRef.current) scrimRef.current.style.transition = 'none'
      }
    }
    if (!s.horiz) return
    const next = Math.min(0, dx)
    const dt = Math.max(1, e.timeStamp - s.t)
    s.v = (next - s.dx) / dt
    s.dx = next
    s.t = e.timeStamp
    // one style write per frame: touchmove can fire faster than the screen draws
    if (!swipeRaf.current) swipeRaf.current = requestAnimationFrame(() => {
      swipeRaf.current = 0
      const cur = swipe.current
      if (!cur || !drawerRef.current) return
      drawerRef.current.style.transform = `translate3d(${cur.dx}px,0,0)`
      const w = drawerRef.current.offsetWidth + 24
      if (scrimRef.current) scrimRef.current.style.opacity = String(Math.max(0, 1 + cur.dx / w))
    })
  }
  function swipeEnd() {
    const s = swipe.current
    const el = drawerRef.current
    swipe.current = null
    cancelAnimationFrame(swipeRaf.current)
    swipeRaf.current = 0
    if (!s || !el || !s.horiz) return
    el.style.transition = ''
    el.style.transform = ''
    if (scrimRef.current) { scrimRef.current.style.transition = ''; scrimRef.current.style.opacity = '' }
    // close on a long drag, or on a quick flick to the left
    if (s.dx < -Math.min(80, el.offsetWidth * 0.25) || (s.v < -0.5 && s.dx < -20)) setMenu(false)
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
  const tabParam = (params.get('tab') as Tab) || 'orders'
  const [shop, setShop] = useState<Shop | null>(null)
  // Android app: new-order push notifications for this phone
  useEffect(() => { if (shop?.id) setupPush() }, [shop?.id])
  // true when the shop could not be loaded (no internet / server error). Never treat that as "no shop yet".
  const [loadErr, setLoadErr] = useState(false)
  const [counters, setCounters] = useState<Counter[]>([])
  // false until the v2 database update (supabase/migrations/2026-11-17-v2.sql) has been run
  const [v2, setV2] = useState(false)
  // Admin link in the drawer: shown only when the database says this account is an admin (v12).
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    // v36: admin_status().admin (true before the 2-step code too, so the link leads to the code screen). Older SQL: is_admin().
    supabase.rpc('admin_status').then(({ data, error }) => {
      if (!error && data && typeof data === 'object') { setIsAdmin((data as { admin?: boolean }).admin === true); return }
      supabase.rpc('is_admin').then((r) => setIsAdmin(!r.error && r.data === true))
    })
  }, [])

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
    setLoadErr(false)
    let res: { data: unknown; error: unknown }
    try {
      res = await supabase.from('shops').select('*').eq('owner_id', session.user.id).maybeSingle()
    } catch (e) {
      res = { data: null, error: e }
    }
    const { data, error } = res
    if (error) {
      // Offline or server error: show the retry screen, never the setup form.
      setLoadErr(true)
      return
    }
    if (!data) {
      // No shop of its own: maybe this login is staff at a Plus shop (v17).
      const st = await supabase.rpc('my_staff_shop').then((r) => r, () => ({ data: null, error: true }))
      if (!st.error && st.data && typeof st.data === 'object') {
        setShop(st.data as Shop)
        if ((st.data as Shop).staff_active) void loadCounters((st.data as Shop).id)
      } else nav('/setup', { replace: true })
    } else {
      setShop(data as Shop)
      void loadCounters((data as Shop).id)
    }
  }, [session, nav, loadCounters])

  useEffect(() => {
    if (loading) return
    if (!session) nav('/login', { replace: true })
    else void loadShop()
  }, [session, loading, nav, loadShop])

  // Coming back online after a failed load: try again by itself.
  useEffect(() => {
    if (!loadErr) return
    const on = () => void loadShop()
    window.addEventListener('online', on)
    return () => window.removeEventListener('online', on)
  }, [loadErr, loadShop])

  async function toggleOpen() {
    if (!shop) return
    const { data, error } = await supabase.from('shops').update({ is_open: !shop.is_open }).eq('id', shop.id).select().single()
    if (!error && data) setShop(data as Shop)
  }

  const [activeCount, setActiveCount] = useState<number | null>(null)

  // Paper stock (v23, owner only): re-read after order changes, since marking Done takes sheets off in the DB.
  const paperOn = useRef(false)
  paperOn.current = !!shop && !shop.staff && shop.paper_sheets !== null && shop.paper_sheets !== undefined
  const refreshPaper = useCallback(async (shopId: string) => {
    if (!paperOn.current) return
    const { data, error } = await supabase.from('shops').select('paper_sheets, paper_low_at, paper_alerted_at').eq('id', shopId).maybeSingle()
    if (!error && data) setShop((s) => (s && s.id === shopId ? { ...s, ...(data as Partial<Shop>) } : s))
  }, [])
  const paperLow = paperOn.current && Number(shop?.paper_sheets) < Number(shop?.paper_low_at ?? 200)
  // Browser fallback for the low-paper push: one notification per alert, only when this tab is in the background.
  useEffect(() => {
    const at = shop?.paper_alerted_at
    if (!paperLow || !at) return
    try {
      if (localStorage.getItem('pq-paper-alert') === at) return
      localStorage.setItem('pq-paper-alert', at)
    } catch { /* ignore */ }
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification(t('paperTitle'), { body: t('paperLow', { n: Number(shop?.paper_sheets) }), tag: 'paper-low' }) } catch { /* ignore */ }
    }
  }, [paperLow, shop?.paper_alerted_at]) // eslint-disable-line react-hooks/exhaustive-deps
  const [appVer] = useState(() => {
    try {
      const v = nativeBridge()?.appVersion?.() || (navigator.userAgent.match(/PrintQR\/(\d[\d.]*)/i) || [])[1] || ''
      return (v ? 'v' + v + ' · ' : 'Web · ') + 'build ' + __BUILD__
    } catch { return 'build ' + __BUILD__ }
  })

  const [loggingOut, setLoggingOut] = useState(false)
  async function logout() {
    if (!await askConfirm(t('logoutAsk'), { icon: 'logout', ok: t('logout') })) return
    setLoggingOut(true)
    // Slow net must not keep the user waiting: each step gets a time cap, then the local session is cleared anyway.
    const cap = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<void>((r) => setTimeout(r, ms))])
    await cap(removePush().catch(() => {}), 1500)
    const done = await cap(supabase.auth.signOut().then(() => true, () => false), 1500)
    if (done !== true) await supabase.auth.signOut({ scope: 'local' }).catch(() => {})
    nav('/', { replace: true })
  }

  if (!shop && loadErr) {
    return (
      <div className="app-page">
        <TopBar to={null} wide lang={false} />
        <div className="page">
          <div className="card empty" role="alert">
            <span className="state-icon" aria-hidden="true"><Icon name="wifi" size={28} /></span>
            <strong>{t('netOffTitle')}</strong>
            <p className="muted small">{t('netOffSub')}</p>
            <button type="button" className="btn primary lg" onClick={() => void loadShop()}>{t('netRetry')}</button>
          </div>
        </div>
      </div>
    )
  }

  if (!shop) {
    return (
      <DashSkeleton tab={isTab(tabParam) ? tabParam : 'orders'} />
    )
  }

  // Staff login (Plus, v17): Orders only. No billing, settings, rates, QR or admin.
  const staff = !!shop.staff
  const tab: Tab = staff ? 'orders' : tabParam
  if (staff && !shop.staff_active) {
    return (
      <div className="app-page">
        <TopBar to={null} wide />
        <div className="page">
          <div className="card empty" role="alert">
            <span className="state-icon" aria-hidden="true"><Icon name="lock" size={28} /></span>
            <strong>{t('staffPausedTitle', { name: shop.name })}</strong>
            <p className="muted small">{t('staffPausedSub')}</p>
            <button type="button" className="btn danger lg" onClick={logout}><Icon name="logout" size={18} /> {t('logout')}</button>
          </div>
        </div>
      </div>
    )
  }
  // Before the v3 database update there are no plans: no ads, no locks (old behaviour).
  const ready = plansReady(shop)
  const pro = shopIsPro(shop)
  const plus = shopIsPlus(shop)
  const free = ready && !pro
  const planLabel = plus ? t('planPlus') : pro ? t('planPro') : t('planFree')
  // New counters allowed: Free = admin setting, Pro = 2, Plus = no limit.
  const counterLimit = free ? freeLimit : ready && !plus ? PRO_COUNTER_LIMIT : Infinity
  // Free shops can use only the first freeLimit counters (admin setting; the rest show a lock).
  const usable = free ? counters.slice(0, freeLimit) : counters
  const goPlan = () => setParams({ tab: 'plan' })

  const current = TABS.find((x) => x.id === tab) || TABS[0]
  // Only below 1024px: at desktop width the bar is hidden (.m-only), so the drawer must keep every tab.
  const bottomNav = ON_ANDROID && !staff && narrow
  // Android phone: Settings is a grouped list; ?s=<key> opens one section as its own page (back button returns).
  const setSub = params.get('s')
  // In the app the bottom bar holds BOTTOM, so the drawer keeps only the rest (Rates, Plan).
  const nav_ = staff ? [{ group: 'navShop' as Key, items: ['orders' as Tab] }]
    : bottomNav ? NAV.map((g) => ({ ...g, items: g.items.filter((id) => !BOTTOM.includes(id)) })).filter((g) => g.items.length)
    : NAV
  const go = (id: Tab) => {
    setMenu(false)
    ;(document.activeElement as HTMLElement | null)?.blur?.()
    setParams({ tab: id })
    window.scrollTo(0, 0)
  }
  // Lock now; with no PIN yet, open the App lock settings instead.
  const lockNow = () => {
    setMenu(false)
    if (appLock.lock()) return
    if (staff) return setSecOpen(true)
    if (bottomNav) setParams({ tab: 'settings', s: 'lock' })
    else setParams({ tab: 'settings' })
    setTimeout(() => document.getElementById('app-lock')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 120)
  }
  const openToggle = (
    <button type="button" className={`toggle ${shop.is_open ? 'is-open' : 'is-closed'}`} onClick={toggleOpen} aria-pressed={shop.is_open}>
      <span className="toggle-dot" />
      <span className="toggle-label">{shop.is_open ? t('shopOpen') : t('shopClosed')}</span>
    </button>
  )

  return (
    <>
    <div ref={rootRef} className={`app-page dash sb-${sb}${sbMenu ? ' sb-pinned' : ''}${menu ? ' menu-open' : ''}${bottomNav ? ' has-bnav' : ''}${appLock.locked ? ' app-locked' : ''}`}
      onClick={unlockAudio} aria-hidden={appLock.locked || undefined}>
      {loggingOut && (
        <div className="cf-back" role="status" aria-live="polite">
          <div className="cf-box cf-busy"><span className="spinner dark" aria-hidden="true" /> {t('loggingOut')}</div>
        </div>
      )}
      <header className="topbar dash-bar no-print">
        <div className="topbar-in wide">
          <button type="button" className="menu-btn" onClick={() => setMenu(true)} aria-label={t('menu')} aria-expanded={menu}>
            <Icon name="menu" size={24} />
          </button>
          {/* Desktop web/Windows: logo in the top-left corner, above the icon bar */}
          {!IN_APP && <span className="bar-logo"><LogoMark size={28} /></span>}
          {/* Android app only: animated print-shop story in the empty space of the phone bar */}
          {IN_APP && <BarStory />}
          {/* Phone/tablet: current page as a Supabase-style tab on the right of the bar */}
          <div className="bar-tab m-only" aria-current="page">
            <Icon name={current.icon} size={16} />
            <span>{t(current.label)}</span>
          </div>
          <div className="bar-title d-only">
            {/* Desktop web/Windows: current page as a tab that flows into the page panel (like the app's bar-tab) */}
            <div className="bar-dtab" aria-current="page">
              <Icon name={current.icon} size={16} />
              <h1>{t(current.label)}</h1>
            </div>
          </div>
          <div className="bar-actions d-only">
            {!staff && openToggle}
            {!IN_APP && <NotifyMenu active={activeCount ?? 0} paperLow={!!paperLow} paperN={Number(shop.paper_sheets)} blocked={!!shop.blocked} onGo={go} onHelp={staff ? undefined : () => setHelpOpen(true)} />}
            {session && <LockMenu uid={session.user.id} enabled={appLock.enabled} onLock={appLock.lock} />}
            <LangMenu />
            <ThemeMenu />
            <ProfileMenu shop={shop} onSettings={staff ? undefined : () => go('settings')} onLogout={logout}
              planChip={staff ? <span className="plan-chip">{t('staffChip')}</span> : ready ? <span className={`plan-chip${pro ? ' is-pro' : ''}`}>{planLabel}</span> : null} />
          </div>
        </div>
      </header>

      <div className="drawer-scrim no-print" ref={scrimRef} onClick={() => setMenu(false)} aria-hidden="true" />
      <aside className="drawer no-print" aria-label={t('menu')} ref={drawerRef}
        onTouchStart={swipeStart} onTouchMove={swipeMove} onTouchEnd={swipeEnd} onTouchCancel={swipeEnd}>
        <div className="drawer-head">
          <ShopAvatar shop={shop} size={44} />
          <div className="drawer-title">
            <strong>{shop.name}</strong>
            {shop.address && <span className="drawer-sub m-only">{shop.address}</span>}
            {staff ? <span className="plan-chip">{t('staffChip')}</span> : ready && <span className={`plan-chip${pro ? ' is-pro' : ''}`}>{planLabel}</span>}
          </div>
          <button type="button" className="drawer-close" onClick={() => setMenu(false)} aria-label={t('close')}>
            <Icon name="x" size={24} />
          </button>
        </div>
        <nav className="drawer-nav">
          {nav_.map((g) => (
            <div className="drawer-group" key={g.group}>
              <div className="drawer-label">{t(g.group)}</div>
              {g.items.map((id) => {
                const x = TABS.find((y) => y.id === id)!
                return (
                  <button key={id} type="button" className={`drawer-item${tab === id ? ' on' : ''}${id === 'orders' && activeCount ? ' has-fold' : ''}`}
                    aria-current={tab === id ? 'page' : undefined} title={t(x.label)} onClick={() => go(id)}>
                    <Icon name={x.icon} size={22} />
                    <span>{t(x.label)}</span>
                    {id === 'orders' && !!activeCount && <FoldCorner n={activeCount} corner="tr" size={34} />}
                    {id === 'orders' && !!activeCount && <b className="dock-badge" aria-hidden="true">{activeCount}</b>}
                  </button>
                )
              })}
            </div>
          ))}
          <div className="drawer-group">
            {/* Computer: the lock lives in the top bar (popup), so the sidebar doesn't repeat it */}
            <button type="button" className="drawer-item m-only" title={t('lockNow')} onClick={lockNow}>
              <Icon name="lock" size={22} />
              <span>{t('lockNow')}</span>
            </button>
            {staff && (
              <button type="button" className="drawer-item" title={t('secTitle')} onClick={() => { setMenu(false); setSecOpen(true) }}>
                <Icon name="shield" size={22} />
                <span>{t('secTitle')}</span>
              </button>
            )}
          </div>
          {staff && (
            <div className="drawer-group">
              <button type="button" className="drawer-item" onClick={logout}>
                <Icon name="logout" size={22} />
                <span>{t('logout')}</span>
              </button>
            </div>
          )}
          {isAdmin && !staff && (
            <div className="drawer-group">
              <div className="drawer-label">{t('admTitle')}</div>
              <button type="button" className="drawer-item" onClick={() => { setMenu(false); nav('/admin') }}>
                <Icon name="shield" size={22} />
                <span>{t('admTitle')}</span>
              </button>
            </div>
          )}
        </nav>
        {/* Phone/tablet only (hidden at >=1024px): the original drawer footer */}
        <div className="drawer-foot m-only">
          <div className="drawer-foot-row">
            {!staff && openToggle}
            <LangToggle />
          </div>
          <ThemeToggle />
        </div>
        <div className="sb-control">
          {sbMenu && (
            <div className="sb-pop" role="menu">
              <div className="sb-pop-title">{t('sbControl')}</div>
              {(['expanded', 'collapsed', 'hover'] as SbMode[]).map((m) => (
                <button key={m} type="button" role="menuitemradio" aria-checked={sb === m} className={sb === m ? 'on' : ''} onClick={() => setSb(m)}>
                  <span className="sb-dot" />{t(m === 'expanded' ? 'sbExpanded' : m === 'collapsed' ? 'sbCollapsed' : 'sbHover')}
                </button>
              ))}
            </div>
          )}
          <button type="button" className="sb-btn" onClick={() => setSbMenu((v) => !v)} aria-label={t('sbControl')} aria-expanded={sbMenu} title={t('sbControl')}>
            <Icon name={sb === 'expanded' ? 'sbClose' : 'sbOpen'} size={18} />
          </button>
        </div>
      </aside>

      {/* Desktop web + Windows app only (CSS hides it below 1024px and in the Android app): VS Code style status bar */}
      {!IN_APP && (
        <footer className="dash-status no-print" aria-label={t('menu')}>
          <span>{t('dActive')}: {activeCount ?? 0}</span>
          {!staff && (
            <button type="button" className="end status-help" onClick={() => setHelpOpen(true)} title={t('supTitle')} aria-label={t('supTitle')}>
              <Icon name="mail" size={14} /> <span>{t('supTitle')}</span>{supUnread > 0 && <i className="status-dot" aria-hidden="true" />}
            </button>
          )}
          {!staff && ready && <span>{planLabel}</span>}
        </footer>
      )}
      {!IN_APP && !staff && helpOpen && <HelpPopup onClose={() => setHelpOpen(false)} />}

      <div className="page wide dash-main">
        <AppDownloadBanner />
        {!staff && <ShopNotices onPlan={goPlan} />}
        {shop.blocked && (
          <div className="notice error" role="alert">
            <strong>{t('blockedTitle')}</strong> {t('blockedBody')}{shop.blocked_reason ? ` ${t('blockedReason', { r: shop.blocked_reason })}` : ''}
          </div>
        )}
        {paperLow && tab !== 'settings' && (
          <div className="notice error paper-banner" role="alert">
            <Icon name="alert" size={18} /> <strong>{t('paperLow', { n: Number(shop.paper_sheets) })}</strong>
            <button type="button" className="btn small" onClick={() => go('settings')}>{t('paperUpdate')}</button>
          </div>
        )}
        {tab === 'orders' && <Orders shop={shop} counters={counters} onCount={setActiveCount} autoPrintAllowed={!ready || pro} onUpgrade={staff ? undefined : goPlan} onPaper={() => void refreshPaper(shop.id)} />}
        {ready && !plus && !staff && tab === 'orders' && <AdSlot className="dash-ad" />}
        {tab === 'rates' && <RatesTab shop={shop} v2={v2} passportLocked={free} onUpgrade={goPlan} onSaved={setShop} />}
        {tab === 'qr' && (
          <QrTab shop={shop} counters={usable} counterId={params.get('c') || ''} pro={pro} free={free} plus={!ready || plus} onUpgrade={goPlan} onSaved={setShop}
            onCounter={(c) => setParams(c ? { tab: 'qr', c } : { tab: 'qr' }, { replace: true })} />
        )}
        {tab === 'edit' && (
          <Suspense fallback={<EditorSkel />}>
            <Editor />
          </Suspense>
        )}
        {tab === 'report' && <Report shop={shop} onUpgrade={goPlan} />}
        {tab === 'settings' && bottomNav && !setSub && (
          <SettingsHub plus={!ready || plus} free={ready && free} onOpen={(k) => setParams({ tab: 'settings', s: k })} onPlan={goPlan} onLogout={logout}
            version={appVer ? 'PrintQR ' + appVer : ''} />
        )}
        {tab === 'settings' && (!bottomNav || setSub) && (
          <>
            {bottomNav && (
              <button type="button" className="set-back" onClick={() => nav(-1)}><Icon name="chevl" size={22} /> {t('tabSettings')}</button>
            )}
            {(!bottomNav || setSub === 'shop') && <Settings shop={shop} onSaved={setShop} onUpgrade={goPlan} />}
            {(!bottomNav || setSub === 'hours') && <HoursCard shop={shop} onSaved={setShop} />}
            {(!bottomNav || setSub === 'paper') && <PaperCard shop={shop} onSaved={setShop} />}
            {(!bottomNav || setSub === 'brand') && <BrandCard shop={shop} plus={!ready || plus} onSaved={setShop} onUpgrade={goPlan} />}
            {(!bottomNav || setSub === 'staff') && <StaffCard shop={shop} plus={!ready || plus} onUpgrade={goPlan} />}
            {(!bottomNav || setSub === 'counters') && <CountersCard shop={shop} counters={counters} usable={usable.length} locked={free} limit={counterLimit} needPlus={pro} v2={v2}
              onChanged={() => loadCounters(shop.id)} onUpgrade={goPlan}
              onShowQr={(c) => setParams({ tab: 'qr', c })} />}
            {(!bottomNav || setSub === 'lock') && session && <div className="m-only"><AppLockCard uid={session.user.id} /></div>}
            {(!bottomNav || setSub === 'devices') && <DevicesCard />}
            {(!bottomNav || setSub === 'support') && !staff && <div className={IN_APP ? undefined : 'm-only'}><SupportCard /></div>}
          </>
        )}
        {tab === 'settings' && !bottomNav && (
          <>
            <button type="button" className="btn danger block lg logout-btn m-only" onClick={logout}><Icon name="logout" size={18} /> {t('logout')}</button>
            {appVer && <p className="app-version">PrintQR {appVer}{isAdmin
              ? (pushStatus() ? ' · push: ' + pushStatus() : '')
              : ({ on: ' · ' + t('pushOn'), blocked: ' · ' + t('pushBlocked'), pending: ' · ' + t('pushNotReady'), '': '' } as const)[pushState()]}</p>}
          </>
        )}
        {tab === 'plan' && <PlanTab shop={shop} email={session?.user.email || undefined} contact={accountPhone(session?.user)} onChanged={loadShop} />}
      </div>

      {bottomNav && (
        <nav className="bnav m-only no-print" aria-label={t('menu')}>
          {BOTTOM.map((id) => {
            const x = TABS.find((y) => y.id === id)!
            return (
              <button key={id} type="button" className={`bnav-item${id === 'orders' ? ' bnav-main' : ''}${tab === id ? ' on' : ''}`}
                aria-current={tab === id ? 'page' : undefined} onClick={() => go(id)}>
                <span className="bnav-ic">
                  <Icon name={x.icon} size={id === 'orders' ? 26 : 22} />
                  {id === 'orders' && !!activeCount && <span className="bnav-badge">{activeCount > 99 ? '99+' : activeCount}</span>}
                </span>
                <span className="bnav-lbl">{t(x.label)}</span>
              </button>
            )
          })}
        </nav>
      )}
    </div>
    {appLock.locked && session && <LockOverlay uid={session.user.id} shopName={shop.name} onUnlock={appLock.unlock} />}
    {secOpen && !appLock.locked && session && (
      <div className="cf-back sec-back" role="dialog" aria-modal="true" aria-label={t('secTitle')} onClick={(e) => { if (e.target === e.currentTarget) setSecOpen(false) }}>
        <div className="sec-sheet">
          <div className="sec-head">
            <strong>{t('secTitle')}</strong>
            <button type="button" className="drawer-close" onClick={() => setSecOpen(false)} aria-label={t('close')}><Icon name="x" size={22} /></button>
          </div>
          <AppLockCard uid={session.user.id} />
          <DevicesCard />
        </div>
      </div>
    )}
    </>
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

function Orders({ shop, counters, onCount, canPrint = true, autoPrintAllowed = false, onUpgrade, onPaper }: {
  shop: Shop; counters: Counter[]; onCount?: (n: number) => void; canPrint?: boolean
  /** Auto-print new orders (Windows app) is Pro / Plus; manual direct print is free. */
  autoPrintAllowed?: boolean
  onUpgrade?: () => void
  /** Orders changed (maybe one became Done): re-read the paper stock (v23). */
  onPaper?: () => void
}) {
  const { t, tn, te, lang } = useI18n()
  const [orders, setOrders] = useState<Order[]>([])
  const [loaded, setLoaded] = useState(false)
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
  const [info, setInfo] = useState<string | null>(null)
  // Windows app: print straight to a printer (free on every plan).
  const desk = canPrint ? desktopApi() : null
  // Start printing (Pro / Plus, Windows app): the tap also sends the order's files to the printer.
  const startPrints = !!desk && autoPrintAllowed
  const [printers, setPrinters] = useState<DesktopPrinter[]>([])
  const [printer, setPrinterState] = useState(savedPrinter)
  const [printingId, setPrintingId] = useState<string | null>(null)
  useEffect(() => {
    if (!desk) return
    desk.printers().then(setPrinters).catch(() => setPrinters([]))
  }, [desk])
  const known = useRef<Set<string> | null>(null)
  // Keep the latest translators in refs so the realtime subscription does not restart on language change.
  const tRef = useRef(t)
  const teRef = useRef(te)
  tRef.current = t
  teRef.current = te
  const paperRef = useRef(onPaper)
  paperRef.current = onPaper

  const load = useCallback(async (retry = true): Promise<void> => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setLoaded(true)
      return setErr(tRef.current('errOffline'))
    }
    const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString()
    const { data, error } = await supabase
      .from('orders')
      .select('*, order_files(*)')
      .eq('shop_id', shop.id)
      .neq('status', 'uploading')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
    if (error) {
      setLoaded(true)
      // Expired login after being offline: refresh it once and load again instead of showing a raw database error.
      if (isAuthError(error) && retry && (await recoverSession())) return load(false)
      return setErr(teRef.current(error))
    }
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
    setLoaded(true)
    setErr(null)
    paperRef.current?.()
  }, [shop.id])

  useEffect(() => {
    void load()
    const ch = supabase
      .channel('orders-' + shop.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `shop_id=eq.${shop.id}` }, () => void load())
      .subscribe()
    const timer = setInterval(() => void load(), 30000) // safety net if realtime drops
    // Back online: refresh the login first, then load the orders again by themselves.
    const onOnline = () => { void supabase.auth.refreshSession().catch(() => null).finally(() => void load()) }
    window.addEventListener('online', onOnline)
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    return () => {
      clearInterval(timer)
      window.removeEventListener('online', onOnline)
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

  async function printOne(o: Order, f: OrderFile): Promise<boolean> {
    if (!desk) return false
    const { data, error } = await supabase.storage.from('uploads').createSignedUrl(f.storage_path, 300)
    if (error || !data) {
      setErr(error ? te(error) : t('fileOpenFail'))
      return false
    }
    const r = await desk.print({
      url: data.signedUrl,
      name: f.file_name,
      // Passport / ID card sheets: the PDF already has every sheet; print it `copies` times, one side, never scaled.
      copies: Math.max(1, Number(f.copies) || 1),
      color: f.item_kind === 'passport' ? true : !!f.color,
      duplex: f.item_kind === 'passport' || f.item_kind === 'idcard' ? false : !!f.duplex,
      pages: f.item_kind === 'passport' || f.item_kind === 'idcard' ? null : f.page_range,
      kind: f.item_kind || 'print',
      printer
    }).catch(() => ({ ok: false }))
    if (!r.ok) setErr(t('dpFail'))
    return r.ok
  }

  async function printDirect(o: Order, files: OrderFile[], claimed = false) {
    if (!desk || printingId) return
    setErr(null)
    if (!claimed) setInfo(null)
    setPrintingId(files.length === 1 ? files[0].id : o.id)
    let ok = true
    for (const f of files) {
      if (!(await printOne(o, f))) { ok = false; break }
    }
    setPrintingId(null)
    if (ok) {
      setInfo(t('dpSent', { token: o.token }))
      if (!claimed && o.status === 'received') void setStatus(o, 'printing')
    } else if (claimed) {
      // Nothing (or not everything) reached the printer: put the order back so it can be started again.
      setOrders((l) => l.map((x) => (x.id === o.id ? { ...x, status: 'received' } : x)))
      await supabase.from('orders').update({ status: 'received', updated_at: new Date().toISOString() }).eq('id', o.id).eq('status', 'printing')
    }
  }

  /**
   * v25: only one screen may start printing an order. The database moves it Received -> Printing only if it is
   * still Received, so a second device (owner + staff, PC + phone) gets "already started" instead of a second copy.
   */
  async function claimForPrint(o: Order): Promise<boolean> {
    const { data, error } = await supabase.from('orders')
      .update({ status: 'printing', updated_at: new Date().toISOString() })
      .eq('id', o.id).eq('status', 'received').select('id')
    if (error) {
      setErr(te(error))
      return false
    }
    if (!data || data.length === 0) {
      setInfo(t('dpAlreadyStarted', { token: o.token }))
      void load()
      return false
    }
    setOrders((l) => l.map((x) => (x.id === o.id ? { ...x, status: 'printing' } : x)))
    return true
  }

  /** v25: block the network this order came from (this shop only) and cancel its open orders. */
  async function blockSender(o: Order) {
    if (!await askConfirm(t('blockConfirm'), { icon: 'shield' })) return
    setErr(null)
    const { data, error } = await supabase.rpc('block_order_sender', { p_order_id: o.id })
    if (error) return setErr(te(error))
    const n = Number(data)
    setInfo(n < 0 ? t('blockNoId') : tn('blockDone_one', 'blockDone_other', n))
    void load()
  }

  /** v34: the shop marks an order Paid / Unpaid (UPI or cash). */
  async function setPaid(o: Order, paid: boolean) {
    setErr(null)
    const at = paid ? o.paid_at || new Date().toISOString() : null
    setOrders((l) => l.map((x) => (x.id === o.id ? { ...x, paid_at: at } : x)))
    const { error } = await supabase.rpc('set_order_paid', { p_order_id: o.id, p_paid: paid })
    if (error) {
      setErr(te(error))
      void load()
    }
  }

  /** v34: "Report file" holds the order (files kept for review, hidden here) and tells the PrintQR team. */
  const [reporting, setReporting] = useState<Order | null>(null)
  async function sendReport(o: Order, reason: FileReportReason, note: string): Promise<string | null> {
    const { error } = await supabase.rpc('report_order_files', { p_order_id: o.id, p_reason: reason, p_note: note.trim() || null })
    if (error) return te(error)
    setReporting(null)
    setOrders((l) => l.map((x) => (x.id === o.id ? { ...x, hold: true } : x)))
    setInfo(t('frSent', { token: o.token }))
    void load()
    return null
  }

  /** "Start printing": Pro / Plus in the Windows app also send the files to the printer; otherwise only the status moves. */
  async function startPrinting(o: Order) {
    const files = o.hold ? [] : (o.order_files || []).filter((f) => canDirectPrint(f.file_name))
    if (startPrints && !o.files_deleted && files.length) {
      if (printingId || !(await claimForPrint(o))) return
      return printDirect(o, files, true)
    }
    if (desk && !autoPrintAllowed && files.length) setInfo(t('apLocked'))
    return setStatus(o, 'printing')
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
    if (!await askConfirm(t('confirmDelete', { token: o.token }), { icon: 'trash' })) return
    // v24: photos may have a small '<path>.thumb.jpg' beside them (missing ones are ignored)
    const files = (o.order_files || []).map((f) => f.storage_path).filter(Boolean)
    const paths = files.flatMap((p) => [p, p + '.thumb.jpg'])
    if (paths.length) {
      const { error } = await supabase.storage.from('uploads').remove(paths)
      if (error) return setErr(te(error))
      // Mark the order "files deleted" only when nothing of it is left in storage (files and thumbnails):
      // remove() skips what it could not delete without an error, and a flag set too early hides the files from auto-delete.
      const folders = [...new Set(files.map((p) => p.split('/').slice(0, -1).join('/')))]
      for (const folder of folders) {
        const { data: left, error: listErr } = await supabase.storage.from('uploads').list(folder, { limit: 1000 })
        if (listErr) return setErr(te(listErr))
        if ((left || []).some((x) => paths.includes(`${folder}/${x.name}`))) return setErr(t('delFilesLeft'))
      }
    }
    const { error: upErr } = await supabase.from('orders').update({ files_deleted: true }).eq('id', o.id)
    if (upErr) return setErr(te(upErr))
    void load()
  }

  const keepHours = fileHours(shop)
  const shown = orders.filter((o) => matchesCounter(o, activeFilter))
  const active = shown.filter((o) => ['received', 'printing', 'ready'].includes(o.status))
  const finished = shown.filter((o) => ['done', 'cancelled'].includes(o.status))
  const allActive = orders.filter((o) => ['received', 'printing', 'ready'].includes(o.status)).length
  useEffect(() => { if (loaded) onCount?.(allActive) }, [loaded, allActive]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section>
      {err && <p className="notice error" role="alert"><Icon name="alert" size={18} /> <span>{err}</span></p>}
      {info && <p className="notice success" role="status"><Icon name="printer" size={18} /> <span>{info}</span></p>}
      {desk && printers.length > 0 && (
        <div className="counter-filter">
          <label className="small muted" htmlFor="printer-pick">{t('dpPrinter')}</label>
          <select id="printer-pick" value={printer} onChange={(e) => { setPrinterState(e.target.value); savePrinter(e.target.value) }}>
            <option value="">{t('dpDefaultPrinter')}{(() => { const d = printers.find((p) => p.isDefault); return d ? ` (${d.displayName})` : '' })()}</option>
            {printers.map((p) => <option key={p.name} value={p.name}>{p.displayName}</option>)}
          </select>
        </div>
      )}
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
      {!loaded && <OrdersSkel />}
      {loaded && (
        // Paper sheet with a folded top-left corner; the fold shows the active order count
        <div className={`card${active.length ? ' fold-card has-orders' : ' empty'}`} aria-label={`${t('dActive')}: ${active.length}`}>
          {active.length > 0 && <FoldCorner n={active.length} corner="tl" size={58} />}
          {active.length > 0 && (
            <div className="queue-summary" aria-hidden="true">
              {(['received', 'printing', 'ready'] as OrderStatus[]).map((st) => {
                const n = active.filter((o) => o.status === st).length
                return n ? <span key={st} className={`pill tiny s-${st}`}>{t(STATUS_TEXT[st])} · {n}</span> : null
              })}
            </div>
          )}
          {!active.length ? (
            <>
              <img className="no-orders-art" src={noOrdersArt} width={160} height={132} alt="" aria-hidden="true" />
              <strong>{t('noOrders')}</strong>
              <p className="muted small">{t('noOrdersSub')}</p>
            </>
          ) : (
            <div className="orders-grid">
              {active.map((o) => (
                <OrderCard key={o.id} o={o} keepHours={keepHours} lang={lang} onStatus={setStatus} onOpen={openFile} onDownload={downloadFile} onDelete={deleteFiles} onPrint={desk ? printDirect : undefined} onStart={startPrinting} onBlock={blockSender} onPaid={setPaid} onReport={setReporting} printingId={printingId} />
              ))}
            </div>
          )}
        </div>
      )}
      {finished.length > 0 && (
        <button type="button" className="btn ghost block show-done" onClick={() => setShowDone(!showDone)}>
          {showDone ? t('hideFinished') : t('showFinished', { n: finished.length })}
        </button>
      )}
      {showDone && (
        <div className="orders-grid">
          {finished.map((o) => (
            <OrderCard key={o.id} o={o} keepHours={keepHours} lang={lang} onStatus={setStatus} onOpen={openFile} onDownload={downloadFile} onDelete={deleteFiles} onPrint={desk ? printDirect : undefined} onStart={startPrinting} onBlock={blockSender} onPaid={setPaid} onReport={setReporting} printingId={printingId} />
          ))}
        </div>
      )}
      {reporting && <ReportFileDialog o={reporting} onClose={() => setReporting(null)} onSend={sendReport} />}
    </section>
  )
}

/** v34 "Report file": reason + optional note. The order's files are then kept for the PrintQR team and hidden here. */
function ReportFileDialog({ o, onClose, onSend }: {
  o: Order
  onClose: () => void
  onSend: (o: Order, reason: FileReportReason, note: string) => Promise<string | null>
}) {
  const { t } = useI18n()
  const [reason, setReason] = useState<FileReportReason | ''>('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!reason) return setErr(t('frPickReason'))
    setBusy(true)
    setErr(null)
    const m = await onSend(o, reason, note)
    setBusy(false)
    if (m) setErr(m)
  }
  return (
    <div className="cf-back" onClick={() => !busy && onClose()}>
      <form className="cf-box fr-box" role="dialog" aria-modal="true" aria-labelledby="fr-title" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <span className="cf-icon is-danger" aria-hidden="true"><Icon name="shield" size={22} /></span>
        <h2 id="fr-title" className="fr-title">{t('frTitle', { token: o.token })}</h2>
        <p className="small muted">{t('frSub')}</p>
        <fieldset className="fr-reasons">
          <legend className="small">{t('frReason')}</legend>
          {FILE_REPORT_REASONS.map((r) => (
            <label key={r} className={`fr-reason${reason === r ? ' on' : ''}`}>
              <input type="radio" name="fr-reason" value={r} checked={reason === r} disabled={busy} onChange={() => setReason(r)} />
              <span>{t(FILE_REPORT_REASON_KEY[r])}</span>
            </label>
          ))}
        </fieldset>
        <label className="field">
          <span>{t('frNote')}</span>
          <textarea rows={3} maxLength={500} value={note} disabled={busy} placeholder={t('frNoteHint')} onChange={(e) => setNote(e.target.value)} />
        </label>
        {reason === 'csam' && <p className="small fr-warn"><Icon name="alert" size={15} /> {t('frCsamWarn')}</p>}
        {err && <p className="notice error" role="alert"><Icon name="alert" size={18} /> <span>{err}</span></p>}
        <div className="cf-row">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="submit" className="btn danger" disabled={busy}>{busy ? t('pleaseWait') : t('frSend')}</button>
        </div>
      </form>
    </div>
  )
}

// Realistic page curl on a corner (tl or tr), showing a count. The corner behind the curl is painted
// in the surrounding colour (--fold-bg) so the page looks peeled; the flap has a curved edge, a light
// gradient and a soft shadow underneath.
let foldSeq = 0
function FoldCorner({ n, corner, size }: { n: number; corner: 'tl' | 'tr'; size: number }) {
  const [id] = useState(() => 'fc' + ++foldSeq)
  const S = size
  const edge = `M${S} 0 Q${S * 0.56} ${S * 0.56} 0 ${S}`
  const flap = `${edge} C${S * 0.36} ${S * 1.02} ${S * 0.72} ${S * 0.98} ${S * 0.9} ${S * 0.9} C${S * 0.98} ${S * 0.72} ${S * 1.02} ${S * 0.36} ${S} 0Z`
  return (
    <span className={`fold fold-${corner}`} style={{ width: S, height: S }} aria-hidden="true">
      <svg width={S + 8} height={S + 8} viewBox={`0 0 ${S + 8} ${S + 8}`}>
        <defs>
          <linearGradient id={id + 'g'} x1="0.25" y1="0.25" x2="0.85" y2="0.85">
            <stop offset="0" stopColor="#7fb31a" />
            <stop offset="0.35" stopColor="#b5e84a" />
            <stop offset="0.8" stopColor="#e4f7b8" />
            <stop offset="1" stopColor="#f6fce6" />
          </linearGradient>
          <filter id={id + 's'} x="-30%" y="-30%" width="160%" height="160%">
            <feDropShadow dx="2" dy="3" stdDeviation="2.4" floodColor="#000" floodOpacity="0.28" />
          </filter>
        </defs>
        <g transform={corner === 'tr' ? `translate(${S} 0) scale(-1 1)` : undefined}>
          <path d={`M0 0H${S} Q${S * 0.56} ${S * 0.56} 0 ${S}Z`} className="fold-bg" />
          <path d={flap} fill={`url(#${id}g)`} filter={`url(#${id}s)`} />
        </g>
      </svg>
      <b>{n}</b>
    </span>
  )
}


function OrderCard(props: {
  o: Order
  onStatus: (o: Order, s: OrderStatus) => void
  onOpen: (path: string) => void
  onDownload: (path: string, name: string) => void
  onDelete: (o: Order) => void
  onPrint?: (o: Order, files: OrderFile[]) => void
  onStart?: (o: Order) => void
  printingId?: string | null
  /** Hours files stay (plan + owner setting): shows when they auto-delete. */
  keepHours?: number
  lang?: string
  onBlock?: (o: Order) => void
  /** v34: Paid / Unpaid toggle */
  onPaid?: (o: Order, paid: boolean) => void
  /** v34: "Report file" */
  onReport?: (o: Order) => void
}) {
  const { o, onStatus, onOpen, onDownload, onDelete, onPrint, onStart, onBlock, onPaid, onReport, printingId, keepHours, lang } = props
  // v34: a reported order's files are kept for review and hidden from the shop.
  const held = !!o.hold
  const noFiles = o.files_deleted || held
  const paid = !!o.paid_at
  // v25: orders not printed yet keep their files for at least 48 hours.
  const keepFor = keepHours ? (['received', 'printing'].includes(o.status) ? Math.max(keepHours, 48) : keepHours) : 0
  const expiry = keepFor ? new Date(new Date(o.created_at).getTime() + keepFor * 3600 * 1000) : null
  const expiryText = expiry
    ? expiry.toLocaleString(lang === 'hi' ? 'hi-IN' : 'en-IN', expiry.toDateString() === new Date().toDateString()
      ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    : ''
  const printable = noFiles ? [] : (o.order_files || []).filter((f) => canDirectPrint(f.file_name))
  const busy = !!printingId
  const { t } = useI18n()
  const next = NEXT[o.status]
  const [viewImg, setViewImg] = useState<ViewImg | null>(null)
  const nextIcon = o.status === 'received' ? 'printer' : o.status === 'printing' ? 'check' : 'user'
  return (
    <article className={`card order s-${o.status}`}>
      <div className="order-top">
        <span className="token-chip" aria-label={`${t('sYourToken')} ${o.token}`}>#{o.token}</span>
        <div className="order-who">
          <strong>{o.customer_name || t('customer')}</strong>
          <div className="order-meta">
            <span className="order-time"><Icon name="clock" size={14} /> {timeText(o.created_at)}</span>
            {o.counter_name && <span className="pill tiny counter-pill"><Icon name="receipt" size={12} className="ico-inl" />{o.counter_name}</span>}
          </div>
        </div>
        <div className="order-right">
          <span className={`pill tiny s-${o.status}`}>{t(STATUS_TEXT[o.status])}</span>
          <strong className="amt">{rupees(Number(o.total))}</strong>
          <PagesFlag files={o.order_files} />
          {onPaid && o.status !== 'cancelled' && (
            <button type="button" className={`paid-toggle${paid ? ' is-paid' : ''}`} aria-pressed={paid}
              title={paid ? t('paidTapUnpaid') : t('paidTapPaid')} onClick={() => onPaid(o, !paid)}>
              {paid ? <><Icon name="check" size={13} stroke={3} /> {t('paidYes')}</> : t('paidNo')}
            </button>
          )}
        </div>
      </div>
      {o.note && <p className="note"><Icon name="note" size={16} /> <span>{o.note}</span></p>}
      <ul className="files">
        {(o.order_files || []).map((f) => (
          <li key={f.id}>
            {!noFiles && isImageName(f.file_name) ? (
              <div className="file-head">
                <StoredImageThumb path={f.storage_path} name={f.file_name} onOpen={setViewImg} />
                <div className="fname is-img">{f.file_name}</div>
              </div>
            ) : <div className="fname">{f.file_name}</div>}
            {f.item_kind === 'passport' ? (
              <div className="file-meta">
                <span className="pill tiny pp-pill"><Icon name="idcard" size={12} className="ico-inl" />{t('ppSheetLabel')}</span>
                <span>{t('ppCalc', { n: f.photos ?? '?', s: f.pages_to_print })}{f.copies > 1 ? ` × ${f.copies}` : ''}</span>
                <b>{rupees(Number(f.price))}</b>
              </div>
            ) : f.item_kind === 'idcard' ? (
              <div className="file-meta">
                <span className="pill tiny pp-pill"><Icon name="idcard" size={12} className="ico-inl" />{t('idSheetLabel')}</span>
                <span className={`mchip${f.color ? ' is-color' : ''}`}>{f.color ? t('color') : t('bw')}</span>
                <span>{t('idCalc', { c: f.copies })} · {t('idPrintHint')}</span>
                <b>{rupees(Number(f.price))}</b>
              </div>
            ) : (
              <div className="file-meta">
                <span className={`mchip${f.color ? ' is-color' : ''}`}>{f.color ? t('color') : t('bw')}</span>
                <span className="mchip">{f.duplex ? t('bothSides') : t('oneSide')}</span>
                {f.binding && <span className="mchip is-extra">{t('optBinding')}</span>}
                {f.lamination && <span className="mchip is-extra">{t('optLamination')}</span>}
                <span>{t('calcLine', { p: f.pages_to_print, c: f.copies })}{f.page_range ? ` (${f.page_range})` : ''}</span>
                <b>{rupees(Number(f.price))}</b>
              </div>
            )}
            <PagesCheck f={f} />
            {!noFiles && (
              <div className="file-actions">
                {onPrint && canDirectPrint(f.file_name) && (
                  <button type="button" className="btn small primary" disabled={busy} onClick={() => onPrint(o, [f])}>
                    <Icon name="printer" size={17} /> {printingId === f.id ? t('dpPrinting') : t('dpPrint')}
                  </button>
                )}
                <button type="button" className="btn small soft" onClick={() => onOpen(f.storage_path)}><Icon name="printer" size={17} /> {t('openPrint')}</button>
                <button type="button" className="btn small" onClick={() => onDownload(f.storage_path, f.file_name)}><Icon name="download" size={17} /> {t('download')}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {viewImg && <ImageLightbox src={viewImg.src} name={viewImg.name} onClose={() => setViewImg(null)} />}
      {held && !o.files_deleted && <p className="small files-gone fr-held"><Icon name="shield" size={15} /> {t('frHeld')}</p>}
      {o.files_deleted && <p className="small muted files-gone"><Icon name="trash" size={15} /> {t('filesDeleted')}</p>}
      {!noFiles && expiryText && <p className="small muted files-gone"><Icon name="clock" size={15} /> {t('filesExpireAt', { time: expiryText })}</p>}
      <div className="order-actions">
        {onPrint && !noFiles && printable.length > 1 && ['received', 'printing'].includes(o.status) && (
          <button type="button" className="btn soft" disabled={busy} onClick={() => onPrint(o, printable)}>
            <Icon name="printer" size={19} /> {printingId === o.id ? t('dpPrinting') : t('dpPrintAll', { n: printable.length })}
          </button>
        )}
        {next && <button type="button" className={`btn primary next-${o.status}`} disabled={busy && o.status === 'received'} onClick={() => (o.status === 'received' && onStart ? onStart(o) : onStatus(o, next.to))}><Icon name={nextIcon} size={19} /> {printingId === o.id && o.status === 'received' ? t('dpPrinting') : t(next.label)}</button>}
        {['received', 'printing', 'ready'].includes(o.status) && (
          <button type="button" className="btn danger-outline" onClick={async () => { if (await askConfirm(t('confirmCancel'), { icon: 'x' })) onStatus(o, 'cancelled') }}>{t('cancel')}</button>
        )}
        {['done', 'cancelled'].includes(o.status) && !noFiles && (
          <button type="button" className="btn" onClick={() => onDelete(o)}><Icon name="trash" size={17} /> {t('deleteNow')}</button>
        )}
        {onBlock && (
          <button type="button" className="link small block-sender" onClick={() => onBlock(o)}>{t('blockSender')}</button>
        )}
        {onReport && !noFiles && (
          <button type="button" className="link small block-sender report-file" onClick={() => onReport(o)}>{t('frButton')}</button>
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
  const init: Rates = { ...shop.rates, passport_sheet: shop.rates.passport_sheet ?? DEFAULT_PASSPORT_RATE, idcard_sheet: shop.rates.idcard_sheet ?? DEFAULT_IDCARD_RATE, binding: shop.rates.binding ?? 0, lamination: shop.rates.lamination ?? 0 }
  // Raw text of each box, so a bad entry ("-5", "abc", empty) is shown with a message instead of silently dropped.
  const [r, setR] = useState<Partial<Record<keyof Rates, string>>>(() => {
    const o: Partial<Record<keyof Rates, string>> = {}
    for (const k of Object.keys(init) as (keyof Rates)[]) o[k] = String(init[k] ?? 0)
    return o
  })
  const [touched, setTouched] = useState<Partial<Record<keyof Rates, boolean>>>({})
  const [tried, setTried] = useState(false)
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
  // ID card sheet (v23): Pro / Plus like the passport sheet. Saved in rates; used once the v23 SQL has run.
  if (v2 && !passportLocked) fields.push({ k: 'idcard_sheet', label: 'rate_idcard_sheet', hint: 'perIdSheet' })
  const extras: [keyof Rates, Key, Key][] = [['binding', 'rate_binding', 'perCopy'], ['lamination', 'rate_lamination', 'perLamSheet']]
  const editable: (keyof Rates)[] = [...fields.map((f) => f.k), ...extras.map(([k]) => k)]
  /** Error key for one box, or null when it holds a valid rate (0 or more, up to 2 decimals). */
  const rateError = (k: keyof Rates): Key | null => {
    const v = String(r[k] ?? '').trim().replace(',', '.')
    if (v === '') return 'rateErrEmpty'
    if (/^-/.test(v) && !isNaN(Number(v))) return 'rateErrNegative'
    if (!/^\d+(\.\d{1,2})?$/.test(v) && !/^\.\d{1,2}$/.test(v)) return 'rateErrInvalid'
    return null
  }
  const num = (k: keyof Rates) => Number(String(r[k] ?? '').trim().replace(',', '.'))
  const isZeroPrint = (k: keyof Rates) => fields.some((f) => f.k === k) && !rateError(k) && num(k) === 0
  async function save(e: FormEvent) {
    e.preventDefault()
    setTried(true)
    if (editable.some((k) => rateError(k))) return setMsg({ text: t('rateErrFix'), error: true })
    // Paid print rates at ₹0 make those prints free for customers: allowed, but only after a clear yes.
    const zero = fields.filter((f) => isZeroPrint(f.k))
    if (zero.length && !await askConfirm(t('rateZeroAsk'), { icon: 'alert', ok: t('rateZeroOk'), body: t('rateZeroBody', { list: zero.map((f) => t(f.label)).join(', ') }) })) return
    const clean: Rates = {
      ...shop.rates,
      bw_single: num('bw_single'),
      bw_double: num('bw_double'),
      color_single: num('color_single'),
      color_double: num('color_double'),
      binding: num('binding'),
      lamination: num('lamination')
    }
    if (v2 && !passportLocked) clean.passport_sheet = num('passport_sheet')
    if (v2 && !passportLocked) clean.idcard_sheet = num('idcard_sheet')
    const { data, error } = await supabase.from('shops').update({ rates: clean }).eq('id', shop.id).select().single()
    if (error) return setMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setMsg({ text: t('ratesSaved'), error: false })
  }
  const rateInput = (k: keyof Rates, label: Key, hint: Key) => {
    const err = (tried || touched[k]) ? rateError(k) : null
    const zero = !err && isZeroPrint(k)
    const hid = `rate-${k}-hint`, eid = `rate-${k}-err`
    return (
      <label className="field" key={k}>
        <span>{t(label)}</span>
        <div className="input-affix">
          <span className="affix">₹</span>
          <input type="text" inputMode="decimal" autoComplete="off" value={r[k] ?? ''}
            aria-invalid={err ? true : undefined} aria-describedby={err || zero ? `${eid} ${hid}` : hid}
            onChange={(e) => { setR({ ...r, [k]: e.target.value }); setMsg(null) }}
            onBlur={() => setTouched({ ...touched, [k]: true })} />
        </div>
        {err && <small className="hint" id={eid} role="alert" style={{ color: 'var(--c-red-ink)', fontWeight: 600 }}>{t(err)}</small>}
        {zero && <small className="hint" id={eid} style={{ color: 'var(--c-amber-ink)', fontWeight: 600 }}>{t('rateZeroWarn')}</small>}
        <small className="hint" id={hid}>{t(hint)}</small>
      </label>
    )
  }
  return (
    <form className="card form-card" onSubmit={save}>
      <h2 className="card-title">{t('ratesTitle')}</h2>
      <p className="small muted">{t('ratesSub')}</p>
      <div className="rates-grid">
        {fields.map((f) => rateInput(f.k, f.label, f.hint))}
        {v2 && passportLocked && ([['rate_passport_sheet', 'ppProOnly'], ['rate_idcard_sheet', 'idProOnly']] as [Key, Key][]).map(([label, hint]) => (
          <div className="field locked-field" key={label}>
            <span>{t(label)} <span className="pro-badge">{t('planPro')}</span></span>
            <div className="input-affix">
              <span className="affix"><Icon name="lock" size={16} /></span>
              <input value="" disabled placeholder={t('proFeature')} aria-label={t(label)} />
            </div>
            <small className="hint">
              {t(hint)}{' '}
              <button type="button" className="link small" onClick={onUpgrade}>{t('seePlans')}</button>
            </small>
          </div>
        ))}
      </div>
      <h3 className="sub-title">{t('ratesExtrasTitle')}</h3>
      <p className="small muted">{t('ratesExtrasSub')}</p>
      <div className="rates-grid">
        {extras.map(([k, label, hint]) => rateInput(k, label, hint))}
      </div>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg">{t('save')}</button>
    </form>
  )
}

/* ------------------------------------------------------------------ */

type CardPalette = {
  bg: string; blobs: boolean; ink: string; muted: string; strip: [string, string]
  tagBg: string; tagInk: string; pillFrom: string; pillTo: string
  stepBg: string; stepLine: string; stepInk: string; arrow: string; rateBg: string; rateInk: string
}

/** QR card colours for a template + optional accent colour (Pro / Plus design, v17). */
function cardPalette(tpl: QrDesign['template'], accent: string | null): CardPalette {
  if (tpl === 'dark') {
    const a = accent || '#a6e22e'
    return { bg: '#0b1210', blobs: false, ink: '#f8fafc', muted: '#94a3b8', strip: [a, a], tagBg: '#1c2a1a', tagInk: a,
      pillFrom: a, pillTo: a, stepBg: '#141f12', stepLine: a, stepInk: a, arrow: '#64748b', rateBg: a, rateInk: inkOn(a) }
  }
  if (tpl === 'minimal') {
    const a = accent || '#0e1628'
    return { bg: '#ffffff', blobs: false, ink: '#0f172a', muted: '#64748b', strip: [a, a], tagBg: '#f1f5f9', tagInk: '#334155',
      pillFrom: a, pillTo: a, stepBg: '#ffffff', stepLine: '#cbd5e1', stepInk: '#0f172a', arrow: '#94a3b8', rateBg: '#f1f5f9', rateInk: '#0f172a' }
  }
  if (accent) {
    return { bg: '#f8fafc', blobs: false, ink: '#0f172a', muted: '#64748b', strip: [accent, accent], tagBg: '#f1f5f9', tagInk: accent,
      pillFrom: '#0b1210', pillTo: accent, stepBg: '#ffffff', stepLine: accent, stepInk: accent, arrow: '#94a3b8', rateBg: accent, rateInk: inkOn(accent) }
  }
  return { bg: '#f8fafc', blobs: true, ink: '#0f172a', muted: '#64748b', strip: ['#a6e22e', '#6fa012'], tagBg: '#ecf8d2', tagInk: '#2b4310',
    pillFrom: '#0b1210', pillTo: '#2b4310', stepBg: '#f2fbe0', stepLine: '#c9ec8a', stepInk: '#3f6212', arrow: '#94a3b8', rateBg: '#fef3c7', rateInk: '#92400e' }
}

function QrTab({ shop, counters, counterId, onCounter, pro, free, plus, onUpgrade, onSaved }: {
  shop: Shop
  counters: Counter[]
  counterId: string
  onCounter: (id: string) => void
  pro: boolean
  free: boolean
  /** Plus: no "Print by Receipto" on the card/poster, the shop photo in the middle of the QR. */
  plus: boolean
  onUpgrade: () => void
  onSaved: (s: Shop) => void
}) {
  const { t, te } = useI18n()
  // Custom QR card design (Pro / Plus). Free shops keep the standard card.
  const canDesign = !free
  const saved = (shop.qr_design || {}) as QrDesign
  const [design, setDesign] = useState<QrDesign>(saved)
  const [designMsg, setDesignMsg] = useState<{ text: string; error: boolean } | null>(null)
  const use = canDesign ? design : {}
  const tpl = use.template || 'classic'
  const accent = validHex(use.color) ? use.color : null
  const pal = cardPalette(tpl, accent)
  const headline = use.headline?.trim() || t('posterHeadline')
  const footer = use.footer?.trim() || ''
  async function saveDesign() {
    const clean: QrDesign = {
      template: design.template || 'classic',
      ...(validHex(design.color) ? { color: design.color } : {}),
      ...(design.headline?.trim() ? { headline: design.headline.trim().slice(0, 60) } : {}),
      ...(design.footer?.trim() ? { footer: design.footer.trim().slice(0, 60) } : {})
    }
    const { data, error } = await supabase.from('shops').update({ qr_design: clean }).eq('id', shop.id).select().single()
    if (error) return setDesignMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setDesignMsg({ text: t('saved'), error: false })
  }
  const counter = counters.find((c) => c.id === counterId) || null
  const counterName = counter?.name || ''
  // Pro: the poster carries a short code (dynamic). Before the v5 update, or on Free, it is the plain shop link.
  const [dyn, setDyn] = useState<QrLink | null>(null)
  const [dynReady, setDynReady] = useState(false)
  const [dynMsg, setDynMsg] = useState<{ text: string; error: boolean } | null>(null)
  const slot = counter?.id || 'main'
  useEffect(() => {
    setDyn(null)
    setDynMsg(null)
    setDynReady(false)
    let alive = true
    // Look up an existing code first (works even if Pro lapsed), then create one when Pro.
    supabase.from('qr_links').select('*').eq('shop_id', shop.id).eq('slot', slot).maybeSingle()
      .then(async ({ data, error }) => {
        if (!alive) return
        if (error) return setDynReady(true)
        if (data) {
          setDyn(data as QrLink)
          return setDynReady(true)
        }
        if (!pro) return setDynReady(true)
        const r = await supabase.rpc('ensure_qr_link', { p_shop: shop.id, p_counter: counter?.id ?? null })
        if (!alive) return
        if (!r.error && r.data) setDyn(r.data as QrLink)
        setDynReady(true)
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
  const centerLogo = plus && shop.logo_url ? shop.logo_url : import.meta.env.BASE_URL + 'icon.svg'
  useEffect(() => {
    const im = new Image()
    im.crossOrigin = 'anonymous'
    im.onload = () => setLogoEl(im)
    im.onerror = () => {
      const fb = new Image()
      fb.onload = () => setLogoEl(fb)
      fb.src = import.meta.env.BASE_URL + 'icon.svg'
    }
    im.src = centerLogo
  }, [centerLogo])
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

    // Background (template), pastel blobs on the classic card, thin brand strips
    g.fillStyle = pal.bg
    g.fillRect(0, 0, W, H)
    const blob = (x: number, y: number, r: number, col: string) => {
      const rg = g.createRadialGradient(x, y, 0, x, y, r)
      rg.addColorStop(0, col)
      rg.addColorStop(1, 'rgba(248,250,252,0)')
      g.fillStyle = rg
      g.fillRect(x - r, y - r, r * 2, r * 2)
    }
    if (pal.blobs) {
      blob(960, 140, 420, 'rgba(217,242,160,0.9)')
      blob(100, 1380, 460, 'rgba(230,246,198,0.85)')
      blob(1000, 1200, 260, 'rgba(254,243,199,0.8)')
    }
    const strip = g.createLinearGradient(0, 0, W, 0)
    strip.addColorStop(0, pal.strip[0])
    strip.addColorStop(1, pal.strip[1])
    g.fillStyle = strip
    g.fillRect(0, 0, W, 14)
    g.fillRect(0, H - 14, W, 14)

    g.textAlign = 'center'
    g.textBaseline = 'middle'
    // Line icons drawn on the card (same paths as components/Icon), not emoji: emoji look different on every phone.
    const IC: Record<string, string> = {
      pin: 'M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
      receipt: 'M6 3h12v18l-2-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 21zM9 8h6M9 12h6M9 16h3',
      scan: 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 12h10',
      upload: 'M12 16V4M7 9l5-5 5 5M4 16v4h16v-4',
      printer: 'M7 9V3h10v6M7 17H4v-8h16v8h-3M7 14h10v7H7z',
    }
    const drawIco = (name: string, x: number, cy: number, s: number, color: string) => {
      g.save()
      g.translate(x, cy - s / 2)
      g.scale(s / 24, s / 24)
      g.strokeStyle = color
      g.lineWidth = 2.2
      g.lineCap = 'round'
      g.lineJoin = 'round'
      g.stroke(new Path2D(IC[name]))
      g.restore()
    }
    /** Icon + text centred on cx as one group (uses the current font and fillStyle). */
    const iconText = (name: string, text: string, cx: number, y: number, maxW: number, s: number) => {
      const gap = s * 0.35
      const tw = Math.min(g.measureText(text).width, maxW - s - gap)
      const x0 = cx - (s + gap + tw) / 2
      drawIco(name, x0, y, s, String(g.fillStyle))
      g.textAlign = 'left'
      g.fillText(text, x0 + s + gap, y, tw)
      g.textAlign = 'center'
    }

    // Tag pill
    // Plus: no PrintQR branding on the card
    const tag = plus ? t('cardTag') : 'Print by Receipto · ' + t('cardTag')
    g.font = `700 30px ${font}`
    const tw = g.measureText(tag).width + 60
    rr((W - tw) / 2, 60, tw, 60, 30)
    g.fillStyle = pal.tagBg
    g.fill()
    g.fillStyle = pal.tagInk
    g.fillText(tag, W / 2, 91)

    // Shop name + address
    fitText(shop.name, 800, 84, 40, W - 120)
    g.fillStyle = pal.ink
    g.fillText(shop.name, W / 2, 200)
    if (shop.address) {
      g.font = `500 36px ${font}`
      g.fillStyle = pal.muted
      iconText('pin', shop.address, W / 2, 268, W - 140, 34)
    }

    // Counter name pill
    if (counterName) {
      const label = counterName
      fitText(label, 800, 40, 26, W - 310)
      const icS = 36
      const cw = Math.min(g.measureText(label).width + icS + 13 + 80, W - 160)
      const grad = g.createLinearGradient((W - cw) / 2, 0, (W + cw) / 2, 0)
      grad.addColorStop(0, pal.pillFrom)
      grad.addColorStop(1, pal.pillTo)
      rr((W - cw) / 2, 300, cw, 68, 34)
      g.fillStyle = grad
      g.fill()
      g.fillStyle = inkOn(pal.pillTo)
      iconText('receipt', label, W / 2, 335, cw - 50, icS)
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
      g.save()
      rr(bx + cell * 0.4, by + cell * 0.4, bs - cell * 0.8, bs - cell * 0.8, cell * 1.6)
      g.clip()
      g.drawImage(logoEl, bx + cell * 0.4, by + cell * 0.4, bs - cell * 0.8, bs - cell * 0.8)
      g.restore()
    } else {
      rr(bx + cell * 0.4, by + cell * 0.4, bs - cell * 0.8, bs - cell * 0.8, cell * 1.6)
      g.fillStyle = '#0b1210'
      g.fill()
    }

    // Headline
    let y = cy + cardS + 90
    g.fillStyle = pal.ink
    fitText(headline, 800, 52, 30, W - 100)
    g.fillText(headline, W / 2, y)

    // Steps row
    y += 100
    const steps = [t('cardScan'), t('cardUpload'), t('cardCollect')]
    const stepIco = ['scan', 'upload', 'printer']
    g.font = `700 32px ${font}`
    const widths = steps.map((s) => g.measureText(s).width + 32 + 11 + 56)
    const gap = 40
    let x = (W - (widths.reduce((a, b) => a + b, 0) + gap * (steps.length - 1))) / 2
    steps.forEach((s, i) => {
      rr(x, y - 36, widths[i], 72, 36)
      g.fillStyle = pal.stepBg
      g.fill()
      g.strokeStyle = pal.stepLine
      g.lineWidth = 2
      g.stroke()
      g.fillStyle = pal.stepInk
      iconText(stepIco[i], s, x + widths[i] / 2, y + 1, widths[i], 32)
      if (i < steps.length - 1) {
        g.fillStyle = pal.arrow
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
    g.fillStyle = pal.rateBg
    g.fill()
    g.fillStyle = pal.rateInk
    g.fillText(rates, W / 2, y + 1, W - 130)

    // Own footer line (Pro / Plus), e.g. timings or a phone number
    if (footer) {
      g.font = `600 30px ${font}`
      g.fillStyle = pal.muted
      g.fillText(footer, W / 2, H - 60, W - 120)
    }

    try {
      setCard(c.toDataURL('image/png'))
    } catch {
      setCard('') // a logo from another site without CORS taints the canvas
    }
  }, [url, counterName, shop.name, shop.address, shop.rates.bw_single, shop.rates.color_single, t, logoEl, plus, headline, footer, tpl, accent]) // eslint-disable-line react-hooks/exhaustive-deps
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
        <div className={`qr-design${canDesign ? '' : ' is-locked'}`}>
          <div className="dyn-head">
            <strong>{canDesign ? null : <Icon name="lock" size={14} className="ico-inl" />}{t('qdTitle')} <span className="pro-badge">{t('planPro')}</span></strong>
          </div>
          <p className="small muted">{canDesign ? t('qdSub') : t('qdLocked')}</p>
          <fieldset disabled={!canDesign} className="qd-fields">
            <div className="field">
              <span>{t('qdTemplate')}</span>
              <div className="seg" role="group" aria-label={t('qdTemplate')}>
                {(['classic', 'dark', 'minimal'] as const).map((x) => (
                  <button key={x} type="button" className={(design.template || 'classic') === x ? 'on' : ''} aria-pressed={(design.template || 'classic') === x}
                    onClick={() => setDesign({ ...design, template: x })}>{t(x === 'classic' ? 'qdClassic' : x === 'dark' ? 'qdDark' : 'qdMinimal')}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>{t('qdColor')}</span>
              <div className="swatches" role="group" aria-label={t('qdColor')}>
                <button type="button" className={`swatch-btn sw-default${!design.color ? ' on' : ''}`} aria-pressed={!design.color} title={t('qdDefault')}
                  onClick={() => setDesign({ ...design, color: undefined })}>A</button>
                {BRAND_SWATCHES.map((c) => (
                  <button key={c} type="button" className={`swatch-btn${design.color === c ? ' on' : ''}`} style={{ background: c }} aria-pressed={design.color === c}
                    aria-label={c} onClick={() => setDesign({ ...design, color: c })} />
                ))}
              </div>
            </div>
            <div className="grid2">
              <label className="field"><span>{t('qdHeadline')}</span>
                <input value={design.headline || ''} maxLength={60} placeholder={t('posterHeadline')} onChange={(e) => setDesign({ ...design, headline: e.target.value })} /></label>
              <label className="field"><span>{t('qdFooter')}</span>
                <input value={design.footer || ''} maxLength={60} placeholder={t('qdFooterPh')} onChange={(e) => setDesign({ ...design, footer: e.target.value })} /></label>
            </div>
          </fieldset>
          {canDesign ? (
            <button type="button" className="btn primary small" onClick={() => void saveDesign()}>{t('save')}</button>
          ) : (
            <div className="upgrade-prompt">
              <span><Icon name="lock" size={14} className="ico-inl" />{t('qdLocked')} <span className="pro-badge">{t('planPro')}</span></span>
              <button type="button" className="btn primary small" onClick={onUpgrade}>{t('seePlans')}</button>
            </div>
          )}
          {designMsg && <p className={`notice${designMsg.error ? ' error' : ' success'}`}>{designMsg.text}</p>}
          {canDesign && card && <img className="qr-card-preview" src={card} alt={t('downloadQr')} />}
        </div>
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
      <div className={`poster poster-${tpl}`} style={accent ? ({ '--poster-accent': accent, '--poster-accent-ink': inkOn(accent) } as CSSProperties) : undefined}>
        <div className="poster-brand">{plus ? <ShopAvatar shop={shop} size={44} /> : tpl === 'dark'
          ? <img src={import.meta.env.BASE_URL + 'logo-dark.svg'} height={34} width={85} alt="Print by Receipto" style={{ display: 'block' }} />
          : <Wordmark height={34} light />}</div>
        <div className="poster-top">{shop.name}</div>
        {counterName && <div className="poster-counter"><Icon name="receipt" size={16} className="ico-inl" />{counterName}</div>}
        <h2>{headline}</h2>
        <div className="poster-qr">{img && dynReady ? <img src={img} alt="Shop QR code" /> : <div className="skel skel-qr" aria-busy="true" />}</div>
        <div className="poster-rates">
          <div><span>{t('bw')}</span><strong>{rupees(shop.rates.bw_single)}</strong><em>{t('perPageShort')}</em></div>
          <div><span>{t('color')}</span><strong>{rupees(shop.rates.color_single)}</strong><em>{t('perPageShort')}</em></div>
        </div>
        <ol className="poster-steps">
          <li><b>1</b><span>{t('posterStep1')}</span></li>
          <li><b>2</b><span>{t('posterStep2')}</span></li>
          <li><b>3</b><span>{t('posterStep3')}</span></li>
        </ol>
        {shop.phone && <div className="poster-phone"><Icon name="phone" size={16} className="ico-inl" />{shop.phone}</div>}
        {footer && <div className="poster-footer">{footer}</div>}
        <div className="poster-url">{url}</div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

type HistRow = { id: string; token: number; customer_name: string | null; status: OrderStatus; total: number; created_at: string; counter_name?: string | null }
const HIST_RANGES: { days: number; label: Key }[] = [
  { days: 7, label: 'h7d' },
  { days: 30, label: 'h30d' },
  { days: 183, label: 'h6m' },
  { days: 365, label: 'h1y' }
]
const HIST_PAGE = 50

function Report({ shop, onUpgrade }: { shop: Shop; onUpgrade: () => void }) {
  const { t, tn, te, lang } = useI18n()
  const tier = shopTier(shop)
  const maxDays = HISTORY_DAYS[tier]
  const [rows, setRows] = useState<{ status: OrderStatus; total: number; created_at: string; paid_at?: string | null }[] | null>(null)
  useEffect(() => {
    const since = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
    const get = (cols: string) => supabase
      .from('orders')
      .select(cols)
      .eq('shop_id', shop.id)
      .in('status', ['received', 'printing', 'ready', 'done'])
      .gte('created_at', since)
    void (async () => {
      // paid_at comes with the v34 database update; before it, load the summary without it.
      let { data, error } = await get('status,total,created_at,paid_at')
      if (error) ({ data } = await get('status,total,created_at'))
      setRows((data || []) as unknown as NonNullable<typeof rows>)
    })()
  }, [shop.id])

  // Order history: as far back as the plan allows (7 days / 6 months / 1 year; the database hides older rows).
  const [range, setRange] = useState(7)
  const [locked, setLocked] = useState<number | null>(null)
  const [hist, setHist] = useState<HistRow[] | null>(null)
  const [more, setMore] = useState(false)
  const [histErr, setHistErr] = useState<string | null>(null)
  const loadHist = useCallback(async (from: number, days: number) => {
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString()
    const { data, error } = await supabase
      .from('orders')
      .select('id,token,customer_name,status,total,created_at,counter_name')
      .eq('shop_id', shop.id)
      .neq('status', 'uploading')
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .range(from, from + HIST_PAGE - 1)
    if (error) return setHistErr(te(error))
    const list = (data || []) as HistRow[]
    setHist((h) => (from ? [...(h || []), ...list] : list))
    setMore(list.length === HIST_PAGE)
    // te only translates errors
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shop.id])
  useEffect(() => { setHist(null); void loadHist(0, Math.min(range, maxDays)) }, [range, maxDays, loadHist])

  const startOfDay = new Date()
  startOfDay.setHours(0, 0, 0, 0)
  const sum = (from: number) => {
    const list = (rows || []).filter((r) => new Date(r.created_at).getTime() >= from)
    return {
      count: list.length,
      total: list.reduce((s, r) => s + Number(r.total), 0),
      paid: list.reduce((s, r) => s + (r.paid_at ? Number(r.total) : 0), 0)
    }
  }
  const today = sum(startOfDay.getTime())
  const week = sum(startOfDay.getTime() - 6 * 86400 * 1000)
  const month = sum(startOfDay.getTime() - 29 * 86400 * 1000)

  const cards: { label: Key; v: { count: number; total: number; paid: number }; accent?: boolean; lock?: boolean }[] = [
    { label: 'today', v: today, accent: true },
    { label: 'last7', v: week },
    { label: 'last30', v: month, lock: maxDays < 30 }
  ]
  const loc = lang === 'hi' ? 'hi-IN' : 'en-IN'
  const groups: { day: string; list: HistRow[] }[] = []
  for (const r of hist || []) {
    const day = new Date(r.created_at).toLocaleDateString(loc, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
    const g = groups[groups.length - 1]
    if (g && g.day === day) g.list.push(r)
    else groups.push({ day, list: [r] })
  }
  const lockedTier = locked ? tierFor(HISTORY_DAYS, locked) : null

  return (
    <section>
      {!rows && (
        <div className="stats" aria-busy="true">
          <span className="sr-only">{t('loading')}</span>
          {cards.map((s) => (
            <div className="card stat skel-stat" key={s.label}>
              <div className="skel skel-line w40" />
              <div className="skel skel-num" />
              <div className="skel skel-line w60" />
            </div>
          ))}
        </div>
      )}
      {rows && <div className="stats">
        {cards.map((s) => s.lock ? (
          <button type="button" className="card stat stat-locked" key={s.label} onClick={onUpgrade}>
            <div className="small stat-label"><Icon name="lock" size={16} /> {t(s.label)}</div>
            <div className="big-num stat-lock"><Icon name="lock" size={30} /></div>
            <div className="small stat-sub"><span className="pro-badge">{t('planPro')}</span> {t('seePlans')}</div>
          </button>
        ) : (
          <div className={`card stat${s.accent ? ' accent' : ''}`} key={s.label}>
            <div className="small stat-label"><Icon name={s.accent ? 'rupee' : 'chart'} size={16} /> {t(s.label)}</div>
            <div className="big-num">{rupees(s.v.total)}</div>
            <div className="small stat-sub">{tn('orders_one', 'orders_other', s.v.count)}</div>
            {s.accent && s.v.count > 0 && (
              <div className="small stat-paid">{t('paidToday', { paid: rupees(s.v.paid), left: rupees(Math.max(0, s.v.total - s.v.paid)) })}</div>
            )}
          </div>
        ))}
      </div>}
      <p className="small muted">{t('reportNote')}</p>

      <div className="card form-card history-card">
        <h2 className="card-title">{t('histTitle')}</h2>
        <p className="small muted">{t('histSub', { n: t(HIST_RANGES.find((r) => r.days === maxDays)?.label || 'h7d') })}</p>
        <div className="seg" role="group" aria-label={t('histTitle')}>
          {HIST_RANGES.map((r) => {
            const lk = r.days > maxDays
            return (
              <button key={r.days} type="button" className={!lk && range === r.days ? 'on' : ''} aria-pressed={!lk && range === r.days}
                onClick={() => (lk ? setLocked(r.days) : (setLocked(null), setRange(r.days)))}>
                {lk && <Icon name="lock" size={13} />}{t(r.label)}
              </button>
            )
          })}
        </div>
        {locked && lockedTier && (
          <div className="upgrade-prompt">
            <span><Icon name="lock" size={14} className="ico-inl" />{t('histLocked', { n: t(HIST_RANGES.find((r) => r.days === locked)!.label) })} <span className="pro-badge">{lockedTier === 'plus' ? t('planPlus') : t('planPro')}</span></span>
            <button type="button" className="btn primary small" onClick={onUpgrade}>{t('seePlans')}</button>
          </div>
        )}
        {histErr && <p className="notice error">{histErr}</p>}
        {!hist && !histErr && <QrLoadBlock small />}
        {hist && !hist.length && <p className="muted small">{t('histEmpty')}</p>}
        {groups.map((g) => (
          <div className="hist-day" key={g.day}>
            <div className="hist-date">{g.day}</div>
            <ul className="hist-list">
              {g.list.map((r) => (
                <li key={r.id}>
                  <span className="token-chip sm">#{r.token}</span>
                  <span className="hist-who">{r.customer_name || t('customer')}{r.counter_name ? ` · ${r.counter_name}` : ''}
                    <span className="small muted"> · {new Date(r.created_at).toLocaleTimeString(loc, { hour: 'numeric', minute: '2-digit' })}</span></span>
                  <span className={`pill tiny s-${r.status}`}>{t(STATUS_TEXT[r.status])}</span>
                  <b className="hist-amt">{rupees(Number(r.total))}</b>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {more && <button type="button" className="btn ghost block" onClick={() => void loadHist(hist?.length || 0, Math.min(range, maxDays))}>{t('histMore')}</button>}
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */

const KEEP_OPTIONS = [1, 3, 6, 12, 24, 48, 72, 168]

type SetKey = 'shop' | 'hours' | 'paper' | 'counters' | 'brand' | 'staff' | 'lock' | 'devices' | 'support'
/** Android phone Settings: grouped list (iOS-style); each row opens its section. */
function SettingsHub({ plus, free, onOpen, onPlan, onLogout, version }: {
  plus: boolean; free: boolean; onOpen: (k: SetKey) => void; onPlan: () => void; onLogout: () => void; version: string
}) {
  const { t, lang, setLang } = useI18n()
  const { pref, setTheme } = useTheme()
  const nav = useNavigate()
  const themeOrder: ThemePref[] = ['light', 'dark', 'system']
  const themeLbl: Record<ThemePref, Key> = { light: 'themeLight', dark: 'themeDark', system: 'themeAuto' }
  const Row = ({ icon, label, value, onClick, lock, lockPro }: { icon: string; label: string; value?: string; onClick: () => void; lock?: boolean; lockPro?: boolean }) => (
    <button type="button" className="set-row" onClick={onClick}>
      <span className="set-ic"><Icon name={icon} size={18} /></span>
      <span className="set-lbl">{label}</span>
      {lock && <span className="pro-badge">{t('planPlus')}</span>}
      {lockPro && <span className="pro-badge">{t('planPro')}</span>}
      {value && <span className="set-val">{value}</span>}
      <Icon name="chevr" size={18} />
    </button>
  )
  return (
    <div className="set-hub">
      <div className="set-grp-lbl">{t('setGrpShop')}</div>
      <div className="set-grp">
        <Row icon="store" label={t('setShopDetails')} onClick={() => onOpen('shop')} />
        <Row icon="clock" label={t('hoursTitle')} onClick={() => onOpen('hours')} />
        <Row icon="file" label={t('paperTitle')} onClick={() => onOpen('paper')} />
        <Row icon="qr" label={t('cTitle')} lockPro={free} onClick={() => onOpen('counters')} />
      </div>
      <div className="set-grp-lbl">{t('setGrpBiz')}</div>
      <div className="set-grp">
        <Row icon="star" label={t('tabPlan')} onClick={onPlan} />
        <Row icon="image" label={t('setBrand')} lock={!plus} onClick={() => onOpen('brand')} />
        <Row icon="user" label={t('staffTitle')} lock={!plus} onClick={() => onOpen('staff')} />
      </div>
      <div className="set-grp-lbl">{t('setGrpPref')}</div>
      <div className="set-grp">
        <Row icon="lock" label={t('lockCardTitle')} onClick={() => onOpen('lock')} />
        <Row icon="shield" label={t('devTitle')} onClick={() => onOpen('devices')} />
        <Row icon="type" label={t('language')} value={lang === 'hi' ? 'हिंदी' : 'English'} onClick={() => setLang(lang === 'hi' ? 'en' : 'hi')} />
        <Row icon={pref === 'dark' ? 'moon' : pref === 'light' ? 'sun' : 'auto'} label={t('theme')} value={t(themeLbl[pref])}
          onClick={() => setTheme(themeOrder[(themeOrder.indexOf(pref) + 1) % 3])} />
      </div>
      <div className="set-grp-lbl">{t('setGrpHelp')}</div>
      <div className="set-grp">
        <Row icon="mail" label={t('supTitle')} onClick={() => onOpen('support')} />
        <Row icon="shield" label={t('setPrivacy')} onClick={() => nav('/legal/privacy')} />
        <Row icon="info" label={t('setTerms')} onClick={() => nav('/legal/terms')} />
      </div>
      <button type="button" className="set-grp set-logout" onClick={onLogout}><Icon name="logout" size={18} /> {t('logout')}</button>
      {version && <p className="app-version">{version}</p>}
    </div>
  )
}

function Settings({ shop, onSaved, onUpgrade }: { shop: Shop; onSaved: (s: Shop) => void; onUpgrade: () => void }) {
  const { t, tn, te } = useI18n()
  const tier = shopTier(shop)
  const cap = FILE_HOURS[tier]
  const [f, setF] = useState({
    name: shop.name,
    address: shop.address || '',
    phone: shop.phone || '',
    upi_id: shop.upi_id || '',
    auto_delete_hours: shop.auto_delete_hours
  })
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  // v25: networks this shop blocked from its orders ("Block sender" on an order)
  const [blocked, setBlocked] = useState(0)
  useEffect(() => {
    supabase.rpc('blocked_sender_count', { p_shop: shop.id }).then(({ data, error }) => { if (!error) setBlocked(Number(data) || 0) }, () => {})
  }, [shop.id])
  async function unblockAll() {
    if (!await askConfirm(t('unblockConfirm'), { icon: 'shield' })) return
    const { error } = await supabase.rpc('unblock_all_senders', { p_shop: shop.id })
    if (error) return setMsg({ text: te(error), error: true })
    setBlocked(0)
    setMsg({ text: t('unblockDone'), error: false })
  }
  const keepText = (h: number) => (h % 24 === 0 && h >= 48 ? tn('keepD_one', 'keepD_other', h / 24) : tn('hours_one', 'hours_other', h))
  const durText = (h: number) => (h % 24 === 0 && h >= 48 ? tn('durD_one', 'durD_other', h / 24) : tn('durH_one', 'durH_other', h))
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
          {Array.from(new Set([...KEEP_OPTIONS, f.auto_delete_hours])).sort((a, b) => a - b).map((h) => {
            const need = tierFor(FILE_HOURS, h)
            return (
              <option key={h} value={h} disabled={h > cap && h !== f.auto_delete_hours}>
                {keepText(h)}{h > cap ? ` · ${need === 'plus' ? t('planPlus') : t('planPro')}` : ''}
              </option>
            )
          })}
        </select>
        <small className="hint">
          {t('keepPlanHint', { time: durText(cap) })}
          {f.auto_delete_hours > cap && ` ${t('keepCapped', { time: durText(cap) })}`}
          {tier !== 'plus' && <>{' '}<button type="button" className="link small" onClick={onUpgrade}>{t('seePlans')}</button></>}
        </small>
      </label>
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      {blocked > 0 && (
        <p className="small muted blocked-row">
          {tn('blockedCount_one', 'blockedCount_other', blocked)}{' '}
          <button type="button" className="link small" onClick={() => void unblockAll()}>{t('unblockAll')}</button>
        </p>
      )}
      <button className="btn primary block lg">{t('save')}</button>
    </form>
  )
}

/* ------------------------------------------------------------------ */

/** Shop timings (all plans): opens / closes by itself at these times, India time (pg_cron, every 5 min). */
function HoursCard({ shop, onSaved }: { shop: Shop; onSaved: (s: Shop) => void }) {
  const { t, te, lang } = useI18n()
  const [h, setH] = useState<ShopHours>(() => normHours(shop.hours))
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const dayName = (d: number) => new Date(2024, 0, 7 + d).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'short' })
  const setDay = (d: number, patch: Partial<ShopHours['days'][string]>) =>
    setH((x) => ({ ...x, days: { ...x.days, [String(d)]: { ...x.days[String(d)], ...patch } } }))
  function copyMon() {
    const m = h.days['1']
    setH((x) => {
      const days = { ...x.days }
      for (const d of [2, 3, 4, 5, 6]) days[String(d)] = { ...m }
      return { ...x, days }
    })
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    const { data, error } = await supabase.from('shops').update({ hours: h }).eq('id', shop.id).select().single()
    if (error) return setMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setMsg({ text: h.enabled ? t('hoursSaved') : t('saved'), error: false })
  }
  return (
    <form className="card form-card" onSubmit={save}>
      <h2 className="card-title">{t('hoursTitle')}</h2>
      <p className="small muted">{t('hoursSub')}</p>
      <label className="check-row plain">
        <input type="checkbox" checked={h.enabled} onChange={(e) => setH({ ...h, enabled: e.target.checked })} />
        <span><strong>{t('hoursOn')}</strong></span>
      </label>
      {h.enabled && (
        <>
          <ul className="hours-list">
            {DAY_ORDER.map((d) => {
              const v = h.days[String(d)]
              return (
                <li key={d} className={v.closed ? 'is-closed' : ''}>
                  <span className="hours-day">{dayName(d)}</span>
                  <input type="time" value={v.open} disabled={v.closed} aria-label={`${dayName(d)} ${t('hoursOpen')}`} onChange={(e) => setDay(d, { open: e.target.value })} />
                  <span className="muted">–</span>
                  <input type="time" value={v.close} disabled={v.closed} aria-label={`${dayName(d)} ${t('hoursClose')}`} onChange={(e) => setDay(d, { close: e.target.value })} />
                  <label className="hours-closed small"><input type="checkbox" checked={v.closed} onChange={(e) => setDay(d, { closed: e.target.checked })} /> {t('hoursClosed')}</label>
                </li>
              )
            })}
          </ul>
          <button type="button" className="btn small" onClick={copyMon}>{t('hoursCopy')}</button>
          <p className="small muted">{t('hoursNote')}</p>
        </>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg">{t('save')}</button>
    </form>
  )
}

/** Paper stock (all plans, v23): sheets come off by themselves when an order is marked Done (database trigger). */
function PaperCard({ shop, onSaved }: { shop: Shop; onSaved: (s: Shop) => void }) {
  const { t, te } = useI18n()
  const REAM = 500
  const [on, setOn] = useState(shop.paper_sheets !== null && shop.paper_sheets !== undefined)
  const [unit, setUnit] = useState<'sheets' | 'reams'>('sheets')
  const [stock, setStock] = useState<string>(String(shop.paper_sheets ?? 0))
  const [low, setLow] = useState<string>(String(shop.paper_low_at ?? 200))
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  // Stock changed elsewhere (orders marked Done): show the new number unless the owner is typing one.
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty && shop.paper_sheets !== null && shop.paper_sheets !== undefined) {
      setStock(String(unit === 'reams' ? shop.paper_sheets / REAM : shop.paper_sheets))
    }
  }, [shop.paper_sheets]) // eslint-disable-line react-hooks/exhaustive-deps
  const sheets = Math.max(0, Math.min(10000000, Math.round((Number(stock) || 0) * (unit === 'reams' ? REAM : 1))))
  function switchUnit(u: 'sheets' | 'reams') {
    if (u === unit) return
    setStock(String(u === 'reams' ? sheets / REAM : sheets))
    setUnit(u)
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    const { data, error } = await supabase.from('shops')
      .update({ paper_sheets: on ? sheets : null, paper_low_at: Math.max(0, Math.min(10000000, Math.round(Number(low) || 0))) })
      .eq('id', shop.id).select().single()
    if (error) return setMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setDirty(false)
    setMsg({ text: t('saved'), error: false })
  }
  const current = shop.paper_sheets
  return (
    <form className="card form-card" onSubmit={save}>
      <h2 className="card-title">{t('paperTitle')}</h2>
      <p className="small muted">{t('paperSub')}</p>
      <label className="check-row plain">
        <input type="checkbox" checked={on} onChange={(e) => { setOn(e.target.checked); setDirty(true) }} />
        <span><strong>{t('paperOn')}</strong></span>
      </label>
      {on && (
        <>
          {current !== null && current !== undefined && (
            <p className={`notice${current < (shop.paper_low_at ?? 200) ? ' error' : ''}`}>
              {current < (shop.paper_low_at ?? 200) ? t('paperLow', { n: current }) : t('paperNow', { n: current })}
            </p>
          )}
          <div className="field">
            <span>{t('paperStock')}</span>
            <div className="paper-units">
              <input type="number" min={0} step={unit === 'reams' ? 0.5 : 1} inputMode="decimal" value={stock} aria-label={t('paperStock')}
                onChange={(e) => { setStock(e.target.value); setDirty(true) }} />
              <div className="seg" role="group" aria-label={t('paperStock')}>
                <button type="button" className={unit === 'sheets' ? 'on' : ''} aria-pressed={unit === 'sheets'} onClick={() => switchUnit('sheets')}>{t('paperUnitSheets')}</button>
                <button type="button" className={unit === 'reams' ? 'on' : ''} aria-pressed={unit === 'reams'} onClick={() => switchUnit('reams')}>{t('paperUnitReams')}</button>
              </div>
              <button type="button" className="btn small" onClick={() => { setStock(String(unit === 'reams' ? sheets / REAM + 1 : sheets + REAM)); setDirty(true) }}>{t('paperAddReam')}</button>
            </div>
            {unit === 'reams' && <small className="hint">= {sheets} {t('paperUnitSheets')}</small>}
          </div>
          <label className="field">
            <span>{t('paperLowAt')}</span>
            <input type="number" min={0} step={1} inputMode="numeric" value={low} onChange={(e) => { setLow(e.target.value); setDirty(true) }} />
          </label>
        </>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      <button className="btn primary block lg">{t('save')}</button>
    </form>
  )
}

/** Plus: own colour + logo on the customer pages, no PrintQR branding there. */
function BrandCard({ shop, plus, onSaved, onUpgrade }: { shop: Shop; plus: boolean; onSaved: (s: Shop) => void; onUpgrade: () => void }) {
  const { t, te } = useI18n()
  const [color, setColor] = useState<string>(shop.brand_color || '')
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  async function save(c: string | null) {
    setColor(c || '')
    const { data, error } = await supabase.from('shops').update({ brand_color: c }).eq('id', shop.id).select().single()
    if (error) return setMsg({ text: te(error), error: true })
    onSaved(data as Shop)
    setMsg({ text: t('saved'), error: false })
  }
  return (
    <div className={`card form-card${plus ? '' : ' is-locked'}`}>
      <h2 className="card-title">{plus ? null : <Icon name="lock" size={14} className="ico-inl" />}{t('brandTitle')} <span className="pro-badge">{t('planPlus')}</span></h2>
      <p className="small muted">{t('brandSub')}</p>
      <fieldset disabled={!plus} className="qd-fields">
        <div className="field">
          <span>{t('brandColor')}</span>
          <div className="swatches" role="group" aria-label={t('brandColor')}>
            <button type="button" className={`swatch-btn sw-default${!color ? ' on' : ''}`} aria-pressed={!color} title={t('qdDefault')} onClick={() => void save(null)}>A</button>
            {BRAND_SWATCHES.map((c) => (
              <button key={c} type="button" className={`swatch-btn${color === c ? ' on' : ''}`} style={{ background: c }} aria-pressed={color === c} aria-label={c} onClick={() => void save(c)} />
            ))}
            <label className="swatch-custom" title={t('brandCustom')}>
              <input type="color" value={validHex(color) ? color : '#3f6212'} onChange={(e) => setColor(e.target.value)} onBlur={(e) => void save(e.target.value)} aria-label={t('brandCustom')} />
            </label>
          </div>
        </div>
        <p className="small muted">{t('brandLogoHint')}</p>
        {validHex(color) && (
          <div className="brand-preview" style={{ background: color, color: inkOn(color) }}>
            <ShopAvatar shop={shop} size={32} /> <strong>{shop.name}</strong>
          </div>
        )}
      </fieldset>
      {!plus && (
        <div className="upgrade-prompt">
          <span><Icon name="lock" size={14} className="ico-inl" />{t('brandLocked')} <span className="pro-badge">{t('planPlus')}</span></span>
          <button type="button" className="btn primary small" onClick={onUpgrade}>{t('seePlans')}</button>
        </div>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
    </div>
  )
}

type StaffRow = { id: string; email: string; user_id: string | null; accepted_at: string | null }

/** Plus: staff logins. Staff sign in with their own email and see only the Orders page of this shop. */
function StaffCard({ shop, plus, onUpgrade }: { shop: Shop; plus: boolean; onUpgrade: () => void }) {
  const { t, te } = useI18n()
  const [list, setList] = useState<StaffRow[] | null>(null)
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('shop_staff').select('id,email,user_id,accepted_at').eq('shop_id', shop.id).order('created_at')
    setList(error ? [] : ((data || []) as StaffRow[]))
  }, [shop.id])
  useEffect(() => { if (plus) void load() }, [plus, load])
  async function add(e: FormEvent) {
    e.preventDefault()
    const v = email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return setMsg({ text: t('staffBadEmail'), error: true })
    setBusy(true)
    setMsg(null)
    const { error } = await supabase.from('shop_staff').insert({ shop_id: shop.id, email: v })
    setBusy(false)
    if (error) return setMsg({ text: error.code === '23505' ? t('staffDup') : te(error), error: true })
    setEmail('')
    setMsg({ text: t('staffAdded', { email: v }), error: false })
    void load()
  }
  async function remove(r: StaffRow) {
    if (!await askConfirm(t('staffRemoveAsk', { email: r.email }), { icon: 'user' })) return
    const { error } = await supabase.from('shop_staff').delete().eq('id', r.id)
    if (error) return setMsg({ text: te(error), error: true })
    void load()
  }
  return (
    <div className={`card form-card${plus ? '' : ' is-locked'}`}>
      <h2 className="card-title">{plus ? null : <Icon name="lock" size={14} className="ico-inl" />}{t('staffTitle')} <span className="pro-badge">{t('planPlus')}</span></h2>
      <p className="small muted">{t('staffSub')}</p>
      {plus ? (
        <>
          {list && list.length > 0 && (
            <ul className="counter-list">
              {list.map((r) => (
                <li key={r.id}>
                  <span className="staff-email">{r.email} <span className={`pill tiny ${r.user_id ? 's-done' : 's-received'}`}>{r.user_id ? t('staffActive') : t('staffPending')}</span></span>
                  <div className="counter-actions">
                    <button type="button" className="btn small danger-outline" onClick={() => void remove(r)}>{t('staffRemove')}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form className="counter-add" onSubmit={add}>
            <input type="email" value={email} maxLength={200} placeholder={t('staffEmailPh')} aria-label={t('staffEmailPh')} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn primary" disabled={busy || !email.trim()}>{t('staffAdd')}</button>
          </form>
          <p className="small muted">{t('staffHow')}</p>
        </>
      ) : (
        <div className="upgrade-prompt">
          <span><Icon name="lock" size={14} className="ico-inl" />{t('staffLocked')} <span className="pro-badge">{t('planPlus')}</span></span>
          <button type="button" className="btn primary small" onClick={onUpgrade}>{t('seePlans')}</button>
        </div>
      )}
      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
    </div>
  )
}

const MAX_COUNTERS = 20

function CountersCard({ shop, counters, usable, locked, limit, needPlus, v2, onChanged, onUpgrade, onShowQr }: {
  shop: Shop
  counters: Counter[]
  /** How many of `counters` (oldest first) can be used. The rest are locked on the Free plan. */
  usable: number
  /** Free plan: no new counters beyond the free limit. */
  locked: boolean
  /** How many counters the plan allows adding up to (Free setting, Pro 2, Plus Infinity). */
  limit: number
  /** On Pro already: the next step is Plus. */
  needPlus: boolean
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

  async function remove(c: Counter) {
    if (!await askConfirm(t('cConfirmDelete', { name: c.name }), { icon: 'trash' })) return
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
                  <span className="counter-locked-name"><Icon name="lock" size={14} className="ico-inl" />{c.name} <span className="small muted">· {t('cLocked')}</span></span>
                  <div className="counter-actions">
                    <button type="button" className="btn small soft" onClick={onUpgrade}>{t('seePlans')}</button>
                    <button type="button" className="btn small danger-outline" onClick={() => remove(c)} disabled={busy}>{t('cDelete')}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {counters.length >= limit ? (
            <div className="upgrade-prompt">
              <span><Icon name="lock" size={14} className="ico-inl" />{needPlus ? t('cUpgradePlus') : t('cUpgradePrompt')} <span className="pro-badge">{needPlus ? t('planPlus') : t('planPro')}</span></span>
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

/** Free / Pro / Plus side by side (v17 feature table). true / false = tick / dash, a Key = text. */
const COMPARE: { label: Key; v: [boolean | Key, boolean | Key, boolean | Key] }[] = [
  { label: 'cmpKeep', v: ['cmp1h', 'cmp24h', 'cmp7d'] },
  { label: 'cmpOrderSize', v: ['cmp50mb', 'cmp100mb', 'cmp200mb'] },
  { label: 'cmpOrdersDay', v: ['cmpUnlimited', 'cmpUnlimited', 'cmpUnlimited'] },
  { label: 'cmpHistory', v: ['cmp7days', 'cmp6m', 'cmp1y'] },
  { label: 'cmpTimings', v: [true, true, true] },
  { label: 'cmpExtras', v: [true, true, true] },
  { label: 'cmpReady', v: [true, true, true] },
  { label: 'cmpDirectPrint', v: [true, true, true] },
  { label: 'cmpPaper', v: [true, true, true] },
  { label: 'cmpAutoPrint', v: [false, true, true] },
  { label: 'cmpQrDesign', v: [false, true, true] },
  { label: 'cmpDynQr', v: [false, true, true] },
  { label: 'cmpPassport', v: [false, true, true] },
  { label: 'cmpIdcard', v: [false, true, true] },
  { label: 'cmpNoAdsCust', v: [false, true, true] },
  { label: 'cmpNoAdsYou', v: [false, false, true] },
  { label: 'cmpNoBranding', v: [false, false, true] },
  { label: 'cmpOwnBrand', v: [false, false, true] },
  { label: 'cmpStaff', v: [false, false, true] }
]

function PlanCompare({ current }: { current: PlanTier }) {
  const { t } = useI18n()
  const tiers: PlanTier[] = ['free', 'pro', 'plus']
  const name = (x: PlanTier) => (x === 'plus' ? t('planPlus') : x === 'pro' ? t('planPro') : t('planFree'))
  return (
    <div className="card plan-compare">
      <h2 className="card-title">{t('cmpTitle')}</h2>
      <div className="cmp-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">{t('cmpTitle')}</span></th>
              {tiers.map((x) => <th key={x} scope="col" className={x === current ? 'is-current' : ''}>{name(x)}{x === current && <span className="cmp-you">{t('cmpYou')}</span>}</th>)}
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((r) => (
              <tr key={r.label}>
                <th scope="row">{t(r.label)}</th>
                {r.v.map((v, i) => (
                  <td key={i} className={tiers[i] === current ? 'is-current' : ''}>
                    {v === true ? <Icon name="check" size={16} stroke={3} className="cmp-yes" /> : v === false ? <span className="cmp-no" aria-label="—">—</span> : t(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const ENDED = ['cancelled', 'completed', 'expired']

/** Plan tab: one row per Razorpay payment (v33 billing_payments) with a PDF receipt. Hidden when there are none. */
function PaymentsList({ shop }: { shop: Shop }) {
  const { t, lang } = useI18n()
  const [rows, setRows] = useState<BillingPayment[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState(false)

  useEffect(() => {
    let live = true
    supabase
      .from('billing_payments')
      .select('payment_id,subscription_id,tier,period,amount,currency,paid_at,period_start,period_end')
      .eq('shop_id', shop.id)
      .order('paid_at', { ascending: false })
      .limit(60)
      .then(({ data, error }) => {
        // Before the v33 database update the table does not exist: show nothing.
        if (live) setRows(error ? [] : ((data || []) as BillingPayment[]))
      })
    return () => { live = false }
  }, [shop.id, shop.plan_expires_at])

  if (!rows?.length) return null
  const day = (iso: string) => new Date(iso).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' })

  async function get(p: BillingPayment) {
    setBusy(p.payment_id)
    setErr(false)
    try {
      await downloadReceipt(p, shop.name)
    } catch (e) {
      console.error(e)
      setErr(true)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="card pay-list">
      <h3 className="card-title">{t('payListTitle')}</h3>
      <ul>
        {rows.map((p) => (
          <li key={p.payment_id}>
            <div className="pay-main">
              <b>{p.tier === 'plus' ? t('planPlus') : t('planPro')}{p.period ? ` · ${p.period === 'yearly' ? t('planYearly') : t('planMonthly')}` : ''}</b>
              <span className="small muted">{day(p.paid_at)} · {money(p)}</span>
            </div>
            <button type="button" className="btn small" disabled={busy !== null} onClick={() => void get(p)}>
              {busy === p.payment_id ? t('pleaseWait') : t('payReceipt')}
            </button>
          </li>
        ))}
      </ul>
      {err && <p className="notice error">{t('payReceiptFail')}</p>}
      <p className="small muted">{t('payListNote', { seller: SELLER })}</p>
    </div>
  )
}

function PlanTab({ shop, email, contact, onChanged }: { shop: Shop; email?: string; contact?: string; onChanged: () => Promise<void> | void }) {
  const couponsOn = useAppSettings().coupons_enabled !== false
  const { t, te, lang } = useI18n()
  const [busy, setBusy] = useState<string | null>(null)
  const [period, setPeriod] = useState<Period>('yearly')
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null)
  // v40 % off code checked by the server; applied server side when paying (the code is all the browser sends).
  const [deal, setDeal] = useState<CouponDeal | null>(null)

  if (!plansReady(shop)) {
    return (
      <div className="card form-card">
        <h2 className="card-title">{t('planTitle')}</h2>
        <p className="notice">{t('planNeedsUpdate')}</p>
      </div>
    )
  }

  const pro = shopIsPro(shop)
  const plus = shopIsPlus(shop)
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
    if (code && code.startsWith('coupon_')) {
      const k: Record<string, Key> = { coupon_expired: 'cpExpired', coupon_used_up: 'cpUsedUp', coupon_already: 'cpAlready', coupon_too_many: 'cpTooMany',
        coupon_not_for_plan: 'cpNotForPlan', coupon_offer_failed: 'cpOfferFail', coupon_tier_higher_than_paid: 'cpTierHigher' }
      return t(k[code] || 'cpNotFound')
    }
    return te(e)
  }

  /** The code's price for this tier + period (paise), or null when the code is not for it. */
  function dealFor(tier: Tier, p: Period): { base: number; amount: number } | null {
    if (!deal || !deal.tiers.includes(tier) || !deal.periods.includes(p)) return null
    return deal.prices[tier]?.[p] || null
  }

  async function upgrade(tier: Tier) {
    // Pro -> Plus: the Pro subscription stops at once; its unused days are added to Plus as extra days (server side).
    if (pro && tier === 'plus' && !await askConfirm(t('planUpgradeConfirm'), { danger: false, icon: 'star' })) return
    setBusy(tier)
    setMsg(null)
    try {
      const desc = `PrintQR ${tier === 'plus' ? 'Plus' : 'Pro'} · ${period === 'yearly' ? t('planYearly') : t('planMonthly')}`
      const d = dealFor(tier, period)
      const ok = await startUpgrade(period, { email, contact, description: d && deal ? `${desc} · ${deal.code}` : desc }, tier, d && deal ? deal.code : undefined)
      if (ok) {
        if (d) setDeal(null)
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
    if (!await askConfirm(t('planConfirmCancel', { date: until }), { icon: 'star' })) return
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

  const per = period === 'yearly' ? t('perYear') : t('perMonth')
  const cards: { tier: Tier; feats: Key[] }[] = [
    { tier: 'pro', feats: ['planFeatDynQr', 'planFeatNoAdsCust', 'planFeatPassport', 'planFeatIdcard', 'planFeatCounters2', 'planFeatKeep24h', 'planFeatOrder100', 'planFeatHist6m', 'planFeatQrDesign', 'planFeatAutoPrint'] },
    { tier: 'plus', feats: ['planFeatAllPro', 'planFeatNoAdsAll', 'planFeatCounters', 'planFeatKeep7d', 'planFeatOrder200', 'planFeatHist1y', 'planFeatNoBranding', 'planFeatOwnBrand', 'planFeatStaff'] }
  ]
  // Free: both plans. Pro: only the upgrade to Plus. Plus: nothing to buy.
  const shown = cards.filter((c) => (!pro ? true : !plus && c.tier === 'plus'))

  return (
    <section>
      <div className={`card plan-current${pro ? ' is-pro' : ''}`}>
        <div className="plan-current-top">
          <div>
            <div className="small muted">{t('planTitle')}</div>
            <h2 className="plan-name">{plus ? t('planPlus') : pro ? t('planPro') : t('planFree')} {pro && <span className="pro-badge">{periodText}</span>}</h2>
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

      {couponsOn && <CouponBox onDone={onChanged} deal={deal} onDeal={(d) => { setDeal(d); setMsg(null); if (d && d.periods.length === 1) setPeriod(d.periods[0]) }} />}

      {shown.length > 0 && (
        <>
          <div className="seg plan-period-toggle" role="group" aria-label={t('planTitle')}>
            {(['monthly', 'yearly'] as Period[]).map((p) => (
              <button key={p} type="button" className={period === p ? 'on' : ''} aria-pressed={period === p}
                onClick={() => setPeriod(p)}>
                {p === 'yearly' ? t('planYearly') : t('planMonthly')}
              </button>
            ))}
          </div>
          <div className="plan-grid">
            {shown.map((c) => {
              const d = dealFor(c.tier, period)
              // Auto mode: the server's discounted price. Offer mode: Razorpay shows the offer at payment.
              const cut = d && deal?.mode === 'auto' && d.amount < d.base ? d.amount / 100 : null
              const price = cut ?? TIER_PRICES[c.tier][period]
              const priceText = Number.isInteger(price) ? String(price) : price.toFixed(2)
              const name = c.tier === 'plus' ? t('planPlus') : t('planPro')
              return (
                <div key={c.tier} className={`card plan-card${c.tier === 'plus' ? ' best' : ''}`}>
                  {period === 'yearly' && <span className="plan-save">{t('planOff', { n: yearlyOff(c.tier) })}</span>}
                  <div className="small muted plan-period">{name}</div>
                  <div className="plan-price">{cut !== null && <s className="plan-cut">₹{TIER_PRICES[c.tier][period]}</s>}₹{priceText}<span>{per}</span></div>
                  {d && deal && <div className="small plan-deal">{deal.mode === 'auto' ? t('cpCardAuto', { code: deal.code, n: deal.percent ?? 0 }) : t('cpCardOffer', { code: deal.code })}</div>}
                  {deal && !d && <div className="small muted plan-deal">{t('cpNotForThis', { code: deal.code })}</div>}
                  {period === 'yearly' && <div className="small muted plan-was"><s>₹{TIER_PRICES[c.tier].monthly * 12}</s> · ₹{TIER_PRICES[c.tier].monthly}{t('perMonth')}</div>}
                  <ul className="plan-feats">
                    {c.feats.map((f) => <li key={f}><Icon name="check" size={16} stroke={3} /> {t(f)}</li>)}
                  </ul>
                  <button type="button" className={`btn block lg${c.tier === 'plus' ? ' primary' : ''}`} disabled={busy !== null}
                    onClick={() => void upgrade(c.tier)}>
                    {busy === c.tier ? t('pleaseWait') : `${pro ? t('planUpgradePlus') : c.tier === 'plus' ? t('planGetPlus') : t('planGetPro')} · ₹${priceText}${per}`}
                  </button>
                  {pro && c.tier === 'plus' && <p className="small muted">{t('planUpgradeCredit')}</p>}
                </div>
              )
            })}
          </div>
        </>
      )}

      {msg && <p className={`notice${msg.error ? ' error' : ' success'}`}>{msg.text}</p>}
      {shown.length > 0 && <p className="small muted">{t('planPayNote')}</p>}
      <PlanCompare current={plus ? 'plus' : pro ? 'pro' : 'free'} />
      <PaymentsList shop={shop} />

      {pro && !ended && shop.razorpay_subscription_id && (
        <button type="button" className="btn danger-outline" disabled={busy !== null} onClick={() => void cancel()}>
          {busy === 'cancel' ? t('pleaseWait') : t('planCancel')}
        </button>
      )}
    </section>
  )
}

/** v41: the server checked each file's pages. Corrected / unverified files get a warning for the shop. */
function PagesCheck({ f }: { f: OrderFile }) {
  const { t } = useI18n()
  if (f.pages_status === 'corrected') {
    const said = f.item_kind === 'passport' ? f.claimed_pages : (f.claimed_total_pages ?? f.claimed_pages)
    const has = f.pages_real ?? f.total_pages
    return (
      <p className="pages-check is-fixed" role="note">
        <Icon name="alert" size={14} className="ico-inl" />
        <span>
          {said != null && said !== has ? t('pvCorrected', { c: said, n: has }) : t('pvCorrected', { c: f.claimed_pages ?? '?', n: f.pages_to_print })}
          {f.claimed_price != null && Number(f.claimed_price) !== Number(f.price) && (
            <> · {t('pvPriceWas', { old: rupees(Number(f.claimed_price)), now: rupees(Number(f.price)) })}</>
          )}
        </span>
      </p>
    )
  }
  if (f.pages_status === 'unverified') {
    const why = f.pages_note === 'office' ? t('pvWhyOffice')
      : f.pages_note === 'encrypted' ? t('pvWhyEncrypted')
      : f.pages_note === 'too_big' || f.pages_note === 'too_complex' || f.pages_note === 'timeout' ? t('pvWhyBig')
      : f.pages_note === 'unreadable' ? t('pvWhyBroken') : null
    return (
      <p className="pages-check is-unverified" role="note">
        <Icon name="alert" size={14} className="ico-inl" />
        <span>{t('pvUnverified')}{why ? ` (${why})` : ''}</span>
      </p>
    )
  }
  return null
}

/** v41: one small flag next to the order total when any file was corrected or could not be checked. */
function PagesFlag({ files }: { files?: OrderFile[] | null }) {
  const { t } = useI18n()
  const list = files || []
  if (list.some((f) => f.pages_status === 'unverified')) return <span className="pill tiny pages-flag is-unverified">{t('pvOrderWarn')}</span>
  if (list.some((f) => f.pages_status === 'corrected')) return <span className="pill tiny pages-flag is-fixed">{t('pvOrderFixed')}</span>
  return null
}
