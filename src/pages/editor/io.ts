/*
 * Import (photos, PDF pages), export (PDF with page settings), print, share, and recent documents
 * kept in IndexedDB on this device.
 */
import { loadImage, toJpeg } from '../../lib/imagePdf'
import { DocMeta, drawPage, forgetPage, loadSign, Page, processed, titleFor } from './doc'
import { FONT, isFullQuad, makeCanvas, toCanvas } from './imgproc'

export const SRC_MAX = 2400

/** Picture file -> canvas (EXIF orientation applied by the browser), longest side <= SRC_MAX. */
export async function fileToCanvas(f: Blob): Promise<HTMLCanvasElement> {
  const img = await loadImage(f)
  return toCanvas(img, img.naturalWidth, img.naturalHeight, SRC_MAX)
}

/* ---------------------------------------------------------------- PDF sources (kept open while editing) */

type PdfProxy = import('pdfjs-dist').PDFDocumentProxy
type PdfSource = { bytes: Uint8Array; doc: PdfProxy; sizes: { w: number; h: number; rot: number }[] }
const pdfSources = new Map<string, PdfSource>()
let pdfSeq = 0

async function pdfjsLib() {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/** Opens a PDF without rendering it: returns a key and each page's size in points (as displayed). Fast. */
export async function openPdfSource(file: File, limit: number): Promise<{ key: string; sizes: { w: number; h: number }[] }> {
  const pdfjs = await pdfjsLib()
  const bytes = new Uint8Array(await file.arrayBuffer())
  // pdf.js takes ownership of the buffer it gets, so hand it a copy and keep the original bytes for export
  const doc = await pdfjs.getDocument({ data: bytes.slice() }).promise
  const n = Math.min(doc.numPages, limit)
  const sizes: PdfSource['sizes'] = []
  for (let i = 1; i <= n; i++) {
    const pg = await doc.getPage(i)
    const v = pg.getViewport({ scale: 1 })
    sizes.push({ w: v.width, h: v.height, rot: pg.rotate || 0 })
  }
  const key = 'pdf' + ++pdfSeq
  pdfSources.set(key, { bytes, doc, sizes })
  return { key, sizes }
}

export function releasePdfSource(key: string) {
  const s = pdfSources.get(key)
  if (!s) return
  pdfSources.delete(key)
  void s.doc.destroy()
}
export function releaseAllPdfSources() { for (const k of [...pdfSources.keys()]) releasePdfSource(k) }

/** Renders one PDF page (0-based) so its longest side is `longSide` pixels. */
export async function renderPdfPage(key: string, index: number, longSide: number): Promise<HTMLCanvasElement> {
  const src = pdfSources.get(key)
  if (!src) throw new Error('pdf closed')
  const page = await src.doc.getPage(index + 1)
  const v1 = page.getViewport({ scale: 1 })
  const vp = page.getViewport({ scale: longSide / Math.max(v1.width, v1.height) })
  const [c, g] = makeCanvas(vp.width, vp.height)
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  await page.render({ canvasContext: g, viewport: vp }).promise
  page.cleanup()
  return c
}

/** Preview size for PDF pages while editing (export goes back to the PDF for full quality). */
export const PDF_PREVIEW = 1600

/** Full-quality source picture for a page, longest side about `need` px, or null when there is no original. */
async function hiSource(p: Page, need: number): Promise<HTMLCanvasElement | null> {
  const o = p.orig
  if (!o) return null
  if (o.kind === 'pdf') {
    if (!pdfSources.has(o.key)) return null
    return renderPdfPage(o.key, o.index, need)
  }
  const img = await loadImage(o.blob)
  if (Math.max(img.naturalWidth, img.naturalHeight) <= Math.max(p.src.width, p.src.height) * 1.05) return null
  return toCanvas(img, img.naturalWidth, img.naturalHeight, need)
}

/** The page re-based on a bigger source picture (quad scaled; edits are stored normalised so they carry over). */
function rebased(p: Page, hi: HTMLCanvasElement, tag: string): Page {
  const kx = hi.width / p.src.width
  const ky = hi.height / p.src.height
  return { ...p, id: p.id + tag, src: hi, quad: p.quad.map((q) => ({ x: q.x * kx, y: q.y * ky })) as Page['quad'] }
}

/** Swaps a loaded picture in for a page's placeholder (or preview), keeping its crop. */
export function withSource(p: Page, c: HTMLCanvasElement): Page {
  const r = rebased(p, c, '')
  return { ...r, id: p.id, srcVer: p.srcVer + 1, loading: false }
}

/* ---------------------------------------------------------------- PDF settings */

export type PageSize = 'auto' | 'a4' | 'a3' | 'a5' | 'b5' | 'letter' | 'legal' | 'card'
export type Orient = 'auto' | 'portrait' | 'landscape'
export type Margin = 'none' | 'small' | 'normal'
export type Quality = 'small' | 'medium' | 'large' | 'original'
export type PageNum = 'none' | 'left' | 'center' | 'right'
export type PdfSettings = { size: PageSize; orient: Orient; margin: Margin; quality: Quality; pageNum: PageNum }

export const PAGE_SIZES: PageSize[] = ['auto', 'a4', 'a3', 'a5', 'b5', 'letter', 'legal', 'card']
/** Portrait size in millimetres (card is the usual 90 × 54 mm, used landscape). */
const MM: Record<Exclude<PageSize, 'auto'>, [number, number]> = {
  a4: [210, 297], a3: [297, 420], a5: [148, 210], b5: [176, 250], letter: [215.9, 279.4], legal: [215.9, 355.6], card: [54, 90]
}
const QUALITY: Record<Quality, { dpi: number; q: number }> = {
  small: { dpi: 110, q: 0.62 }, medium: { dpi: 150, q: 0.78 }, large: { dpi: 220, q: 0.88 }, original: { dpi: 300, q: 0.95 }
}
const PT_PER_MM = 72 / 25.4

export const DEFAULT_PDF: PdfSettings = { size: 'auto', orient: 'auto', margin: 'none', quality: 'original', pageNum: 'none' }
// v2: new defaults (keep the original page, best quality); older saved choices are dropped once
const KEY = 'pq_editor_pdf2'
export function loadPdfSettings(): PdfSettings {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}')
    return { ...DEFAULT_PDF, ...v }
  } catch { return DEFAULT_PDF }
}
export function savePdfSettings(s: PdfSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* ignore */ }
}

