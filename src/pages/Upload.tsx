import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { errMsg, Rates, supabase } from '../lib/supabase'
import { countPdfPages } from '../lib/pdf'
import { countRange, rateFor, rupees } from '../lib/pricing'

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

export default function Upload() {
  const { slug = '' } = useParams()
  const nav = useNavigate()
  const [shop, setShop] = useState<ShopPublic | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [name, setName] = useState(() => localStorage.getItem('pq_name') || '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.rpc('get_shop_public', { p_slug: slug }).then(({ data, error }) => {
      if (error) return setLoadErr(errMsg(error))
      const row = (data as ShopPublic[] | null)?.[0]
      if (!row) return setLoadErr('Ye shop nahi mili. QR dobara scan karo.')
      setShop(row)
    })
  }, [slug])

  function update(key: string, patch: Partial<Item>) {
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)))
  }

  async function onPick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    setMsg(null)
    const room = MAX_FILES - items.length
    if (files.length > room) setMsg(`Ek order mein max ${MAX_FILES} files.`)
    const added: Item[] = []
    for (const f of files.slice(0, room)) {
      if (f.size > MAX_SIZE) {
        setMsg(`${f.name} 50 MB se badi hai.`)
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
        setMsg(`${it.file.name} ke pages gin nahi paye, page count khud likho.`)
      }
    }
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
        setProgress(`Upload ho raha hai ${i + 1}/${items.length}...`)
        const it = items[i]
        const { error: upErr } = await supabase.storage.from('uploads').upload(order.paths[i], it.file, {
          contentType: it.file.type || 'application/octet-stream',
          upsert: false
        })
        if (upErr) throw upErr
      }
      setProgress('Bhej rahe hain...')
      const { error: finErr } = await supabase.rpc('finalize_order', { p_order_id: order.order_id, p_key: order.access_key })
      if (finErr) throw finErr
      const saved = JSON.parse(localStorage.getItem('pq_orders') || '[]') as unknown[]
      localStorage.setItem('pq_orders', JSON.stringify([{ id: order.order_id, key: order.access_key, shop: shop.name, at: Date.now() }, ...saved].slice(0, 10)))
      nav(`/o/${order.order_id}/${order.access_key}`, { replace: true })
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  if (loadErr) return <div className="page narrow"><div className="card"><p>{loadErr}</p></div></div>
  if (!shop) return <div className="page narrow"><p className="muted center">Loading...</p></div>

  return (
    <div className="page narrow">
      <header className="shop-head">
        <h1>{shop.name}</h1>
        {shop.address && <p className="muted">{shop.address}</p>}
        <p className="rates-line">
          B/W {rupees(shop.rates.bw_single)}/page · Color {rupees(shop.rates.color_single)}/page
        </p>
      </header>

      {!shop.is_open ? (
        <div className="card"><p>Shop abhi band hai. Thodi der baad try karo.</p></div>
      ) : (
        <>
          <input ref={inputRef} type="file" multiple hidden onChange={onPick}
            accept=".pdf,image/*,.doc,.docx,.xls,.xlsx,.ppt,.pptx" />
          <button className="btn primary block big" onClick={() => inputRef.current?.click()} disabled={busy}>
            {items.length ? '+ Aur file jodo' : 'File chuno (PDF, photo, Word)'}
          </button>

          {priced.map(({ it, pages, price }) => (
            <div className="card file" key={it.key}>
              <div className="row between">
                <div className="fname">
                  <strong>{it.file.name}</strong>
                  <span className="muted small"> {sizeText(it.file.size)}</span>
                </div>
                <button className="link danger" onClick={() => setItems((l) => l.filter((x) => x.key !== it.key))} disabled={busy}>Hatao</button>
              </div>

              {it.kind === 'pdf' && (
                <p className="small muted">{it.counting ? 'Pages gin rahe hain...' : `${it.totalPages} pages`}</p>
              )}

              <div className="grid2">
                {it.kind === 'pdf' ? (
                  <label>
                    Kaunse pages (khali = sab)
                    <input value={it.range} placeholder={`1-${it.totalPages}`} onChange={(e) => update(it.key, { range: e.target.value })} />
                  </label>
                ) : (
                  <label>
                    Kitne pages
                    <input type="number" min={1} max={2000} value={it.totalPages}
                      onChange={(e) => update(it.key, { totalPages: Math.max(1, Math.min(2000, Number(e.target.value) || 1)) })} />
                  </label>
                )}
                <label>
                  Copies
                  <input type="number" min={1} max={100} value={it.copies}
                    onChange={(e) => update(it.key, { copies: Math.max(1, Math.min(100, Number(e.target.value) || 1)) })} />
                </label>
              </div>

              <div className="seg">
                <button className={!it.color ? 'on' : ''} onClick={() => update(it.key, { color: false })}>B/W</button>
                <button className={it.color ? 'on' : ''} onClick={() => update(it.key, { color: true })}>Color</button>
              </div>
              <div className="seg">
                <button className={!it.duplex ? 'on' : ''} onClick={() => update(it.key, { duplex: false })}>Ek side</button>
                <button className={it.duplex ? 'on' : ''} onClick={() => update(it.key, { duplex: true })}>Dono side</button>
              </div>

              <div className="row between">
                <span className="small muted">
                  {pages ? `${pages} page × ${it.copies} copy` : 'Page range galat hai (jaise 1-3,5)'}
                </span>
                <strong>{rupees(price)}</strong>
              </div>
            </div>
          ))}

          {items.length > 0 && (
            <div className="card">
              <label>
                Aapka naam (optional)
                <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Shop wale ke liye note (optional)
                <input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Jaise: spiral binding bhi karni hai" />
              </label>
              <div className="total row between">
                <span>Total</span>
                <strong>{rupees(total)}</strong>
              </div>
              {msg && <p className="notice error">{msg}</p>}
              <button className="btn primary block big" onClick={submit} disabled={busy || invalid}>
                {busy ? progress || 'Ruko...' : 'Bhejo'}
              </button>
              <p className="small muted center">Aapki files print ke baad apne aap delete ho jaati hain.</p>
            </div>
          )}
          {!items.length && msg && <p className="notice error">{msg}</p>}
        </>
      )}
    </div>
  )
}
