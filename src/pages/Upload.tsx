import { ChangeEvent, DragEvent, ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Rates, supabase, UUID_RE } from '../lib/supabase'
import { countPdfPages } from '../lib/pdf'
import { countRange, rateFor, rupees } from '../lib/pricing'
import { imagesToPdf, PASSPORT_OPTIONS, passportPreview, passportSheetPdf, passportSheets } from '../lib/imagePdf'
import { useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'
import AdSlot from '../components/AdSlot'
import Icon from '../components/Icon'

type ShopPublic = {
  id: string
  name: string
  address: string | null
  is_open: boolean
  rates: Rates
  upi_id: string | null
  /** From the v3 database update. undefined = older database (no plans: no ads, passport as before). */
  is_pro?: boolean
}

type Item = {
  key: string
  file: File
  kind: 'pdf' | 'image' | 'doc'
  totalPages: number
  counting: boolean
  range: string
  copies: number
  color: boolean
  duplex: boolean
}

type Progress = { text: string; pct: number }

type Opts = { copies: number; color: boolean; duplex: boolean }

type Passport = { file: File; photos: number; preview: string }

/** One file that will be uploaded: what create_order gets, and the bytes. */
type Upload = { payload: Record<string, unknown>; blob: Blob; contentType: string }

const MAX_FILES = 20
const MAX_SIZE = 50 * 1024 * 1024

function kindOf(f: File): Item['kind'] {
  if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) return 'pdf'
  if (f.type.startsWith('image/')) return 'image'
  return 'doc'
}

function sizeText(b: number) {
  return b > 1024 * 1024 ? (b / 1024 / 1024).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB'
}

type OptProps = { o: Opts; onChange: (p: Partial<Opts>) => void; disabled?: boolean }