/** Page layout in points: page size and the image box. */
function layout(imgW: number, imgH: number, s: PdfSettings) {
  const landscapeImg = imgW > imgH
  let pw: number, ph: number
  if (s.size === 'auto') {
    // the page takes the picture's own shape (long side = A4 long side)
    const long = 297 * PT_PER_MM
    if (landscapeImg) { pw = long; ph = (long * imgH) / imgW } else { ph = long; pw = (long * imgW) / imgH }
  } else {
    const [a, b] = MM[s.size]
    const land = s.orient === 'landscape' || (s.orient === 'auto' && landscapeImg)
    pw = (land ? b : a) * PT_PER_MM
    ph = (land ? a : b) * PT_PER_MM
  }
  const small = Math.min(pw, ph) < 200
  const m = s.margin === 'none' ? 0 : (s.margin === 'small' ? 6 : 12) * PT_PER_MM * (small ? 0.35 : 1)
  const bottomExtra = s.pageNum !== 'none' && m < 14 ? 14 - m : 0
  const boxW = pw - m * 2
  const boxH = ph - m * 2 - bottomExtra
  const fit = Math.min(boxW / imgW, boxH / imgH)
  const w = imgW * fit
  const h = imgH * fit
  return { pw, ph, x: (pw - w) / 2, y: m + (boxH - h) / 2, w, h }
}

