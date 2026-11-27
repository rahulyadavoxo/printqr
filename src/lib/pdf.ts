import type { PDFDocumentProxy } from 'pdfjs-dist'

async function pdfjsLib() {
  const pdfjs = await import('pdfjs-dist')
  const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  return pdfjs
}

/** Opens a PDF in the browser with pdf.js (loaded only when needed). Call destroy() when done. */
export async function openPdf(file: File): Promise<PDFDocumentProxy> {
  const pdfjs = await pdfjsLib()
  const data = new Uint8Array(await file.arrayBuffer())
  return pdfjs.getDocument({ data }).promise
}

/** Counts pages of a PDF in the browser. */
export async function countPdfPages(file: File): Promise<number> {
  const doc = await openPdf(file)
  const n = doc.numPages
  await doc.destroy()
  return n
}

/** Renders one page (1-based) to a JPEG data URL about `width` px wide. */
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, width: number): Promise<string> {
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(4, width / base.width)
  const vp = page.getViewport({ scale })
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(vp.width))
  c.height = Math.max(1, Math.round(vp.height))
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  page.cleanup()
  const url = c.toDataURL('image/jpeg', 0.8)
  c.width = c.height = 0
  return url
}

/**
 * A new PDF holding only the chosen pages (1-based, in document order). The pages are copied as they are
 * (text, vectors, fonts, page size), so the print looks exactly like the original.
 */
export async function extractPages(file: File, pages: number[]): Promise<Blob> {
  const { PDFDocument } = await import('pdf-lib')
  const src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false })
  const out = await PDFDocument.create()
  const copied = await out.copyPages(src, [...pages].sort((a, b) => a - b).map((p) => p - 1))
  copied.forEach((p) => out.addPage(p))
  const bytes = await out.save()
  if (out.getPageCount() !== pages.length) throw new Error('page_copy')
  return new Blob([bytes], { type: 'application/pdf' })
}

/** "1-3,5,8-9" for a sorted list of pages. */
export function pagesToRange(pages: number[]): string {
  const s = [...pages].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < s.length; i++) {
    const a = s[i]
    while (i + 1 < s.length && s[i + 1] === s[i] + 1) i++
    parts.push(a === s[i] ? `${a}` : `${a}-${s[i]}`)
  }
  return parts.join(',')
}

/**
 * "1-3, 5, 8-9" -> [1, 2, 3, 5, 8, 9] (sorted, no repeats). null when the text is not a page list inside 1..total
 * (QA #45: pages can be typed as well as ticked).
 */
export function parsePageRange(text: string, total: number): number[] | null {
  const parts = text.replace(/[\u2013\u2014]/g, '-').replace(/\s*-\s*/g, '-').split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)
  if (!parts.length) return null
  const out = new Set<number>()
  for (const p of parts) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(p)
    if (!m) return null
    const a = Number(m[1])
    const b = m[2] ? Number(m[2]) : a
    if (a < 1 || b < a || b > total) return null
    for (let i = a; i <= b; i++) out.add(i)
  }
  return [...out].sort((x, y) => x - y)
}
