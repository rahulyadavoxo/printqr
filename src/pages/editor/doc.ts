/*
 * Document model for the editor and the page renderer shared by the preview and the PDF export.
 * Geometry of edits and layers is stored normalised (0..1 of the processed page), so crop, rotation and
 * filter can change afterwards without losing markup.
 */
import { applyFilter, drawFittedText, FilterId, FONT, inpaint, makeCanvas, Pt, Quad, Rect, rotate, warp } from './imgproc'

export type EraseOp = { kind: 'erase'; strokes: { pts: Pt[]; r: number }[]; rects: Rect[] }
export type RetextOp = { kind: 'retext'; rect: Rect; bg: string; color: string; text: string; bold: boolean }
export type Op = EraseOp | RetextOp

export type TextLayer = { id: string; kind: 'text'; x: number; y: number; size: number; text: string; color: string; bold: boolean }
export type SignLayer = { id: string; kind: 'sign'; x: number; y: number; w: number; ratio: number; src: string; color: string; opacity: number }
export type StrokeLayer = { id: string; kind: 'stroke'; tool: 'pen' | 'hl'; color: string; width: number; opacity: number; pts: Pt[] }
export type Layer = TextLayer | SignLayer | StrokeLayer

export type Watermark = { text: string; color: string; size: number; opacity: number; angle: number; mode: 'single' | 'tile' }

export type PageState = {
  quad: Quad
  rot: number
  filter: FilterId
  bright: number
  contrast: number
  detail: number
  ops: Op[]
  layers: Layer[]
  wm: Watermark | null
}

/** Where a page came from, so export can go back to the full-quality original. */
export type Orig = { kind: 'pdf'; key: string; index: number } | { kind: 'img'; blob: Blob }

export type Page = PageState & {
  id: string
  /** preview-size picture used while editing (export re-renders from `orig` at full quality) */
  src: HTMLCanvasElement
  srcVer: number
  undo: string[]
  orig?: Orig
  /** true while a PDF page is still rendering in the background (src is a blank placeholder) */
  loading?: boolean
}

export type TitleMode = 'off' | 'first' | 'all'
export type DocMeta = { name: string; titleMode: TitleMode }

export const uid = () => Math.random().toString(36).slice(2, 10)

export function snap(p: PageState): string {
  const { quad, rot, filter, bright, contrast, detail, ops, layers, wm } = p
  return JSON.stringify({ quad, rot, filter, bright, contrast, detail, ops, layers, wm })
}
export function clonePageState(p: PageState): PageState {
  return JSON.parse(snap(p)) as PageState
}

/* ---------------------------------------------------------------- processing cache */

type Cached = { key: string; c: HTMLCanvasElement }
const cache = new Map<string, Cached>()

function cached(id: string, key: string, make: () => HTMLCanvasElement): HTMLCanvasElement {
  const hit = cache.get(id)
  if (hit && hit.key === key) return hit.c
  const c = make()
  if (hit && hit.c !== c) hit.c.width = hit.c.height = 1
  cache.set(id, { key, c })
  return c
}

export function forgetPage(id: string) {
  for (const k of [...cache.keys()]) if (k.startsWith(id + ':')) {
    const v = cache.get(k)
    if (v) v.c.width = v.c.height = 1
    cache.delete(k)
  }
}

/** Crop + rotation only (before filters). */
export function geometry(p: Page, maxSide: number): HTMLCanvasElement {
  const key = `${p.srcVer}|${JSON.stringify(p.quad)}|${p.rot}|${maxSide}`
  return cached(`${p.id}:geo:${maxSide}`, key, () => {
    const w = warp(p.src, p.quad, maxSide)
    const r = rotate(w, p.rot)
    if (r !== w) w.width = w.height = 1
    return r
  })
}

/** Crop + rotation + filter + pixel edits (smart erase, edit text). Layers are drawn separately. */
export function processed(p: Page, maxSide: number): HTMLCanvasElement {
  const geo = geometry(p, maxSide)
  const fkey = `${p.srcVer}|${JSON.stringify(p.quad)}|${p.rot}|${p.filter}|${p.bright}|${p.contrast}|${p.detail}`
  const filtered = cached(`${p.id}:flt:${maxSide}`, fkey, () =>
    applyFilter(geo, p.filter, { bright: p.bright, contrast: p.contrast, detail: p.detail }))
  if (!p.ops.length) return filtered
  return cached(`${p.id}:ops:${maxSide}`, fkey + JSON.stringify(p.ops), () => {
    const [c, g] = makeCanvas(filtered.width, filtered.height)
    g.drawImage(filtered, 0, 0)
    for (const op of p.ops) applyOp(c, op)
    return c
  })
}