/** Composes one finished PDF page as a canvas (white page, image box, page number), from the full-quality original. */
export async function composePage(p: Page, meta: DocMeta, index: number, total: number, s: PdfSettings): Promise<{ c: HTMLCanvasElement; pw: number; ph: number }> {
  const preview = processed(p, SRC_MAX)
  const L = layout(preview.width, preview.height, s)
  const { dpi } = QUALITY[s.quality]
  let k = dpi / 72
  const maxPx = 5000
  if (Math.max(L.pw, L.ph) * k > maxPx) k = maxPx / Math.max(L.pw, L.ph)
  const iw = Math.round(L.w * k)
  const ih = Math.round(L.h * k)
  const ix = Math.round(L.x * k)
  const iy = Math.round(L.y * k)
  // Go back to the original when the preview is smaller than the printed box needs.
  let base = preview
  let tmp: Page | null = null
  const ratio = Math.max(p.src.width, p.src.height) / Math.max(preview.width, preview.height)
  const need = Math.min(6000, Math.ceil(Math.max(iw, ih) * ratio))
  if (p.loading || need > Math.max(p.src.width, p.src.height) * 1.1) {
    const hi = await hiSource(p, need).catch(() => null)
    if (hi) {
      tmp = rebased(p, hi, '~hi')
      base = processed(tmp, Math.max(iw, ih, 1))
    }
  }
  const [c, g] = makeCanvas(L.pw * k, L.ph * k)
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  // draw at the image box size so text and strokes stay sharp
  const [pc, pg] = makeCanvas(iw, ih)
  drawPage(pg, p, base, iw, ih, { title: titleFor(meta, index) })
  g.drawImage(pc, ix, iy)
  pc.width = pc.height = 1
  if (tmp) { forgetPage(tmp.id); tmp.src.width = tmp.src.height = 1 }
  if (s.pageNum !== 'none') drawPageNum(g, index, total, s, c.width, c.height, k, L.x)
  return { c, pw: L.pw, ph: L.ph }
}

function drawPageNum(g: CanvasRenderingContext2D, index: number, total: number, s: PdfSettings, W: number, H: number, k: number, marginX: number) {
  const size = Math.max(8, 9 * k)
  g.font = `500 ${size}px ${FONT}`
  g.fillStyle = '#333'
  g.textBaseline = 'alphabetic'
  const label = `${index + 1} / ${total}`
  const pad = Math.max(10 * k, (marginX / 1.5) * k)
  g.textAlign = s.pageNum === 'left' ? 'left' : s.pageNum === 'right' ? 'right' : 'center'
  const x = s.pageNum === 'left' ? pad : s.pageNum === 'right' ? W - pad : W / 2
  g.fillText(label, x, H - Math.max(5 * k, size * 0.6))
}

/** A PDF page whose picture was not changed (no crop, rotation, filter or pixel edit): it can stay vector. */
function keepsVector(p: Page): boolean {
  if (p.orig?.kind !== 'pdf') return false
  const src = pdfSources.get(p.orig.key)
  if (!src) return false
  return p.filter === 'original' && !p.bright && !p.contrast && !p.detail && p.rot === 0 && !p.ops.length &&
    (p.loading || isFullQuad(p.quad, p.src.width, p.src.height))
}

/**
 * Builds the PDF. Unchanged PDF pages are copied as they are (text, fonts and vectors stay original, same size);
 * marks on them (text, signature, pen, watermark, title, page number) go on top as a transparent layer.
 * Other pages are full-quality pictures.
 */
