import { ChangeEvent, DragEvent, ReactElement, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Rates, supabase } from '../lib/supabase'
import { countPdfPages } from '../lib/pdf'
import { countRange, rateFor, rupees } from '../lib/pricing'
import { useI18n } from '../lib/i18n'
import { TopBar } from '../components/TopBar'

type ShopPublic = { id: string; name: string; address: string | null; is_open: boolean; rates: Rates; upi_id: string | null }

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

function FileBadge({ kind }: { kind: Item['kind'] }) {
  const label = kind === 'pdf' ? 'PDF' : kind === 'image' ? 'IMG' : 'DOC'
  return <span className={`file-badge k-${kind}`}>{label}</span>
}

export default function Upload() {
  const { slug = '' } = useParams()
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
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.rpc('get_shop_public', { p_slug: slug }).then(({ data, error }) => {
      if (error) return setLoadErr({ text: te(error) })
      const row = (data as ShopPublic[] | null)?.[0]
      if (!row) return setLoadErr({ notFound: true })
      setShop(row)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug])

  function update(key: string, patch: Partial<Item>) {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  }

  async function addFiles(files: File[]) {
    setMsg(null)
    const room = MAX_FILES - items.length
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

  function onDrop(e: DragEvent<HTMLButtonElement>) {
    e.preventDefault()
    setDragging(false)
    if (busy) return
    void addFiles(Array.from(e.dataTransfer.files || []))
  }

  const priced = useMemo(() => {
    if (!shop) return []
    return items.map((it) => {
      const pages = it.kind === 'pdf' ? countRange(it.range, it.totalPages) : it.totalPages
      const price = pages ? pages * it.copies * rateFor(shop.rates, it.color, it.duplex) : 0
      return { it, pages, price }
    })
  }, [items, shop])

  const total = priced.reduce((s, p) => s + p.price, 0)
  const invalid = priced.some((p) => !p.pages) || items.some((i) => i.counting)

  async function submit() {
    if (!shop || !items.length || invalid) return
    setBusy(true)
    setMsg(null)
    try {
      localStorage.setItem('pq_name', name.trim())
      const payload = priced.map(({ it, pages }) => ({
        name: it.file.name,
        mime: it.file.type || 'application/octet-stream',
        size: it.file.size,
        total_pages: it.totalPages,
        page_range: it.kind === 'pdf' ? it.range.replace(/\s+/g, '') : '',
        pages_to_print: pages,
        copies: it.copies,
        color: it.color,
        duplex: it.duplex
      }))
      const { data, error } = await supabase.rpc('create_order', {
        p_slug: slug,
        p_customer_name: name,
        p_note: note,
        p_files: payload
      })
      if (error) throw error
      const order = (data as { order_id: string; access_key: string; token: number; paths: string[] }[])[0]
      for (let i = 0; i < items.length; i++) {
        setProgress({ text: t('uUploading', { i: i + 1, n: items.length }), pct: Math.round((i / items.length) * 100) })
        const it = items[i]
        const { error: upErr } = await supabase.storage.from('uploads').upload(order.paths[i], it.file, {
          contentType: it.file.type || 'application/octet-stream',
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

  if (loadErr) return shell(<div className="card center"><p>{loadErr.notFound ? t('uShopNotFound') : loadErr.text}</p></div>)
  if (!shop) return shell(<p className="muted center loading">{t('loading')}</p>)

  const hasItems = items.length > 0

  return shell(
    <>
      <header className="shop-head card">
        <div className="shop-avatar" aria-hidden="true">{shop.name.trim().charAt(0).toUpperCase() || 'P'}</div>
        <h1>{shop.name}</h1>
        {shop.address && <p className="muted">{shop.address}</p>}
        <p className="rates-pill">
          {t('ratesLine', { bw: rupees(shop.rates.bw_single), color: rupees(shop.rates.color_single) })}
        </p>
      </header>

      {!shop.is_open ? (
        <div className="card center closed-card">
          <div className="closed-icon" aria-hidden="true">🔒</div>
          <h2>{t('uClosedTitle')}</h2>
          <p className="muted">{t('uClosedBody')}</p>
        </div>
      ) : (
        <>
          <input ref={inputRef} type="file" multiple hidden onChange={onPick}
            accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx" />

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
            </button>
          ) : null}

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
                  onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} disabled={busy}>✕</button>
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
                <div className="field">
                  <span>{t('uCopies')}</span>
                  <div className="stepper">
                    <button type="button" aria-label="-" disabled={it.copies <= 1}
                      onClick={() => update(it.key, { copies: Math.max(1, it.copies - 1) })}>−</button>
                    <input type="number" min={1} max={100} value={it.copies} aria-label={t('uCopies')}
                      onChange={(e) => update(it.key, { copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
                    <button type="button" aria-label="+" disabled={it.copies >= 100}
                      onClick={() => update(it.key, { copies: Math.min(100, it.copies + 1) })}>+</button>
                  </div>
                </div>
              </div>

              <div className="seg">
                <button type="button" className={!it.color ? 'on' : ''} onClick={() => update(it.key, { color: false })}>{t('bw')}</button>
                <button type="button" className={it.color ? 'on' : ''} onClick={() => update(it.key, { color: true })}>{t('color')}</button>
              </div>
              <div className="seg">
                <button type="button" className={!it.duplex ? 'on' : ''} onClick={() => update(it.key, { duplex: false })}>{t('oneSide')}</button>
                <button type="button" className={it.duplex ? 'on' : ''} onClick={() => update(it.key, { duplex: true })}>{t('bothSides')}</button>
              </div>

              <div className="file-price">
                <span className={pages ? 'small muted' : 'small err-text'}>
                  {pages ? t('calcLine', { p: pages, c: it.copies }) : t('uBadRange')}
                </span>
                <strong>{rupees(price)}</strong>
              </div>
            </div>
          ))}

          {hasItems && items.length < MAX_FILES && (
            <button type="button" className="btn dashed block lg" onClick={() => inputRef.current?.click()} disabled={busy}>
              {t('uAddMore')}
            </button>
          )}

          {hasItems && (
            <div className="card">
              <h3 className="card-title">{t('uDetails')}</h3>
              <label className="field">
                <span>{t('uYourName')} <em className="opt">({t('optional')})</em></span>
                <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </label>
              <label className="field">
                <span>{t('uNote')} <em className="opt">({t('optional')})</em></span>
                <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder={t('uNotePh')} />
              </label>
              <p className="small muted">🔒 {t('uAutoDelete')}</p>
            </div>
          )}

          {msg && <p className="notice error">{msg}</p>}

          {hasItems && (
            <div className="sticky-bar">
              <div className="sticky-in">
                {progress && (
                  <div className="progress-track" aria-hidden="true">
                    <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
                  </div>
                )}
                <div className="sticky-row">
                  <div className="sticky-total">
                    <span className="small muted">{t('total')} · {tn('files_one', 'files_other', items.length)}</span>
                    <strong>{rupees(total)}</strong>
                  </div>
                  <button type="button" className="btn primary lg" onClick={submit} disabled={busy || invalid}>
                    {busy ? progress?.text || t('pleaseWait') : t('uSend')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>,
    hasItems ? 'has-sticky' : ''
  )
}