export function eraseMask(w: number, h: number, op: EraseOp): Uint8Array {
  const [c, g] = makeCanvas(w, h)
  g.fillStyle = '#000'
  g.strokeStyle = '#000'
  g.lineCap = 'round'
  g.lineJoin = 'round'
  for (const s of op.strokes) {
    g.lineWidth = Math.max(1, s.r * 2 * w)
    g.beginPath()
    s.pts.forEach((p, i) => (i ? g.lineTo(p.x * w, p.y * h) : g.moveTo(p.x * w, p.y * h)))
    if (s.pts.length === 1) g.lineTo(s.pts[0].x * w + 0.1, s.pts[0].y * h)
    g.stroke()
  }
  for (const r of op.rects) g.fillRect(r.x * w, r.y * h, r.w * w, r.h * h)
  const d = g.getImageData(0, 0, w, h).data
  const m = new Uint8Array(w * h)
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] > 20 ? 1 : 0
  c.width = c.height = 1
  return m
}

/** Grows a mask by r pixels so the soft edges of erased marks go too. */
function grow(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  let a = m
  for (let it = 0; it < r; it++) {
    const b = new Uint8Array(a)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (a[i]) continue
        if ((x > 0 && a[i - 1]) || (x < w - 1 && a[i + 1]) || (y > 0 && a[i - w]) || (y < h - 1 && a[i + w])) b[i] = 1
      }
    a = b
  }
  return a
}

export function applyOp(c: HTMLCanvasElement, op: Op) {
  const w = c.width
  const h = c.height
  if (op.kind === 'erase') {
    inpaint(c, grow(eraseMask(w, h, op), w, h, Math.max(1, Math.round(w / 700))))
  } else {
    const g = c.getContext('2d')!
    const r = { x: op.rect.x * w, y: op.rect.y * h, w: op.rect.w * w, h: op.rect.h * h }
    g.fillStyle = op.bg
    g.fillRect(r.x - 1, r.y - 1, r.w + 2, r.h + 2)
    if (op.text.trim()) drawFittedText(g, op.text, r, op.color, op.bold)
  }
}

/* ---------------------------------------------------------------- layers */

const signImgs = new Map<string, HTMLImageElement>()
/** Cached image for a signature (recoloured to the layer colour). */
export function signImage(src: string, color: string, onLoad?: () => void): HTMLImageElement | HTMLCanvasElement | null {
  const key = src
  let img = signImgs.get(key)
  if (!img) {
    img = new Image()
    img.onload = () => onLoad?.()
    img.src = src
    signImgs.set(key, img)
  }
  if (!img.complete || !img.naturalWidth) return null
  if (!color) return img
  const tk = src.length + '|' + src.slice(-40) + '|' + color
  const t = tinted.get(tk)
  if (t) return t
  const [c, g] = makeCanvas(img.naturalWidth, img.naturalHeight)
  g.drawImage(img, 0, 0)
  g.globalCompositeOperation = 'source-in'
  g.fillStyle = color
  g.fillRect(0, 0, c.width, c.height)
  tinted.set(tk, c)
  return c
}
const tinted = new Map<string, HTMLCanvasElement>()

export function loadSign(src: string): Promise<void> {
  return new Promise((ok) => {
    const im = signImgs.get(src)
    if (im && im.complete && im.naturalWidth) return ok()
    const i = new Image()
    i.onload = () => { signImgs.set(src, i); ok() }
    i.onerror = () => ok()
    i.src = src
  })
}

export function textLines(l: TextLayer) { return (l.text || ' ').replace(/\r/g, '').split('\n') }

/** Size of a text layer in page pixels for a page of width W. */
export function textBox(g: CanvasRenderingContext2D, l: TextLayer, W: number): { w: number; h: number } {
  const size = l.size * W
  g.font = `${l.bold ? 700 : 500} ${size}px ${FONT}`
  const lines = textLines(l)
  const w = Math.max(...lines.map((s) => g.measureText(s).width), size * 0.6)
  return { w: w + size * 0.2, h: lines.length * size * 1.25 }
}