export async function exportPdf(pages: Page[], meta: DocMeta, s: PdfSettings, onStep?: (i: number) => void): Promise<Blob> {
  for (const p of pages) for (const l of p.layers) if (l.kind === 'sign') await loadSign(l.src)
  const { PDFDocument, BlendMode } = await import('pdf-lib')
  const out = await PDFDocument.create()
  const loaded = new Map<string, Awaited<ReturnType<typeof PDFDocument.load>>>()
  const srcDoc = async (key: string) => {
    let d = loaded.get(key)
    if (!d) {
      d = await PDFDocument.load(pdfSources.get(key)!.bytes, { ignoreEncryption: true, updateMetadata: false })
      loaded.set(key, d)
    }
    return d
  }
  for (let i = 0; i < pages.length; i++) {
    onStep?.(i)
    await new Promise((r) => setTimeout(r, 0))
    const p = pages[i]
    const title = titleFor(meta, i)
    const marks = p.layers.length > 0 || !!p.wm || !!title || s.pageNum !== 'none'
    let done = false
    if (keepsVector(p) && p.orig?.kind === 'pdf') {
      const o = p.orig
      const info = pdfSources.get(o.key)!.sizes[o.index]
      try {
        const d = await srcDoc(o.key)
        if (!marks && s.size === 'auto') {
          const [cp] = await out.copyPages(d, [o.index])
          out.addPage(cp)
          done = true
        } else if (!info.rot) {
          const emb = await out.embedPage(d.getPage(o.index))
          const L = s.size === 'auto' ? { pw: emb.width, ph: emb.height, x: 0, y: 0, w: emb.width, h: emb.height } : layout(emb.width, emb.height, s)
          const pg = out.addPage([L.pw, L.ph])
          pg.drawPage(emb, { x: L.x, y: L.ph - L.y - L.h, width: L.w, height: L.h })
          if (marks) {
            const k = 220 / 72
            const hl = p.layers.filter((l) => l.kind === 'stroke' && l.tool === 'hl')
            const rest = p.layers.filter((l) => !(l.kind === 'stroke' && l.tool === 'hl'))
            const blank = makeCanvas(1, 1)[0]
            const overlay = async (pp: Page, t: string, num: boolean) => {
              const [c, g] = makeCanvas(L.pw * k, L.ph * k)
              const [bc, bg] = makeCanvas(L.w * k, L.h * k)
              drawPage(bg, pp, blank, bc.width, bc.height, { title: t })
              g.drawImage(bc, Math.round(L.x * k), Math.round(L.y * k))
              bc.width = bc.height = 1
              if (num) drawPageNum(g, i, pages.length, s, c.width, c.height, k, L.x)
              const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/png'))
              c.width = c.height = 1
              return b ? out.embedPng(new Uint8Array(await b.arrayBuffer())) : null
            }
            if (hl.length) {
              const im = await overlay({ ...p, layers: hl, wm: null }, '', false)
              if (im) pg.drawImage(im, { x: 0, y: 0, width: L.pw, height: L.ph, blendMode: BlendMode.Multiply })
            }
            if (rest.length || p.wm || title || s.pageNum !== 'none') {
              const im = await overlay({ ...p, layers: rest }, title, s.pageNum !== 'none')
              if (im) pg.drawImage(im, { x: 0, y: 0, width: L.pw, height: L.ph })
            }
          }
          done = true
        }
      } catch { done = false }
    }
    if (!done) {
      const { c, pw, ph } = await composePage(p, meta, i, pages.length, s)
      const jpeg = await toJpeg(c, QUALITY[s.quality].q)
      c.width = c.height = 1
      const im = await out.embedJpg(jpeg)
      out.addPage([pw, ph]).drawImage(im, { x: 0, y: 0, width: pw, height: ph })
    }
  }
  const bytes = await out.save()
  return new Blob([bytes], { type: 'application/pdf' })
}

/** Page images for printing (the same pages as the PDF). */
export async function printImages(pages: Page[], meta: DocMeta, s: PdfSettings): Promise<string[]> {
  for (const p of pages) for (const l of p.layers) if (l.kind === 'sign') await loadSign(l.src)
  const urls: string[] = []
  for (let i = 0; i < pages.length; i++) {
    await new Promise((r) => setTimeout(r, 0))
    const { c } = await composePage(pages[i], meta, i, pages.length, s)
    const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.9))
    c.width = c.height = 1
    if (b) urls.push(URL.createObjectURL(b))
  }
  return urls
}

/**
 * Prints the pages the way the app prints the QR poster: window.print() (the Android app routes it to the
 * system print dialog). Only the page images are visible while printing.
 */
