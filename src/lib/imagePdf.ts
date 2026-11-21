/*
 * Client-side PDF making without dependencies:
 *  - imagesToPdf: each photo on its own A4 page (compressed JPEG)
 *  - passportSheetPdf: one photo, center-cropped to 35x45 mm, laid out on A4 at 300 dpi with cut lines
 *  - idcardSheetPdf: front (and back) of an ID card at real size (85.6 x 54 mm) on one A4 page at 300 dpi
 * The PDF writer embeds canvas JPEGs directly (DCTDecode), so the files stay small.
 */

const A4_W = 595.28 // points (1/72 inch)
const A4_H = 841.89

export type PdfPage = {
  jpeg: Uint8Array
  pxW: number
  pxH: number
  pageW: number
  pageH: number
  /** image placement on the page, in points from the bottom-left corner */
  x: number
  y: number
  w: number
  h: number
}

export function buildPdf(pages: PdfPage[]): Blob {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const offsets: number[] = []
  let pos = 0
  const push = (part: string | Uint8Array) => {
    const b = typeof part === 'string' ? enc.encode(part) : part
    chunks.push(b)
    pos += b.length
  }
  const n = (v: number) => (Math.round(v * 100) / 100).toString()

  // Object numbers: 1 catalog, 2 pages, then per page: page, content, image
  const total = 2 + pages.length * 3
  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')
  offsets[1] = pos
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n')
  offsets[2] = pos
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ')
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`)
  pages.forEach((p, i) => {
    const pageNo = 3 + i * 3
    const contentNo = pageNo + 1
    const imageNo = pageNo + 2
    offsets[pageNo] = pos
    push(
      `${pageNo} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.pageW)} ${n(p.pageH)}] ` +
        `/Resources << /XObject << /Im0 ${imageNo} 0 R >> >> /Contents ${contentNo} 0 R >>\nendobj\n`
    )
    const content = `q ${n(p.w)} 0 0 ${n(p.h)} ${n(p.x)} ${n(p.y)} cm /Im0 Do Q`
    offsets[contentNo] = pos
    push(`${contentNo} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`)
    offsets[imageNo] = pos
    push(
      `${imageNo} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${p.pxW} /Height ${p.pxH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`
    )
    push(p.jpeg)
    push('\nendstream\nendobj\n')
  })
  const xref = pos
  let table = `xref\n0 ${total + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= total; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  push(table)
  push(`trailer\n<< /Size ${total + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  return new Blob(chunks as BlobPart[], { type: 'application/pdf' })
}

/** Loads a picture file. Browsers apply the EXIF rotation when drawing it on a canvas. */
export async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('Could not read image'))
    })
    if (!img.naturalWidth || !img.naturalHeight) throw new Error('Could not read image')
    return img
  } finally {
    // The decoded image stays usable after the URL is revoked.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('Canvas not supported')
  g.imageSmoothingEnabled = true
  g.imageSmoothingQuality = 'high'
  return { c, g }
}

export async function toJpeg(c: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', quality))
  if (!blob) throw new Error('Could not make JPEG')
  return new Uint8Array(await blob.arrayBuffer())
}

/** Each photo on its own A4 page (landscape page for landscape photos), fitted with a small margin. */
export async function imagesToPdf(files: Blob[], onStep?: (i: number) => void): Promise<Blob> {
  const MAX_SIDE = 2000 // ~200 dpi on A4 — sharp prints, small file
  const MARGIN = 18 // points (~6 mm)
  const pages: PdfPage[] = []
  for (let i = 0; i < files.length; i++) {
    onStep?.(i)
    const img = await loadImage(files[i])
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
    const pxW = Math.max(1, Math.round(img.naturalWidth * scale))
    const pxH = Math.max(1, Math.round(img.naturalHeight * scale))
    const { c, g } = canvas(pxW, pxH)
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, pxW, pxH)
    g.drawImage(img, 0, 0, pxW, pxH)
    const jpeg = await toJpeg(c, 0.82)
    c.width = c.height = 1 // free memory early (mobile)
    const landscape = pxW > pxH
    const pageW = landscape ? A4_H : A4_W
    const pageH = landscape ? A4_W : A4_H
    const fit = Math.min((pageW - MARGIN * 2) / pxW, (pageH - MARGIN * 2) / pxH)
    const w = pxW * fit
    const h = pxH * fit
    pages.push({ jpeg, pxW, pxH, pageW, pageH, x: (pageW - w) / 2, y: (pageH - h) / 2, w, h })
  }
  return buildPdf(pages)
}

/* ---------------- Passport photos ---------------- */

const DPI = 300
const mm = (v: number) => Math.round((v / 25.4) * DPI)
const PHOTO_W = mm(35) // 413 px
const PHOTO_H = mm(45) // 531 px
const GAP = mm(3)
const SHEET_W = mm(210) // 2480 px
const SHEET_H = mm(297) // 3508 px
const COLS = Math.floor((SHEET_W - mm(8) + GAP) / (PHOTO_W + GAP)) // 5
const ROWS = Math.floor((SHEET_H - mm(8) + GAP) / (PHOTO_H + GAP)) // 6

/** Photos of 35x45 mm that fit on one A4 sheet. Must match the database (create_order uses 30). */
export const PASSPORT_PER_SHEET = COLS * ROWS
export const PASSPORT_OPTIONS = [8, 16, 32]

export function passportSheets(photos: number): number {
  return Math.max(1, Math.ceil(photos / PASSPORT_PER_SHEET))
}

/** Center-crops the picture to 35:45 and draws it at the given size. */
function cropped(img: HTMLImageElement, w: number, h: number) {
  const sw = img.naturalWidth
  const sh = img.naturalHeight
  const ratio = PHOTO_W / PHOTO_H
  let cw = sw
  let ch = sh
  if (sw / sh > ratio) cw = sh * ratio
  else ch = sw / ratio
  const { c, g } = canvas(w, h)
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, w, h)
  g.drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h)
  return c
}

/** Small preview (data URL) of the cropped passport photo. */
export async function passportPreview(file: Blob): Promise<string> {
  const img = await loadImage(file)
  return cropped(img, 140, 180).toDataURL('image/jpeg', 0.85)
}

/** A4 sheet(s) at 300 dpi with `photos` copies of the 35x45 mm photo and thin cut lines. */
export async function passportSheetPdf(file: Blob, photos: number): Promise<Blob> {
  const img = await loadImage(file)
  const photo = cropped(img, PHOTO_W, PHOTO_H)
  const gridW = COLS * PHOTO_W + (COLS - 1) * GAP
  const gridH = ROWS * PHOTO_H + (ROWS - 1) * GAP
  const left = Math.round((SHEET_W - gridW) / 2)
  const top = Math.round((SHEET_H - gridH) / 2)
  const sheets = passportSheets(photos)
  const pages: PdfPage[] = []
  let remaining = photos
  for (let s = 0; s < sheets; s++) {
    const { c, g } = canvas(SHEET_W, SHEET_H)
    g.fillStyle = '#ffffff'
    g.fillRect(0, 0, SHEET_W, SHEET_H)
    const count = Math.min(PASSPORT_PER_SHEET, remaining)
    remaining -= count
    g.strokeStyle = '#9ca3af'
    g.lineWidth = 2
    for (let i = 0; i < count; i++) {
      const x = left + (i % COLS) * (PHOTO_W + GAP)
      const y = top + Math.floor(i / COLS) * (PHOTO_H + GAP)
      g.drawImage(photo, x, y)
      // cut line in the middle of the gap around each photo (shared lines overlap exactly)
      g.strokeRect(x - GAP / 2, y - GAP / 2, PHOTO_W + GAP, PHOTO_H + GAP)
    }
    const jpeg = await toJpeg(c, 0.9)
    c.width = c.height = 1
    pages.push({ jpeg, pxW: SHEET_W, pxH: SHEET_H, pageW: A4_W, pageH: A4_H, x: 0, y: 0, w: A4_W, h: A4_H })
  }
  return buildPdf(pages)
}

/* ---------------- ID card (Aadhaar / PAN ...) ---------------- */

const CARD_W = mm(85.6) // 1011 px, ID-1 / CR80
const CARD_H = mm(54) // 638 px
const CARD_GAP = mm(12)
const CARD_RADIUS = mm(3.18)

/** Small preview (data URL) of a cropped card side. */
export function idcardPreview(side: HTMLCanvasElement): string {
  const portrait = side.height > side.width
  const w = portrait ? 108 : 171
  const h = portrait ? 171 : 108
  const { c, g } = canvas(w, h)
  g.drawImage(side, 0, 0, w, h)
  return c.toDataURL('image/jpeg', 0.85)
}

/**
 * One A4 page at 300 dpi: the front above the back (if given), each at real card size, centred,
 * with a thin dashed cut line on the card edge. A side cropped upright (taller than wide) is printed
 * as an upright card (54 x 85.6 mm). The shop prints it at 100% (no scaling), `copies` times.
 */
export async function idcardSheetPdf(front: HTMLCanvasElement, back: HTMLCanvasElement | null): Promise<Blob> {
  const sides = back ? [front, back] : [front]
  const sizes = sides.map((s) => (s.height > s.width ? { w: CARD_H, h: CARD_W } : { w: CARD_W, h: CARD_H }))
  const blockH = sizes.reduce((n, z) => n + z.h, 0) + CARD_GAP * (sides.length - 1)
  const { c, g } = canvas(SHEET_W, SHEET_H)
  g.fillStyle = '#ffffff'
  g.fillRect(0, 0, SHEET_W, SHEET_H)
  let y = Math.round((SHEET_H - blockH) / 2)
  sides.forEach((side, i) => {
    const { w, h } = sizes[i]
    const x = Math.round((SHEET_W - w) / 2)
    g.drawImage(side, x, y, w, h)
    g.save()
    g.strokeStyle = '#9ca3af'
    g.lineWidth = 2
    g.setLineDash([mm(1.5), mm(1)])
    // Rounded like the card; older browsers without roundRect get a plain rectangle.
    g.beginPath()
    if (typeof g.roundRect === 'function') g.roundRect(x - 1, y - 1, w + 2, h + 2, CARD_RADIUS)
    else g.rect(x - 1, y - 1, w + 2, h + 2)
    g.stroke()
    g.restore()
    y += h + CARD_GAP
  })
  const jpeg = await toJpeg(c, 0.92)
  c.width = c.height = 1
  return buildPdf([{ jpeg, pxW: SHEET_W, pxH: SHEET_H, pageW: A4_W, pageH: A4_H, x: 0, y: 0, w: A4_W, h: A4_H }])
}