export function drawStroke(g: CanvasRenderingContext2D, s: StrokeLayer, W: number, H: number) {
  g.save()
  g.globalAlpha = s.opacity
  g.strokeStyle = s.color
  g.lineWidth = Math.max(0.5, s.width * W)
  g.lineCap = s.tool === 'hl' ? 'square' : 'round'
  g.lineJoin = 'round'
  if (s.tool === 'hl') g.globalCompositeOperation = 'multiply'
  g.beginPath()
  s.pts.forEach((p, i) => (i ? g.lineTo(p.x * W, p.y * H) : g.moveTo(p.x * W, p.y * H)))
  if (s.pts.length === 1) g.lineTo(s.pts[0].x * W + 0.01, s.pts[0].y * H)
  g.stroke()
  g.restore()
}

export function drawWatermark(g: CanvasRenderingContext2D, wm: Watermark, W: number, H: number) {
  if (!wm.text.trim()) return
  g.save()
  g.globalAlpha = wm.opacity
  g.fillStyle = wm.color
  const size = Math.max(6, wm.size * W)
  g.font = `700 ${size}px ${FONT}`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  const a = (wm.angle * Math.PI) / 180
  if (wm.mode === 'single') {
    g.translate(W / 2, H / 2)
    g.rotate(a)
    g.fillText(wm.text, 0, 0)
  } else {
    const tw = g.measureText(wm.text).width
    const stepX = tw + size * 2.2
    const stepY = size * 3.4
    const R = Math.hypot(W, H)
    g.translate(W / 2, H / 2)
    g.rotate(a)
    let row = 0
    for (let y = -R; y <= R; y += stepY, row++)
      for (let x = -R + (row % 2) * (stepX / 2); x <= R; x += stepX) g.fillText(wm.text, x, y)
  }
  g.restore()
}

export function drawTitle(g: CanvasRenderingContext2D, title: string, W: number, H: number) {
  if (!title.trim()) return
  const size = Math.max(8, W * 0.032)
  g.save()
  g.font = `700 ${size}px ${FONT}`
  const tw = Math.min(W * 0.9, g.measureText(title).width)
  const padX = size * 0.6
  const y = Math.max(size * 0.5, H * 0.015)
  g.fillStyle = 'rgba(255,255,255,.88)'
  g.fillRect(W / 2 - tw / 2 - padX, y, tw + padX * 2, size * 1.5)
  g.fillStyle = '#111'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(title, W / 2, y + size * 0.75, W * 0.9)
  g.restore()
  void H
}

export type DrawOpts = { title?: string; skipLayerId?: string; liveStroke?: StrokeLayer | null; onAsset?: () => void }

/** Draws the finished page (processed image + title + watermark + layers) into W×H at (0,0). */
export function drawPage(g: CanvasRenderingContext2D, p: Page, base: HTMLCanvasElement, W: number, H: number, o: DrawOpts = {}) {
  g.drawImage(base, 0, 0, W, H)
  if (o.title) drawTitle(g, o.title, W, H)
  if (p.wm) drawWatermark(g, p.wm, W, H)
  const all = o.liveStroke ? [...p.layers, o.liveStroke] : p.layers
  for (const l of all) {
    if (l.id === o.skipLayerId) continue
    if (l.kind === 'stroke') drawStroke(g, l, W, H)
    else if (l.kind === 'text') {
      const size = l.size * W
      g.save()
      g.font = `${l.bold ? 700 : 500} ${size}px ${FONT}`
      g.fillStyle = l.color
      g.textBaseline = 'top'
      textLines(l).forEach((s, i) => g.fillText(s, l.x * W + size * 0.1, l.y * H + i * size * 1.25 + size * 0.1))
      g.restore()
    } else if (l.kind === 'sign') {
      const im = signImage(l.src, l.color, o.onAsset)
      if (!im) continue
      const w = l.w * W
      g.save()
      g.globalAlpha = l.opacity
      g.drawImage(im, l.x * W, l.y * H, w, w * l.ratio)
      g.restore()
    }
  }
}

export function titleFor(meta: DocMeta, index: number): string {
  if (meta.titleMode === 'off') return ''
  if (meta.titleMode === 'first' && index > 0) return ''
  return meta.name
}

/** Default document name, e.g. "Scan 19-11-2026 12.40". */
export function defaultName(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `Scan ${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}.${p(d.getMinutes())}`
}

export function safeFileName(name: string): string {
  return (name.trim() || 'Scan').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)
}
