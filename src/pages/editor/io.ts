/*
 * Import (photos, PDF pages), export (PDF with page settings), print, share, and recent documents
 * kept in IndexedDB on this device.
 */
import { buildPdf, loadImage, PdfPage, toJpeg } from '../../lib/imagePdf'
import { DocMeta, drawPage, loadSign, Page, processed, titleFor } from './doc'
import { FONT, makeCanvas, toCanvas } from './imgproc'

export const SRC_MAX = 2400

/** Picture file -> canvas (EXIF orientation applied by the browser), longest side <= SRC_MAX. */
export async function fileToCanvas(f: Blob): Promise<HTMLCanvasElement> {
  const img = await loadImage(f)
  return toCanvas(img, img.naturalWidth, img.naturalHeight, SRC_MAX)
}

/** Renders every page of a PDF to a canvas (pdf.js loaded on demand). */
export async function pdfToCanvases(file: File, limit: number, onPage?: (i: number, n: number) => void): Promise<HTMLCanvasElement[]> {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise
  const out: HTMLCanvasElement[] = []
  try {
    const n = Math.min(doc.numPages, limit)
    for (let i = 1; i <= n; i++) {
      onPage?.(i, n)
      const page = await doc.getPage(i)
      const v1 = page.getViewport({ scale: 1 })
      const scale = Math.min(3, 2000 / Math.max(v1.width, v1.height))
      const vp = page.getViewport({ scale })
      const [c, g] = makeCanvas(vp.width, vp.height)
      g.fillStyle = '#fff'
      g.fillRect(0, 0, c.width, c.height)
      await page.render({ canvasContext: g, viewport: vp }).promise
      page.cleanup()
      out.push(c)
    }
  } finally {
    await doc.destroy()
  }
  return out
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
  small: { dpi: 110, q: 0.6 }, medium: { dpi: 150, q: 0.72 }, large: { dpi: 200, q: 0.82 }, original: { dpi: 260, q: 0.92 }
}
const PT_PER_MM = 72 / 25.4

export const DEFAULT_PDF: PdfSettings = { size: 'a4', orient: 'auto', margin: 'small', quality: 'medium', pageNum: 'none' }
const KEY = 'pq_editor_pdf'
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

/** Composes one finished PDF page as a canvas (white page, image box, page number). */
export function composePage(p: Page, meta: DocMeta, index: number, total: number, s: PdfSettings): { c: HTMLCanvasElement; pw: number; ph: number } {
  const base = processed(p, SRC_MAX)
  const L = layout(base.width, base.height, s)
  const { dpi } = QUALITY[s.quality]
  let k = dpi / 72
  const maxPx = 4200
  if (Math.max(L.pw, L.ph) * k > maxPx) k = maxPx / Math.max(L.pw, L.ph)
  const [c, g] = makeCanvas(L.pw * k, L.ph * k)
  g.fillStyle = '#fff'
  g.fillRect(0, 0, c.width, c.height)
  const iw = Math.round(L.w * k)
  const ih = Math.round(L.h * k)
  const ix = Math.round(L.x * k)
  const iy = Math.round(L.y * k)
  // draw at the image box size so text and strokes stay sharp
  const [pc, pg] = makeCanvas(iw, ih)
  drawPage(pg, p, base, iw, ih, { title: titleFor(meta, index) })
  g.drawImage(pc, ix, iy)
  pc.width = pc.height = 1
  if (s.pageNum !== 'none') {
    const size = Math.max(8, 9 * k)
    g.font = `500 ${size}px ${FONT}`
    g.fillStyle = '#333'
    g.textBaseline = 'alphabetic'
    const label = `${index + 1} / ${total}`
    const pad = Math.max(10 * k, (L.x / 1.5) * k)
    g.textAlign = s.pageNum === 'left' ? 'left' : s.pageNum === 'right' ? 'right' : 'center'
    const x = s.pageNum === 'left' ? pad : s.pageNum === 'right' ? c.width - pad : c.width / 2
    g.fillText(label, x, c.height - Math.max(5 * k, size * 0.6))
  }
  return { c, pw: L.pw, ph: L.ph }
}

export async function exportPdf(pages: Page[], meta: DocMeta, s: PdfSettings, onStep?: (i: number) => void): Promise<Blob> {
  for (const p of pages) for (const l of p.layers) if (l.kind === 'sign') await loadSign(l.src)
  const out: PdfPage[] = []
  for (let i = 0; i < pages.length; i++) {
    onStep?.(i)
    await new Promise((r) => setTimeout(r, 0))
    const { c, pw, ph } = composePage(pages[i], meta, i, pages.length, s)
    const jpeg = await toJpeg(c, QUALITY[s.quality].q)
    out.push({ jpeg, pxW: c.width, pxH: c.height, pageW: pw, pageH: ph, x: 0, y: 0, w: pw, h: ph })
    c.width = c.height = 1
  }
  return buildPdf(out)
}

/** Page images for printing (the same pages as the PDF). */
export async function printImages(pages: Page[], meta: DocMeta, s: PdfSettings): Promise<string[]> {
  for (const p of pages) for (const l of p.layers) if (l.kind === 'sign') await loadSign(l.src)
  const urls: string[] = []
  for (let i = 0; i < pages.length; i++) {
    await new Promise((r) => setTimeout(r, 0))
    const { c } = composePage(pages[i], meta, i, pages.length, s)
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
      const base = processed(pages[i], SRC_MAX)
      const s = Math.min(1, 1800 / Math.max(base.width, base.height))
      const [c, g] = makeCanvas(base.width * s, base.height * s)
      drawPage(g, pages[i], base, c.width, c.height, { title: titleFor(meta, i) })
      const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, 'image/jpeg', 0.85))
      if (b) blobs.push(b)
      if (i === 0) thumb = toCanvas(c, c.width, c.height, 160).toDataURL('image/jpeg', 0.7)
      c.width = c.height = 1
    }
    await tx('readwrite', (st) => st.put({ id, name: meta.name, at: Date.now(), thumb, pages: blobs } satisfies Recent))
    const all = await listRecents()
    for (const old of all.slice(12)) await deleteRecent(old.id)
  } catch { /* storage full or blocked: recents are optional */ }
}
