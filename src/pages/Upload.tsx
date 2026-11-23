import { ChangeEvent, DragEvent, lazy, ReactElement, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { DEFAULT_IDCARD_RATE, Rates, supabase, UUID_RE } from '../lib/supabase'
import { countPdfPages, extractPages, pagesToRange } from '../lib/pdf'
import { filePrice, rupees } from '../lib/pricing'
import { idcardPreview, idcardSheetPdf, imagesToPdf, PASSPORT_OPTIONS, passportPreview, passportSheetPdf, passportSheets } from '../lib/imagePdf'
import { useI18n } from '../lib/i18n'
import { ShopBrand, TopBar } from '../components/TopBar'
import { QrLoadBlock } from '../components/QrLoader'
import { brandStyle } from '../lib/brand'
import { nextOpening, normHours, timeLabel } from '../lib/hours'
import AdSlot from '../components/AdSlot'
import Icon from '../components/Icon'
import { CopiesField, FileBadge, RatePapers, SideColor, UploadOpts } from '../components/UploadParts'
import { ImageLightbox, LocalImageThumb, ViewImg } from '../components/ImagePreview'
import { makeThumb, thumbPath } from '../lib/thumb'
import PagePicker from '../components/PagePicker'
import ReportShop from '../components/ReportShop'
import { Turnstile } from '../components/Turnstile'
import standeeUrl from '../assets/qr-standee.svg'
import closedStandeeUrl from '../assets/closed-qr-standee.svg'

// ID card crop screen (editor code): loaded only when a customer adds an ID card.
const IdCardCrop = lazy(() => import('../components/IdCardCrop'))

type ShopPublic = {
  id: string
  name: string
  address: string | null
  is_open: boolean
  rates: Rates
  upi_id: string | null
  /** From the v3 database update. undefined = older database (no plans: no ads, passport as before). */
  is_pro?: boolean
  /** v17: Plus branding, plan order size, how long files stay, timings */
  is_plus?: boolean
  logo_url?: string | null
  brand_color?: string | null
  max_order_mb?: number
  file_hours?: number
  hours?: unknown
}

type Item = {
  key: string
  file: File
  kind: 'pdf' | 'image' | 'doc'
  totalPages: number
  counting: boolean
  /** PDF: the pages to print (1-based, sorted); null = all pages. */
  pages: number[] | null
  copies: number
  color: boolean
  duplex: boolean
  binding: boolean
  lamination: boolean
}

type Progress = { text: string; pct: number }

type Opts = UploadOpts

type Passport = { file: File; photos: number; preview: string }

/** ID card sheet (v23): cropped front (and back) pictures, printed `copies` times. */
type IdSide = { card: HTMLCanvasElement; preview: string }
type IdCard = { front: IdSide; back: IdSide | null; copies: number; color: boolean }

/** One file that will be uploaded: what create_order gets, and the bytes. */
type Upload = { payload: Record<string, unknown>; blob: Blob; contentType: string }

const MAX_FILES = 20
const MAX_SIZE = 50 * 1024 * 1024

/** File types a customer may send: extension -> the one content type the server accepts for it (v7). */
const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

function mimeOf(f: File): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(f.name)
  return m ? TYPES[m[1].toLowerCase()] ?? null : null
}

function kindOf(f: File): Item['kind'] {
  if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) return 'pdf'
  if (f.type.startsWith('image/')) return 'image'
  return 'doc'
}

function sizeText(b: number) {
  return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB'
}

type OptProps = { o: Opts; onChange: (p: Partial<Opts>) => void; disabled?: boolean }

/** Binding / lamination (v17): shown only when the shop has a rate for them. */
function Extras({ o, onChange, rates }: OptProps & { rates: Rates }) {
  const { t } = useI18n()
  const bind = Number(rates.binding ?? 0) > 0
  const lam = Number(rates.lamination ?? 0) > 0
  if (!bind && !lam) return null
  return (
    <div className="opt-row extras-row">
      <span className="opt-label">{t('optExtras')}</span>
      <div className="seg" role="group" aria-label={t('optExtras')}>
        {bind && (
          <button type="button" className={o.binding ? 'on' : ''} aria-pressed={o.binding} onClick={() => onChange({ binding: !o.binding })}>
            {o.binding && <Icon name="check" size={14} stroke={3} />}{t('optBinding')} +{rupees(Number(rates.binding))}
          </button>
        )}
        {lam && (
          <button type="button" className={o.lamination ? 'on' : ''} aria-pressed={o.lamination} onClick={() => onChange({ lamination: !o.lamination })}>
            {o.lamination && <Icon name="check" size={14} stroke={3} />}{t('optLamination')} +{rupees(Number(rates.lamination))}
          </button>
        )}
      </div>
    </div>
  )
}