function CopiesField({ o, onChange, disabled }: OptProps) {
  const { t } = useI18n()
  return (
      <div className="field">
        <span>{t('uCopies')}</span>
        <div className="stepper">
          <button type="button" aria-label={`${t('uCopies')} −`} disabled={disabled || o.copies <= 1}
            onClick={() => onChange({ copies: Math.max(1, o.copies - 1) })}>−</button>
          <input type="number" min={1} max={100} value={o.copies} aria-label={t('uCopies')} disabled={disabled}
            onChange={(e) => onChange({ copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
          <button type="button" aria-label={`${t('uCopies')} +`} disabled={disabled || o.copies >= 100}
            onClick={() => onChange({ copies: Math.min(100, o.copies + 1) })}>+</button>
        </div>
      </div>
  )
}

function SideColor({ o, onChange }: OptProps) {
  const { t } = useI18n()
  return (
    <div className="opt-group">
      <div className="opt-row">
        <span className="opt-label">{t('optPrint')}</span>
        <div className="seg" role="group" aria-label={t('optPrint')}>
          <button type="button" className={!o.color ? 'on' : ''} aria-pressed={!o.color} onClick={() => onChange({ color: false })}>
            <span className="swatch sw-bw" aria-hidden="true" />{t('bw')}
          </button>
          <button type="button" className={o.color ? 'on' : ''} aria-pressed={o.color} onClick={() => onChange({ color: true })}>
            <span className="swatch sw-color" aria-hidden="true" />{t('color')}
          </button>
        </div>
      </div>
      <div className="opt-row">
        <span className="opt-label">{t('optSides')}</span>
        <div className="seg" role="group" aria-label={t('optSides')}>
          <button type="button" className={!o.duplex ? 'on' : ''} aria-pressed={!o.duplex} onClick={() => onChange({ duplex: false })}>{t('oneSide')}</button>
          <button type="button" className={o.duplex ? 'on' : ''} aria-pressed={o.duplex} onClick={() => onChange({ duplex: true })}>{t('bothSides')}</button>
        </div>
      </div>
    </div>
  )
}

function FileBadge({ kind }: { kind: Item['kind'] }) {
  const label = kind === 'pdf' ? 'PDF' : kind === 'image' ? 'IMG' : 'DOC'
  return <span className={`file-badge k-${kind}`}>{label}</span>
}

export default function Upload() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const rawCounter = params.get('c')
  const counterId = rawCounter && UUID_RE.test(rawCounter) ? rawCounter : null
  const nav = useNavigate()
  const { t, tn, te } = useI18n()
  const [shop, setShop] = useState<ShopPublic | null>(null)
  const [loadErr, setLoadErr] = useState<{ text?: string; notFound?: boolean } | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState(() => localStorage.getItem('pq_name') || '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [combine, setCombine] = useState(true)
  const [combo, setCombo] = useState<Opts>({ copies: 1, color: true, duplex: false })
  const [passport, setPassport] = useState<Passport | null>(null)
  const [counterName, setCounterName] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const passportRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.rpc('get_shop_public', { p_slug: slug }).then(({ data, error }) => {
      if (error) return setLoadErr({ text: te(error) })
      const row = (data as ShopPublic[] | null)?.[0]
      if (!row) return setLoadErr({ notFound: true })
      setShop(row)
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

  function update(key: string, patch: Partial<Item>) {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  }

  async function addFiles(files: File[]) {
    setMsg(null)
    const room = MAX_FILES - items.length - (passport ? 1 : 0)
    if (files.length > room) setMsg(t('uMaxFiles', { n: MAX_FILES }))
    const added: Item[] = []
    for (const f of files.slice(0, Math.max(0, room))) {
      if (f.size > MAX_SIZE) {
        setMsg(t('uTooBig', { name: f.name }))
        continue
      }
      const kind = kindOf(f)
      added.push({
        key: crypto.randomUUID(),
        file: f,
        kind,
        totalPages: 1,
        counting: kind === 'pdf',
        range: '',
        copies: 1,
        color: kind === 'image',
        duplex: false
      })
    }
    setItems((list) => [...list, ...added])
    for (const it of added) {
      if (it.kind !== 'pdf') continue
      try {
        const n = await countPdfPages(it.file)
        update(it.key, { totalPages: n, counting: false })
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
    try {
      const preview = await passportPreview(f)
      setPassport((p) => ({ file: f, photos: p?.photos ?? PASSPORT_OPTIONS[0], preview }))
    } catch {
      setMsg(t('ppReadFail'))
    }
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

  const priced = useMemo(() => {
    if (!shop) return []
    return items
      .filter((it) => !(combineOn && it.kind === 'image'))
      .map((it) => {
        const pages = it.kind === 'pdf' ? countRange(it.range, it.totalPages) : it.totalPages
        const price = pages ? pages * it.copies * rateFor(shop.rates, it.color, it.duplex) : 0
        return { it, pages, price }
      })
  }, [items, shop, combineOn])

  const comboPrice = shop && combineOn ? images.length * combo.copies * rateFor(shop.rates, combo.color, combo.duplex) : 0
  const sheets = passport ? passportSheets(passport.photos) : 0
  const passportPrice = passport ? sheets * Number(passportRate ?? 0) : 0
  const total = priced.reduce((s, p) => s + p.price, 0) + comboPrice + passportPrice
  const invalid = priced.some((p) => !p.pages) || items.some((i) => i.counting)
  const uploadCount = priced.length + (combineOn ? 1 : 0) + (passport ? 1 : 0)

  async function submit() {
    if (!shop || (!items.length && !passport) || invalid) return
    setBusy(true)
    setMsg(null)
    try {
      localStorage.setItem('pq_name', name.trim())
      const uploads: Upload[] = []
      const fileUpload = (it: Item, pages: number): Upload => ({
        payload: {
          name: it.file.name,
          mime: it.file.type || 'application/octet-stream',
          size: it.file.size,
          total_pages: it.totalPages,
          page_range: it.kind === 'pdf' ? it.range.replace(/\s+/g, '') : '',
          pages_to_print: pages,
          copies: it.copies,
          color: it.color,
          duplex: it.duplex
        },
        blob: it.file,
        contentType: it.file.type || 'application/octet-stream'
      })
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
              duplex: combo.duplex
            },
            blob: pdf,
            contentType: 'application/pdf'
          })
          continue
        }
        const p = priced.find((x) => x.it.key === it.key)
        if (p?.pages) uploads.push(fileUpload(it, p.pages))
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
      setProgress(null)

      const args = { p_slug: slug, p_customer_name: name, p_note: note, p_files: uploads.map((u) => u.payload) }
      let res = counterId
        ? await supabase.rpc('create_order', { ...args, p_counter: counterId })
        : await supabase.rpc('create_order', args)
      // Database not updated to v2 yet: the counter argument is unknown. Send the order without it.
      if (counterId && res.error && res.error.code === 'PGRST202') res = await supabase.rpc('create_order', args)
      const { data, error } = res
      if (error) throw error
      const order = (data as { order_id: string; access_key: string; token: number; paths: string[] }[])[0]
      for (let i = 0; i < uploads.length; i++) {
        setProgress({ text: t('uUploading', { i: i + 1, n: uploads.length }), pct: Math.round((i / uploads.length) * 100) })
        const u = uploads[i]
        const { error: upErr } = await supabase.storage.from('uploads').upload(order.paths[i], u.blob, {
          contentType: u.contentType,
          upsert: false
        })
        if (upErr) throw upErr
      }
      setProgress({ text: t('uSending'), pct: 100 })
      const { error: finErr } = await supabase.rpc('finalize_order', { p_order_id: order.order_id, p_key: order.access_key })
      if (finErr) throw finErr
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

  const shell = (body: ReactElement, extraClass = '') => (
    <div className={`app-page ${extraClass}`}>
      <TopBar to={null} />
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
      <div className="skeleton-wrap" aria-busy="true">
        <span className="sr-only">{t('loading')}</span>
        <div className="card skel-card"><div className="skel skel-avatar" /><div className="skel skel-line w60" /><div className="skel skel-line w40" /></div>
        <div className="card skel-card"><div className="skel skel-block" /></div>
      </div>
    )
  }

  const hasItems = items.length > 0 || passport !== null
  const roomLeft = MAX_FILES - items.length - (passport ? 1 : 0)
  const flowAt = !hasItems ? 0 : busy ? 2 : 1
  const flow = [t('flowAdd'), t('flowOptions'), t('flowSend')]

  return shell(
    <>
      <header className="shop-head card">
        <div className="shop-head-row">
          <div className="shop-avatar" aria-hidden="true">{shop.name.trim().charAt(0).toUpperCase() || 'P'}</div>
          <div className="shop-head-text">
            <h1>{shop.name}</h1>
            {shop.address && <p className="shop-addr"><Icon name="pin" size={15} /> {shop.address}</p>}
          </div>
          <span className={`open-chip ${shop.is_open ? 'is-open' : 'is-closed'}`}>
            <span className="open-dot" aria-hidden="true" />{shop.is_open ? t('shopOpen') : t('shopClosed')}
          </span>
        </div>
        {counterName && <p className="counter-tag">🧾 {t('uCounter', { name: counterName })}</p>}
        <p className="rates-pill">
          {t('ratesLine', { bw: rupees(shop.rates.bw_single), color: rupees(shop.rates.color_single) })}
        </p>
      </header>

      {!shop.is_open ? (
        <div className="card state-card closed-card">
          <span className="state-icon" aria-hidden="true"><Icon name="lock" size={28} /></span>
          <h2>{t('uClosedTitle')}</h2>
          <p className="muted">{t('uClosedBody')}</p>
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
              <div className="file-price">
                <span className="small muted">{t('calcLine', { p: images.length, c: combo.copies })}</span>
                <strong>{rupees(comboPrice)}</strong>
              </div>
            </div>
          )}

          {priced.map(({ it, pages, price }) => (
            <div className="card file-card" key={it.key}>
              <div className="file-top">
                <FileBadge kind={it.kind} />
                <div className="fname">
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
                  <label className="field">
                    <span>{t('uWhichPages')}</span>
                    <input value={it.range} placeholder={`1-${it.totalPages}`} inputMode="numeric"
                      onChange={(e) => update(it.key, { range: e.target.value })} />
                  </label>
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

              <div className="file-price">
                <span className={pages ? 'small muted' : 'small err-text'}>
                  {pages ? t('calcLine', { p: pages, c: it.copies }) : t('uBadRange')}
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
              <p className="privacy-line"><Icon name="shield" size={18} /> <span>{t('uAutoDelete')}</span></p>
            </div>
          )}

          {msg && <p className="notice error" role="alert"><Icon name="alert" size={18} /> <span>{msg}</span></p>}

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
                  <button type="button" className="btn primary lg sticky-cta" onClick={submit} disabled={busy || invalid}>
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
    </>,
    hasItems ? 'has-sticky' : ''
  )
}