export async function printPages(urls: string[], title: string) {
  document.querySelector('.ed-print')?.remove()
  const box = document.createElement('div')
  box.className = 'ed-print'
  for (const u of urls) {
    const im = document.createElement('img')
    im.src = u
    im.alt = ''
    box.appendChild(im)
  }
  document.body.appendChild(box)
  await Promise.all([...box.querySelectorAll('img')].map((im) => im.decode().catch(() => undefined)))
  document.body.classList.add('ed-printing')
  const old = document.title
  document.title = title
  const done = () => {
    document.body.classList.remove('ed-printing')
    document.title = old
    box.remove()
    urls.forEach((u) => URL.revokeObjectURL(u))
    window.removeEventListener('afterprint', done)
  }
  window.addEventListener('afterprint', done)
  window.print()
  // Android's bridge returns at once; keep the pages around long enough for the print job to read them.
  setTimeout(() => { if (document.body.classList.contains('ed-printing')) done() }, 60000)
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 8000)
}

/** Shares the PDF with the system share sheet; falls back to a download. Returns 'shared' | 'downloaded'. */
export async function share(blob: Blob, name: string): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const file = new File([blob], name, { type: 'application/pdf' })
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: name })
      return 'shared'
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') return 'cancelled'
    }
  }
  download(blob, name)
  return 'downloaded'
}

/* ---------------------------------------------------------------- recent documents (IndexedDB) */

export type Recent = { id: string; name: string; at: number; thumb: string; pages: Blob[] }
const DB = 'pq-editor'
const STORE = 'docs'

function db(): Promise<IDBDatabase> {
  return new Promise((ok, bad) => {
    if (!('indexedDB' in window)) return bad(new Error('no idb'))
    const r = indexedDB.open(DB, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' })
    r.onsuccess = () => ok(r.result)
    r.onerror = () => bad(r.error)
  })
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db()
  return new Promise<T>((ok, bad) => {
    const t = d.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => ok(req.result)
    req.onerror = () => bad(req.error)
    t.oncomplete = () => d.close()
  })
}

export async function listRecents(): Promise<Recent[]> {
  try {
    const all = await tx<Recent[]>('readonly', (s) => s.getAll() as IDBRequest<Recent[]>)
    return all.sort((a, b) => b.at - a.at)
  } catch { return [] }
}
export async function deleteRecent(id: string) {
  try { await tx('readwrite', (s) => s.delete(id)) } catch { /* ignore */ }
}

/** Saves the finished pages (flattened, without margins) so the document can be opened again. */
export async function saveRecent(id: string, pages: Page[], meta: DocMeta) {
  try {
    for (const p of pages) for (const l of p.layers) if (l.kind === 'sign') await loadSign(l.src)
    const blobs: Blob[] = []
    let thumb = ''
    for (let i = 0; i < pages.length; i++) {
      let pg = pages[i]
      if (pg.loading) {
        const hi = await hiSource(pg, 1800).catch(() => null)
        if (hi) pg = rebased(pg, hi, '~rc')
      }
      const base = processed(pg, SRC_MAX)
      const s = Math.min(1, 1800 / Math.max(base.width, base.height))
      const [c, g] = makeCanvas(base.width * s, base.height * s)
      drawPage(g, pages[i], base, c.width, c.height, { title: titleFor(meta, i) })
      const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.85))
      if (b) blobs.push(b)
      if (i === 0) thumb = toCanvas(c, c.width, c.height, 160).toDataURL('image/jpeg', 0.7)
      c.width = c.height = 1
      if (pg !== pages[i]) forgetPage(pg.id)
    }
    await tx('readwrite', (st) => st.put({ id, name: meta.name, at: Date.now(), thumb, pages: blobs } satisfies Recent))
    const all = await listRecents()
    for (const old of all.slice(12)) await deleteRecent(old.id)
  } catch { /* storage full or blocked: recents are optional */ }
}