export default function Upload() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const rawCounter = params.get('c')
  const counterId = rawCounter && UUID_RE.test(rawCounter) ? rawCounter : null
  const nav = useNavigate()
  const { t, tn, te, lang } = useI18n()
  const [shop, setShop] = useState<ShopPublic | null>(null)
  const [viewImg, setViewImg] = useState<ViewImg | null>(null)
  const [loadErr, setLoadErr] = useState<{ text?: string; notFound?: boolean } | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState(() => localStorage.getItem('pq_name') || '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  // v25: the bot check appears only when the server asks for it (many orders from one network / shop in 10 min).
  const [needCheck, setNeedCheck] = useState(false)
  const [pass, setPass] = useState<string | null>(null)
  const [checkReset, setCheckReset] = useState(0)
  async function onCheckToken(token: string | null) {
    if (!token) return setPass(null)
    const r = await supabase.functions.invoke('upload-pass', { body: { token } })
    const p = (r.data as { pass?: string } | null)?.pass
    if (r.error || !p) {
      setPass(null)
      setMsg(t('uCheckFail'))
      setCheckReset((n) => n + 1)
      return
    }
    setPass(p)
    setMsg(null)
  }
  const [dragging, setDragging] = useState(false)
  const [combine, setCombine] = useState(true)
  const [combo, setCombo] = useState<Opts>({ copies: 1, color: true, duplex: false, binding: false, lamination: false })
  const [passport, setPassport] = useState<Passport | null>(null)
  const [idcard, setIdcard] = useState<IdCard | null>(null)
  /** Photo being cropped for one side of the ID card. */
  const [idCrop, setIdCrop] = useState<{ file: File; side: 'front' | 'back' } | null>(null)
  const [counterName, setCounterName] = useState<string | null>(null)
  /** PDFs waiting for the page picker (opens right after upload), first one is shown. */
  const [pickQueue, setPickQueue] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const passportRef = useRef<HTMLInputElement>(null)
  const idFrontRef = useRef<HTMLInputElement>(null)
  const idBackRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.rpc('get_shop_public', { p_slug: slug }).then(({ data, error }) => {
      if (error) return setLoadErr({ text: te(error) })
      const row = (data as ShopPublic[] | null)?.[0]
      if (!row) return setLoadErr({ notFound: true })
      setShop(row)
      if (row.is_plus) document.title = row.name
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  // Counter QR (?c=<id>): show the counter name. Before the v2 database update this RPC does not exist; ignore.
  useEffect(() => {
    if (!counterId) return
    supabase.rpc('get_counter_public', { p_slug: slug, p_counter: counterId }).then(({ data, error }) => {
      if (!error && typeof data === 'string' && data) setCounterName(data)
    })
  }, [slug, counterId])

  const maxMb = shop?.max_order_mb || 200
  const maxOrder = maxMb * 1024 * 1024

  function update(key: string, patch: Partial<Item>) {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  }

  async function addFiles(files: File[]) {
    setMsg(null)
    const room = MAX_FILES - items.length - (passport ? 1 : 0) - (idcard ? 1 : 0)
    if (files.length > room) setMsg(t('uMaxFiles', { n: MAX_FILES }))
    const added: Item[] = []
    // Whole order: up to the shop plan's size (50 / 100 / 200 MB, checked again by the server).
    let bytes = items.reduce((n, it) => n + it.file.size, 0) + (passport?.file.size ?? 0)
    for (const f of files.slice(0, Math.max(0, room))) {
      if (f.size > MAX_SIZE) {
        setMsg(t('uTooBig', { name: f.name }))
        continue
      }
      if (bytes + f.size > maxOrder) {
        setMsg(t('uOrderTooBig', { mb: maxMb }))
        continue
      }
      bytes += f.size
      if (!mimeOf(f)) {
        setMsg(t('uBadType', { name: f.name }))
        continue
      }
      const kind = kindOf(f)
      added.push({
        key: crypto.randomUUID(),
        file: f,
        kind,
        totalPages: 1,
        counting: kind === 'pdf',
        pages: null,
        copies: 1,
        color: kind === 'image',
        duplex: false,
        binding: false,
        lamination: false
      })
    }
    setItems((list) => [...list, ...added])
    for (const it of added) {
      if (it.kind !== 'pdf') continue
      try {
        const n = await countPdfPages(it.file)
        update(it.key, { totalPages: n, counting: false })
        if (n > 1) setPickQueue((q) => [...q, it.key])
      } catch {
        update(it.key, { counting: false, kind: 'doc' })
        setMsg(t('uCountFail', { name: it.file.name }))
      }
    }
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    void addFiles(files)
  }

  async function onPickPassport(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setMsg(null)
    if (f.size > MAX_SIZE) return setMsg(t('uTooBig', { name: f.name }))
    if (items.reduce((n, it) => n + it.file.size, 0) + f.size > maxOrder) return setMsg(t('uOrderTooBig', { mb: maxMb }))
    if (!mimeOf(f)?.startsWith('image/')) return setMsg(t('uBadType', { name: f.name }))
    try {
      const preview = await passportPreview(f)
      setPassport((p) => ({ file: f, photos: p?.photos ?? PASSPORT_OPTIONS[0], preview }))
    } catch {
      setMsg(t('ppReadFail'))
    }
  }

  function onPickIdSide(side: 'front' | 'back', e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    setMsg(null)
    if (f.size > MAX_SIZE) return setMsg(t('uTooBig', { name: f.name }))
    if (!mimeOf(f)?.startsWith('image/')) return setMsg(t('uBadType', { name: f.name }))
    setIdCrop({ file: f, side })
  }

  function onIdCropped(side: 'front' | 'back', card: HTMLCanvasElement) {
    setIdCrop(null)
    const s: IdSide = { card, preview: idcardPreview(card) }
    if (side === 'front') setIdcard((c) => (c ? { ...c, front: s } : { front: s, back: null, copies: 1, color: true }))
    else setIdcard((c) => (c ? { ...c, back: s } : c))
  }

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragging(false)
    if (busy) return
    void addFiles(Array.from(e.dataTransfer.files || []))
  }

  const images = items.filter((it) => it.kind === 'image')
  const combineOn = combine && images.length >= 2
  const passportRate = shop?.rates.passport_sheet
  // Passport sheet is a Pro feature (free shops also get no passport_sheet rate from the server).
  const passportEnabled = passportRate !== undefined && passportRate !== null && shop?.is_pro !== false
  // ID card sheet (v23): same rule. Before the v23 database update the rate is missing, so it stays hidden.
  const idcardRate = shop?.rates.idcard_sheet
  const idcardEnabled = idcardRate !== undefined && idcardRate !== null && shop?.is_pro !== false

  const priced = useMemo(() => {
    if (!shop) return []
    return items
      .filter((it) => !(combineOn && it.kind === 'image'))
      .map((it) => {
        const pages = it.kind === 'pdf' ? (it.pages ? it.pages.length : it.totalPages) : it.totalPages
        const price = pages ? filePrice(shop.rates, pages, it.copies, it.color, it.duplex, it.binding, it.lamination) : 0
        return { it, pages, price }
      })
  }, [items, shop, combineOn])

  const comboPrice = shop && combineOn ? filePrice(shop.rates, images.length, combo.copies, combo.color, combo.duplex, combo.binding, combo.lamination) : 0
  const sheets = passport ? passportSheets(passport.photos) : 0
  const passportPrice = passport ? sheets * Number(passportRate ?? 0) : 0
  const idcardPrice = idcard ? idcard.copies * Number(idcardRate ?? DEFAULT_IDCARD_RATE) : 0
  const total = priced.reduce((s, p) => s + p.price, 0) + comboPrice + passportPrice + idcardPrice
  const invalid = priced.some((p) => !p.pages) || items.some((i) => i.counting)
  const uploadCount = priced.length + (combineOn ? 1 : 0) + (passport ? 1 : 0) + (idcard ? 1 : 0)

  async function submit() {
    if (!shop || (!items.length && !passport && !idcard) || invalid) return
    setBusy(true)
    setMsg(null)
    try {
      localStorage.setItem('pq_name', name.trim())
      const uploads: Upload[] = []
      // A PDF with chosen pages is sent as a new PDF of just those pages (copied as they are, same look).
      // The shop prints the whole file; the server counts its pages and sets the price (v11).
      const fileUpload = async (it: Item, pages: number): Promise<Upload> => {
        let blob: Blob = it.file
        let name = it.file.name
        if (it.kind === 'pdf' && it.pages && it.pages.length < it.totalPages) {
          try {
            blob = await extractPages(it.file, it.pages)
          } catch {
            throw new Error(t('ppkSplitFail', { name: it.file.name }))
          }
          name = it.file.name.replace(/\.pdf$/i, '') + ` (p${pagesToRange(it.pages)}).pdf`
        }
        return {
          payload: {
            name,
            mime: mimeOf(it.file) || 'application/pdf',
            size: blob.size,
            total_pages: pages,
            page_range: '',
            pages_to_print: pages,
            copies: it.copies,
            color: it.color,
            duplex: it.duplex,
            binding: it.binding,
            lamination: it.lamination
          },
          blob,
          contentType: mimeOf(it.file) || 'application/pdf'
        }
      }
      let comboAdded = false
      for (const it of items) {
        if (combineOn && it.kind === 'image') {
          if (comboAdded) continue
          comboAdded = true
          let pdf: Blob
          try {
            pdf = await imagesToPdf(images.map((x) => x.file), (i) =>
              setProgress({ text: t('uMakingPdf', { i: i + 1, n: images.length }), pct: Math.round((i / images.length) * 100) })
            )
          } catch {
            throw new Error(t('uPdfFail'))
          }
          if (pdf.size > MAX_SIZE) throw new Error(t('uTooBig', { name: 'photos.pdf' }))
          uploads.push({
            payload: {
              name: 'photos.pdf',
              mime: 'application/pdf',
              size: pdf.size,
              total_pages: images.length,
              page_range: '',
              pages_to_print: images.length,
              copies: combo.copies,
              color: combo.color,
              duplex: combo.duplex,
              binding: combo.binding,
              lamination: combo.lamination
            },
            blob: pdf,
            contentType: 'application/pdf'
          })
          continue
        }
        const p = priced.find((x) => x.it.key === it.key)
        if (p?.pages) {
          setProgress({ text: t('ppkPreparing', { name: it.file.name }), pct: 0 })
          uploads.push(await fileUpload(it, p.pages))
        }
      }
      if (passport) {
        setProgress({ text: t('ppMaking'), pct: 50 })
        let pdf: Blob
        try {
          pdf = await passportSheetPdf(passport.file, passport.photos)
        } catch {
          throw new Error(t('ppReadFail'))
        }
        uploads.push({
          payload: { kind: 'passport', name: 'passport-photos.pdf', mime: 'application/pdf', size: pdf.size, photos: passport.photos },
          blob: pdf,
          contentType: 'application/pdf'
        })
      }
      if (idcard) {
        setProgress({ text: t('idMaking'), pct: 50 })
        let pdf: Blob
        try {
          pdf = await idcardSheetPdf(idcard.front.card, idcard.back?.card ?? null)
        } catch {
          throw new Error(t('ppReadFail'))
        }
        uploads.push({
          payload: { kind: 'idcard', name: 'id-card.pdf', mime: 'application/pdf', size: pdf.size, copies: idcard.copies, color: idcard.color },
          blob: pdf,
          contentType: 'application/pdf'
        })
      }
      setProgress(null)
      if (uploads.reduce((n, u) => n + u.blob.size, 0) > maxOrder) throw new Error(t('uOrderTooBig', { mb: maxMb }))

      const args: Record<string, unknown> = { p_slug: slug, p_customer_name: name, p_note: note, p_files: uploads.map((u) => u.payload) }
      // v25: no bot check for normal customers; the server asks for one (captcha_required) only for automated-looking orders.
      if (pass) {
        args.p_pass = pass
        setPass(null)
        setCheckReset((n) => n + 1)
      }
      let res: { data: unknown; error: { code?: string; message: string } | null } = counterId
        ? await supabase.rpc('create_order', { ...args, p_counter: counterId })
        : await supabase.rpc('create_order', args)
      // Database not updated to v2 yet: the counter argument is unknown. Send the order without it.
      if (counterId && res.error && res.error.code === 'PGRST202') res = await supabase.rpc('create_order', args)
      const { data, error } = res
      if (error && /captcha_required/i.test(error.message || '')) {
        setNeedCheck(true)
        throw new Error(t('uCheckNeeded'))
      }
      if (error) throw error
      setNeedCheck(false)
      const order = (data as { order_id: string; access_key: string; token: number; paths: string[] }[])[0]
      // v18: the 'order ready' notification comes in the language the customer ordered in (ignored if the DB is older).
      void supabase.rpc('set_order_lang', { p_order_id: order.order_id, p_key: order.access_key, p_lang: lang === 'hi' ? 'hi' : 'en' }).then(() => {}, () => {})
      for (let i = 0; i < uploads.length; i++) {
        setProgress({ text: t('uUploading', { i: i + 1, n: uploads.length }), pct: Math.round((i / uploads.length) * 100) })
        const u = uploads[i]
        const { error: upErr } = await supabase.storage.from('uploads').upload(order.paths[i], u.blob, {
          contentType: u.contentType,
          upsert: false
        })
        if (upErr) throw upErr
        // v24: a small copy of each photo for the owner's list (saves their data). Best effort: never blocks the order.
        if (u.contentType.startsWith('image/')) {
          const th = await makeThumb(u.blob)
          if (th) await supabase.storage.from('uploads').upload(thumbPath(order.paths[i]), th, { contentType: 'image/jpeg', upsert: false }).then(() => {}, () => {})
        }
      }
      setProgress({ text: t('uSending'), pct: 100 })
      // v11: the server counts the pages of every uploaded PDF, fixes the price if needed, then queues the order.
      const fin = await supabase.functions.invoke('finalize-order', { body: { order_id: order.order_id, key: order.access_key } })
      if (fin.error) {
        const ctx = (fin.error as { context?: Response }).context
        let body: { error?: string; message?: string } | undefined
        try { body = (await ctx?.json()) as { error?: string; message?: string } } catch { /* none */ }
        // 546 = the function hit its CPU / memory limit (a very heavy PDF); pdf_too_complex = refused up front.
        if (ctx?.status === 546 || body?.error === 'pdf_too_complex') throw new Error(t('uPdfHeavy'))
        throw new Error(body?.message || t('uFinalizeFail'))
      }
      const saved = JSON.parse(localStorage.getItem('pq_orders') || '[]') as unknown[]
      localStorage.setItem('pq_orders', JSON.stringify([{ id: order.order_id, key: order.access_key, shop: shop.name, at: Date.now() }, ...saved].slice(0, 10)))
      nav(`/o/${order.order_id}/${order.access_key}`, { replace: true })
    } catch (e) {
      setMsg(te(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  // Plus shops: their own logo/name instead of the PrintQR wordmark, and their colour.
  const own = shop?.is_plus ? brandStyle(shop.brand_color) : undefined
  const shell = (body: ReactElement, extraClass = '') => (
    <div className={`app-page ${extraClass}${own ? ' branded' : ''}`} style={own}>
      <TopBar to={null} brand={shop?.is_plus ? <ShopBrand name={shop.name} logo={shop.logo_url} /> : undefined} />
      <main className="page narrow">{body}</main>
    </div>
  )

  if (loadErr) {
    return shell(
      <div className="card state-card">
        <span className="state-icon is-error" aria-hidden="true"><Icon name={loadErr.notFound ? 'qr' : 'alert'} size={28} /></span>
        <p className="state-title">{loadErr.notFound ? t('uShopNotFound') : loadErr.text}</p>
      </div>
    )
  }
  if (!shop) {
    return shell(
      // Shop open, closed, paused or Pro-only parts: not known until it loads
      <QrLoadBlock />
    )
  }

  const opening = !shop.is_open ? nextOpening(shop.hours ? normHours(shop.hours) : null) : null
  const dayName = (d: number) => new Date(2024, 0, 7 + d).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { weekday: 'long' })
  const hasItems = items.length > 0 || passport !== null || idcard !== null
  const roomLeft = MAX_FILES - items.length - (passport ? 1 : 0) - (idcard ? 1 : 0)
  const flowAt = !hasItems ? 0 : busy ? 2 : 1
  const flow = [t('flowAdd'), t('flowOptions'), t('flowSend')]
  const pickItem = busy ? null : pickQueue.map((k) => items.find((it) => it.key === k)).find((it) => it && it.kind === 'pdf' && !it.counting) ?? null
  const closePicker = (key: string) => setPickQueue((q) => q.filter((k) => k !== key))

  return shell(
    <>
      <header className="shop-head card">
        <div className="shop-head-row">
          {shop.is_plus && shop.logo_url
            ? <img className="shop-avatar" src={shop.logo_url} alt="" aria-hidden="true" width={52} height={52} />
            : <div className="shop-avatar" aria-hidden="true">{shop.name.trim().charAt(0).toUpperCase() || 'P'}</div>}
          <div className="shop-head-text">
            <h1>{shop.name}</h1>
            {shop.address && <p className="shop-addr"><Icon name="pin" size={15} /> {shop.address}</p>}
          </div>
          <span className={`open-chip ${shop.is_open ? 'is-open' : 'is-closed'}`}>
            <span className="open-dot" aria-hidden="true" />{shop.is_open ? t('shopOpen') : t('shopClosed')}
          </span>
        </div>
        {counterName && <p className="counter-tag"><Icon name="receipt" size={14} className="ico-inl" />{t('uCounter', { name: counterName })}</p>}
        <div className="shop-head-foot">
          <RatePapers bw={shop.rates.bw_single} color={shop.rates.color_single} />
          <img className="shop-standee" src={shop.is_open ? standeeUrl : closedStandeeUrl} alt="" aria-hidden="true" width={160} height={132} />
        </div>
      </header>

      {!shop.is_open ? (
        <div className="card state-card closed-card">
          <img className="closed-card-art" src={closedStandeeUrl} alt="" aria-hidden="true" width={160} height={132} />
          <h2>{t('uClosedTitle')}</h2>
          <p className="muted">{t('uClosedBody')}</p>
          {opening && (
            <p className="opens-line"><Icon name="clock" size={16} /> {opening.today
              ? t('uOpensToday', { time: timeLabel(opening.time, lang) })
              : t('uOpensOn', { day: dayName(opening.dow), time: timeLabel(opening.time, lang) })}</p>
          )}
          {opening && shop.hours ? (() => { const d = normHours(shop.hours).days[String(opening.dow)]; return d ? <p className="hours-line">{timeLabel(d.open, lang)} – {timeLabel(d.close, lang)}</p> : null })() : null}
        </div>
      ) : (
        <>
          <ol className="flow" aria-label={t('uStepFiles')}>
            {flow.map((label, i) => (
              <li key={i} className={i < flowAt ? 'done' : i === flowAt ? 'current' : ''} aria-current={i === flowAt ? 'step' : undefined}>
                <span className="flow-dot">{i < flowAt ? <Icon name="check" size={14} stroke={3} /> : i + 1}</span>
                <span className="flow-lbl">{label}</span>
              </li>
            ))}
          </ol>

          <input ref={inputRef} type="file" multiple hidden onChange={onPick}
            accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx" />
          <input ref={passportRef} type="file" hidden accept="image/*" onChange={(e) => void onPickPassport(e)} />
          <input ref={idFrontRef} type="file" hidden accept="image/*" onChange={(e) => onPickIdSide('front', e)} />
          <input ref={idBackRef} type="file" hidden accept="image/*" onChange={(e) => onPickIdSide('back', e)} />

          {!hasItems ? (
            <button
              type="button"
              className={`dropzone${dragging ? ' drag' : ''}`}
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              disabled={busy}
            >
              <span className="dz-icon" aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4" />
                </svg>
              </span>
              <span className="dz-title">{t('uDropTitle')}</span>
              <span className="dz-sub">{t('uDropSub')}</span>
              <span className="dz-types" aria-hidden="true">
                <span className="file-badge k-pdf">PDF</span><span className="file-badge k-image">IMG</span><span className="file-badge k-doc">DOC</span>
              </span>
            </button>
          ) : null}

          {!hasItems && passportEnabled && (
            <button type="button" className="btn block lg passport-entry" onClick={() => passportRef.current?.click()} disabled={busy}>
              <span className="pe-icon" aria-hidden="true"><Icon name="idcard" size={22} /></span>
              <span className="pe-text"><strong>{t('ppEntry')}</strong><span className="small muted">{t('ppEntrySub')}</span></span>
              <Icon name="arrow" size={18} className="pe-arrow" />
            </button>
          )}

          {!hasItems && idcardEnabled && (
            <button type="button" className="btn block lg passport-entry" onClick={() => idFrontRef.current?.click()} disabled={busy}>
              <span className="pe-icon" aria-hidden="true"><Icon name="idcard" size={22} /></span>
              <span className="pe-text"><strong>{t('idEntry')}</strong><span className="small muted">{t('idEntrySub')}</span></span>
              <Icon name="arrow" size={18} className="pe-arrow" />
            </button>
          )}

          {hasItems && (
            <div className="step-head">
              <span className="step-dot" aria-hidden="true">2</span>
              <h2>{t('uStepFiles')}</h2>
              <span className="step-count">{tn('files_one', 'files_other', uploadCount)}</span>
            </div>
          )}

          {images.length >= 2 && (
            <label className="card check-row">
              <input type="checkbox" checked={combine} onChange={(e) => setCombine(e.target.checked)} disabled={busy} />
              <span>
                <strong>{t('uCombine')}</strong>
                <span className="small muted">{t('uCombineSub')}</span>
              </span>
            </label>
          )}

          {combineOn && (
            <div className="card file-card">
              <div className="file-top">
                <FileBadge kind="pdf" />
                <div className="fname">
                  <strong>{t('uComboTitle', { n: images.length })}</strong>
                  <span className="muted small">{tn('uPages_one', 'uPages_other', images.length)} · A4</span>
                </div>
              </div>
              <ul className="combo-list">
                {images.map((it, i) => (
                  <li key={it.key}>
                    <span className="combo-num">{i + 1}</span>
                    <LocalImageThumb file={it.file} small onOpen={setViewImg} />
                    <span className="combo-name">{it.file.name}</span>
                    <span className="small muted">{sizeText(it.file.size)}</span>
                    <button type="button" className="icon-btn sm" aria-label={t('uRemove')} title={t('uRemove')}
                      onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} disabled={busy}><Icon name="x" size={18} /></button>
                  </li>
                ))}
              </ul>
              <div className="grid2">
                <CopiesField o={combo} onChange={(p) => setCombo((c) => ({ ...c, ...p }))} disabled={busy} />
              </div>
              <SideColor o={combo} onChange={(p) => setCombo((c) => ({ ...c, ...p }))} />
              <Extras o={combo} rates={shop.rates} onChange={(p) => setCombo((c) => ({ ...c, ...p }))} />
              <div className="file-price">
                <span className="small muted">{t('calcLine', { p: images.length, c: combo.copies })}</span>
                <strong>{rupees(comboPrice)}</strong>
              </div>
            </div>
          )}

          {priced.map(({ it, pages, price }) => (
            <div className="card file-card" key={it.key}>
              <div className="file-top">
                {it.kind === 'image'
                  ? <LocalImageThumb file={it.file} fallback={<FileBadge kind="image" />} onOpen={setViewImg} />
                  : <FileBadge kind={it.kind} />}
                <div className={`fname${it.kind === 'image' ? ' is-img' : ''}`}>
                  <strong>{it.file.name}</strong>
                  <span className="muted small">
                    {sizeText(it.file.size)}
                    {it.kind === 'pdf' && ' · ' + (it.counting ? t('uCounting') : tn('uPages_one', 'uPages_other', it.totalPages))}
                  </span>
                </div>
                <button type="button" className="icon-btn" aria-label={t('uRemove')} title={t('uRemove')}
                  onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} disabled={busy}><Icon name="x" size={18} /></button>
              </div>

              <div className="grid2">
                {it.kind === 'pdf' ? (
                  <div className="field">
                    <span>{t('uWhichPages')}</span>
                    <button type="button" className="btn pp-open" disabled={busy || it.counting}
                      onClick={() => setPickQueue((q) => [it.key, ...q.filter((k) => k !== it.key)])}>
                      <Icon name="file" size={16} />
                      <span>{it.pages ? t('ppkSome', { r: pagesToRange(it.pages) }) : t('ppkAllPages')}</span>
                    </button>
                  </div>
                ) : (
                  <label className="field">
                    <span>{t('uNumPages')}</span>
                    <input type="number" min={1} max={2000} value={it.totalPages}
                      onChange={(e) => update(it.key, { totalPages: Math.max(1, Math.min(2000, Number(e.target.value) || 1)) })} />
                  </label>
                )}
                <CopiesField o={it} onChange={(p) => update(it.key, p)} disabled={busy} />
              </div>

              <SideColor o={it} onChange={(p) => update(it.key, p)} />
              <Extras o={it} rates={shop.rates} onChange={(p) => update(it.key, p)} />

              <div className="file-price">
                <span className={pages ? 'small muted' : 'small err-text'}>
                  {t('calcLine', { p: pages, c: it.copies })}
                </span>
                <strong>{rupees(price)}</strong>
              </div>
            </div>
          ))}

          {passport && (
            <div className="card file-card passport-card">
              <div className="file-top">
                <img className="pp-thumb" src={passport.preview} alt="" />
                <div className="fname">
                  <strong>{t('ppTitle')}</strong>
                  <span className="muted small">{t('ppSub')}</span>
                  <button type="button" className="link small" onClick={() => passportRef.current?.click()} disabled={busy}>
                    {t('ppChange')}
                  </button>
                </div>
                <button type="button" className="icon-btn" aria-label={t('uRemove')} title={t('uRemove')}
                  onClick={() => setPassport(null)} disabled={busy}><Icon name="x" size={18} /></button>
              </div>
              <div className="field">
                <span>{t('ppHowMany')}</span>
                <div className="seg">
                  {PASSPORT_OPTIONS.map((n) => (
                    <button type="button" key={n} className={passport.photos === n ? 'on' : ''}
                      onClick={() => setPassport({ ...passport, photos: n })}>{n}</button>
                  ))}
                </div>
              </div>
              <div className="file-price">
                <span className="small muted">{t('ppCalc', { n: passport.photos, s: sheets })}</span>
                <strong>{rupees(passportPrice)}</strong>
              </div>
            </div>
          )}

          {idcard && (
            <div className="card file-card passport-card idcard-card">
              <div className="file-top">
                <div className="fname">
                  <strong>{t('idTitle')}</strong>
                  <span className="muted small">{t('idSub')}</span>
                </div>
                <button type="button" className="icon-btn" aria-label={t('uRemove')} title={t('uRemove')}
                  onClick={() => setIdcard(null)} disabled={busy}><Icon name="x" size={18} /></button>
              </div>
              <div className="id-sides">
                <div className="id-side">
                  <img className="id-thumb" src={idcard.front.preview} alt={t('idFront')} />
                  <span className="small"><strong>{t('idFront')}</strong> · <button type="button" className="link small" onClick={() => idFrontRef.current?.click()} disabled={busy}>{t('idChange')}</button></span>
                </div>
                <div className="id-side">
                  {idcard.back ? (
                    <>
                      <img className="id-thumb" src={idcard.back.preview} alt={t('idBack')} />
                      <span className="small"><strong>{t('idBack')}</strong> · <button type="button" className="link small" onClick={() => idBackRef.current?.click()} disabled={busy}>{t('idChange')}</button>
                        {' · '}<button type="button" className="link small" onClick={() => setIdcard({ ...idcard, back: null })} disabled={busy}>{t('idRemoveBack')}</button></span>
                    </>
                  ) : (
                    <>
                      <button type="button" className="id-thumb id-add" onClick={() => idBackRef.current?.click()} disabled={busy}>
                        <Icon name="plus" size={20} /><span className="small">{t('idAddBack')}</span>
                      </button>
                      <span className="small muted">{t('idBackOptional')}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="grid2">
                <CopiesField o={{ copies: idcard.copies, color: idcard.color, duplex: false, binding: false, lamination: false }}
                  onChange={(p) => setIdcard({ ...idcard, ...(p.copies ? { copies: p.copies } : {}) })} disabled={busy} />
              </div>
              <div className="opt-row">
                <span className="opt-label">{t('optPrint')}</span>
                <div className="seg" role="group" aria-label={t('optPrint')}>
                  <button type="button" className={!idcard.color ? 'on' : ''} aria-pressed={!idcard.color} onClick={() => setIdcard({ ...idcard, color: false })}>
                    <span className="swatch sw-bw" aria-hidden="true" />{t('bw')}
                  </button>
                  <button type="button" className={idcard.color ? 'on' : ''} aria-pressed={idcard.color} onClick={() => setIdcard({ ...idcard, color: true })}>
                    <span className="swatch sw-color" aria-hidden="true" />{t('color')}
                  </button>
                </div>
              </div>
              <div className="file-price">
                <span className="small muted">{t('idCalc', { c: idcard.copies })}</span>
                <strong>{rupees(idcardPrice)}</strong>
              </div>
            </div>
          )}

          {hasItems && roomLeft > 0 && (
            <div className="add-row">
              <button type="button" className="btn dashed block lg" onClick={() => inputRef.current?.click()} disabled={busy}>
                {t('uAddMore')}
              </button>
              {passportEnabled && !passport && (
                <button type="button" className="btn dashed block lg" onClick={() => passportRef.current?.click()} disabled={busy}>
                  <Icon name="idcard" size={20} /> {t('ppEntry')}
                </button>
              )}
              {idcardEnabled && !idcard && (
                <button type="button" className="btn dashed block lg" onClick={() => idFrontRef.current?.click()} disabled={busy}>
                  <Icon name="idcard" size={20} /> {t('idEntry')}
                </button>
              )}
            </div>
          )}

          {hasItems && (
            <div className="card details-card">
              <div className="step-head in-card">
                <span className="step-dot" aria-hidden="true">3</span>
                <h2>{t('uDetails')}</h2>
              </div>
              <label className="field">
                <span>{t('uYourName')} <em className="opt">({t('optional')})</em></span>
                <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
              <label className="field">
                <span>{t('uNote')} <em className="opt">({t('optional')})</em></span>
                <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t('uNotePh')} />
              </label>
              <p className="privacy-line"><Icon name="shield" size={18} /> <span>{shop.file_hours
                ? t('uAutoDeleteH', { time: shop.file_hours % 24 === 0 && shop.file_hours >= 48 ? tn('durD_one', 'durD_other', shop.file_hours / 24) : tn('durH_one', 'durH_other', shop.file_hours) })
                : t('uAutoDelete')}</span></p>
            </div>
          )}


          {msg && <p className="notice error" role="alert"><Icon name="alert" size={18} /> <span>{msg}</span></p>}
          {needCheck && (
            <div className="card check-card">
              <p className="small"><strong>{t('uCheckTitle')}</strong> {pass ? t('uCheckOk') : t('uCheckSub')}</p>
              <Turnstile action="upload" onToken={(tok) => void onCheckToken(tok)} resetKey={checkReset} lang={lang} />
            </div>
          )}

          {hasItems && (
            <div className="sticky-bar">
              <div className="sticky-in">
                {progress && (
                  <div className="progress-track" role="progressbar" aria-valuenow={progress.pct} aria-valuemin={0} aria-valuemax={100} aria-label={progress.text}>
                    <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
                  </div>
                )}
                <div className="sticky-row">
                  <div className="sticky-total" aria-live="polite">
                    <span className="sticky-label">{t('total')} · {tn('files_one', 'files_other', uploadCount)}</span>
                    <strong>{rupees(total)}</strong>
                  </div>
                  <button type="button" className="btn primary lg sticky-cta" onClick={submit} disabled={busy || invalid || (needCheck && !pass)}>
                    {busy ? <><span className="spinner" aria-hidden="true" />{progress?.text || t('pleaseWait')}</> : <>{t('uSend')} <Icon name="arrow" size={20} /></>}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* Free-plan shops show an ad below the form. It never covers the upload controls. */}
      <p className="small muted center upload-legal">
        {t('uAgreePre')} <Link to="/legal/terms">{t('agreeTerms')}</Link> {t('agreeAnd')} <Link to="/legal/privacy">{t('agreePrivacy')}</Link>{t('uAgreePost')}
      </p>
      {shop.is_pro === false && <AdSlot className="upload-ad" />}
      <ReportShop slug={slug} />

      {idCrop && (
        <Suspense fallback={<div className="ed-busy" role="status"><div className="ed-busy-box"><span className="spinner" aria-hidden="true" /> {t('idOpening')}</div></div>}>
          <IdCardCrop key={idCrop.file.name + idCrop.file.lastModified + idCrop.side} file={idCrop.file}
            onDone={(card) => onIdCropped(idCrop.side, card)}
            onCancel={() => setIdCrop(null)}
            onError={() => { setIdCrop(null); setMsg(t('ppReadFail')) }} />
        </Suspense>
      )}

      {pickItem && (
        <PagePicker key={pickItem.key} file={pickItem.file} total={pickItem.totalPages} initial={pickItem.pages}
          onDone={(pages) => { update(pickItem.key, { pages }); closePicker(pickItem.key) }}
          onCancel={() => closePicker(pickItem.key)} />
      )}

      {viewImg && <ImageLightbox src={viewImg.src} name={viewImg.name} onClose={() => setViewImg(null)} />}
    </>,
    hasItems ? 'has-sticky' : ''
  )
}
